//! 桌面目录 → 围栏 DTO。**全程只读**：本模块不移动、不创建、不删除任何文件。
//! 这是与旧 fence_takeover 最本质的区别（INV-1）。

// 和 meta.rs 同性质的一笔债：本模块的消费者是 **Task 10（切换读源）**，
// 在那之前 lib 构建会报 7 条 dead_code（`ScannedItem` / `scan_root` / `build_fences`
// / `fence_of` / `icon_file` / `ensure_icons` / `FENCE_ORDER`）。
//
// **和 meta.rs 的 `#![allow(dead_code)]` 一起，在 Task 12 删。**
// 两处一并删除的理由：Task 10 一接线，「谁还在用」就稳定了，那时才是删的时机；
// 分两次删只会多一次「删早了又要加回来」的机会。
#![allow(dead_code)]

use super::guess_fence;
use super::meta::{key as meta_key, FenceMeta};
use super::{system_shell_items, FenceDto, FenceItemDto};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub(crate) struct ScannedItem {
    pub key: String,
    pub origin: String,
    pub file_name: String,
    pub label: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub mtime: i64,
}

/// 围栏显示顺序。沿用旧实现，改动会让用户的既有布局换位置。
const FENCE_ORDER: [&str; 5] = ["游戏", "工具", "工作", "文件夹", "其它"];

/// 图标文件名：meta key 含 `:`（Windows 文件名非法字符），转义一次。
/// 用可读的文件名而不是哈希 —— 出问题时能一眼看出这个 png 属于谁。
pub(crate) fn icon_file(key: &str) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    match super::icons_dir() {
        Ok(d) => d.join(format!("{safe}.png")),
        Err(_) => PathBuf::new(),
    }
}

/// 枚举一个桌面根目录。纯读操作。跳过 desktop.ini 与 desk 自身的快捷方式。
pub(crate) fn scan_root(origin: &str, root: &Path) -> Vec<ScannedItem> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let file_name = ent.file_name().to_string_lossy().to_string();
        if file_name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        if super::is_self_desk_shortcut(&file_name) {
            continue;
        }
        let path = ent.path();
        let is_dir = path.is_dir();
        let label = if is_dir {
            file_name.clone()
        } else {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone())
        };
        let mtime = ent
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(ScannedItem {
            key: meta_key(origin, &file_name),
            origin: origin.to_string(),
            file_name,
            label,
            path,
            is_dir,
            mtime,
        });
    }
    out
}

/// 归属判定：meta 里有记录就用记录，否则用 guess_fence 兜底。
/// **永远返回一个非空围栏名** —— 任何项都不允许因为"没分类"而从看板上消失。
fn fence_of(it: &ScannedItem, meta: &FenceMeta) -> String {
    if let Some(e) = meta.entries.get(&it.key) {
        if !e.fence.is_empty() {
            return e.fence.clone();
        }
    }
    if it.is_dir {
        return "文件夹".into();
    }
    guess_fence(&it.file_name).to_string()
}

/// 把扫描结果按 meta 偏好分组，末尾追加「系统」围栏。
pub(crate) fn build_fences(items: &[ScannedItem], meta: &FenceMeta) -> Vec<FenceDto> {
    let mut buckets: BTreeMap<String, Vec<(u32, String, FenceItemDto)>> = BTreeMap::new();

    for it in items {
        let name = fence_of(it, meta);
        let order = meta
            .entries
            .get(&it.key)
            .map(|e| e.order)
            .unwrap_or(u32::MAX);
        let icon_path = icon_file(&it.key);
        let icon = if icon_path.as_os_str().is_empty() || !icon_path.exists() {
            None
        } else {
            Some(icon_path.to_string_lossy().to_string())
        };
        buckets.entry(name).or_default().push((
            order,
            it.label.clone(),
            FenceItemDto {
                id: it.key.clone(),
                label: it.label.clone(),
                path: it.path.to_string_lossy().to_string(),
                icon,
            },
        ));
    }

    for v in buckets.values_mut() {
        v.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    }

    let mut fences: Vec<FenceDto> = Vec::new();
    for name in FENCE_ORDER {
        if let Some(v) = buckets.remove(name) {
            if !v.is_empty() {
                fences.push(FenceDto {
                    name: name.to_string(),
                    items: v.into_iter().map(|(_, _, d)| d).collect(),
                });
            }
        }
    }
    for (name, v) in buckets {
        if !v.is_empty() {
            fences.push(FenceDto {
                name,
                items: v.into_iter().map(|(_, _, d)| d).collect(),
            });
        }
    }

    if let Ok(icons) = super::icons_dir() {
        fences.push(FenceDto {
            name: "系统".into(),
            items: system_shell_items(&icons),
        });
    }
    fences
}

/// 为尚无图标缓存的项抽取图标。返回本次抽取数量。
///
/// 旧实现是在 fence_takeover 搬文件时顺手抽的；现在没有 takeover 了，
/// 抽取改为索引的附属步骤 —— 缺什么补什么，天然对迁移后的新 key 自愈。
pub(crate) fn ensure_icons(items: &[ScannedItem]) -> usize {
    let mut n = 0;
    for it in items {
        let dest = icon_file(&it.key);
        if dest.as_os_str().is_empty() || dest.exists() {
            continue;
        }
        if super::extract_icon_png(&it.path, &dest) {
            n += 1;
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fence::meta::{Entry, FenceMeta};

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn scan_skips_desktop_ini() {
        let d = scratch();
        std::fs::write(d.path().join("desktop.ini"), b"").unwrap();
        std::fs::write(d.path().join("a.txt"), b"hi").unwrap();
        let items = scan_root("user", d.path());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].file_name, "a.txt");
    }

    #[test]
    fn scan_label_strips_extension_for_files_keeps_it_for_dirs() {
        let d = scratch();
        std::fs::write(d.path().join("报表.xlsx"), b"").unwrap();
        std::fs::create_dir(d.path().join("项目资料")).unwrap();
        let items = scan_root("user", d.path());
        let by = |n: &str| items.iter().find(|i| i.file_name == n).unwrap();
        assert_eq!(by("报表.xlsx").label, "报表");
        assert!(!by("报表.xlsx").is_dir);
        assert_eq!(by("项目资料").label, "项目资料");
        assert!(by("项目资料").is_dir);
    }

    #[test]
    fn scan_key_carries_origin() {
        let d = scratch();
        std::fs::write(d.path().join("x.lnk"), b"").unwrap();
        let items = scan_root("public", d.path());
        assert_eq!(items[0].key, "public:x.lnk");
    }

    #[test]
    fn build_places_items_into_meta_fences() {
        let d = scratch();
        std::fs::write(d.path().join("PVZ.lnk"), b"").unwrap();
        std::fs::write(d.path().join("未知物.xyz"), b"").unwrap();
        let items = scan_root("user", d.path());

        let mut m = FenceMeta::default();
        m.entries.insert(
            "user:PVZ.lnk".into(),
            Entry {
                fence: "游戏".into(),
                order: 0,
                mtime: 0,
            },
        );

        let fences = build_fences(&items, &m);
        let games = fences.iter().find(|f| f.name == "游戏").unwrap();
        assert_eq!(games.items.len(), 1);
        assert_eq!(games.items[0].label, "PVZ");
        // 未在 meta 里的落到 guess_fence 的默认分类，不能消失
        let total: usize = fences
            .iter()
            .filter(|f| f.name != "系统")
            .map(|f| f.items.len())
            .sum();
        assert_eq!(total, 2);
    }

    #[test]
    fn build_always_appends_system_fence() {
        let fences = build_fences(&[], &FenceMeta::default());
        assert_eq!(fences.last().unwrap().name, "系统");
    }

    /// 真机验证 —— `cargo test real_icons -- --ignored --nocapture` 手动跑。
    ///
    /// **为什么不照计划原文直接扫桌面**：本机 `HideIcons=0x1` 且 desk 已接管，
    /// 两个桌面目录（user / public）里各只剩一个 `desktop.ini`，
    /// 扫出来是 0 项 —— 那个测试会「通过」，但一个图标都没抽，
    /// 等于拿空集证明了「抽取没问题」。**这就是计划 Step 6 原样照抄会踩的坑。**
    ///
    /// 真正的风险集是 vault/ 里那 34 个条目：它们就是迁移后围栏的全部内容，
    /// 「这一步不过，迁移后就是 34 个空白方块」说的是它们，不是空桌面。
    /// 所以这里把 vault/ 当**只读的文件来源**（只取 path，不碰 vault 的语义），
    /// 逐个丢给 `extract_icon_png`，抽到临时目录里 —— 不污染线上图标缓存。
    ///
    /// 注意要连**目录**一起测：34 个条目里 `user-_____-33/` 是目录，不是文件。
    /// 第一版我只测 `is_file()`，33 个全过，看着挺好 —— 而漏掉的那个目录条目
    /// 恰恰是唯一会失败的（目录要另走 SHGetFileInfo，见 extract_icon_png 的注释）。
    #[test]
    #[ignore]
    fn real_icons_extract_from_real_files() {
        // 1) 真桌面（当前为空，如实打印，不假装验过）
        let desktop = crate::fence::desktop_dir().unwrap();
        let items = scan_root("user", &desktop);
        println!("[desktop] {} 项（本机已隐藏图标，预期 0）", items.len());

        // 2) vault：迁移后围栏的全部内容，按只读来源用
        let vault = crate::fence::app_data_dir().unwrap().join("vault");
        let Ok(rd) = std::fs::read_dir(&vault) else {
            println!("[vault] 读不到 {}，跳过", vault.display());
            return;
        };
        let dest_dir = tempfile::tempdir().unwrap();
        let mut total = 0usize;
        let mut dirs = 0usize;
        let mut failed: Vec<String> = Vec::new();
        let mut thin: Vec<String> = Vec::new();
        let mut sizes: Vec<u64> = Vec::new();
        for (i, ent) in rd.flatten().enumerate() {
            let path = ent.path();
            total += 1;
            if path.is_dir() {
                dirs += 1;
            }
            let name = ent.file_name().to_string_lossy().to_string();
            let dest = dest_dir.path().join(format!("{i}.png"));
            if !crate::fence::extract_icon_png(&path, &dest) {
                failed.push(name);
                continue;
            }
            // 返回 true 只说明「写盘成功」，不说明写出来的是真图标。
            // 尺寸是最省的像素代理，阈值**实测标定过**：
            //   用同一套 System.Drawing 编码器生成 64×64 全透明 PNG → **146 B**
            //   本机 34 个真图标 → 最小 406 B / 中位 3929 B（2026-09-13 实测）
            // 取 400 B：离空图 2.7 倍，离最瘦的真图标还留了一点裕度。
            let len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            sizes.push(len);
            if len < 400 {
                thin.push(format!("{name} ({len} B)"));
            }
        }
        sizes.sort_unstable();
        println!(
            "[vault] 共 {total} 个条目（其中目录 {dirs} 个），抽取失败 {} 个",
            failed.len()
        );
        println!(
            "[png] {} 个，最小 {} B / 中位 {} B / 最大 {} B",
            sizes.len(),
            sizes.first().copied().unwrap_or(0),
            sizes.get(sizes.len() / 2).copied().unwrap_or(0),
            sizes.last().copied().unwrap_or(0),
        );
        for f in &failed {
            println!("   抽取失败: {f}");
        }
        for f in &thin {
            println!("   疑似空白: {f}");
        }
        assert_eq!(total, 34, "vault 条目数变了，下面的断言口径要跟着改");
        assert!(failed.is_empty(), "有条目抽不出图标 → 迁移后是空白方块");
        assert!(thin.is_empty(), "png 太小，多半是全透明空图 → 迁移后是空白方块");
    }
}
