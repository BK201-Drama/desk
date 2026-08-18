//! Multica strip: counts + recent active issues + open board URL.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MulticaIssueDto {
    pub st: String,
    pub title: String,
    pub who: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MulticaSnapshotDto {
    pub app_url: String,
    pub inbox: u32,
    pub doing: u32,
    pub review: u32,
    pub issues: Vec<MulticaIssueDto>,
    pub runtime_online: bool,
    pub cached: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MulticaConfig {
    server_url: String,
    app_url: String,
    workspace_id: String,
    token: String,
}

fn home_multica_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home dir".to_string())?;
    Ok(home.join(".multica"))
}

fn load_config() -> Result<MulticaConfig, String> {
    let path = home_multica_dir()?.join("config.json");
    let raw = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse multica config: {e}"))
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn cache_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("multica-cache.json"))
}

fn save_cache(snap: &MulticaSnapshotDto) -> Result<(), String> {
    let p = cache_path()?;
    let s = serde_json::to_string_pretty(snap).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

fn load_cache() -> Option<MulticaSnapshotDto> {
    let p = cache_path().ok()?;
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn daemon_online() -> bool {
    let Ok(dir) = home_multica_dir() else {
        return false;
    };
    let pid_path = dir.join("daemon.pid");
    let Ok(pid_raw) = fs::read_to_string(pid_path) else {
        return false;
    };
    let Ok(pid) = pid_raw.trim().parse::<u32>() else {
        return false;
    };
    #[cfg(windows)]
    {
        let output = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(0x08000000)
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                s.contains(&pid.to_string())
            }
            _ => false,
        }
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(format!("/proc/{pid}")).exists()
    }
}

fn map_status(raw: &str) -> Option<&'static str> {
    match raw {
        "inbox" | "backlog" | "todo" => Some("inbox"),
        "in_progress" | "doing" => Some("doing"),
        "in_review" | "review" => Some("review"),
        _ => None,
    }
}

fn who_label(issue: &Value) -> String {
    match issue.get("assignee_type").and_then(|x| x.as_str()) {
        Some("agent") => "agent".into(),
        Some("squad") => "squad".into(),
        Some("member") => "you".into(),
        Some(other) if !other.is_empty() => other.into(),
        _ => "—".into(),
    }
}

fn title_label(issue: &Value) -> String {
    let id = issue
        .get("identifier")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let title = issue.get("title").and_then(|x| x.as_str()).unwrap_or("");
    if id.is_empty() {
        title.to_string()
    } else if title.is_empty() {
        id.to_string()
    } else {
        format!("{id} · {title}")
    }
}

async fn fetch_snapshot(cfg: &MulticaConfig) -> Result<MulticaSnapshotDto, String> {
    let client = reqwest::Client::builder()
        .user_agent("desk-opc/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let base = cfg.server_url.trim_end_matches('/');
    let url = format!(
        "{base}/api/issues?workspace_id={}&limit=200",
        cfg.workspace_id
    );
    let res = client
        .get(&url)
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("Multica HTTP {status}: {text}"));
    }
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    let issues = v
        .get("issues")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    let mut inbox = 0u32;
    let mut doing = 0u32;
    let mut review = 0u32;
    let mut active: Vec<MulticaIssueDto> = Vec::new();

    for issue in &issues {
        let raw = issue
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let Some(st) = map_status(raw) else {
            continue;
        };
        match st {
            "inbox" => inbox += 1,
            "doing" => doing += 1,
            "review" => review += 1,
            _ => {}
        }
        active.push(MulticaIssueDto {
            st: st.to_string(),
            title: title_label(issue),
            who: who_label(issue),
            id: issue
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }

    // Prefer doing → review → inbox for the strip list
    let rank = |st: &str| match st {
        "doing" => 0,
        "review" => 1,
        "inbox" => 2,
        _ => 9,
    };
    active.sort_by(|a, b| rank(&a.st).cmp(&rank(&b.st)));
    active.truncate(3);

    Ok(MulticaSnapshotDto {
        app_url: cfg.app_url.clone(),
        inbox,
        doing,
        review,
        issues: active,
        runtime_online: daemon_online(),
        cached: false,
        error: None,
    })
}

/// Local Multica board URL from `~/.multica/config.json`.
#[tauri::command]
pub fn multica_app_url() -> Result<String, String> {
    let cfg = load_config()?;
    if cfg.app_url.trim().is_empty() {
        return Err("multica config missing app_url".into());
    }
    Ok(cfg.app_url)
}

/// Live Multica strip snapshot; falls back to cache on error.
#[tauri::command]
pub async fn multica_snapshot() -> Result<MulticaSnapshotDto, String> {
    let cfg = match load_config() {
        Ok(c) => c,
        Err(e) => {
            if let Some(mut c) = load_cache() {
                c.cached = true;
                c.error = Some(e);
                return Ok(c);
            }
            return Err(e);
        }
    };

    match fetch_snapshot(&cfg).await {
        Ok(snap) => {
            let _ = save_cache(&snap);
            Ok(snap)
        }
        Err(e) => {
            if let Some(mut c) = load_cache() {
                c.cached = true;
                c.error = Some(e);
                c.runtime_online = daemon_online();
                Ok(c)
            } else {
                Err(e)
            }
        }
    }
}
