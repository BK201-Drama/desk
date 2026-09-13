//! 一次性把 vault 里的图标搬回真桌面。**幂等可重入，不做回滚。**
//! 判据是「**vault 里的文件还在不在**」，不是「上次跑到哪」——
//! 所以中途失败 / 断电 / 强杀都能重跑收敛（spec §5.3，INV-5）。
//! ⚠️ 本模块是 fence/ 里**唯一**还能移动文件的地方
//! （`grep -rn 'fs::rename' src-tauri/src/fence/` 只该命中本文件）。

use crate::fence::meta;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ── 旧架构的账本（vault.json）──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(super) struct VaultMeta {
    pub items: Vec<VaultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct VaultEntry {
    pub id: String,
    pub label: String,
    pub vault_name: String,
    pub fence: String,
    pub original_name: String,
    #[serde(default = "default_origin")]
    pub origin: String,
    #[serde(default)]
    pub is_dir: bool,
}

fn default_origin() -> String {
    "user".into()
}

pub(super) fn vault_dir() -> Result<PathBuf, String> {
    let dir = super::paths::app_data_dir()?.join("vault");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(super) fn meta_path() -> Result<PathBuf, String> {
    Ok(super::paths::app_data_dir()?.join("vault.json"))
}

pub(super) fn load_meta() -> Result<VaultMeta, String> {
    let p = meta_path()?;
    if !p.exists() {
        return Ok(VaultMeta::default());
    }
    let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn save_meta(meta: &VaultMeta) -> Result<(), String> {
    let p = meta_path()?;
    let s = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(p, s).map_err(|e| e.to_string())
}

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
    let old = load_meta()?;
    let roots = super::paths::desktop_roots()?;

    // vault.json 为空 → 从没搬过图标，或者早就迁完了。直接返回，别碰任何东西。
    if old.items.is_empty() {
        return Ok(MigrateReport::default());
    }

    // 迁移前备份 —— 这一步动的是真实文件，出事要能人工核对原始映射。
    backup()?;

    let report = run_in(&vault, &roots, &old);

    // 分类偏好写进 fence.json。用 or_insert 而不是 insert：重跑时 skipped 分支的 id_map 是「最佳猜测」（名字可能带过 (2) 后缀），不能覆盖第一次写对的值。
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

    // 最近列表跟着换 id —— 否则用户会觉得「最近」被清空了
    crate::recent::remap_ids(&report.id_map)?;

    // 全部成功才把旧 meta 归档；有失败项则保留原样，下次启动自动重试
    if report.failed.is_empty() {
        if let Ok(p) = meta_path() {
            let _ = std::fs::rename(&p, p.with_extension("json.migrated"));
        }
    } else {
        let mut remaining = old;
        remaining.items.retain(|e| report.failed.iter().any(|f| f.starts_with(&e.original_name)));
        save_meta(&remaining)?;
    }

    Ok(report)
}

/// 可测版本：显式传入 vault 目录与桌面根，不碰真实路径。**刻意私有**：写成 `pub(crate)` 会因参数是
/// 私有的 `VaultMeta` 触发 `private_interfaces` 警告，为消警告就得把那个类型摊给整个 crate。
fn run_in(vault: &Path, roots: &[(String, PathBuf)], old: &VaultMeta) -> MigrateReport {
    let mut r = MigrateReport::default();
    // 保留 (origin, 路径) 成对：origin 只能从**实际落点**那个根上取，不能从 `e.origin` 取。
    let user_root = roots.iter().find(|(o, _)| o == "user").cloned();
    let public_root = roots.iter().find(|(o, _)| o == "public").cloned();

    for e in &old.items {
        let src = vault.join(&e.vault_name);

        // src 不在了 = 上一轮已经搬过。跳过，但**必须补记 id_map** —— 否则 run() 写 fence.json 时这一项的分类偏好会丢（这是「最佳猜测」，run() 用 or_insert 兜住了）。
        if !src.exists() {
            r.skipped += 1;
            r.id_map
                .insert(e.id.clone(), meta::key(&e.origin, &e.original_name));
            continue;
        }

        let Some((root_origin, primary)) = preferred_root(e, &user_root, &public_root) else {
            r.failed
                .push(format!("{}: 找不到可写入的桌面目录", e.original_name));
            continue;
        };

        let dest = unique_dest(&primary, &e.original_name, &e.vault_name);
        match move_path(&src, &dest) {
            Ok(()) => {
                r.moved += 1;
                r.id_map
                    .insert(e.id.clone(), meta::key(&root_origin, &file_name_of(&dest, e)));
            }
            // 公共桌面常需管理员；退回用户桌面，避免整批失败
            Err(_) if e.origin == "public" => match user_root.clone() {
                Some((user_origin, user)) => {
                    let fallback = unique_dest(&user, &e.original_name, &e.vault_name);
                    match move_path(&src, &fallback) {
                        Ok(()) => {
                            r.moved += 1;
                            // key 用**实际落点**的 origin，见 preferred_root 的注释。
                            r.id_map.insert(
                                e.id.clone(),
                                meta::key(&user_origin, &file_name_of(&fallback, e)),
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

/// 该项该回哪个桌面根。public 项优先公共桌面，用户桌面永远是保底。返回 **(实际选中的根的 origin 标签, 路径)**
/// —— 不一定等于 `e.origin`（会退到用户桌面）。⚠️ 调用方**必须**拿该标签拼 key，否则 fence.json 与看板对不上账。
fn preferred_root(
    e: &VaultEntry,
    user: &Option<(String, PathBuf)>,
    public: &Option<(String, PathBuf)>,
) -> Option<(String, PathBuf)> {
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
    let p = meta_path()?;
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

/// 目标已存在时退回到 vault_name，**绝不覆盖**桌面上已有的东西。⚠️ 落点是 `user-PVZ-0.lnk` 这种带 vault
/// 前缀的名字，**不是** `PVZ (2).lnk`；改成 `(2)` 序号是**改行为**，会连带改掉 `fence_restore` 的落点（spec §5.3）。
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

    /// ⚠️ 「桌面和 vault 两边都在」那个场景是**不可达的**（理由见函数内注释）。
    #[test]
    fn resumes_after_partial_failure() {
        let (_d, vault, desktop) = setup();
        let old = VaultMeta {
            items: vec![
                entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk"),
                entry("user-报表-1", "工作", "报表.txt", "user-报表-1.txt"),
            ],
        };
        // 「上次跑到一半」的真实形态：PVZ 已经搬完（move_path 成功即删源），报表还没动。
        // ⚠️ 「两边都在」是 move_path 跑不出来的状态；spec §5.3 的判据是**vault 里文件还在不在**。
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
        assert_eq!(r.id_map["user-PVZ-0"], "user:PVZ.lnk");
        assert_eq!(r.id_map["user-报表-1"], "user:报表.txt");
    }

    /// ⚠️ 落点**不是** `PVZ (2).lnk` —— 按 spec §5.3（见 `unique_dest`）。
    #[test]
    fn name_collision_never_clobbers_the_existing_file() {
        let (_d, vault, desktop) = setup();
        std::fs::write(desktop.join("PVZ.lnk"), b"already here").unwrap();
        let old = VaultMeta {
            items: vec![entry("user-PVZ-0", "游戏", "PVZ.lnk", "user-PVZ-0.lnk")],
        };
        let roots = vec![("user".to_string(), desktop.clone())];
        let r = run_in(&vault, &roots, &old);

        assert_eq!(r.moved, 1);
        // 本测试的**意图**：用户桌面上那份绝不能被覆盖。
        assert_eq!(
            std::fs::read(desktop.join("PVZ.lnk")).unwrap(),
            b"already here"
        );
        // 重名时 unique_dest 退回 vault_name。造 `(2)` 序号是新策略 = 改行为，会连带改掉 fence_restore 的落点。
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
        // ⚠️ 落点在用户桌面，key 就必须是 `user:`，不是 `public:` —— 索引按「文件**实际躺在哪个根**」
        // 算 id，写错的后果是 fence.json 和看板永远对不上账，这一项的围栏偏好静默丢失（真机踩到过）。
        assert_eq!(r2.id_map["public-工具-0"], "user:工具.lnk");
    }

    /// 公共桌面**在**、但写进去失败 → 退回用户桌面。
    /// 和上一个测试走的**不是同一行代码**：这里走的是 `Err(_) if e.origin == "public"` 那条分支。
    #[test]
    fn public_move_failure_falls_back_to_user_and_keys_by_landing_root() {
        let (d, vault, desktop) = setup();
        let public = d.path().join("public");
        std::fs::create_dir_all(&public).unwrap();
        let mut e = entry("public-工具-0", "工具", "工具.lnk", "public-工具-0.lnk");
        e.origin = "public".into();
        let old = VaultMeta {
            items: vec![e],
        };

        // 让 public 这一侧**必然写不进去**：落点和兜底名都占成非空目录，rename 会报错 → 进降级分支（真机上是权限不够，等价）。
        std::fs::create_dir_all(public.join("工具.lnk")).unwrap();
        std::fs::create_dir_all(public.join("public-工具-0.lnk").join("占位")).unwrap();
        std::fs::write(vault.join("public-工具-0.lnk"), b"z").unwrap();

        let roots = vec![
            ("user".to_string(), desktop.clone()),
            ("public".to_string(), public.clone()),
        ];
        let r = run_in(&vault, &roots, &old);

        assert_eq!(r.moved, 1);
        assert!(r.failed.is_empty());
        assert!(desktop.join("工具.lnk").exists(), "应退回用户桌面");
        assert_eq!(
            r.id_map["public-工具-0"], "user:工具.lnk",
            "落点在用户桌面，key 就必须是 user: —— 否则 fence.json 与看板对不上账"
        );
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

    /// 真机干跑：**只读，一个字节都不写**。补的是 tempdir 测试看不见的那件事 ——
    /// 「真机上会不会撞名」（撞名会让落点变成 `user-XXX-3.lnk` 躺在桌面上）。
    /// 刻意**不调用 `run_in`**（那会真的搬文件），末尾用 vault 文件数证明这次是只读的。
    #[test]
    #[ignore] // 需要真实 vault.json / 桌面，只在真机手动跑
    fn real_vault_dry_run_is_read_only() {
        let vault = vault_dir().unwrap();
        let old = load_meta().unwrap();
        let roots = crate::fence::paths::desktop_roots().unwrap();
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
                // 干跑时就不在 → run() 判「已搬过」跳过并**猜测** id_map。
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
            // 撞名 = unique_dest 会退到 vault_name，迁移后桌面上多一个 `user-XXX-N.lnk`。
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
        // 这个断言是**给未来看的**：哪天它红了，说明迁移会把项落到 `user-XXX-N.lnk`
        // 这种名字上，值得先人工看一眼再迁。
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
