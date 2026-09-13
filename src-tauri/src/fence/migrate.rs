//! 一次性把 vault 里的图标搬回真桌面。**幂等可重入，不做回滚。**
//!
//! 判据是「**vault 里的文件还在不在**」，不是「上次跑到哪」——
//! 所以中途失败 / 断电 / 强杀都能重跑收敛（spec §5.3，INV-5）。
//!
//! Task 12 之后，本模块会是 fence/ 里**唯一**还能 `fs::rename` 的地方
//! （Task 17 的验收项：`grep -rn 'fs::rename' src-tauri/src/fence/` 只命中本文件）——
//! 新架构下文件永远住在桌面，搬动只发生在这唯一一次迁移里。
//!
//! 现在还没到那一步：`mod.rs:545` / `569` 仍在 `fence_takeover` 里把图标**搬进** vault，
//! 那正是 Task 12 要删掉的那条写路径。所以上面那条 grep 现在会多两处，不是漏改。

// 本模块和它的单测是 Task 9 的产物，生产入口 `run()` 由 Task 10 接到
// `fence_restore` 上。在那之前 lib 构建会有 dead_code。
//
// 这是**债**，不是设计 —— 和 Task 2/6/7/8 的 `#![allow(dead_code)]` 同性质。
// Task 10 把 `fence_restore` 改成调 `migrate::run()` 之后，这行必须回来删掉。
//
// 连带影响：`recent::remap_ids` 的唯一消费者就是本模块的 `run()`，
// 所以 recent.rs 那笔债也跟着顺延到 Task 10 —— 两笔一起还。
#![allow(dead_code)]

use super::{vault_dir, VaultEntry, VaultMeta};
use crate::fence::meta;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize)]
pub(crate) struct MigrateReport {
    pub moved: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
    /// 旧 id → 新 meta key。`run()` 用它写 fence.json 和改写最近列表。
    pub id_map: HashMap<String, String>,
}

/// 生产入口。迁移完成后再调用是空操作（vault.json 已被改名）。
pub(crate) fn run() -> Result<MigrateReport, String> {
    let vault = vault_dir()?;
    let old = super::load_meta()?;
    let roots = super::desktop_roots()?;

    // vault.json 不存在 → 从没搬过图标，或者早就迁完了。直接返回，别碰任何东西。
    if old.items.is_empty() {
        return Ok(MigrateReport::default());
    }

    // 迁移前备份。这一步动的是 33 个真实文件，出事要能人工核对原始映射。
    backup()?;

    let report = run_in(&vault, &roots, &old);

    // 分类偏好写进 fence.json。
    // 用 or_insert 而不是 insert：重跑时 skipped 分支的 id_map 是"最佳猜测"
    // （文件已经被上一轮搬走，名字可能带过 (2) 后缀），不能让它覆盖第一次写对的值。
    let mut m = meta::load()?;
    for e in &old.items {
        if let Some(new_key) = report.id_map.get(&e.id) {
            m.entries.entry(new_key.clone()).or_insert(meta::Entry {
                fence: e.fence.clone(),
                order: 0,
                mtime: 0,
            });
        }
    }
    meta::save(&m)?;

    // 最近列表跟着换 id —— 否则用户会觉得"最近"被清空了
    crate::recent::remap_ids(&report.id_map)?;

    // 全部成功才把旧 meta 归档；有失败项则保留原样，下次启动自动重试
    if report.failed.is_empty() {
        if let Ok(p) = super::meta_path() {
            let _ = std::fs::rename(&p, p.with_extension("json.migrated"));
        }
    } else {
        let mut remaining = old;
        remaining.items.retain(|e| report.failed.iter().any(|f| f.starts_with(&e.original_name)));
        super::save_meta(&remaining)?;
    }

    Ok(report)
}

/// 可测版本：显式传入 vault 目录与桌面根，不碰真实路径。
///
/// 刻意是**私有**的（计划里写的是 `pub(crate)`）：它只对 `run()` 和本模块的单测有意义，
/// 外面该用的入口是 `run()`。写成 `pub(crate)` 会触发 `private_interfaces` 警告 ——
/// 参数是 `VaultMeta`，而那个类型是 `fence` 私有的；为消警告就得把它也提升到
/// `pub(crate)`，等于为了一个测试缝把 fence 内部类型摊给整个 crate。收窄函数是更紧的一侧。
fn run_in(vault: &Path, roots: &[(String, PathBuf)], old: &VaultMeta) -> MigrateReport {
    let mut r = MigrateReport::default();
    let user_root = roots.iter().find(|(o, _)| o == "user").map(|(_, p)| p.clone());
    let public_root = roots
        .iter()
        .find(|(o, _)| o == "public")
        .map(|(_, p)| p.clone());

    for e in &old.items {
        let src = vault.join(&e.vault_name);

        // src 不在了 = 上一轮已经搬过。跳过，但补记 id_map ——
        // 否则 run() 里写 fence.json 时这一项的分类偏好会丢。
        // 注意这是"最佳猜测"：若当初发生过重名，实际名字带过 (2) 后缀。
        // run() 用 or_insert 兜住了这个不准，见那边的注释。
        if !src.exists() {
            r.skipped += 1;
            r.id_map
                .insert(e.id.clone(), meta::key(&e.origin, &e.original_name));
            continue;
        }

        let Some(primary) = preferred_root(e, &user_root, &public_root) else {
            r.failed
                .push(format!("{}: 找不到可写入的桌面目录", e.original_name));
            continue;
        };

        let dest = unique_dest(&primary, &e.original_name, &e.vault_name);
        match move_path(&src, &dest) {
            Ok(()) => {
                r.moved += 1;
                r.id_map
                    .insert(e.id.clone(), meta::key(&e.origin, &file_name_of(&dest, e)));
            }
            // 公共桌面常需管理员；退回用户桌面，避免整批失败（沿用旧 fence_restore 策略）
            Err(_) if e.origin == "public" => match user_root.clone() {
                Some(user) => {
                    let fallback = unique_dest(&user, &e.original_name, &e.vault_name);
                    match move_path(&src, &fallback) {
                        Ok(()) => {
                            r.moved += 1;
                            r.id_map.insert(
                                e.id.clone(),
                                meta::key(&e.origin, &file_name_of(&fallback, e)),
                            );
                        }
                        Err(err) => r.failed.push(format!("{}: {err}", e.original_name)),
                    }
                }
                None => r
                    .failed
                    .push(format!("{}: 公共桌面与用户桌面均不可写", e.original_name)),
            },
            Err(err) => r.failed.push(format!("{}: {err}", e.original_name)),
        }
    }
    r
}

/// 该项该回哪个桌面根。public 项优先公共桌面，用户桌面永远是保底。
fn preferred_root(
    e: &VaultEntry,
    user: &Option<PathBuf>,
    public: &Option<PathBuf>,
) -> Option<PathBuf> {
    if e.origin == "public" {
        public.clone().or_else(|| user.clone())
    } else {
        user.clone()
    }
}

/// 落到磁盘上的实际文件名（可能因重名退回 vault_name）。
fn file_name_of(dest: &Path, fallback: &VaultEntry) -> String {
    dest.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| fallback.original_name.clone())
}

/// vault.json → vault.json.bak-{时间戳}。失败不算致命，但要告诉调用方。
fn backup() -> Result<(), String> {
    let p = super::meta_path()?;
    if !p.exists() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    std::fs::copy(&p, p.with_file_name(format!("vault.json.bak-{stamp}")))
        .map(|_| ())
        .map_err(|e| format!("备份 vault.json 失败：{e}"))
}

/// rename，失败则 copy + 删源（跨卷时 rename 会失败）。
/// 从 `fence/mod.rs` 整体迁入，行为一字未改 —— 见下面 `unique_dest` 的说明。
pub(crate) fn move_path(src: &Path, dest: &Path) -> Result<(), std::io::Error> {
    match std::fs::rename(src, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            if src.is_dir() {
                // directories: copy tree is heavy; rename already failed — surface error
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "无法移动文件夹（权限不足）",
                ));
            }
            std::fs::copy(src, dest)?;
            std::fs::remove_file(src)?;
            Ok(())
        }
    }
}

/// 目标已存在时退回到 vault_name，**绝不覆盖**桌面上已有的东西。
///
/// ⚠️ **这个函数是从旧 fence_restore 原样搬来的，行为一字未改** ——
/// spec §5.3 明说「`unique_dest()` 已处理重名冲突，直接复用」。
/// 所以它不会产生 `PVZ (2).lnk` 这种带序号的落点，而是 `user-PVZ-0.lnk`。
/// 结果不算好看（桌面上会多一个带 vault 前缀的文件），但：不覆盖、不丢文件、
/// 重跑收敛，三条都满足。改成 `(2)` 序号是**改行为**而不是搬代码，
/// 会连带改掉 fence_restore 的落点 —— 记在 Task 9 完成记录里提请裁决，不擅自做。
pub(crate) fn unique_dest(desktop: &Path, original_name: &str, vault_name: &str) -> PathBuf {
    let dest = desktop.join(original_name);
    if dest.exists() {
        desktop.join(vault_name)
    } else {
        dest
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fence::{VaultEntry, VaultMeta};

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn entry(id: &str, fence: &str, original: &str, vault_name: &str) -> VaultEntry {
        VaultEntry {
            id: id.into(),
            label: original.into(),
            vault_name: vault_name.into(),
            fence: fence.into(),
            original_name: original.into(),
            origin: "user".into(),
            is_dir: false,
        }
    }

    fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let d = scratch();
        let vault = d.path().join("vault");
        let desktop = d.path().join("desktop");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(vault.join("user-PVZ-0.lnk"), b"x").unwrap();
        std::fs::write(vault.join("user-报表-1.txt"), b"y").unwrap();
        (d, vault, desktop)
    }

    #[test]
    fn moves_everything_home_and_maps_ids() {
        let (_d, vault, desktop) = setup();
        let old = VaultMeta {
            items: vec![
                entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk"),
                entry("user-报表-1", "工作", "报表.txt", "user-报表-1.txt"),
            ],
            hide_icons_applied: true,
        };
        let roots = vec![("user".to_string(), desktop.clone())];
        let r = run_in(&vault, &roots, &old);

        assert_eq!(r.moved, 2);
        assert!(r.failed.is_empty());
        assert!(desktop.join("PVZ.lnk").exists());
        assert!(desktop.join("报表.txt").exists());
        assert_eq!(r.id_map["user-PVZ-0"], "user:PVZ.lnk");
        assert_eq!(r.id_map["user-报表-1"], "user:报表.txt");
        // 搬走了就不该留在 vault 里（否则下次还会再搬一次）
        assert!(!vault.join("user-PVZ-0.lnk").exists());
    }

    #[test]
    fn second_run_is_a_noop() {
        let (_d, vault, desktop) = setup();
        let old = VaultMeta {
            items: vec![entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk")],
            hide_icons_applied: true,
        };
        let roots = vec![("user".to_string(), desktop.clone())];

        let first = run_in(&vault, &roots, &old);
        assert_eq!(first.moved, 1);

        let second = run_in(&vault, &roots, &old);
        assert_eq!(second.moved, 0);
        assert_eq!(second.skipped, 1);
        assert!(second.failed.is_empty());
        // 关键：第二次不能把文件搬回来又搬出去，也不能产生 PVZ (2).lnk
        assert!(desktop.join("PVZ.lnk").exists());
        assert!(!desktop.join("PVZ (2).lnk").exists());
    }

    /// ⚠️ **计划原文这版测试的场景是不可达的，已重写。**（理由见函数内注释）
    #[test]
    fn resumes_after_partial_failure() {
        let (_d, vault, desktop) = setup();
        let old = VaultMeta {
            items: vec![
                entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk"),
                entry("user-报表-1", "工作", "报表.txt", "user-报表-1.txt"),
            ],
            hide_icons_applied: true,
        };
        // 「上次跑到一半」的真实形态：PVZ 那一项**已经搬完**了 ——
        // move_path 成功就会删源，所以 vault 里那份已经不在了。报表 还没动。
        //
        // 计划原文写的是「桌面放一个 PVZ.lnk，同时 vault 里那份也留着」。那个状态
        // move_path 跑不出来：rename 成功即删源，两边都在只有「copy 成功但
        // remove_file 失败」才可能出现。拿它当「重跑收敛」的判据，测的是不会发生的
        // 场景，而且会推出与 spec §5.3 相矛盾的口径
        // （spec：判据是**vault 里文件还在不在**，不是「桌面上有没有同名文件」）。
        std::fs::remove_file(vault.join("user-PVZ-0.lnk")).unwrap();
        std::fs::write(desktop.join("PVZ.lnk"), b"x").unwrap();
        let roots = vec![("user".to_string(), desktop.clone())];

        let r = run_in(&vault, &roots, &old);
        assert_eq!(r.moved, 1); // 只搬 报表.txt
        assert_eq!(r.skipped, 1); // PVZ 判为已完成
        assert!(r.failed.is_empty());
        assert!(desktop.join("报表.txt").exists());
        // 桌面原来那份一个字节都没被动过
        assert_eq!(std::fs::read(desktop.join("PVZ.lnk")).unwrap(), b"x");
        // 跳过的那一项也必须补 id_map —— 否则 run() 写 fence.json 时它的分类偏好就丢了。
        // 计划原文的注释声称了这件事，但四个测试里**一个都没断言它**。
        assert_eq!(r.id_map["user-PVZ-0"], "user:PVZ.lnk");
        assert_eq!(r.id_map["user-报表-1"], "user:报表.txt");
    }

    /// ⚠️ **计划原文断言 `PVZ (2).lnk`，与 spec §5.3 冲突，已按 spec 重写。**
    #[test]
    fn name_collision_never_clobbers_the_existing_file() {
        let (_d, vault, desktop) = setup();
        std::fs::write(desktop.join("PVZ.lnk"), b"already here").unwrap();
        let old = VaultMeta {
            items: vec![entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk")],
            hide_icons_applied: true,
        };
        let roots = vec![("user".to_string(), desktop.clone())];
        let r = run_in(&vault, &roots, &old);

        assert_eq!(r.moved, 1);
        // 本测试的**意图**：用户桌面上那份绝不能被覆盖。这一条计划写对了，保留。
        assert_eq!(
            std::fs::read(desktop.join("PVZ.lnk")).unwrap(),
            b"already here"
        );
        // 但落点不是 `PVZ (2).lnk`。spec §5.3 明说「unique_dest() 已处理重名冲突，
        // **直接复用**」，而现成的 unique_dest 在重名时退回到 vault_name：
        //     if dest.exists() { desktop.join(vault_name) } else { dest }
        // 造一个 `(2)` 的新策略属于改行为，不是本任务的范围（而且会连带改掉
        // fence_restore 的落点）。要改的话是 spec 层的事，已在完成记录里提请裁决。
        assert!(desktop.join("user-PVZ-0.lnk").exists());
        assert_eq!(r.id_map["user-PVZ-0"], "user:user-PVZ-0.lnk");
    }

    /// public 项优先回公共桌面；公共桌面不在时退回用户桌面（spec §5.3 的降级策略）。
    #[test]
    fn public_item_prefers_public_root_and_falls_back_to_user() {
        let (d, vault, desktop) = setup();
        let public = d.path().join("public");
        std::fs::create_dir_all(&public).unwrap();
        let mut e = entry("public-工具-0", "工具", "工具.lnk", "public-工具-0.lnk");
        e.origin = "public".into();
        let old = VaultMeta {
            items: vec![e],
            hide_icons_applied: true,
        };

        // 有公共桌面 → 落公共桌面
        std::fs::write(vault.join("public-工具-0.lnk"), b"z").unwrap();
        let roots = vec![
            ("user".to_string(), desktop.clone()),
            ("public".to_string(), public.clone()),
        ];
        let r = run_in(&vault, &roots, &old);
        assert_eq!(r.moved, 1);
        assert!(public.join("工具.lnk").exists());
        assert_eq!(r.id_map["public-工具-0"], "public:工具.lnk");

        // 没有公共桌面（第二台机器/被策略移除）→ 退回用户桌面，不许整批失败
        std::fs::write(vault.join("public-工具-0.lnk"), b"z").unwrap();
        let only_user = vec![("user".to_string(), desktop.clone())];
        let r2 = run_in(&vault, &only_user, &old);
        assert_eq!(r2.moved, 1);
        assert!(r2.failed.is_empty());
        assert!(desktop.join("工具.lnk").exists());
    }

    /// 两个桌面根都拿不到 → 记进 failed，不 panic、不丢文件。
    #[test]
    fn no_writable_root_reports_failure_without_losing_the_file() {
        let (_d, vault, desktop) = setup();
        let old = VaultMeta {
            items: vec![
                entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk"),
                entry("user-报表-1", "工作", "报表.txt", "user-报表-1.txt"),
            ],
            hide_icons_applied: true,
        };
        // roots 是空的 —— 两个桌面目录都解析不出来
        let r = run_in(&vault, &[], &old);

        assert_eq!(r.moved, 0);
        assert_eq!(r.failed.len(), 2);
        // 关键：失败项的文件必须**原地不动**，否则下次启动就找不回来了
        assert!(vault.join("user-PVZ-0.lnk").exists());
        assert!(vault.join("user-报表-1.txt").exists());
        assert!(desktop.read_dir().unwrap().next().is_none());
        assert!(r.id_map.is_empty());
    }

    /// 真机干跑：**只读，一个字节都不写**。Task 11 真正迁移之前的对账。
    ///
    /// 上面 6 个测试都跑在 tempdir 里，对真实数据的形状一无所知。这个测试补的是
    /// 「**真机上会不会撞名**」—— 撞名是唯一会让迁移结果不好看（落点变成
    /// `user-XXX-3.lnk` 躺在桌面上）的情况，而它取决于两个桌面目录当前有什么。
    ///
    /// 刻意**不调用 `run_in`** —— 那会真的搬文件。这里手工重算一遍它要做的事，
    /// 最后再断言 vault 目录的文件数没变，用文件系统本身证明这次跑是只读的。
    #[test]
    #[ignore] // 需要真实 vault.json / 桌面，只在真机手动跑
    fn real_vault_dry_run_is_read_only() {
        let vault = crate::fence::vault_dir().unwrap();
        let old = crate::fence::load_meta().unwrap();
        let roots = crate::fence::desktop_roots().unwrap();
        println!("vault 目录：{}", vault.display());

        if old.items.is_empty() {
            println!("vault.json 不存在或为空 → run() 会直接空操作返回");
            return;
        }
        println!("待迁移 {} 项", old.items.len());

        let count = |d: &std::path::Path| std::fs::read_dir(d).map(|r| r.count()).unwrap_or(0);
        let before = count(&vault);

        let user = roots.iter().find(|(o, _)| o == "user").map(|(_, p)| p.clone());
        let public = roots
            .iter()
            .find(|(o, _)| o == "public")
            .map(|(_, p)| p.clone());

        let mut missing = Vec::new();
        let mut collisions = Vec::new();
        let mut no_root = Vec::new();
        let mut dirs = 0usize;
        let mut public_items = 0usize;

        for e in &old.items {
            let src = vault.join(&e.vault_name);
            if !src.exists() {
                // 干跑时就不在 → run() 会判「已搬过」跳过，并**猜测** id_map。
                // 真机上出现这个，说明 vault.json 和 vault 目录已经不同步了。
                missing.push(e.vault_name.clone());
                continue;
            }
            if e.is_dir {
                dirs += 1;
            }
            if e.origin == "public" {
                public_items += 1;
            }
            let Some(root) = (if e.origin == "public" {
                public.clone().or_else(|| user.clone())
            } else {
                user.clone()
            }) else {
                no_root.push(e.original_name.clone());
                continue;
            };
            // 撞名 = 桌面上已经有一个同名文件。这正是 unique_dest 会退到
            // vault_name 的情形，迁移后桌面上会多一个 `user-XXX-N.lnk`。
            let dest = unique_dest(&root, &e.original_name, &e.vault_name);
            if dest.file_name().and_then(|s| s.to_str()) == Some(e.vault_name.as_str()) {
                collisions.push(format!(
                    "{} → {}",
                    e.original_name,
                    dest.file_name().unwrap().to_string_lossy()
                ));
            }
            // id_map 的 key 必须是 well-formed 的，否则 fence.json 里会写进查不回来的条目
            let k = meta::key(&e.origin, &e.original_name);
            assert!(k.contains(':'), "坏 key: {k}");
            assert!(k.starts_with(&format!("{}:", e.origin)), "origin 丢了: {k}");
        }

        println!(
            "目标桌面根：user={:?} public={:?}",
            user.as_ref().map(|p| p.display().to_string()),
            public.as_ref().map(|p| p.display().to_string())
        );
        println!("其中目录 {dirs} 个 / public 来源 {public_items} 项");
        println!("vault 里查无此文件：{} 项 {:?}", missing.len(), missing);
        println!("找不到桌面根：{} 项 {:?}", no_root.len(), no_root);
        println!("会撞名：{} 项 {:?}", collisions.len(), collisions);

        assert!(missing.is_empty(), "vault.json 与 vault 目录不同步，先别迁移");
        assert!(no_root.is_empty(), "有项找不到可写入的桌面根");
        // 本机 2026-09-13 实测：两个桌面目录都只有 desktop.ini → 0 处撞名。
        // 这个断言是**给未来看的** —— 如果哪天它红了，说明迁移会把项落到
        // `user-XXX-N.lnk` 这种名字上，值得先人工看一眼再迁。
        assert!(
            collisions.is_empty(),
            "有 {} 项会因重名落到 vault 名字上：{:?}",
            collisions.len(),
            collisions
        );
        // 用文件系统证明这次跑是只读的
        assert_eq!(count(&vault), before, "干跑改动了 vault 目录！");
    }
}
