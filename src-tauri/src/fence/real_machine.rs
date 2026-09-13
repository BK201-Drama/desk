//! 真机验收：不开 `tauri dev`，直接调生产函数读**真实**的桌面与 `fence.json`。
//!
//! 跑法：`cargo test -- --ignored real_machine`
//!
//! ⚠️ **全部 `#[ignore]`** —— 默认 `cargo test` 一条都不跑，它们碰真桌面、跑一次就改一次真实世界。
//! 其中 `real_machine_migrate_vault_to_desktop` **不可逆**，必须**单独**跑
//! （`cargo test -- --ignored real_machine_migrate`）—— 它搬真实文件，与别的真机测试并行会互相打架。

use super::*;
// `use super::*` 够不着下面这两个 —— 路径搬去了 `paths`，它不再从 `mod` 根上转出。
use super::paths::{desktop_dir, desktop_roots};
use std::path::PathBuf;

/// 探针文件：`Drop` 时删掉 —— 断言失败 / panic 也不会在真桌面上留垃圾。
struct Probe {
    path: PathBuf,
}

impl Probe {
    fn new() -> Probe {
        let (_origin, root) = desktop_roots().expect("desktop roots")[0].clone();
        let path = root.join("__desk_task10_probe__.txt");
        std::fs::write(&path, b"desk index probe").expect("write probe");
        Probe { path }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn all_items() -> Vec<FenceItemDto> {
    collect_fences()
        .expect("collect_fences")
        .into_iter()
        .flat_map(|f| f.items)
        .collect()
}

#[test]
#[ignore = "真机：读真实桌面"]
fn real_machine_desktop_file_is_indexed_left_in_place_and_gone_after_delete() {
    // 一条测试走完整个生命周期 —— 拆两条的话两个 test 线程会同时往桌面写同名探针，计数互相打架。
    let probe = Probe::new();
    let desktop = probe.path.parent().unwrap().to_path_buf();
    let before = std::fs::read_dir(&desktop).unwrap().count();

    let items = all_items();
    let found = items
        .iter()
        .find(|i| Path::new(&i.path) == probe.path)
        .unwrap_or_else(|| {
            panic!(
                "桌面上的探针没进围栏（共 {} 项，没一项对上 {}）",
                items.len(),
                probe.path.display()
            )
        });

    assert_eq!(found.label, "__desk_task10_probe__");
    // 它**还在桌面上** —— 读源是只读索引，不搬文件
    assert!(probe.path.exists(), "图标被搬走了");
    assert_eq!(
        before,
        std::fs::read_dir(&desktop).unwrap().count(),
        "collect_fences 改动了桌面目录"
    );

    // 删掉文件 → 下一次读就不再出现：读源是实时的，不是缓存
    let path = probe.path.clone();
    drop(probe);
    assert!(!path.exists());
    assert!(
        !all_items().iter().any(|i| Path::new(&i.path) == path),
        "文件都删了还留在看板上 —— 读源不是实时的"
    );
}

/// 迁移**之后**的稳态：看板上一个 vault 项都不该再有（vault 层已不在读路径上）。
#[test]
#[ignore = "真机：读真实桌面"]
fn real_machine_no_item_comes_from_vault() {
    // 路径手工拼，**刻意不调 `migrate::vault_dir()`** —— 那个函数带 `create_dir_all`，
    // 在一条只读验收里凭空造出一个空 vault 目录就本末倒置了。
    let vault = desk_file("vault");
    let listing = |d: &PathBuf| -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    };
    let before = listing(&vault);

    let items = all_items();
    let from_vault: Vec<&String> = items
        .iter()
        .filter(|i| Path::new(&i.path).parent() == Some(vault.as_path()))
        .map(|i| &i.id)
        .collect();

    assert_eq!(before, listing(&vault), "collect_fences 动了 vault 目录");
    eprintln!("围栏共 {} 项，其中 vault 来的 {} 项", items.len(), from_vault.len());
    assert!(
        from_vault.is_empty(),
        "迁移（Task 11）之后读源只剩桌面，这些项却还从 vault 来：{from_vault:?}"
    );
    // 迁移完 vault 层就该整个空掉/不存在 —— 有东西 = 有旧构建在往回吸。
    assert!(
        before.is_empty(),
        "vault 目录里还有 {} 项，迁移之后它应该永远是空的：{before:?}",
        before.len()
    );
}

/// `%LOCALAPPDATA%\desk` 下的两个文件路径，测试直接读盘核对（不经过 recent:: 的私有类型）。
fn desk_file(name: &str) -> PathBuf {
    dirs::data_local_dir()
        .expect("local app data")
        .join("desk")
        .join(name)
}

fn count_entries(d: &Path) -> usize {
    std::fs::read_dir(d).map(|it| it.flatten().count()).unwrap_or(0)
}

/// 另一个桌面根。迁移时公共桌面不可写会退回用户桌面，key 里的 origin 也就跟着变。
fn other_origin(origin: &str) -> &'static str {
    if origin == "public" {
        "user"
    } else {
        "public"
    }
}

/// 逐项核对：迁移前在哪个围栏，迁移后还在哪个围栏。`expected` 是
/// `(迁移前 origin, 原文件名, 迁移前围栏)`。**只读**，首次跑与事后重跑共用同一份断言。
fn check_each_item_kept_its_fence(
    fences: &[FenceDto],
    m: &meta::FenceMeta,
    expected: &[(String, String, String)],
) {
    let where_is: std::collections::HashMap<&str, &str> = fences
        .iter()
        .flat_map(|f| f.items.iter().map(move |it| (it.id.as_str(), f.name.as_str())))
        .collect();

    for (origin, name, fence) in expected {
        // 落点在哪个桌面根上代码可能改主意（公共桌面不可写时退回用户桌面），两个 origin 都试。
        //
        // ⚠️ key 必须从**看板**里挑，不能从迁移账本里挑 —— 账本把 key 写错时两边会"自洽"地
        // 一起错、断言照样通过；真机迁移就这么放过去过一条（星云.lnk）。
        let want = meta::key(origin, name);
        let k = [want.clone(), meta::key(other_origin(origin), name)]
            .into_iter()
            .find(|k| where_is.contains_key(k.as_str()))
            .unwrap_or_else(|| {
                panic!(
                    "{name} 不在看板里 —— 迁移后这个图标看不见了\
                     （围栏账本里记的是 {origin} 一侧的 key：{:?}）",
                    m.entries
                        .keys()
                        .filter(|x| x.as_str().ends_with(name.as_str()))
                        .collect::<Vec<_>>()
                )
            });
        if k != want {
            eprintln!("注意：{name} 的落点换了桌面根（期望 {want}，实际 {k}），围栏不变");
        }
        assert_eq!(
            m.entries.get(&k).map(|e| e.fence.as_str()),
            Some(fence.as_str()),
            "fence.json 里 {k} 的围栏归属和迁移前不一致"
        );
        assert_eq!(
            where_is.get(k.as_str()).copied(),
            Some(fence.as_str()),
            "{k} 没落在「{fence}」围栏里（看板这一侧）"
        );
    }
}

/// 看板上的每一项（系统项除外）都得在 `fence.json` 里有账 —— 孤儿 id = 丢了围栏偏好，
/// 只能靠 `guess_fence` 碰运气（正是「public 项退回用户桌面、账本却记 public:」那个 bug 的形状）。
fn check_no_orphan_ids(fences: &[FenceDto], m: &meta::FenceMeta) {
    let orphans: Vec<&str> = fences
        .iter()
        .flat_map(|f| f.items.iter())
        .map(|it| it.id.as_str())
        .filter(|id| !id.starts_with(SYS_ID_PREFIX) && !m.entries.contains_key(*id))
        .collect();
    assert!(
        orphans.is_empty(),
        "这些项在 fence.json 里没有账，围栏偏好已丢：{orphans:?}"
    );
}

/// 「最近」那一行不该指向已经不存在的条目。这里只能查**单向**（id 在 fence.json 里有账）——
/// 「旧 id 已被改写」那条更强的断言只在首次跑的路径上做（那里才有 `id_map`）。
fn check_recent_ids_are_backed(m: &meta::FenceMeta) {
    for id in recent_file_ids() {
        if id.starts_with(SYS_ID_PREFIX) {
            continue;
        }
        assert!(
            m.entries.contains_key(&id),
            "最近列表里的 {id} 在 fence.json 里没有账 —— 这一行指向一条不存在的条目"
        );
    }
}

/// 两个桌面根上的**真项**数：排除 `desktop.ini`（系统自己放的，不算图标）。
fn desktop_item_count() -> usize {
    desktop_roots()
        .expect("desktop roots")
        .iter()
        .map(|(_, root)| {
            std::fs::read_dir(root)
                .map(|it| {
                    it.flatten()
                        .filter(|e| {
                            e.file_name() != std::ffi::OsStr::new("desktop.ini")
                        })
                        .count()
                })
                .unwrap_or(0)
        })
        .sum()
}

/// `recent-launches.json` 里的 id 列表。**故意直接读文件、不调 `recent_list()`** ——
/// 要验的是磁盘上到底存了什么，`recent_list()` 会顺手 normalize，把问题洗掉。
fn recent_file_ids() -> Vec<String> {
    let p = desk_file("recent-launches.json");
    if !p.exists() {
        return Vec::new();
    }
    let s = std::fs::read_to_string(&p).expect("read recent");
    let v: serde_json::Value = serde_json::from_str(&s).expect("parse recent");
    v.get("ids")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 真机迁移。**本仓库唯一会动真实数据的测试** —— 走的是 `migrate::run()`，和工具栏
/// 「还原到系统桌面」按钮点下去是**同一个生产入口**，区别只是验收由机器做。
/// **不可逆**，单独跑：`cargo test -- --ignored real_machine_migrate --nocapture`
#[test]
#[ignore = "真机：不可逆，把 vault 里的文件搬回真桌面"]
fn real_machine_migrate_vault_to_desktop() {
    let vault = migrate::vault_dir().expect("vault dir");
    let meta_p = migrate::meta_path().expect("meta path");

    // 快照只能在 run() 之前取 —— 跑完 vault.json 就改名了，真相只剩这份内存里的。
    let before = migrate::load_meta().expect("vault meta").items;

    if before.is_empty() {
        // 幂等分支：上一次已经迁完。**不重跑**（`run()` 本来也是空操作），但验收一条不少 ——
        // 归档账本 `vault.json.migrated` 还在盘上，逐项 (origin, 文件名, 围栏) 都能从它读回来。
        // v2 的生产路径上再没有 vault.json 的写者，所以这里直接收紧成：文件不该存在。
        assert!(
            !meta_p.exists(),
            "{} 又出现了 —— 已经归档的旧账本被重新创建，v2 不该再有它的写者：{}",
            meta_p.display(),
            std::fs::read_to_string(&meta_p).unwrap_or_else(|e| format!("<读不到：{e}>"))
        );
        let archived = meta_p.with_extension("json.migrated");
        assert!(
            archived.exists(),
            "vault.json 不在、归档的 vault.json.migrated 也不在 —— 旧账本两边都没了"
        );
        assert_eq!(count_entries(&vault), 0, "vault 目录里还有残留");

        let s = std::fs::read_to_string(&archived).expect("读归档账本");
        let old: migrate::VaultMeta =
            serde_json::from_str(&s).expect("解析 vault.json.migrated（归档的是原始 JSON）");
        let expected: Vec<(String, String, String)> = old
            .items
            .iter()
            .map(|e| (e.origin.clone(), e.original_name.clone(), e.fence.clone()))
            .collect();
        assert_eq!(
            expected.len(),
            34,
            "归档账本里应有 34 项 —— 少了说明归档的不是迁移前那份"
        );

        let fences = collect_fences().expect("collect_fences");
        let m = meta::load().expect("fence.json");
        check_each_item_kept_its_fence(&fences, &m, &expected);
        check_no_orphan_ids(&fences, &m);
        check_recent_ids_are_backed(&m);

        let total: usize = fences.iter().map(|f| f.items.len()).sum();
        eprintln!(
            "迁移此前已完成（vault.json 已归档）；幂等复核**逐项**通过：\
             看板 {total} 项、fence.json {} 条、34 项归属与归档账本一致",
            m.entries.len()
        );
        return;
    }

    let recent_before = recent_file_ids();
    let desktop_before = desktop_item_count();
    let expected: Vec<(String, String, String)> = before
        .iter()
        .map(|e| (e.origin.clone(), e.original_name.clone(), e.fence.clone()))
        .collect();

    let r = migrate::run().expect("migrate::run");
    eprintln!(
        "migrate: moved={} skipped={} failed={} id_map={}",
        r.moved,
        r.skipped,
        r.failed.len(),
        r.id_map.len()
    );

    assert!(r.failed.is_empty(), "有迁移失败的项：{:?}", r.failed);
    assert_eq!(r.moved, expected.len(), "搬走的数量和 vault 里的项数对不上");
    assert_eq!(r.skipped, 0, "全新迁移不该有 skipped（重跑才会出现）");

    // 「一个图标都不会消失」的可测形式：桌面只多出搬走的那批，vault 清零
    assert_eq!(
        desktop_item_count(),
        desktop_before + expected.len(),
        "桌面上的项数对不上：应该只多出 {} 项",
        expected.len()
    );
    assert_eq!(count_entries(&vault), 0, "vault 目录里还有残留");

    assert!(!meta_p.exists(), "vault.json 应该已经改名");
    assert!(
        meta_p.with_extension("json.migrated").exists(),
        "找不到 vault.json.migrated"
    );
    let m = meta::load().expect("fence.json");

    let fences = collect_fences().expect("collect_fences");
    check_each_item_kept_its_fence(&fences, &m, &expected);
    check_no_orphan_ids(&fences, &m);
    // 系统围栏的项数和实现耦合，只打印不硬断言（硬编码以后会变成假失败）。
    let total: usize = fences.iter().map(|f| f.items.len()).sum();
    eprintln!(
        "看板共 {total} 项（桌面 {} + 系统 {}）",
        expected.len(),
        total.saturating_sub(expected.len())
    );

    let recent_after = recent_file_ids();
    let moved_old_ids: std::collections::HashSet<&str> =
        before.iter().map(|e| e.id.as_str()).collect();
    for id in &recent_after {
        assert!(
            !moved_old_ids.contains(id.as_str()),
            "最近列表里还留着旧 id {id} —— remap_ids 没生效，这一行会指向不存在的条目"
        );
    }
    for old in &recent_before {
        if let Some(new) = r.id_map.get(old) {
            assert!(
                recent_after.iter().any(|x| x == new),
                "最近列表里的 {old} 应该被改写成 {new} 后留在原位"
            );
        }
    }
    eprintln!("最近：{recent_before:?} → {recent_after:?}");
}

/// 看板上 `label` 这一项落在哪个围栏。排除「系统」—— 那几个 shell 项的 label 是写死的，
/// 同名碰撞只会让断言说谎。
fn fence_of_label(label: &str) -> Option<String> {
    collect_fences()
        .expect("collect_fences")
        .into_iter()
        .find(|f| f.name != "系统" && f.items.iter().any(|i| i.label == label))
        .map(|f| f.name)
}

/// 真机验收：新建 → 改名 → 删除，全走**真实桌面**上的生产入口（`ops::fence_create` /
/// `fence_rename` / `fence_delete` 就是右键菜单点下去调的那三个）。改名后**围栏归属不变**
/// 是 §1.5「先写 meta 再动文件」那个顺序的唯一可测形式。
/// 剪贴板与资源管理器**双向**那一条只能留给手：剪贴板是全局资源，机器跑一遍会踩掉用户正拿着的东西。
/// 跑法：`cargo test -- --ignored real_machine_ops --nocapture`
#[test]
#[ignore = "真机：在真实桌面上建/改名/删一个探针文件夹"]
fn real_machine_ops_create_rename_delete() {
    /// 探针文件夹。`Drop` 用**裸 `remove_dir_all`**、**不用 `fence_delete`** ——
    /// 兜底不能依赖被测代码本身，它坏了兜底也跟着坏，探针就永远留在用户桌面上。
    struct DirProbe {
        paths: Vec<PathBuf>,
    }

    impl Drop for DirProbe {
        fn drop(&mut self) {
            for p in &self.paths {
                let _ = std::fs::remove_dir_all(p);
                let _ = std::fs::remove_file(p);
            }
        }
    }

    let entries_before = meta::load().expect("fence.json").entries.len();
    let root = desktop_dir().expect("desktop dir");

    let name = "__desk_task14_probe__";
    let path = PathBuf::from(
        ops::fence_create(name.into(), "folder".into(), None).expect("fence_create"),
    );
    // 新名字先算出来推进兜底清单、再动文件 —— 从改名那一刻起两个路径都在兜底范围内。
    let renamed = root.join(format!("{name}_renamed"));
    // `_probe` 只为它的 `Drop` 活着（`let _ = …` 会当场析构，那就不兜底了）。
    let _probe = DirProbe {
        paths: vec![path.clone(), renamed.clone()],
    };

    assert!(path.is_dir(), "新建的文件夹没落到盘上：{}", path.display());
    assert_eq!(
        path.parent(),
        Some(root.as_path()),
        "新建的东西不在用户桌面上（看板读的是 {}）",
        root.display()
    );
    // 它得同时过得了护栏 —— 建得出来却删不掉会是个很闷的 bug。
    assert!(
        ops::gate(&path).is_ok(),
        "刚建出来的项自己过不了护栏：{}",
        path.display()
    );

    // 给它记一笔「工具」：选这个围栏是**故意的** —— 目录没有 meta 时 `fence_of` 兜到
    // 「文件夹」，这样「落在工具里」和「没落任何围栏」不会长得一样。
    let old_key = meta::key("user", name);
    {
        let mut m = meta::load().expect("fence.json");
        m.entries.insert(
            old_key.clone(),
            meta::Entry {
                fence: "工具".into(),
                order: 0,
                mtime: 0,
            },
        );
        meta::save(&m).expect("save fence.json");
    }
    assert_eq!(
        fence_of_label(name).as_deref(),
        Some("工具"),
        "记了偏好的项没落在「工具」围栏里"
    );

    // 改名 —— 围栏归属必须跟着走（spec §11-3）
    let new_name = format!("{name}_renamed");
    let returned = ops::fence_rename(path.to_string_lossy().to_string(), new_name.clone())
        .expect("fence_rename");

    assert!(!path.exists(), "改名后旧路径还在：{}", path.display());
    assert!(renamed.is_dir(), "改名后新路径不存在：{}", renamed.display());
    assert_eq!(
        Path::new(&returned),
        renamed.as_path(),
        "fence_rename 返回的路径和盘上的对不上"
    );

    let m = meta::load().expect("fence.json");
    let new_key = meta::key("user", &new_name);
    assert!(
        !m.entries.contains_key(&old_key),
        "改名后旧 key 还留在 fence.json 里：{old_key}"
    );
    assert_eq!(
        m.entries.get(&new_key).map(|e| e.fence.as_str()),
        Some("工具"),
        "改名把围栏归属弄丢了（fence.json 这一侧）—— meta::rename_key 没生效"
    );
    assert_eq!(
        fence_of_label(&new_name).as_deref(),
        Some("工具"),
        "改名后项跳到了别的围栏（看板这一侧）—— 用户看得见的错分栏，且不会自己回来"
    );

    // 删除 —— 进回收站（可撤销），账实两清
    ops::fence_delete(renamed.to_string_lossy().to_string()).expect("fence_delete");
    assert!(!renamed.exists(), "删完还在盘上：{}", renamed.display());
    assert!(
        !meta::load().expect("fence.json").entries.contains_key(&new_key),
        "删完还剩一条 meta —— 下次冷启动会被 prune 收走，但眼下它是个孤儿 {new_key}"
    );
    assert_eq!(
        fence_of_label(&new_name),
        None,
        "删完看板上还留着这一项"
    );

    // 账目回到原样：这一趟没在 fence.json 里留下任何痕迹
    assert_eq!(
        meta::load().expect("fence.json").entries.len(),
        entries_before,
        "fence.json 的条目数没回到起点，这一趟留下了残留"
    );

    eprintln!(
        "新建 → 改名 → 删除 全程通过；探针文件夹现在在**回收站**里（可撤销），\
         fence.json {} 条（与开始时一致）",
        entries_before
    );
}
