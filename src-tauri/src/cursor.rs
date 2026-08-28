//! Cursor 用量：从本机 state.vscdb 读会话 token，再打 Dashboard API。
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct CursorUsage {
    pub ok: bool,
    pub remaining_pct: f64,
    pub used_pct: f64,
    /// Cursor Models（auto / Composer 等）
    pub auto_pct_used: f64,
    /// Other Models（API / named）
    pub api_pct_used: f64,
    pub included_limit_usd: f64,
    pub included_used_usd: f64,
    pub included_remaining_usd: f64,
    pub total_spend_usd: f64,
    pub message: String,
    pub auto_message: String,
    pub api_message: String,
    pub billing_cycle_end_ms: Option<i64>,
    pub hit_limit: bool,
    pub hint: String,
}

fn empty(hint: impl Into<String>) -> CursorUsage {
    CursorUsage {
        ok: false,
        remaining_pct: 0.0,
        used_pct: 0.0,
        auto_pct_used: 0.0,
        api_pct_used: 0.0,
        included_limit_usd: 0.0,
        included_used_usd: 0.0,
        included_remaining_usd: 0.0,
        total_spend_usd: 0.0,
        message: String::new(),
        auto_message: String::new(),
        api_message: String::new(),
        billing_cycle_end_ms: None,
        hit_limit: false,
        hint: hint.into(),
    }
}

fn state_db_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| {
        d.join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb")
    })
}

/// Windows 上 URI/`\\?\` 路径容易炸，统一复制到 temp 再普通打开。
fn read_access_token(db: &Path) -> Result<String, String> {
    let tmp_dir = std::env::temp_dir().join(format!("desk-cursor-{}", std::process::id()));
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("temp dir: {e}"))?;
    let tmp = tmp_dir.join("state.vscdb");

    fs::copy(db, &tmp).map_err(|e| format!("copy state.vscdb: {e}"))?;
    // WAL 模式下尽量带上 sidecar，避免只读到半截
    for suffix in ["-wal", "-shm"] {
        let src = PathBuf::from(format!("{}{suffix}", db.display()));
        if src.exists() {
            let dst = PathBuf::from(format!("{}{suffix}", tmp.display()));
            let _ = fs::copy(&src, &dst);
        }
    }

    let result = (|| -> Result<String, String> {
        let conn = Connection::open(&tmp).map_err(|e| format!("open state.vscdb: {e}"))?;
        let val: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?1",
                ["cursorAuth/accessToken"],
                |row| {
                    row.get::<_, String>(0).or_else(|_| {
                        let b: Vec<u8> = row.get(0)?;
                        Ok(String::from_utf8_lossy(&b).into_owned())
                    })
                },
            )
            .map_err(|_| "未找到 cursorAuth/accessToken（请先登录 Cursor）".to_string())?;
        let s = val.trim().trim_matches('"').to_string();
        if s.is_empty() {
            return Err("accessToken 为空".into());
        }
        Ok(s)
    })();

    let _ = fs::remove_dir_all(&tmp_dir);
    result
}

fn cents_to_usd(v: &Value) -> f64 {
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .unwrap_or(0.0)
        / 100.0
}

fn parse_ms(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    v.as_str()?.parse().ok()
}

fn map_usage(v: Value) -> CursorUsage {
    let plan = v.get("planUsage").cloned().unwrap_or(Value::Null);
    let used_pct = plan
        .get("totalPercentUsed")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0)
        .clamp(0.0, 999.0);
    let auto_pct = plan
        .get("autoPercentUsed")
        .and_then(|x| x.as_f64())
        .unwrap_or(used_pct)
        .clamp(0.0, 999.0);
    let api_pct = plan
        .get("apiPercentUsed")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0)
        .clamp(0.0, 999.0);
    let remaining_pct = (100.0 - used_pct).clamp(0.0, 100.0);
    let limit_usd = cents_to_usd(plan.get("limit").unwrap_or(&Value::Null));
    let included_used = cents_to_usd(plan.get("includedSpend").unwrap_or(&Value::Null));
    let total_spend = cents_to_usd(plan.get("totalSpend").unwrap_or(&Value::Null));
    let included_remaining = (limit_usd - included_used).max(0.0);
    let auto_message = v
        .get("autoModelSelectedDisplayMessage")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let api_message = v
        .get("namedModelSelectedDisplayMessage")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let msg = if !auto_message.is_empty() {
        auto_message.clone()
    } else {
        v.get("displayMessage")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let hit = v
        .get("displayMessage")
        .and_then(|x| x.as_str())
        .map(|s| s.to_ascii_lowercase().contains("limit"))
        .unwrap_or(false)
        || used_pct >= 100.0
        || auto_pct >= 100.0
        || included_remaining <= 0.0 && limit_usd > 0.0;

    CursorUsage {
        ok: true,
        remaining_pct,
        used_pct,
        auto_pct_used: auto_pct,
        api_pct_used: api_pct,
        included_limit_usd: limit_usd,
        included_used_usd: included_used,
        included_remaining_usd: included_remaining,
        total_spend_usd: total_spend,
        message: msg,
        auto_message,
        api_message,
        billing_cycle_end_ms: parse_ms(v.get("billingCycleEnd").unwrap_or(&Value::Null)),
        hit_limit: hit,
        hint: String::new(),
    }
}

#[tauri::command]
pub async fn cursor_usage() -> Result<CursorUsage, String> {
    let db = state_db_path().ok_or_else(|| "找不到 Cursor 配置目录".to_string())?;
    if !db.exists() {
        return Ok(empty("未检测到 Cursor（缺 state.vscdb）"));
    }
    let token = match read_access_token(&db) {
        Ok(t) => t,
        Err(e) => return Ok(empty(e)),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("desk-cursor-capsule/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body("{}")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(empty("Cursor 登录已过期，请在 IDE 重新登录"));
    }
    if !status.is_success() {
        return Ok(empty(format!("Cursor API {status}")));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(map_usage(v))
}
