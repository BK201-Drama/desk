//! Reminders: multi-item list under %LOCALAPPDATA%/desk/reminders.json.
//! Due items fire a Windows toast at local 09:00 via tauri-plugin-notification.

use chrono::{Datelike, Duration, Local, NaiveDate, TimeZone, Weekday};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderDto {
    pub id: String,
    pub title: String,
    pub rule: String,
    pub rule_label: String,
    pub done: bool,
    pub created_at: u64,
    /// Unix seconds; 0 = silent / not scheduled.
    #[serde(default)]
    pub next_fire_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Store {
    items: Vec<ReminderDto>,
}

fn store_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("reminders.json"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn rule_label(rule: &str) -> String {
    match rule {
        "once" => "一次性".into(),
        "1m" => "每 1 月".into(),
        "1w" => "每 1 周".into(),
        "on15" => "每月 15 日".into(),
        other => other.to_string(),
    }
}

fn local_nine(date: NaiveDate) -> chrono::DateTime<Local> {
    let naive = date
        .and_hms_opt(9, 0, 0)
        .expect("09:00 is a valid wall time");
    match Local.from_local_datetime(&naive) {
        chrono::offset::LocalResult::Single(dt) => dt,
        chrono::offset::LocalResult::Ambiguous(a, _) => a,
        chrono::offset::LocalResult::None => Local.from_utc_datetime(&naive),
    }
}

/// Next local 09:00 strictly after `now` if already past today's 09:00; else today's 09:00.
pub fn next_nine_am(now: chrono::DateTime<Local>) -> chrono::DateTime<Local> {
    let today_nine = local_nine(now.date_naive());
    if now < today_nine {
        today_nine
    } else {
        local_nine(now.date_naive() + Duration::days(1))
    }
}

fn next_weekday_nine(now: chrono::DateTime<Local>, weekday: Weekday) -> chrono::DateTime<Local> {
    let mut d = now.date_naive();
    for _ in 0..14 {
        if d.weekday() == weekday {
            let t = local_nine(d);
            if now < t {
                return t;
            }
        }
        d += Duration::days(1);
    }
    next_nine_am(now)
}

fn clamp_day(year: i32, month: u32, day: u32) -> NaiveDate {
    for d in (1..=day.min(31)).rev() {
        if let Some(date) = NaiveDate::from_ymd_opt(year, month, d) {
            return date;
        }
    }
    NaiveDate::from_ymd_opt(year, month, 1).expect("month has day 1")
}

fn next_month_day_nine(now: chrono::DateTime<Local>, day: u32) -> chrono::DateTime<Local> {
    let mut y = now.year();
    let mut m = now.month();
    for _ in 0..14 {
        let d = clamp_day(y, m, day);
        let t = local_nine(d);
        if now < t {
            return t;
        }
        if m == 12 {
            m = 1;
            y += 1;
        } else {
            m += 1;
        }
    }
    next_nine_am(now)
}

/// Compute the next fire instant for a rule. `dom_hint` is day-of-month for `1m` (from created_at).
pub fn compute_next_fire(rule: &str, now: chrono::DateTime<Local>, dom_hint: u32) -> u64 {
    let dt = match rule {
        "1w" => next_weekday_nine(now, Weekday::Mon),
        "on15" => next_month_day_nine(now, 15),
        "1m" => next_month_day_nine(now, dom_hint.clamp(1, 31)),
        // once + unknown → next 09:00
        _ => next_nine_am(now),
    };
    dt.timestamp().max(0) as u64
}

fn dom_from_created(created_at: u64) -> u32 {
    Local
        .timestamp_opt(created_at as i64, 0)
        .single()
        .map(|d| d.day())
        .unwrap_or_else(|| Local::now().day())
}

fn schedule_for(item: &ReminderDto, now: chrono::DateTime<Local>) -> u64 {
    if item.done {
        return 0;
    }
    compute_next_fire(&item.rule, now, dom_from_created(item.created_at))
}

fn load_store() -> Result<Store, String> {
    let p = store_path()?;
    if !p.exists() {
        let now = Local::now();
        let created = now_secs();
        let mut item = ReminderDto {
            id: format!("r-{created}"),
            title: "买洗洁精".into(),
            rule: "1m".into(),
            rule_label: rule_label("1m"),
            done: false,
            created_at: created,
            next_fire_at: 0,
        };
        item.next_fire_at = schedule_for(&item, now);
        let seeded = Store { items: vec![item] };
        save_store(&seeded)?;
        return Ok(seeded);
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut store: Store = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    let now = Local::now();
    let mut dirty = false;
    for item in &mut store.items {
        if !item.done && item.next_fire_at == 0 {
            item.next_fire_at = schedule_for(item, now);
            dirty = true;
        }
    }
    if dirty {
        save_store(&store)?;
    }
    Ok(store)
}

fn save_store(store: &Store) -> Result<(), String> {
    let p = store_path()?;
    let s = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

fn advance_after_fire(item: &mut ReminderDto, now: chrono::DateTime<Local>) {
    if item.rule == "once" {
        item.done = true;
        item.next_fire_at = 0;
        return;
    }
    // Push past the just-fired slot so the next occurrence is in the future.
    let just_after = now + Duration::seconds(1);
    item.next_fire_at = schedule_for(item, just_after);
}

#[tauri::command]
pub fn remind_list() -> Result<Vec<ReminderDto>, String> {
    Ok(load_store()?.items)
}

#[tauri::command]
pub fn remind_add(title: String, rule: String) -> Result<Vec<ReminderDto>, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("先写标题".into());
    }
    let rule = if rule.trim().is_empty() {
        "once".to_string()
    } else {
        rule.trim().to_string()
    };
    let mut store = load_store()?;
    let created = now_secs();
    let now = Local::now();
    let mut item = ReminderDto {
        id: format!("r-{}-{}", created, store.items.len()),
        title,
        rule_label: rule_label(&rule),
        rule,
        done: false,
        created_at: created,
        next_fire_at: 0,
    };
    item.next_fire_at = schedule_for(&item, now);
    store.items.insert(0, item);
    save_store(&store)?;
    Ok(store.items)
}

#[tauri::command]
pub fn remind_toggle(id: String) -> Result<Vec<ReminderDto>, String> {
    let mut store = load_store()?;
    let Some(item) = store.items.iter_mut().find(|i| i.id == id) else {
        return Err("not found".into());
    };
    item.done = !item.done;
    let now = Local::now();
    item.next_fire_at = if item.done {
        0
    } else {
        schedule_for(item, now)
    };
    save_store(&store)?;
    Ok(store.items)
}

#[tauri::command]
pub fn remind_remove(id: String) -> Result<Vec<ReminderDto>, String> {
    let mut store = load_store()?;
    store.items.retain(|i| i.id != id);
    save_store(&store)?;
    Ok(store.items)
}

/// Background ticker: due items → Windows toast, then advance schedule.
pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        // First pass soon after boot so a missed morning still surfaces.
        std::thread::sleep(std::time::Duration::from_secs(5));
        loop {
            if let Err(e) = tick_once(&app) {
                eprintln!("remind tick: {e}");
            }
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
}

fn tick_once(app: &AppHandle) -> Result<(), String> {
    let mut store = load_store()?;
    let now = Local::now();
    let now_ts = now.timestamp().max(0) as u64;
    let mut fired = false;
    for item in &mut store.items {
        if item.done || item.next_fire_at == 0 || item.next_fire_at > now_ts {
            continue;
        }
        let title = item.title.clone();
        let body = format!("{} · {}", item.rule_label, "desk 提醒");
        if let Err(e) = app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            eprintln!("remind notification: {e}");
        }
        advance_after_fire(item, now);
        fired = true;
    }
    if fired {
        save_store(&store)?;
        let _ = app.emit("remind:changed", ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    fn fixed(y: i32, m: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<Local> {
        Local
            .with_ymd_and_hms(y, m, d, h, mi, 0)
            .single()
            .expect("fixed local time")
    }

    #[test]
    fn next_nine_before_nine_is_today() {
        let now = fixed(2026, 10, 9, 8, 30);
        let n = next_nine_am(now);
        assert_eq!(n.hour(), 9);
        assert_eq!(n.day(), 9);
    }

    #[test]
    fn next_nine_after_nine_is_tomorrow() {
        let now = fixed(2026, 10, 9, 10, 0);
        let n = next_nine_am(now);
        assert_eq!(n.day(), 10);
        assert_eq!(n.hour(), 9);
    }

    #[test]
    fn weekly_lands_on_monday() {
        // Friday afternoon → next Monday 09:00
        let now = fixed(2026, 10, 9, 15, 0); // Friday
        assert_eq!(now.weekday(), Weekday::Fri);
        let ts = compute_next_fire("1w", now, 9);
        let dt = Local.timestamp_opt(ts as i64, 0).single().unwrap();
        assert_eq!(dt.weekday(), Weekday::Mon);
        assert_eq!(dt.hour(), 9);
    }

    #[test]
    fn on15_skips_to_next_month_after_midday() {
        let now = fixed(2026, 10, 15, 12, 0);
        let ts = compute_next_fire("on15", now, 15);
        let dt = Local.timestamp_opt(ts as i64, 0).single().unwrap();
        assert_eq!(dt.month(), 11);
        assert_eq!(dt.day(), 15);
        assert_eq!(dt.hour(), 9);
    }
}
