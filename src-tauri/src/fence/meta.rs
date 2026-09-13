//! fence.json v2 —— 只存偏好（围栏归属 / 排序 / 可见性），**不存文件**。
//! 文件永远住在真桌面上（INV-1）；删掉本文件只丢偏好，不丢文件（INV-4）。

// 本模块是有意建在使用者前面的：类型和函数先按 v2 的最终形态定义好，
// Task 7（index.rs）才开始读 Entry/FenceMeta，Task 9–12 才用到 load/save/prune/rename_key。
// 在那之前，lib 构建会有 10 条 dead_code。
//
// 这是**债**，不是设计 —— 和 Task 2 的 `#![allow(dead_code)]` 同性质，那次在 Task 3
// 接线后已经删掉了。这里同样：Task 12 删完 vault 读源、meta.rs 成为唯一读源时，
// 这行必须回来删掉，让编译器重新盯着它。
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FenceMeta {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
    #[serde(default)]
    pub hide: HideState,
}

fn default_version() -> u32 {
    2
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Entry {
    pub fence: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub mtime: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct HideState {
    #[serde(default)]
    pub owned: bool,
    #[serde(default)]
    pub visible: bool,
}

impl Default for FenceMeta {
    fn default() -> Self {
        Self {
            version: 2,
            entries: BTreeMap::new(),
            hide: HideState::default(),
        }
    }
}

/// `{origin}:{文件名}`。origin ∈ {"user", "public"}。
/// 刻意不用文件系统路径做 key —— 路径会变，文件名 + 来源才是稳定标识。
pub(crate) fn key(origin: &str, file_name: &str) -> String {
    format!("{origin}:{file_name}")
}

pub(crate) fn path() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("fence.json"))
}

pub(crate) fn load() -> Result<FenceMeta, String> {
    let p = path()?;
    if !p.exists() {
        return Ok(FenceMeta::default());
    }
    let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

pub(crate) fn save(m: &FenceMeta) -> Result<(), String> {
    let p = path()?;
    let s = serde_json::to_string_pretty(m).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| e.to_string())
}

/// 清掉磁盘上已不存在的条目。返回清理数量。
pub(crate) fn prune(m: &mut FenceMeta, present: &HashSet<String>) -> usize {
    let before = m.entries.len();
    m.entries.retain(|k, _| present.contains(k));
    before - m.entries.len()
}

/// 文件改名时把条目迁移过去，保留 fence / order。返回是否迁移成功。
pub(crate) fn rename_key(m: &mut FenceMeta, from: &str, to: &str) -> bool {
    match m.entries.remove(from) {
        Some(e) => {
            m.entries.insert(to.to_string(), e);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn meta_with(pairs: &[(&str, &str, u32)]) -> FenceMeta {
        let mut m = FenceMeta::default();
        for (k, f, o) in pairs {
            m.entries.insert(
                k.to_string(),
                Entry {
                    fence: f.to_string(),
                    order: *o,
                    mtime: 0,
                },
            );
        }
        m
    }

    #[test]
    fn key_is_origin_colon_filename() {
        assert_eq!(key("user", "PVZ.lnk"), "user:PVZ.lnk");
        assert_eq!(key("public", "新建文件夹"), "public:新建文件夹");
    }

    #[test]
    fn prune_drops_missing_keeps_present() {
        let mut m = meta_with(&[("user:a.txt", "工作", 0), ("user:b.txt", "工作", 1)]);
        let present: HashSet<String> = ["user:a.txt".to_string()].into_iter().collect();
        assert_eq!(prune(&mut m, &present), 1);
        assert!(m.entries.contains_key("user:a.txt"));
        assert!(!m.entries.contains_key("user:b.txt"));
    }

    #[test]
    fn rename_key_preserves_fence_and_order() {
        let mut m = meta_with(&[("user:old.txt", "游戏", 7)]);
        assert!(rename_key(&mut m, "user:old.txt", "user:new.txt"));
        let e = &m.entries["user:new.txt"];
        assert_eq!(e.fence, "游戏");
        assert_eq!(e.order, 7);
        assert!(!m.entries.contains_key("user:old.txt"));
    }

    #[test]
    fn rename_key_returns_false_when_absent() {
        let mut m = meta_with(&[]);
        assert!(!rename_key(&mut m, "user:ghost", "user:ghost2"));
    }

    #[test]
    fn default_has_version_2() {
        assert_eq!(FenceMeta::default().version, 2);
    }
}
