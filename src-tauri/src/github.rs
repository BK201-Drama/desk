//! GitHub live panel: profile, contribution wall, pins, languages.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubPinDto {
    pub repo: String,
    pub desc: String,
    pub lang: String,
    pub lang_name: String,
    pub stars: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubLangDto {
    pub name: String,
    pub pct: u32,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GithubSnapshotDto {
    pub login: String,
    pub name: String,
    pub bio: String,
    pub avatar_url: String,
    pub streak: u32,
    pub year_total: u32,
    /// Column-major weeks: each inner vec is 7 days Sun..Sat, level 0..=4
    pub weeks: Vec<Vec<u8>>,
    pub pins: Vec<GithubPinDto>,
    pub langs: Vec<GithubLangDto>,
    pub cached: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct GithubConfig {
    token: Option<String>,
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("github.json"))
}

fn cache_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("github-cache.json"))
}

fn load_config() -> GithubConfig {
    let Ok(p) = config_path() else {
        return GithubConfig::default();
    };
    let Ok(s) = fs::read_to_string(p) else {
        return GithubConfig::default();
    };
    serde_json::from_str(&s).unwrap_or_default()
}

fn save_cache(snap: &GithubSnapshotDto) -> Result<(), String> {
    let p = cache_path()?;
    let s = serde_json::to_string_pretty(snap).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

fn load_cache() -> Option<GithubSnapshotDto> {
    let p = cache_path().ok()?;
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn resolve_token() -> Result<String, String> {
    if let Some(t) = load_config().token {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    for key in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(t) = std::env::var(key) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Ok(t);
            }
        }
    }
    #[cfg(windows)]
    let output = Command::new("gh")
        .args(["auth", "token"])
        .creation_flags(0x08000000)
        .output();
    #[cfg(not(windows))]
    let output = Command::new("gh").args(["auth", "token"]).output();

    match output {
        Ok(o) if o.status.success() => {
            let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if t.is_empty() {
                Err("gh auth token returned empty".into())
            } else {
                Ok(t)
            }
        }
        Ok(o) => Err(format!(
            "gh auth token failed: {}",
            String::from_utf8_lossy(&o.stderr).trim()
        )),
        Err(e) => Err(format!(
            "no GitHub token: set %LOCALAPPDATA%\\desk\\github.json or install gh ({e})"
        )),
    }
}

const GQL: &str = "
query {
  viewer {
    login
    name
    bio
    avatarUrl
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
            contributionLevel
            date
          }
        }
      }
    }
    pinnedItems(first: 4, types: [REPOSITORY]) {
      nodes {
        ... on Repository {
          name
          description
          stargazerCount
          primaryLanguage { name color }
        }
      }
    }
    repositories(first: 40, ownerAffiliations: OWNER, isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        languages(first: 8, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
  }
}
";

fn level_to_u8(level: &str) -> u8 {
    match level {
        "NONE" => 0,
        "FIRST_QUARTILE" => 1,
        "SECOND_QUARTILE" => 2,
        "THIRD_QUARTILE" => 3,
        "FOURTH_QUARTILE" => 4,
        _ => 0,
    }
}

fn prev_day(ymd: &str) -> String {
    let parts: Vec<_> = ymd.split('-').collect();
    if parts.len() != 3 {
        return ymd.to_string();
    }
    let y: i32 = parts[0].parse().unwrap_or(1970);
    let m: u32 = parts[1].parse().unwrap_or(1);
    let d: u32 = parts[2].parse().unwrap_or(1);
    let (ny, nm, nd) = if d > 1 {
        (y, m, d - 1)
    } else if m > 1 {
        let pm = m - 1;
        (y, pm, days_in_month(y, pm))
    } else {
        (y - 1, 12, 31)
    };
    format!("{ny:04}-{nm:02}-{nd:02}")
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Consecutive days with contributions, ending today (or yesterday if today is empty).
fn compute_streak(days: &[(String, u32)]) -> u32 {
    if days.is_empty() {
        return 0;
    }
    let mut idx = days.len() - 1;
    if days[idx].1 == 0 {
        if idx == 0 {
            return 0;
        }
        idx -= 1;
        if days[idx].1 == 0 {
            return 0;
        }
    }
    let mut streak = 1u32;
    let mut expect = prev_day(&days[idx].0);
    while idx > 0 {
        idx -= 1;
        let (date, count) = &days[idx];
        if date != &expect || *count == 0 {
            break;
        }
        streak += 1;
        expect = prev_day(date);
    }
    streak
}

fn lang_short(name: &str) -> String {
    match name {
        "TypeScript" => "TS".into(),
        "JavaScript" => "JS".into(),
        "Python" => "Py".into(),
        "Rust" => "Rust".into(),
        "Go" => "Go".into(),
        "C++" => "C++".into(),
        "C#" => "C#".into(),
        other => {
            if other.len() <= 6 {
                other.into()
            } else {
                format!("{}…", &other[..5])
            }
        }
    }
}

fn lang_color(name: &str, api: Option<&str>) -> String {
    match name {
        "TypeScript" => "var(--lang-ts)".into(),
        "JavaScript" => "var(--lang-js)".into(),
        "Python" => "var(--lang-py)".into(),
        "Rust" => "var(--lang-rs)".into(),
        _ => api
            .filter(|c| !c.is_empty())
            .unwrap_or("#8b9cb3")
            .to_string(),
    }
}

async fn fetch_snapshot(token: &str) -> Result<GithubSnapshotDto, String> {
    let client = reqwest::Client::builder()
        .user_agent("desk-opc/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let body = json!({ "query": GQL });
    let res = client
        .post("https://api.github.com/graphql")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("GitHub HTTP {status}: {text}"));
    }

    let v: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    if let Some(errs) = v.get("errors") {
        return Err(format!("GitHub GraphQL: {errs}"));
    }
    let viewer = v
        .pointer("/data/viewer")
        .ok_or_else(|| "missing viewer".to_string())?;

    let login = viewer
        .get("login")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let name = viewer
        .get("name")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(&login)
        .to_string();
    let bio = viewer
        .get("bio")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let avatar_url = viewer
        .get("avatarUrl")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let cal = viewer
        .pointer("/contributionsCollection/contributionCalendar")
        .ok_or_else(|| "missing contribution calendar".to_string())?;
    let year_total = cal
        .get("totalContributions")
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;

    let mut flat_days: Vec<(String, u32)> = Vec::new();
    let mut weeks_raw: Vec<Vec<u8>> = Vec::new();
    if let Some(weeks) = cal.get("weeks").and_then(|x| x.as_array()) {
        for w in weeks {
            let mut col = Vec::with_capacity(7);
            if let Some(days) = w.get("contributionDays").and_then(|x| x.as_array()) {
                for day in days {
                    let count = day
                        .get("contributionCount")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0) as u32;
                    let level = level_to_u8(
                        day.get("contributionLevel")
                            .and_then(|x| x.as_str())
                            .unwrap_or("NONE"),
                    );
                    let date = day
                        .get("date")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    flat_days.push((date, count));
                    col.push(level);
                }
            }
            while col.len() < 7 {
                col.push(0);
            }
            weeks_raw.push(col);
        }
    }

    let weeks: Vec<Vec<u8>> = if weeks_raw.len() > 40 {
        weeks_raw[weeks_raw.len() - 40..].to_vec()
    } else {
        weeks_raw
    };

    let streak = compute_streak(&flat_days);

    let mut pins = Vec::new();
    if let Some(nodes) = viewer.pointer("/pinnedItems/nodes").and_then(|x| x.as_array()) {
        for n in nodes {
            if n.is_null() {
                continue;
            }
            let repo = n
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("repo")
                .to_string();
            let desc = n
                .get("description")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let stars = n
                .get("stargazerCount")
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let lang_name = n
                .pointer("/primaryLanguage/name")
                .and_then(|x| x.as_str())
                .unwrap_or("—");
            let lang_api = n
                .pointer("/primaryLanguage/color")
                .and_then(|x| x.as_str());
            pins.push(GithubPinDto {
                repo,
                desc,
                lang: lang_color(lang_name, lang_api),
                lang_name: lang_short(lang_name),
                stars: stars.to_string(),
            });
        }
    }

    let mut lang_bytes: std::collections::HashMap<String, (u64, String)> =
        std::collections::HashMap::new();
    if let Some(repos) = viewer.pointer("/repositories/nodes").and_then(|x| x.as_array()) {
        for repo in repos {
            if let Some(edges) = repo.pointer("/languages/edges").and_then(|x| x.as_array()) {
                for e in edges {
                    let size = e.get("size").and_then(|x| x.as_u64()).unwrap_or(0);
                    let name = e
                        .pointer("/node/name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("Other");
                    let color = e
                        .pointer("/node/color")
                        .and_then(|x| x.as_str())
                        .unwrap_or("#8b9cb3");
                    let entry = lang_bytes
                        .entry(name.to_string())
                        .or_insert((0, color.to_string()));
                    entry.0 += size;
                }
            }
        }
    }
    let mut lang_list: Vec<_> = lang_bytes.into_iter().collect();
    lang_list.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    let top: Vec<_> = lang_list.into_iter().take(4).collect();
    let sum: u64 = top.iter().map(|(_, (s, _))| *s).sum::<u64>().max(1);
    let mut langs = Vec::new();
    let mut assigned = 0u32;
    for (i, (name, (size, color))) in top.iter().enumerate() {
        let pct = if i + 1 == top.len() {
            100u32.saturating_sub(assigned)
        } else {
            ((size * 100) / sum) as u32
        };
        assigned = assigned.saturating_add(pct);
        langs.push(GithubLangDto {
            name: lang_short(name),
            pct,
            color: lang_color(name, Some(color)),
        });
    }

    Ok(GithubSnapshotDto {
        login,
        name,
        bio,
        avatar_url,
        streak,
        year_total,
        weeks,
        pins,
        langs,
        cached: false,
        error: None,
    })
}

/// Save personal token to `%LOCALAPPDATA%/desk/github.json`.
#[tauri::command]
pub fn github_set_token(token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("empty token".into());
    }
    let cfg = GithubConfig {
        token: Some(token),
    };
    let p = config_path()?;
    let s = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

/// Fetch live GitHub snapshot; on failure return last cache if any.
#[tauri::command]
pub async fn github_snapshot() -> Result<GithubSnapshotDto, String> {
    let token = match resolve_token() {
        Ok(t) => t,
        Err(e) => {
            if let Some(mut c) = load_cache() {
                c.cached = true;
                c.error = Some(e);
                return Ok(c);
            }
            return Err(e);
        }
    };

    match fetch_snapshot(&token).await {
        Ok(snap) => {
            let _ = save_cache(&snap);
            Ok(snap)
        }
        Err(e) => {
            if let Some(mut c) = load_cache() {
                c.cached = true;
                c.error = Some(e);
                Ok(c)
            } else {
                Err(e)
            }
        }
    }
}
