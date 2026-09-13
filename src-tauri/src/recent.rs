//! Recently launched fence icons — persisted under %LOCALAPPDATA%/desk/recent-launches.json
//!
//! 存储格式（`recent-launches.json` 里的 id 长什么样）**只有本模块和
//! `fence::migrate` 知道**。前端不碰格式，只拿 id 去围栏里查条目
//! （`src/plugins/fence/recent/index.ts`）。

// 本模块是有意建在使用者前面的：remap / remap_ids 是给 fence::migrate 准备的
// （图标 id 从 `user-PVZ-3` 改成 `user:PVZ.lnk` 时要就地改写磁盘上的列表）。
// Task 9 起 `migrate::run()` 已经在调 `remap_ids`，Task 10 把 `run()` 接到了
// `fence_restore` 上 —— 生产者接到了消费者，这行 `#![allow(dead_code)]` 也随之删掉：
// 让编译器重新盯着本模块剩下的东西。

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

/// 把一组 id 按映射表翻译一遍。纯函数，便于测试。
/// 未命中映射的 id 原样保留；翻译后重复的只留首次出现。
pub fn remap(ids: Vec<String>, map: &std::collections::HashMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        let next = map.get(&id).cloned().unwrap_or(id);
        if !out.contains(&next) {
            out.push(next);
        }
    }
    out
}

/// 图标 id 格式变更后（`user-PVZ-3` → `user:PVZ.lnk`）就地改写最近列表。
/// 由 fence::migrate 在迁移时调用一次 —— 它是 recent 存储格式的唯一外部知情者。
pub fn remap_ids(map: &std::collections::HashMap<String, String>) -> Result<(), String> {
    if map.is_empty() {
        return Ok(());
    }
    let mut store = load_store()?;
    store.ids = remap(store.ids, map);
    save_store(&store)
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

#[cfg(test)]
mod tests {
    use super::remap;
    use std::collections::HashMap;

    #[test]
    fn remap_translates_known_ids() {
        let map: HashMap<String, String> = [("user-PVZ-3".to_string(), "user:PVZ.lnk".to_string())]
            .into_iter()
            .collect();
        assert_eq!(remap(vec!["user-PVZ-3".into()], &map), vec!["user:PVZ.lnk"]);
    }

    #[test]
    fn remap_keeps_unknown_ids_untouched() {
        let map: HashMap<String, String> = HashMap::new();
        assert_eq!(remap(vec!["user-x-1".into()], &map), vec!["user-x-1"]);
    }

    #[test]
    fn remap_preserves_order_and_dedupes() {
        let map: HashMap<String, String> = [
            ("a".to_string(), "z".to_string()),
            ("b".to_string(), "z".to_string()),
        ]
        .into_iter()
        .collect();
        // a 和 b 都映射到 z → 去重，保留首次出现的顺序
        assert_eq!(remap(vec!["a".into(), "b".into()], &map), vec!["z"]);
    }
}
