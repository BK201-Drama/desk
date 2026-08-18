//! Reminders: multi-item list persisted under %LOCALAPPDATA%/desk/reminders.json.
//! Toast / next_fire scheduling comes later; this unlocks multi-add in UI.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderDto {
    pub id: String,
    pub title: String,
    pub rule: String,
    pub rule_label: String,
    pub done: bool,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Store {
    items: Vec<ReminderDto>,
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn store_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("reminders.json"))
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

fn load_store() -> Result<Store, String> {
    let p = store_path()?;
    if !p.exists() {
        // Seed one sample so first launch isn't empty
        let seeded = Store {
            items: vec![ReminderDto {
                id: format!("r-{}", now_secs()),
                title: "买洗洁精".into(),
                rule: "1m".into(),
                rule_label: rule_label("1m"),
                done: false,
                created_at: now_secs(),
            }],
        };
        save_store(&seeded)?;
        return Ok(seeded);
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn save_store(store: &Store) -> Result<(), String> {
    let p = store_path()?;
    let s = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remind_list() -> Result<Vec<ReminderDto>, String> {
    Ok(load_store()?.items)
}

#[tauri::command]
pub fn remind_add(title: String, rule: String) -> Result<Vec<ReminderDto>, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("title empty".into());
    }
    let rule = if rule.trim().is_empty() {
        "once".to_string()
    } else {
        rule.trim().to_string()
    };
    let mut store = load_store()?;
    store.items.insert(
        0,
        ReminderDto {
            id: format!("r-{}-{}", now_secs(), store.items.len()),
            title,
            rule_label: rule_label(&rule),
            rule,
            done: false,
            created_at: now_secs(),
        },
    );
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
