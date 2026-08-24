//! Recently launched fence icons — persisted under %LOCALAPPDATA%/desk/recent-launches.json

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const RECENT_MAX: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Store {
    ids: Vec<String>,
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn store_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("recent-launches.json"))
}

fn load_store() -> Result<Store, String> {
    let p = store_path()?;
    if !p.exists() {
        return Ok(Store::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn save_store(store: &Store) -> Result<(), String> {
    let p = store_path()?;
    let s = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

fn normalize_ids(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() || id.starts_with("sys-") {
            continue;
        }
        if out.iter().any(|x| x == &id) {
            continue;
        }
        out.push(id);
        if out.len() >= RECENT_MAX {
            break;
        }
    }
    out
}

#[tauri::command]
pub fn recent_list() -> Result<Vec<String>, String> {
    let store = load_store()?;
    Ok(normalize_ids(store.ids))
}

#[tauri::command]
pub fn recent_push(id: String) -> Result<Vec<String>, String> {
    let id = id.trim().to_string();
    if id.is_empty() || id.starts_with("sys-") {
        return recent_list();
    }
    let mut store = load_store()?;
    store.ids.retain(|x| x != &id);
    store.ids.insert(0, id);
    store.ids = normalize_ids(store.ids);
    save_store(&store)?;
    Ok(store.ids.clone())
}
