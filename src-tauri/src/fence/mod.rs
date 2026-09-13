//! 围栏 = **真桌面的只读索引**（INV-1）：不搬、不藏、不复制，图标就住在 Windows 桌面上。
//!
//! 读：`collect_fences()` → `scan_desktop()` → `index::build_fences()`；桌面在 desk 外面被改时
//! 由 `watch.rs` 盯着重扫。写：**只有** `ops.rs` 的右键菜单命令会动用户文件，每个入口都先过
//! `ops::locate` 那道闸（只放行桌面根的**直接**子项）。`fence.json` 里全是偏好，删掉只丢分类不丢文件。

// 本模块只做编排：路径在 `paths`、纯分类在 `classify`、PE/PowerShell 在 `shell_icons`、真机测试在 `real_machine`。
// 没有 `pub(crate) use` 转出是刻意的：调用方写全 `paths::icons_dir()` —— 别给同一个东西两条路径。
pub(crate) mod classify;
pub(crate) mod hide;
pub(crate) mod index;
pub(crate) mod meta;
pub(crate) mod migrate;
pub(crate) mod ops;
pub(crate) mod paths;
#[cfg(test)]
mod real_machine;
pub(crate) mod shell_icons;
pub(crate) mod watch;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;

/// 宿主自己造的项（回收站 / 此电脑）的 id 前缀 —— 它们**不在**真桌面上。
///
/// 这是一个**跨语言约定**：`src/plugins/fence/model.ts` 的同名常量决定前端把哪些项当
/// 「系统项」（不可重命名 / 删除 / 拖拽），Rust 侧用它跳过记账与孤儿检测。两边一分家，
/// 其中一侧就会**静默**少认一类项 —— 由 `index::sys_id_prefix_matches_frontend` 钉住。
///
/// 下面造 id 写 `format!("{SYS_ID_PREFIX}recycle")` 而不是字面量 `"sys-recycle"`，
/// 是为了让「改这个常量」带不动 id：写死的话，只改常量的人会把前缀和 id 劈成两家。
pub(crate) const SYS_ID_PREFIX: &str = "sys-";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceItemDto {
    pub id: String,
    pub label: String,
    pub path: String,
    pub icon: Option<String>,
    /// 是不是目录 —— 右键菜单按它决定「打开方式」出不出现。前端**猜不出来**（`label` 里
    /// 没有扩展名，而目录名带点是常事：`v1.2 备份`），必须传。
    /// ⚠️ 前端先看 `sys-` 前缀再看它，所以下面两个系统项轮不到这个分支。
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceDto {
    pub name: String,
    pub items: Vec<FenceItemDto>,
    /// 这一栏收起了没（`fence.json` 的 `ui.collapsed`）。挂在 DTO 上而不是单开一条命令，
    /// 是为了**首帧就带着它** —— 分两次拿的话每次启动都会看见围栏先展开、再「啪」地收起。
    pub collapsed: bool,
    /// 用户自定义行数。**0 = 自动**；上界见 `index::ROWS_MAX`。
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceLayoutDto {
    pub name: String,
    pub ids: Vec<String>,
}

fn system_shell_items(icons: &Path) -> Vec<FenceItemDto> {
    // imageres.dll 的资源 ID 是负数：-55 回收站、-109 此电脑。
    // 已有 PNG 绝不再起 PowerShell —— `fence_list` 是同步的，会卡死。
    let imageres = r"C:\Windows\System32\imageres.dll";
    let recycle_icon = icons.join("sys-recycle.png");
    let pc_icon = icons.join("sys-pc.png");
    if !recycle_icon.exists() {
        let _ = shell_icons::extract_dll_icon(imageres, -55, &recycle_icon);
    }
    if !pc_icon.exists() {
        let _ = shell_icons::extract_dll_icon(imageres, -109, &pc_icon);
    }

    vec![
        FenceItemDto {
            id: format!("{SYS_ID_PREFIX}recycle"),
            label: "回收站".into(),
            path: "shell:RecycleBinFolder".into(),
            icon: recycle_icon
                .exists()
                .then(|| recycle_icon.to_string_lossy().to_string()),
            is_dir: true,
        },
        FenceItemDto {
            id: format!("{SYS_ID_PREFIX}pc"),
            label: "此电脑".into(),
            path: "shell:MyComputerFolder".into(),
            icon: pc_icon
                .exists()
                .then(|| pc_icon.to_string_lossy().to_string()),
            is_dir: true,
        },
    ]
}

/// 隐藏桌面图标 —— **唯一的隐藏出口**。
///
/// 逃生口是硬约束（spec §6.2 第 3 条）：用户按过「显示桌面图标」之后，任何路径都不得再
/// 把它盖回去。判断收在一处，是为了「以后新增的隐藏路径默认就是安全的」。失败只 `eprintln!`
/// 不返回 Err（spec §8：`HideIcons` 写失败不阻塞启动）。「用户意愿」取 `hide::may_hide()` ——
/// 优先级全在 `hide.rs` 的 `classify` 里，这里只是取用，别再加第二个判断。
fn hide_unless_user_wants_visible() {
    if !hide::may_hide() {
        return;
    }
    if let Err(e) = hide::set_desktop_icons_hidden(true) {
        eprintln!("hide desktop icons: {e}");
    }
}

/// 启动路径的隐藏：**同步记下意图，后台真去隐藏**。
///
/// 记账不能省（INV-3）：`hide.owned` 不落盘的话，下次启动的孤儿自检会把这个 `HideIcons=1`
/// 判成无主、自己清掉 —— 用户会看到图标在两次启动之间闪回来。隐藏本身不能同步做
/// （`reg add` 之后还要刷 Explorer，会卡住首屏）。
fn hide_desktop_icons_on_start() {
    // 用户按过逃生开关时**一个字都不写**：不隐藏，也**不记这条账** ——
    // `owned` 是给「我们收下的那个 1」用的，这条分支下我们什么都没收下。
    if !hide::may_hide() {
        return;
    }
    if let Ok(mut m) = meta::load() {
        if !m.hide.owned {
            m.hide.owned = true;
            if let Err(e) = meta::save(&m) {
                eprintln!("mark hide intent: {e}");
            }
        }
    }
    std::thread::spawn(hide_unless_user_wants_visible);
}

/// 扫两个桌面根，返回 `(项, 是不是每个根都读成功了)`。
///
/// 那个布尔值是 `meta::prune` 的判据：**只有「每个根都读成功」的那次扫描才有资格说
/// 「这个 key 没了」** —— 公共桌面一时读不到时它的项一个都扫不到，拿去 prune 会清掉整栏偏好。
/// 用户桌面读不到则**整个失败**：「返回一个空看板」是撒谎（用户会以为文件没了）。
fn scan_desktop_checked() -> Result<(Vec<index::ScannedItem>, bool), String> {
    let roots = paths::desktop_roots()?;
    let mut items: Vec<index::ScannedItem> = Vec::new();
    let mut all_ok = true;
    let mut user_ok = false;

    for (origin, root) in &roots {
        match index::scan_root(origin, root) {
            Ok(v) => {
                if origin == "user" {
                    user_ok = true;
                }
                items.extend(v);
            }
            Err(e) => {
                all_ok = false;
                eprintln!("desk: {e}");
            }
        }
    }

    if !user_ok {
        return Err("读不到用户桌面目录".into());
    }
    Ok((items, all_ok))
}

/// 桌面上的全部项。**纯读**。尽力而为：公共桌面读不到时只显示能读到的那些。
/// **别拿它判断「哪些项没了」** —— 要那个请用 `scan_desktop_checked` 并看第二个返回值。
fn scan_desktop() -> Result<Vec<index::ScannedItem>, String> {
    Ok(scan_desktop_checked()?.0)
}

/// 真相源是「真桌面」（INV-1），全程只读。
fn collect_fences() -> Result<Vec<FenceDto>, String> {
    let items = scan_desktop()?;

    // 图标不在这里抽 —— 每缺一个就是一次 PowerShell，会把首屏卡死（见 refresh_icons_once）。
    Ok(index::build_fences(&items, &meta::load()?))
}

/// 补齐图标缓存（`index::ensure_icons`）。缓存按 key 命名，所以文件换了位置也能自愈。
///
/// 一次调用可能起 30+ 次 PowerShell，耗时上不封顶 —— **前台还是后台由调用方决定**。
fn refresh_icons_once() {
    match scan_desktop() {
        Ok(items) => {
            let n = index::ensure_icons(&items);
            if n > 0 {
                eprintln!("desk: extracted {n} desktop icons");
            }
        }
        Err(e) => eprintln!("scan for icons: {e}"),
    }
}

/// 冷启动走这条：图标丢后台，首屏先用「有就用、没有就空着」的列表渲染。
fn refresh_icons_in_background() {
    std::thread::spawn(refresh_icons_once);
}

#[tauri::command]
pub fn fence_list() -> Result<Vec<FenceDto>, String> {
    // 冷启动主路径：**先给列表，再做重活**。隐藏桌面图标与抽图标都在后台。
    let (items, all_ok) = scan_desktop_checked()?;

    // 顺手收掉 `fence.json` 里的孤儿条目：留着的话，同名文件以后再出现会**静默继承**
    // 上一次的分类和排序。只在 `all_ok` 时做 —— 这里必须靠一次扫描反推「谁没了」。
    let mut m = meta::load()?;
    if all_ok {
        let present: HashSet<String> = items.iter().map(|i| i.key.clone()).collect();
        if meta::prune(&mut m, &present) > 0 {
            meta::save(&m)?;
        }
    }

    let fences = index::build_fences(&items, &m);
    hide_desktop_icons_on_start();
    refresh_icons_in_background();
    Ok(fences)
}

/// 强制重扫。**只读，不移动任何文件。**
/// 和 `fence_list` 的差别只有图标：这里**同步**抽，返回时图标是齐的（用户刚做完一件事，正等着看结果）。
#[tauri::command]
pub fn fence_rescan() -> Result<Vec<FenceDto>, String> {
    refresh_icons_once();
    collect_fences()
}

/// Persist custom icon order (and optional cross-fence moves). System fence is ignored.
#[tauri::command]
pub fn fence_save_order(layout: Vec<FenceLayoutDto>) -> Result<Vec<FenceDto>, String> {
    // **只写 `fence.json`。**别改回 `vault.json`：它已被归档成 `vault.json.migrated`，
    // 写它等于当场复活一个空 vault —— 布局静默丢失，且旧 release 构建看到
    // 「vault.json 在 + 桌面是满的」会把 34 项重新吸回 vault。
    // 看板项的 id 就是 meta key，所以这里零换算。
    let mut m = meta::load()?;
    for block in &layout {
        if block.name == "系统" {
            continue;
        }
        // order 只在同一个围栏内部比大小，所以每个围栏各自从 0 数。
        let mut order = 0u32;
        for id in &block.ids {
            if id.starts_with(SYS_ID_PREFIX) {
                continue;
            }
            // or_insert 而不是 get_mut：还没记过账的项在这里被补上 —— 拖一下就把归属记下来。
            let e = m.entries.entry(id.clone()).or_insert_with(|| meta::Entry {
                fence: block.name.clone(),
                order,
                mtime: 0,
            });
            e.fence = block.name.clone();
            e.order = order;
            order += 1;
        }
    }
    meta::save(&m)?;
    // 返回值必须和 `fence_list` 走**同一条读路径**（`collect_fences`）：前端拿它直接
    // setFences，回吐一份口径不同的列表会让一批项的图标当场从看板上消失。
    collect_fences()
}

/// 只写**显示偏好**（收起 / 高度），不动任何归属与顺序。
///
/// 两个参数都是 `Option`，语义是「改不改」而不是「改成什么」：`None` = 别碰，`Some(0)`/`Some(false)`
/// = 回到「自动」/ 展开（都是删键，让 json 保持干净）。前端**两个都显式发**（另一个发 `null`）。
/// 返回值必须和 `fence_list` 走**同一条读路径**（`collect_fences`，理由同 `fence_save_order`）。
#[tauri::command]
pub fn fence_save_ui(
    name: String,
    collapsed: Option<bool>,
    rows: Option<u32>,
) -> Result<Vec<FenceDto>, String> {
    let mut m = meta::load()?;
    if let Some(c) = collapsed {
        if c {
            m.ui.collapsed.insert(name.clone());
        } else {
            m.ui.collapsed.remove(&name);
        }
    }
    if let Some(r) = rows {
        // 0 与缺键同义，统一成「没有这个键」。夹上界的是 `index::ui_of`（读那一侧），不在这里夹。
        if r == 0 {
            m.ui.rows.remove(&name);
        } else {
            m.ui.rows.insert(name.clone(), r);
        }
    }
    meta::save(&m)?;
    collect_fences()
}

// 搬动文件只在 migrate.rs 那一处一次性迁移里发生，本模块不自己搬东西。

#[tauri::command]
pub fn fence_launch(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        if path.starts_with("shell:") {
            crate::proc::command("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }

        let h = HSTRING::from(path.as_str());
        let rc = unsafe {
            ShellExecuteW(HWND::default(), w!("open"), &h, None, None, SW_SHOWNORMAL)
        };
        if (rc.0 as usize) <= 32 {
            return Err(format!("无法打开（错误码 {}）", rc.0 as usize));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        open::that(&path).map_err(|e| e.to_string())
    }
}

/// 迁移入口。**幂等**：vault 空了之后调用是空操作。判据是「vault 里的文件还在不在」，
/// 不是「上次跑到哪」—— 中途失败 / 断电 / 强杀都能重跑收敛（spec §5.3，INV-5）。
/// 备份、搬动、记账、最近列表改写全在 `migrate::run()` 里，本函数只负责报告 + 放图标。
#[tauri::command]
pub fn fence_restore() -> Result<serde_json::Value, String> {
    let r = migrate::run()?;
    if !r.failed.is_empty() {
        return Err(format!(
            "部分图标未能迁移（{}）：{}",
            r.failed.len(),
            r.failed.join("；")
        ));
    }
    // **只在用户明确要求过显示桌面图标时**才放掉 HideIcons。没按过逃生口的话，
    // desk 运行期间照旧替他收着（HideIcons 绑进程寿命，见 lib.rs 的退出钩子）。
    if hide::user_wants_visible() {
        // **硬失败，不吞。**文件已经搬回真桌面了，但 `HideIcons` 还是 1 —— 用户按的是
        // 「把图标还给我」，而他看着一个空桌面。吞掉会报告成功、事实失败。
        // 前端两处调用点本来就是 `try/catch` 弹「还原失败」，不用改。
        hide::disable()?;
    }
    Ok(serde_json::json!({ "moved": r.moved, "skipped": r.skipped }))
}
/// 围栏的诊断信息。**没有前端消费者**（只在 `host/api.ts` 的读权限白名单里）。
#[tauri::command]
pub fn fence_status() -> Result<serde_json::Value, String> {
    let m = meta::load()?;
    Ok(serde_json::json!({
        "count": m.entries.len(),
        "hide_icons": m.hide.owned,
    }))
}

/// 当前桌面图标是否可见（= `HideIcons` 为 0 或未设置）。
///
/// 报的是**事实**，不是**意图** —— 所以刻意**不**走 `hide::classify`：用户按了逃生开关、
/// 但改注册表那一步失败时，两者不一致，这时如实报「还隐藏着」才会让前端弹「还原失败」。
#[tauri::command]
pub fn fence_icons_visible() -> Result<bool, String> {
    Ok(hide::is_enabled()? != Some(true))
}

/// 逃生开关：立即切换桌面图标可见性，并记住这个选择（重启 desk 不反弹）。
/// 三处来源（注册表 / 标志文件 / `hide.owned`）的读写全在 `hide::apply_user_choice`。
#[tauri::command]
pub fn fence_set_icons_visible(visible: bool) -> Result<bool, String> {
    hide::apply_user_choice(visible)?;
    Ok(visible)
}

