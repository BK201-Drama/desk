//! 围栏 = **真桌面的只读索引**（INV-1）。
//!
//! 图标就住在 Windows 桌面上，desk 只是把它们分组显示出来 —— 不搬、不藏、不复制。
//! 唯一会移动文件的路径是一次性的 `migrate`（把旧 vault 里的 34 项搬回桌面，
//! 见 `migrate.rs`），2026-09-13 已经跑完，再没有下一次。
//!
//! 读路径只有一条：`collect_fences()` → `scan_desktop()` → `index::build_fences()`。
//! 桌面在 desk 外面被改（新建 / 删除 / 改名）时由 `watch.rs` 盯着，重扫一遍并把
//! 新看板推给前端 —— 否则看板只是冷启动那一刻的快照。
//! 过渡期的「桌面 + vault 合并读」随 Task 12 删除；`fence.json` 里的东西全是偏好，
//! 删掉它只丢分类不丢文件（INV-4）。
//!
//! 写路径（Task 14）只有一条：`ops.rs` 的右键菜单命令。它是本模块唯一会动**用户文件**
//! 的地方，所以每个入口都先过 `ops::locate` 那道闸（只放行桌面根的**直接**子项）。

// 2026-09-14 拆走了四块（架构腐蚀清单 #7）。原先这一个文件 1371 行，装着 DTO、路径解析、
// 字符串启发式、**270 行 PE 图标提取**、隐藏策略、扫描、10 个命令、4 条真机测试。
// 现在这里只剩编排，四块各回了各自该在的地方：
//
//   paths.rs       回答「那个目录在哪」            —— 不做别的
//   classify.rs    两个 `&str -> …` 纯函数        —— 不碰 IO
//   shell_icons.rs  唯一碰 PE 与 PowerShell 的地方
//   real_machine.rs 真机验收（`#[cfg(test)]`）
//
// ⚠️ **没有 `pub(crate) use` 转出**，是刻意的：转出等于给同一个东西两条路径，
// 而「一个东西两条路」正是这一轮要消掉的那类病。调用方一律写全 `paths::icons_dir()`。
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceItemDto {
    pub id: String,
    pub label: String,
    pub path: String,
    pub icon: Option<String>,
    /// 是不是目录 —— 右键菜单按它决定「打开方式」出不出现。
    ///
    /// 前端**猜不出来**，所以必须传：`index.rs:74` 已经把文件的扩展名从 `label`
    /// 里去掉了（`Cursor.lnk` → `Cursor`），而目录名带点是常事（`v1.2 备份`），
    /// 两条猜法都会错。`ScannedItem.is_dir` 早就算好了（`index.rs:73`），
    /// 这里只是把它送到线上去。
    ///
    /// ⚠️ 前端**先**看 id 前缀（`sys-`）再看这个字段：下面那两个系统项在这里是
    /// `true`（它们确实是 shell 文件夹），但 sys 目标的菜单只剩「打开」，
    /// 那个分支永远轮不到 `is_dir`。
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceDto {
    pub name: String,
    pub items: Vec<FenceItemDto>,
    /// 这一栏现在是不是收起的（只留标题条）。来自 `fence.json` 的 `ui.collapsed`。
    ///
    /// 挂在 DTO 上而不是单开一条 `fence_ui_get`，是为了**首帧就带着它**：
    /// 分两次拿的话，用户每次启动都会看见所有围栏先展开、再「啪」地收起来。
    /// 三个读命令（`fence_list` / `fence_rescan` / `fence_save_order`）与 watcher
    /// 推帧都走 `collect_fences()`，于是四条路一次性拿到同一个口径。
    pub collapsed: bool,
    /// 用户自定义的行数。**0 = 自动**（用 `styles.css` 里那份默认）。
    /// 上界见 `index::ROWS_MAX`。
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceLayoutDto {
    pub name: String,
    pub ids: Vec<String>,
}

fn system_shell_items(icons: &Path) -> Vec<FenceItemDto> {
    // Windows shell icons live in imageres.dll (resource IDs are negative).
    // Recycle Bin empty = -55; This PC = -109.
    // 冷启动：已有 PNG 绝不再起 PowerShell（否则 fence_list 同步卡死）。
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
            id: "sys-recycle".into(),
            label: "回收站".into(),
            path: "shell:RecycleBinFolder".into(),
            icon: recycle_icon
                .exists()
                .then(|| recycle_icon.to_string_lossy().to_string()),
            is_dir: true,
        },
        FenceItemDto {
            id: "sys-pc".into(),
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
/// 逃生口是硬约束（spec §6.2 第 3 条）：用户按过「显示桌面图标」之后，
/// 任何路径都不得再把它盖回去。把这个判断收在一个函数里，而不是散在各个
/// 调用点，是为了「以后新增的隐藏路径默认就是安全的」。
///
/// 失败只 `eprintln!` 不返回 Err：spec §8 要求 `HideIcons` 写失败**不阻塞启动**
/// （reg + powershell 刷 Explorer 在有些机器上会卡）。
///
/// 「用户意愿」取 `hide::may_hide()` —— 优先级（用户意愿 > 认领记录 > 残留）
/// 全部在 `fence/hide.rs` 的 `classify` 里。这里只是取用，不要在这里再加第二个判断。
fn hide_unless_user_wants_visible() {
    if !hide::may_hide() {
        return;
    }
    if let Err(e) = hide::set_desktop_icons_hidden(true) {
        eprintln!("hide desktop icons: {e}");
    }
}

/// 启动路径的隐藏：**同步记下意图，后台真去隐藏**（取代旧 `fence_takeover` 里那两处调用）。
///
/// 记账不能省（INV-3）：`hide.owned` 不落盘的话，下次启动的孤儿自检会把这个
/// `HideIcons=1` 判成无主、自己清掉 —— 用户会看到桌面图标在两次启动之间闪回来。
///
/// Task 12 之前这本账记在 `vault.json` 里，迁移后那个文件已被归档 ——
/// 于是**每次启动都会凭空造一个新的空 `vault.json`**（真机实测：一天内两次）。
/// 现在记进 `fence.json` 的 `hide.owned`，v2 早就为此留好了字段。
///
/// 隐藏本身不能同步做：`reg add` 之后还要刷 Explorer，同步跑会卡住首屏
/// （旧 takeover 的冷启动快路径就是为了这个才把隐藏丢后台的）。
fn hide_desktop_icons_on_start() {
    // 用户按过逃生开关时**一个字都不写**：不隐藏，也**不记这条账**。
    //
    // 旧实现无条件把 `owned` 记成 true，于是「用户要求显示」的机器上每次启动都会
    // 凭空留下一条假认领 —— 同一条状态的两个真相源。它当时没出事，只是因为
    // `recover_orphan_hidden_state` 恰好先查标志文件把它压住了；换个顺序就翻。
    // 现在这条记录根本不会产生。
    //
    // INV-3 不受影响：`owned` 是给「我们收下的那个 1」用的，而这条分支下我们
    // 根本没有收下任何东西（真收下了的话下面照样记账）。
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
/// 那个布尔值是给 `meta::prune` 用的判据：**只有「每个根都读成功」的那一次扫描
/// 才有资格说「这个 key 没了」**。公共桌面一时读不到（权限 / 被占用 / 网络盘重连）时
/// 它的项一个都扫不到，拿这个结果去 prune 就会把公共桌面那一栏的偏好全清掉 ——
/// 那正是 Task 13 驳回「watcher 上挂 prune」的同一条理由，只不过换了个时机。
///
/// 用户桌面读不到则**整个失败**：看板本来就是用户桌面的索引，读不到它，
/// 「返回一个空看板」是撒谎（用户会以为文件没了）。
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

/// 桌面上的全部项（用户桌面 + 公共桌面）。**纯读**：不移动、不创建、不删除。
///
/// 尽力而为：公共桌面读不到时只显示能读到的那些。**别拿它判断「哪些项没了」** ——
/// 要那个判断请用 `scan_desktop_checked` 并检查第二个返回值。
fn scan_desktop() -> Result<Vec<index::ScannedItem>, String> {
    Ok(scan_desktop_checked()?.0)
}

/// 现在的真相源是「真桌面」（INV-1）。**全程只读** —— 本函数不移动任何文件。
///
/// Task 12 起这里**只有**桌面一条读路径：`vault.json` / `list_fences_inner` /
/// `merge_fences` 那条过渡期支线已随迁移完成一起删除。
fn collect_fences() -> Result<Vec<FenceDto>, String> {
    let items = scan_desktop()?;

    // 图标不在这里抽 —— 每缺一个就是一次 PowerShell，会把首屏卡死。
    // 由 fence_list / fence_rescan 决定前台还是后台，见 refresh_icons_once。
    Ok(index::build_fences(&items, &meta::load()?))
}

/// 补齐图标缓存：桌面项按需抽取（`index::ensure_icons`，缺什么补什么）。
///
/// 旧实现是在 `fence_takeover` 搬文件时顺手 `extract_icon_png` 的；takeover 没了之后
/// 抽取变成索引的附属步骤 —— 缓存是按 key 命名的，所以文件换了位置也能自愈。
/// 旧 vault 项的 png 缓存重建（`refresh_icon_cache_if_needed` + `ICON_CACHE_VER`）
/// 已随 vault 读路径在 Task 12 一起删除。
///
/// 一次调用可能起 30+ 次 PowerShell（迁移后的第一次启动就是「全缺」），
/// 所以耗时上不封顶 —— **前台还是后台由调用方决定**（下面两个包装各是一种）。
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

    // 顺手收掉 `fence.json` 里的孤儿条目（Task 14 §1.6）—— 用户上次运行期间在
    // 资源管理器里删掉的东西，它的分类偏好没有理由继续留着：留着的后果是同名文件
    // 以后再出现时会**静默继承**上一次的分类和排序。
    //
    // 只在 `all_ok` 时做。`fence_delete` 那一条路不需要这个判断（它删的是谁是自己
    // 拿的 key），而这里必须靠一次扫描反推，所以必须确认扫描是完整的。
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

/// 强制重扫（取代 `fence_takeover`）。**只读，不移动任何文件。**
///
/// 和 `fence_list` 的差别只有图标：调用它的场景是「用户刚做完一件事（迁移/还原），
/// 就等着看新结果」，所以图标这一遍**同步**做掉，返回的列表里图标是齐的。
#[tauri::command]
pub fn fence_rescan() -> Result<Vec<FenceDto>, String> {
    refresh_icons_once();
    collect_fences()
}

/// Persist custom icon order (and optional cross-fence moves). System fence is ignored.
#[tauri::command]
pub fn fence_save_order(layout: Vec<FenceLayoutDto>) -> Result<Vec<FenceDto>, String> {
    // v2 的写路径：**只写 fence.json**。
    //
    // 迁移前这里写的是 `vault.json`，而那个文件在 Task 11 之后已被归档成
    // `vault.json.migrated` —— 继续写它等于**当场复活一个空的 vault.json**
    // （真机实测：迁移当天的 16:59 复现，内容 `{"items": [], "hide_icons_applied": true}`）：
    // 拖拽布局静默丢失，还在盘上留下一个引信 —— 万一旧的 release 构建再被拉起，
    // 它看到「vault.json 在 + 桌面是满的」就会走完整接管，把 34 项重新吸回 vault。
    //
    // 看板项的 id 就是 meta key（`index.rs` 用的是 `it.key`），所以这里零换算。
    let mut m = meta::load()?;
    for block in &layout {
        if block.name == "系统" {
            continue;
        }
        // order 只在同一个围栏内部比大小（`index.rs` 按 (order, label) 排），
        // 所以每个围栏各自从 0 数，不必用全局计数。
        let mut order = 0u32;
        for id in &block.ids {
            if id.starts_with("sys-") {
                continue;
            }
            // or_insert 而不是 get_mut：还没记过账的项（比如迁移时落点换过根、
            // key 与账本对不上的那种）在这里被补上 —— 用户拖一下就把归属**显式**记下来。
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
    // 返回值必须和 `fence_list` 走**同一条读路径**（`collect_fences`，即真桌面）。
    // 前端 `persistOrder` 是拿这个返回值直接 setFences 的 —— 回吐一份口径不同的列表
    // （比如只回吐 meta 里记过账的那些）会让一批项的图标当场从看板上消失。
    collect_fences()
}

/// 只写**显示偏好**（收起 / 高度），不动任何归属与顺序。
///
/// 两个参数都是 `Option`，语义是「这一项改不改」而不是「改成什么」：
///   - `collapsed: None` = 别碰收起态；`Some(false)` = 展开（删键，让 json 保持干净）
///   - `rows: None` = 别碰高度；`Some(0)` = 回到「自动」（删键）
///
/// 前端**两个都显式发**（另一个发 `null`）—— 与 `fence_create` 的 `target: null`
/// 同一条规矩：不缺字段，免得依赖后端对缺键的宽容度。
///
/// 返回值必须和 `fence_list` 走**同一条读路径**（`collect_fences`），理由与
/// `fence_save_order` 那条注释完全一样：前端拿它直接 `setFences`。
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
        // 0 与缺键同义（都是「自动」），所以落盘时统一成「没有这个键」。
        // 夹上界的是 `index::ui_of`（读那一侧）—— 写这一侧原样存，
        // user 手写的 99 也在读的时候被收敛，不必两处各夹一遍。
        if r == 0 {
            m.ui.rows.remove(&name);
        } else {
            m.ui.rows.insert(name.clone(), r);
        }
    }
    meta::save(&m)?;
    collect_fences()
}

// move_path / unique_dest 已迁到 migrate.rs（Task 9）——
// 新架构下「搬动文件」只发生在那一处一次性迁移里，本模块不再自己搬东西。

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

/// 迁移入口（取代旧的「还原到系统桌面」）。**幂等**：vault 空了之后调用是空操作。
///
/// 判据是「vault 里的文件还在不在」，不是「上次跑到哪」—— 中途失败 / 断电 / 强杀
/// 都能重跑收敛（spec §5.3，INV-5）。备份、搬动、fence.json 记账、最近列表改写
/// 全在 `migrate::run()` 里，本函数只负责「报告」和「迁移后把桌面图标放出来」。
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
    // 迁移完成的含义是「图标都躺在真桌面上」——
    // 但**只在用户明确要求过显示桌面图标时**才把 HideIcons 放掉。
    // 没按过逃生口的用户，desk 运行期间照旧替他把桌面图标收着（HideIcons 绑进程寿命，
    // 见 lib.rs 的退出钩子），看板靠新读源继续显示同一批图标，注册表不需要任何变化。
    if hide::user_wants_visible() {
        // **硬失败，不吞。**这一步失败的含义是：文件确实已经搬回真桌面了，但
        // `HideIcons` 还是 1 —— 用户按的是「把图标还给我」，而他看着一个空桌面。
        // 原来这里的 `let _ =` 会把这次失败扔掉、照样返回 Ok，前端于是弹
        // 「已还原」，而桌面上一个图标都没有：报告成功、事实失败。
        //
        // 抛出去前端不用改：`FencePanel.tsx:196` 与 `:443` 两处调用点本来就是
        // `try { await invoke("fence_restore") } catch { dialog.alert("还原失败") }`。
        hide::disable()?;
    }
    Ok(serde_json::json!({ "moved": r.moved, "skipped": r.skipped }))
}
/// 围栏的诊断信息。**没有前端消费者**（只在 `host/api.ts` 的读权限白名单里），
/// 所以 Task 12 直接把 v1 的字段（`count` = vault 项数、`vault` 路径）换成了 v2 的。
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
/// 这里报的是**事实**（注册表现在是什么值），不是**意图**（谁说了算）——
/// 所以刻意**不**走 `hide::classify`。用户按了逃生开关、但改注册表那一步失败时，
/// 两者会不一致，这时如实报「还隐藏着」才对：前端 `catch` 会弹「还原失败」，
/// 用户看得见、能重试。拿意图来粉饰事实会把这个失败藏起来。
#[tauri::command]
pub fn fence_icons_visible() -> Result<bool, String> {
    Ok(hide::is_enabled()? != Some(true))
}

/// 逃生开关：立即切换桌面图标可见性，并记住这个选择（重启 desk 不反弹）。
///
/// 三处来源（注册表 / 标志文件 / `hide.owned`）的写法整体搬进了
/// `hide::apply_user_choice` —— 它们和读它们的 `classify` 现在同处一室，
/// 改一处就能看见另一处。这里只负责把它接出来。
#[tauri::command]
pub fn fence_set_icons_visible(visible: bool) -> Result<bool, String> {
    hide::apply_user_choice(visible)?;
    Ok(visible)
}

