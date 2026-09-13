//! 桌面目录 → 围栏 DTO。**全程只读**：不移动、不创建、不删除任何文件（INV-1）。

use super::classify::guess_fence;
use super::meta::{key as meta_key, FenceMeta};
use super::{system_shell_items, FenceDto, FenceItemDto};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone)]
pub(crate) struct ScannedItem {
    /// `{origin}:{文件名}` —— 既是 `fence.json` 的 entry key，也是看板上的 item id；
    /// 要判断一个项属于哪个桌面根，看 key 的前缀即可。
    pub key: String,
    pub file_name: String,
    pub label: String,
    pub path: PathBuf,
    pub is_dir: bool,
    /// 抽取图标那一刻的文件时间。设计 §「icons」要求「`mtime` 不一致则重抽」，但**这条还没接线**
    /// （`ensure_icons` 只看 png 在不在），所以暂时没有读者 —— 删了就得从 git 里捞回来。
    #[allow(dead_code)]
    pub mtime: i64,
}

/// 围栏显示顺序。改动会让用户的既有布局换位置。
const FENCE_ORDER: [&str; 5] = ["游戏", "工具", "工作", "文件夹", "其它"];

/// 自定义高度的上界（行）。前端的行数是**类名**（`.fence-grid.rows-N`），放出界就会指向一个
/// 不存在的类。这里在**读取时**夹住，手改过的 `fence.json` 也收敛得回来。
///
/// 这个数在三处各写一遍（这里 / `model.ts` / `panel.css`），抄错不报错、只默默画歪 ——
/// 一致性由 `rows_max_matches_frontend` 钉住，改一处就得三处一起改。
pub(crate) const ROWS_MAX: u32 = 5;

/// 一个围栏在 `ui` 里的显示偏好。读时就地收敛：`rows` 超界夹到 `ROWS_MAX`，0 与缺键同义。
fn ui_of(name: &str, meta: &FenceMeta) -> (bool, u32) {
    (
        meta.ui.collapsed.contains(name),
        meta.ui.rows.get(name).copied().unwrap_or(0).min(ROWS_MAX),
    )
}

/// 图标文件名：meta key 含 `:` 等 Windows 非法字符，转义一次。
/// 用可读名而不是哈希 —— 出问题时能一眼看出这个 png 属于谁。
pub(crate) fn icon_file(key: &str) -> PathBuf {
    let safe: String = key
        .chars()
        .map(|c| match c {
            ':' | '\\' | '/' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    match super::paths::icons_dir() {
        Ok(d) => d.join(format!("{safe}.png")),
        Err(_) => PathBuf::new(),
    }
}

/// 枚举一个桌面根目录。纯读。跳过 desktop.ini 与 desk 自身的快捷方式。
///
/// ⚠️ **读不到根目录是 `Err`，不是空列表** —— 「一时读不到」和「本来就是空的」在调用方眼里
/// 不能长得一样，否则一次读失败会被当成「这些 key 真的没了」，清掉整栏分类偏好
/// 且**不会自己回来**。调用方能区分了，`scan_desktop_checked` 才有条件说「没扫到的 key 是真的没了」。
///
/// 条目级的读失败（`rd.flatten()` 丢掉的）依然静默跳过：一个坏项不该让整次扫描失败。
pub(crate) fn scan_root(origin: &str, root: &Path) -> Result<Vec<ScannedItem>, String> {
    let rd = std::fs::read_dir(root)
        .map_err(|e| format!("读不到桌面目录 {}：{e}", root.display()))?;
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let file_name = ent.file_name().to_string_lossy().to_string();
        if file_name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        if super::classify::is_self_desk_shortcut(&file_name) {
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
            file_name,
            label,
            path,
            is_dir,
            mtime,
        });
    }
    Ok(out)
}

/// 归属判定：meta 里有记录就用记录，否则用 guess_fence 兜底。
/// **永远返回非空围栏名** —— 任何项都不允许因为「没分类」而从看板上消失。
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
                is_dir: it.is_dir,
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
                let (collapsed, rows) = ui_of(name, meta);
                fences.push(FenceDto {
                    name: name.to_string(),
                    items: v.into_iter().map(|(_, _, d)| d).collect(),
                    collapsed,
                    rows,
                });
            }
        }
    }
    for (name, v) in buckets {
        if !v.is_empty() {
            let (collapsed, rows) = ui_of(&name, meta);
            fences.push(FenceDto {
                name,
                items: v.into_iter().map(|(_, _, d)| d).collect(),
                collapsed,
                rows,
            });
        }
    }

    if let Ok(icons) = super::paths::icons_dir() {
        let (collapsed, rows) = ui_of("系统", meta);
        fences.push(FenceDto {
            name: "系统".into(),
            items: system_shell_items(&icons),
            collapsed,
            rows,
        });
    }
    fences
}

/// 为尚无图标缓存的项抽取图标。返回本次抽取数量。缺什么补什么，文件换了位置也能自愈。
pub(crate) fn ensure_icons(items: &[ScannedItem]) -> usize {
    let mut n = 0;
    for it in items {
        let dest = icon_file(&it.key);
        if dest.as_os_str().is_empty() || dest.exists() {
            continue;
        }
        if super::shell_icons::extract_icon_png(&it.path, &dest) {
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
        let items = scan_root("user", d.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].file_name, "a.txt");
    }

    #[test]
    fn scan_label_strips_extension_for_files_keeps_it_for_dirs() {
        let d = scratch();
        std::fs::write(d.path().join("报表.xlsx"), b"").unwrap();
        std::fs::create_dir(d.path().join("项目资料")).unwrap();
        let items = scan_root("user", d.path()).unwrap();
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
        let items = scan_root("public", d.path()).unwrap();
        assert_eq!(items[0].key, "public:x.lnk");
    }

    #[test]
    fn build_places_items_into_meta_fences() {
        let d = scratch();
        std::fs::write(d.path().join("PVZ.lnk"), b"").unwrap();
        std::fs::write(d.path().join("未知物.xyz"), b"").unwrap();
        let items = scan_root("user", d.path()).unwrap();

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

    /// `ui` 是**按围栏名**发下去的：收了「游戏」不该顺手把「工具」也收掉。
    /// 顺带钉住默认值 —— 没有任何 ui 记录时每一栏都是 `collapsed: false, rows: 0`。
    #[test]
    fn build_reads_collapsed_and_rows_per_fence() {
        let d = scratch();
        std::fs::write(d.path().join("PVZ.lnk"), b"").unwrap();
        std::fs::write(d.path().join("Cursor.lnk"), b"").unwrap();
        let items = scan_root("user", d.path()).unwrap();

        let mut m = FenceMeta::default();
        m.entries.insert(
            "user:PVZ.lnk".into(),
            Entry {
                fence: "游戏".into(),
                order: 0,
                mtime: 0,
            },
        );
        m.entries.insert(
            "user:Cursor.lnk".into(),
            Entry {
                fence: "工具".into(),
                order: 0,
                mtime: 0,
            },
        );
        m.ui.collapsed.insert("游戏".into());
        m.ui.rows.insert("工具".into(), 3);
        // 手改过的 json 可能留下越界行数：读取时就夹住，别指到不存在的 CSS 类
        m.ui.rows.insert("系统".into(), 99);

        let fences = build_fences(&items, &m);
        let by = |n: &str| fences.iter().find(|f| f.name == n).unwrap();

        assert!(by("游戏").collapsed);
        assert_eq!(by("游戏").rows, 0, "只收了，没设高度");
        assert!(!by("工具").collapsed, "收的是游戏，不是工具");
        assert_eq!(by("工具").rows, 3);
        assert_eq!(by("系统").rows, ROWS_MAX, "越界行数在读取时被夹住");
    }

    /// 把 `.rows-N { --fence-rows: N }` 解析成 `(N, N)`。CSS 里这些规则各占一行；
    /// 若将来有人把类名和变量拆到两行，这里给 `None`，上层**报错而不是静默放过**。
    fn rows_rule(line: &str) -> Option<(u32, u32)> {
        let digits = |s: &str| -> Option<u32> {
            s.trim_start()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .ok()
        };
        Some((
            digits(line.split(".rows-").nth(1)?)?,
            digits(line.split("--fence-rows:").nth(1)?)?,
        ))
    }

    /// `ROWS_MAX` 在三个地方各写一遍：这里（读取时夹住）、`model.ts`（生成菜单项）、
    /// `panel.css`（`.rows-N` 类）。漂移的症状是**静默的** —— 菜单多出一项，点下去产出一个
    /// 不存在的类名，高度悄悄回落默认值，`tsc` 与全部测试都不响。
    ///
    /// CSS 是**约束源**（`.rows-N` 才真正决定画几行），所以先钉它：必须正好覆盖 `1..=ROWS_MAX`。
    #[test]
    fn rows_max_matches_frontend() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let read = |p: &str| {
            std::fs::read_to_string(root.join(p)).unwrap_or_else(|e| panic!("读不到 {p}：{e}"))
        };
        let css = read("src/plugins/fence/panel.css");
        let ts = read("src/plugins/fence/model.ts");

        let rules: Vec<(u32, u32)> = css
            .lines()
            .filter(|l| l.contains(".rows-") && l.contains("--fence-rows:"))
            .map(|l| rows_rule(l).unwrap_or_else(|| panic!("这行像 `.rows-N` 规则却解析不出：{l}")))
            .collect();

        let mut got: Vec<u32> = rules.iter().map(|(n, _)| *n).collect();
        got.sort_unstable();
        assert_eq!(
            got,
            (1..=ROWS_MAX).collect::<Vec<u32>>(),
            "panel.css 的 `.rows-N` 必须正好覆盖 1..={ROWS_MAX}"
        );

        for (n, m) in &rules {
            assert_eq!(
                n, m,
                "`.rows-{n}` 把 `--fence-rows` 设成了 {m} —— 类名与高度不同号，比整个类缺失更难查"
            );
        }

        // ⚠️ 必须卡词法边界：单纯 `starts_with("export const ROWS_MAX")` 会让
        // `ROWS_MAX_X` 也命中，于是「改名」被当成「没改名」，测试静默通过。
        let line = ts
            .lines()
            .find(|l| {
                l.trim_start()
                    .strip_prefix("export const ROWS_MAX")
                    .is_some_and(|rest| {
                        !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_')
                    })
            })
            .unwrap_or_else(|| {
                panic!("model.ts 里找不到 `export const ROWS_MAX` —— 改了名就得同步改这条测试")
            });
        let ts_max: u32 = line
            .split('=')
            .nth(1)
            .and_then(|s| s.trim().trim_end_matches(';').trim().parse().ok())
            .unwrap_or_else(|| panic!("model.ts 的 ROWS_MAX 解析不出数字：{line}"));
        assert_eq!(
            ts_max, ROWS_MAX,
            "model.ts 的 ROWS_MAX 与本文件的 ROWS_MAX 不一致"
        );
    }

    /// 真机验证 —— `cargo test real_icons -- --ignored --nocapture` 手动跑。
    /// 抽取结果写到临时目录，不污染线上图标缓存。
    /// ⚠️ 必须连**目录**一起测：目录另走 `SHGetFileInfo`（见 `extract_icon_png`），
    /// 只测 `is_file()` 会漏掉唯一那类会失败项。
    #[test]
    #[ignore]
    fn real_icons_extract_from_real_files() {
        // 用 `desktop_roots()` 而不是 `desktop_dir()`：只盯一个根可能一个文件都扫不到。
        let mut targets: Vec<(String, PathBuf)> = Vec::new();
        for (origin, root) in crate::fence::paths::desktop_roots().unwrap() {
            for it in scan_root(&origin, &root).unwrap_or_default() {
                targets.push((it.label, it.path));
            }
        }
        println!("[desktop] 共 {} 项", targets.len());

        let dest_dir = tempfile::tempdir().unwrap();
        let mut dirs = 0usize;
        let mut failed: Vec<String> = Vec::new();
        let mut thin: Vec<String> = Vec::new();
        let mut sizes: Vec<u64> = Vec::new();
        for (i, (name, path)) in targets.iter().enumerate() {
            if path.is_dir() {
                dirs += 1;
            }
            let dest = dest_dir.path().join(format!("{i}.png"));
            if !crate::fence::shell_icons::extract_icon_png(path, &dest) {
                failed.push(name.clone());
                continue;
            }
            // 返回 true 只说明「写盘成功」，不说明写出来的是真图标。尺寸是最省的像素代理，
            // 阈值实测标定过：同一套编码器生成的全透明 64×64 PNG = 146 B，真图标最小 406 B —— 取 400 B。
            let len = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
            sizes.push(len);
            if len < 400 {
                thin.push(format!("{name} ({len} B)"));
            }
        }
        sizes.sort_unstable();
        println!(
            "[desktop] 其中目录 {dirs} 个，抽取失败 {} 个",
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
        // ── 非 ASCII 名的覆盖率 ─────────────────────────────────────────────
        // 「中文路径抽不出图标」这条分支曾因抽取源是纯 ASCII 的 vault 名而**从没被走到过**，
        // 所以现在把它数出来喊一声。**不做成 assert**：用户桌面上可能本来就没有中文名，
        // 断言会变成假失败 —— 那不是「代码坏了」，是「这台机器上验不了这个分支」。
        let non_ascii: Vec<&String> = targets
            .iter()
            .map(|(n, _)| n)
            .filter(|n| !n.is_ascii())
            .collect();
        if non_ascii.is_empty() {
            println!(
                "⚠️ 本次没有覆盖任何非 ASCII 名 —— 「中文路径抽不出图标」那个分支没被验到。\
                 要验它，往桌面放一个中文名的东西再跑这条。"
            );
        } else {
            println!("[non-ascii] {} 个：{:?}", non_ascii.len(), non_ascii);
        }
        // 刻意**不硬编码项数**：桌面是活的，硬编码会变成假失败。要守的是**空集不能算通过**。
        assert!(
            !targets.is_empty(),
            "真桌面上一个项都没扫到 —— 这条测试会「通过」，但它什么都没验"
        );
        assert!(failed.is_empty(), "有条目抽不出图标 → 看板上是空白方块");
        assert!(thin.is_empty(), "png 太小，多半是全透明空图 → 看板上是空白方块");
    }
}
