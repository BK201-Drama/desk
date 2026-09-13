//! fence.json v2 —— 只存偏好（围栏归属 / 排序 / 可见性 / 收起与高度），**不存文件**。
//! 文件永远住在真桌面上（INV-1）；删掉本文件只丢偏好，不丢文件（INV-4）。
//!
//! `version` 停在 2 是**故意的**：它今天没有任何读取者（只有 `default_version()`
//! 和一条钉住它的单测），升号换不到兼容性 —— 桌面只有一个构建。新字段一律
//! `#[serde(default)]`，旧文件读进来就是「没收起、没自定义高度」。

// Task 12 已按约删掉 `#![allow(dead_code)]` —— vault 读源没了，`fence.json` 是唯一
// 读源，这个模块的每个类型/函数都有了确定的使用者（或已被编译器指出来没有）。

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct FenceMeta {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
    #[serde(default)]
    pub hide: HideState,
    #[serde(default)]
    pub ui: UiState,
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

/// 看板自己的显示偏好（2026-09-13）：哪些围栏收起了、每个围栏几行高。
///
/// **为什么和 `entries` 不同、不参与 `prune`**：`entries` 按 `{origin}:{文件名}` 记账，
/// 一条过期条目会在同名文件**再次出现**时静默继承上一次的分类 —— 那是真缺陷，
/// 所以 `fence_list` 每次冷启动都要收一次。这里按**围栏名**记账，过期的键是**惰性**的：
/// 它只在同名围栏再次出现时生效，而那一刻它正是用户想要的东西（用户就是把它收着的）。
/// 于是不收，也不为它多跑一次扫描。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct UiState {
    /// 收起（只留标题条）的围栏名。
    #[serde(default)]
    pub collapsed: BTreeSet<String>,
    /// 自定义行数。**缺键 = 自动**（用 `styles.css` 里那份默认）。
    /// 上界由 `index::ROWS_MAX` 在读取时夹住 —— 前端只发 1..=ROWS_MAX，
    /// 但手改过的 json 也得收敛到一个存在的 CSS 类上。
    #[serde(default)]
    pub rows: BTreeMap<String, u32>,
}

impl Default for FenceMeta {
    fn default() -> Self {
        Self {
            version: 2,
            entries: BTreeMap::new(),
            hide: HideState::default(),
            ui: UiState::default(),
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
///
/// **唯一的调用点是冷启动的 `fence_list`，且必须在「每个桌面根都读成功」时才调。**
/// 入参 `present` 只能来自一次扫描，而扫描有两种失败法：
///
/// - `read_dir` 失败（权限 / 被进程占用 / 网络盘重连）—— Task 13 为此**驳回了**
///   「watcher 上挂 prune」：那时的 `index::scan_root` 读失败会**静默返回空列表**，
///   于是「桌面一时读不到」和「桌面真的空了」长得一样，一次读失败就清空整份偏好。
/// - 只读到一个根 —— 公共桌面读不到时它的项一个都扫不到，同样会误清。
///
/// 现在两条都有解了：`scan_root` 改成 `Result`（失败**说出来**）、
/// `scan_desktop_checked` 多返回一个「每个根都读成功吗」，调用方拿它当闸。
/// 于是这里是「用户主动启动 desk 时的一次权威扫描」，而不是「随时可能读失败的
/// 某一拍」—— 这就是它和 watcher 那条路的区别。
///
/// 单键删除（`fence_delete`）**不用**它：那里「刚删的是谁」是调用方自己拿的 key，
/// 不需要也不该靠一次扫描去反推。`ops.rs` 用 `m.entries.remove(&key)`。
pub(crate) fn prune(m: &mut FenceMeta, present: &HashSet<String>) -> usize {
    let before = m.entries.len();
    m.entries.retain(|k, _| present.contains(k));
    before - m.entries.len()
}

/// 文件改名时把条目迁移过去，保留 fence / order。返回是否迁移成功。
///
/// 调用点是 `ops::fence_rename`，它保证**先调本函数落盘、再 `fs::rename`** ——
/// 反过来的话 watcher 可能先看到改名、把新名字按 `guess_fence` 猜一个围栏推给前端，
/// 而那一帧之后指纹就稳定了，第二拍（只管图标）不会来纠。顺序的理由写在 `ops.rs`。
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

    /// 迁移期的**旧文件**（没有 `ui` 键，Task 15 之前写下的每一份都是这样）
    /// 必须读成「没事发生」。这条是 `#[serde(default)]` 的落点 ——
    /// 漏了它，用户一升级就看板全空（或者直接 `load()` 报错）。
    #[test]
    fn old_json_without_ui_loads_as_default() {
        let old = r#"{
            "version": 2,
            "entries": { "user:a.lnk": { "fence": "游戏", "order": 0, "mtime": 0 } },
            "hide": { "owned": true, "visible": false }
        }"#;
        let m: FenceMeta = serde_json::from_str(old).expect("old json must load");
        assert!(m.ui.collapsed.is_empty());
        assert!(m.ui.rows.is_empty());
        // 旧字段一个都没被这条新字段影响
        assert_eq!(m.entries["user:a.lnk"].fence, "游戏");
        assert!(m.hide.owned);
    }

    /// `ui` 的读写是**往返**的：写出去再读回来必须一模一样。
    /// 它同时钉住 JSON 的形状（两个容器都序列化成 object / array，不是别的）。
    #[test]
    fn ui_state_round_trips() {
        let mut m = FenceMeta::default();
        m.ui.collapsed.insert("游戏".into());
        m.ui.collapsed.insert("工作".into());
        m.ui.rows.insert("工作".into(), 3);

        let s = serde_json::to_string(&m).unwrap();
        let back: FenceMeta = serde_json::from_str(&s).unwrap();

        // BTreeSet / BTreeMap 是有序的：顺序稳定，`fence.json` 的 diff 才读得下去
        assert_eq!(
            back.ui.collapsed.iter().cloned().collect::<Vec<_>>(),
            vec!["工作".to_string(), "游戏".to_string()]
        );
        assert_eq!(back.ui.rows["工作"], 3);
        assert!(!back.ui.rows.contains_key("游戏"));
    }

    /// 串起来的键**不 panic**，只是没记录 = 自动。
    /// （`fence_save_ui` 传 `rows: null` 时走的就是这条路。）
    #[test]
    fn missing_rows_key_means_auto() {
        let m: FenceMeta = serde_json::from_str(r#"{"ui":{"collapsed":["工具"]}}"#).unwrap();
        assert!(m.ui.rows.get("工具").is_none());
        assert!(m.ui.collapsed.contains("工具"));
    }
}
