//! Windows「显示桌面图标」全局开关（HKCU\...\Explorer\Advanced\HideIcons）的生命周期管理。
//! 这是新版围栏唯一还碰系统的地方 —— 所有写入都收敛在本文件内。
//!
//! **不写 `reg.exe`。** 关机/注销时会话正在拆掉，再 CreateProcess 控制台子进程会
//! `0xc0000142`（DllMain 失败）弹系统框；2026-09-16 真机就是 Exit → `disable()` → reg。
//! 读写一律走 Win32 Registry API；刷新 Explorer 也尽量进程内完成。
//! Exit / 关机路径用 [`disable_for_exit`]：只写注册表，**不起任何子进程、不刷壳**。

use std::path::{Path, PathBuf};

const ADVANCED_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";
const VALUE_HIDE_ICONS: &str = "HideIcons";

/// 写完 HideIcons 之后要不要通知壳层。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RefreshMode {
    /// 正常运行：进程内通知 Explorer 重读（无子进程）。
    Full,
    /// 退出 / 关机：会话可能已在拆，只落盘，绝不 CreateProcess。
    None,
}

/// Exit 钩子是否该刷壳 —— 单测钉死，防止以后又把 fan-out 加回去。
pub(crate) fn exit_skips_shell_refresh(mode: RefreshMode) -> bool {
    matches!(mode, RefreshMode::None)
}

fn hide_icons_from_dword(v: u32) -> bool {
    v != 0
}

/// Hide all desktop icons (including Recycle Bin / This PC shell icons).
pub(crate) fn set_desktop_icons_hidden(hidden: bool) -> Result<(), String> {
    set_desktop_icons_hidden_with(hidden, RefreshMode::Full)
}

fn set_desktop_icons_hidden_with(hidden: bool, refresh: RefreshMode) -> Result<(), String> {
    #[cfg(windows)]
    {
        write_hide_icons(hidden)?;
        if !exit_skips_shell_refresh(refresh) {
            refresh_desktop_icons();
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (hidden, refresh);
        Err("Windows only".into())
    }
}

/// 当前 HideIcons 的值。`None` = 注册表里没这个值（等价于未隐藏）。
#[cfg(windows)]
pub(crate) fn is_enabled() -> Result<Option<bool>, String> {
    read_hide_icons()
}

/// 非 Windows 上没有 `HideIcons` 这个值 —— 语义上等价于「从没隐藏过」。
#[cfg(not(windows))]
pub(crate) fn is_enabled() -> Result<Option<bool>, String> {
    Ok(None)
}

pub(crate) fn enable() -> Result<(), String> {
    set_desktop_icons_hidden(true)
}

pub(crate) fn disable() -> Result<(), String> {
    set_desktop_icons_hidden(false)
}

/// 进程退出 / 关机专用：只把 HideIcons 置 0，不刷壳、不起子进程。
pub(crate) fn disable_for_exit() -> Result<(), String> {
    set_desktop_icons_hidden_with(false, RefreshMode::None)
}

#[cfg(windows)]
fn write_hide_icons(hidden: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_CREATE_KEY_DISPOSITION, REG_DWORD, REG_OPTION_NON_VOLATILE, HKEY,
    };

    let subkey: Vec<u16> = std::ffi::OsStr::new(ADVANCED_SUBKEY)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let value_name: Vec<u16> = std::ffi::OsStr::new(VALUE_HIDE_ICONS)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut hkey = HKEY::default();
    let mut disposition = REG_CREATE_KEY_DISPOSITION::default();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            Some(&mut disposition as *mut _),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("RegCreateKeyEx HideIcons failed: {status:?}"));
    }

    let dword: u32 = if hidden { 1 } else { 0 };
    let bytes = dword.to_le_bytes();
    let set = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            0,
            REG_DWORD,
            Some(&bytes),
        )
    };
    let _ = unsafe { RegCloseKey(hkey) };
    if set != ERROR_SUCCESS {
        return Err(format!("RegSetValueEx HideIcons failed: {set:?}"));
    }
    Ok(())
}

#[cfg(windows)]
fn read_hide_icons() -> Result<Option<bool>, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        REG_VALUE_TYPE, HKEY,
    };

    let subkey: Vec<u16> = std::ffi::OsStr::new(ADVANCED_SUBKEY)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let value_name: Vec<u16> = std::ffi::OsStr::new(VALUE_HIDE_ICONS)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut hkey = HKEY::default();
    let open = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if open == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if open != ERROR_SUCCESS {
        return Err(format!("RegOpenKeyEx Advanced failed: {open:?}"));
    }

    let mut ty = REG_VALUE_TYPE::default();
    let mut data = [0u8; 4];
    let mut data_size = data.len() as u32;
    let query = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(value_name.as_ptr()),
            None,
            Some(&mut ty),
            Some(data.as_mut_ptr()),
            Some(&mut data_size),
        )
    };
    let _ = unsafe { RegCloseKey(hkey) };

    if query == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if query != ERROR_SUCCESS {
        return Err(format!("RegQueryValueEx HideIcons failed: {query:?}"));
    }
    if ty != REG_DWORD || data_size < 4 {
        return Ok(None);
    }
    let dword = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    Ok(Some(hide_icons_from_dword(dword)))
}

/// 进程内通知壳层；失败只吞掉 —— 注册表已经写上了，刷不刷不影响 INV-3。
#[cfg(windows)]
fn refresh_desktop_icons() {
    use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
    use windows::Win32::UI::WindowsAndMessaging::{
        SendNotifyMessageW, HWND_BROADCAST, WM_SETTINGCHANGE,
    };

    unsafe {
        let _ = SendNotifyMessageW(HWND_BROADCAST, WM_SETTINGCHANGE, None, None);
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

// ── 逃生口的持久化标志 ──────────────────────────────────────────────────────
// 标志文件存在 = 用户明确要求「显示桌面图标」。**独立于 desk 进程健康与注册表状态**
// （spec §6.2 第 3 条），用独立文件而不是 fence.json 正是为了这个。
// 下面两个纯函数只收路径：单测**绝不能碰真实的 %LOCALAPPDATA%\desk\icons-visible** ——
// 误建那个文件会让 desk 以为用户要求显示图标。

fn flag_exists_at(p: &Path) -> bool {
    p.exists()
}

fn set_flag_at(p: &Path, v: bool) -> Result<(), String> {
    if v {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(p, b"1").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(p) {
            Ok(()) => Ok(()),
            // 不存在 = 已经是目标状态，不算错
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn visible_flag_path() -> Result<PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("icons-visible"))
}

/// 用户是否明确要求「显示桌面图标」。
/// 读不到路径 / 文件不存在都算「没要求」—— 逃生口的默认值是「不干预」。
pub(crate) fn user_wants_visible() -> bool {
    visible_flag_path().map(|p| flag_exists_at(&p)).unwrap_or(false)
}

pub(crate) fn set_user_wants_visible(v: bool) -> Result<(), String> {
    set_flag_at(&visible_flag_path()?, v)
}

// ── 优先级：三个来源 → 一个结论 ────────────────────────────────────────────
// 改这里之前先读完本段，**别再往调用点加判断** —— 优先级是一个值，读它的人只拿结论。

/// 「桌面图标该不该隐藏」的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HideIntent {
    /// 用户按过逃生开关。**优先级最高**：注册表里的 1 和 `owned` 都盖不过它。
    UserWantsVisible,
    /// 没有人认领这个状态 → 该隐藏；若注册表里已经有 `HideIcons=1`，那是残留，该清。
    Unclaimed,
    /// `fence.json` 的 `hide.owned` 记着「这个 1 是我们收的」→ 别动它。
    OwnedByUs,
}

impl HideIntent {
    /// 结论允许 desk 去隐藏（或维持隐藏）桌面图标吗？
    pub(crate) fn allows_hiding(self) -> bool {
        !matches!(self, HideIntent::UserWantsVisible)
    }
}

/// 三个持久化来源 → 一个结论。**hide 状态优先级的唯一出处。**
/// 标志文件 `%LOCALAPPDATA%\desk\icons-visible`（`flag`）**恒赢**（spec §6.2 第 3 条）——
/// `owned` 哪怕是过期的 true 也压不过它，压得过的话用户按了开关图标仍被收着，逃生口就失效了。
/// `fence.json` 的 `hide.owned` 次之。注册表值**不是参数**：它是「现在隐藏着没有」这个**事实**，
/// 做成参数会把一次注册表 IO 塞回归结路径。
/// 输入空间就是 `flag × owned` 这 4 种，`classify_covers_all_inputs` 逐条钉着。
pub(crate) fn classify(flag: bool, owned: bool) -> HideIntent {
    if flag {
        HideIntent::UserWantsVisible
    } else if owned {
        HideIntent::OwnedByUs
    } else {
        HideIntent::Unclaimed
    }
}

/// 「现在允许隐藏吗？」—— 冷启动路径的窄问法，**只读标志文件**。
/// 不读 `owned`：`allows_hiding()` 只对 `UserWantsVisible` 返回 false，多读一次 `fence.json`
/// 不改变结论 —— 而两个调用点都在首屏路径上，那是白花的一次 IO。
pub(crate) fn may_hide() -> bool {
    flag_allows_hiding(user_wants_visible())
}

/// `may_hide` 的纯核心（可单测，不碰真实标志文件）。
fn flag_allows_hiding(flag: bool) -> bool {
    classify(flag, false).allows_hiding()
}

/// 逃生开关：把「用户要 visible 吗」这一个选择**同时**写到三个来源上。
/// 三处必须一起变：注册表 `HideIcons`（立刻兑现）、标志文件（让启动隐藏路径不再动它）、
/// `fence.json` 的 `hide.owned`（让启动时的孤儿自检知道这个 `HideIcons` 有主）。
/// ⚠️ **只置位不清除会让 `owned` 变成过期记录**，把孤儿自检的判据带偏。
pub(crate) fn apply_user_choice(visible: bool) -> Result<(), String> {
    if visible {
        disable()?;
    } else {
        enable()?;
    }
    set_user_wants_visible(visible)?;

    let mut m = crate::fence::meta::load()?;
    if m.hide.owned != !visible {
        m.hide.owned = !visible;
        crate::fence::meta::save(&m)?;
    }
    Ok(())
}

/// INV-3 兜底：注册表是 1 但本地没有认领它的记录 → 上次异常退出。主动置 0，
/// 宁可少隐藏一次，也不让系统停在无人认领的状态。返回 true 表示执行了恢复。
pub(crate) fn recover_orphan_hidden_state() -> Result<bool, String> {
    // 前置条件：没有 1 就没有「可恢复的东西」。优先级不在这里，在 `classify` 里。
    if is_enabled()? != Some(true) {
        return Ok(false);
    }
    // 读不到 fence.json（不存在 / 坏了）按「没有认领」处理。
    let owned = crate::fence::meta::load()
        .map(|m| m.hide.owned)
        .unwrap_or(false);

    match classify(user_wants_visible(), owned) {
        // 两种都说明这个 1 不是我们要的 → 清掉。
        HideIntent::UserWantsVisible | HideIntent::Unclaimed => {
            disable()?;
            Ok(true)
        }
        // 「这个 1 是我收的」→ 有主人，不动。
        HideIntent::OwnedByUs => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        exit_skips_shell_refresh, flag_exists_at, hide_icons_from_dword, set_flag_at, RefreshMode,
    };

    // ── 关机路径契约 ──────────────────────────────────────────────────────

    #[test]
    fn exit_path_must_skip_shell_refresh() {
        assert!(exit_skips_shell_refresh(RefreshMode::None));
        assert!(!exit_skips_shell_refresh(RefreshMode::Full));
    }

    #[test]
    fn dword_zero_means_visible() {
        assert!(!hide_icons_from_dword(0));
        assert!(hide_icons_from_dword(1));
        assert!(hide_icons_from_dword(2));
    }

    // ── 优先级（#4）────────────────────────────────────────────────────────
    // 把两个 `if` 调个位置 → 这里必红。

    /// 输入空间就是 `flag × owned` 这 4 种（注册表不是参数，见 `classify` 的注释）。
    #[test]
    fn classify_covers_all_inputs() {
        use super::{classify, HideIntent::*};
        assert_eq!(classify(true, true), UserWantsVisible);
        assert_eq!(classify(true, false), UserWantsVisible);
        assert_eq!(classify(false, true), OwnedByUs);
        assert_eq!(classify(false, false), Unclaimed);
    }

    /// **标志文件优先**：`owned` 是过期的 true 时也必须让位，否则逃生口就是失效的。
    #[test]
    fn flag_beats_ownership() {
        use super::{classify, HideIntent};
        for owned in [true, false] {
            assert_eq!(
                classify(true, owned),
                HideIntent::UserWantsVisible,
                "标志文件在时必须压过 owned={owned}"
            );
        }
    }

    /// `may_hide()` 那条窄路径不许和完整 `classify` 漂移 —— 两个入口读的是同一份状态。
    #[test]
    fn narrow_path_matches_full_classify() {
        use super::{classify, flag_allows_hiding};
        for flag in [true, false] {
            for owned in [true, false] {
                assert_eq!(
                    flag_allows_hiding(flag),
                    classify(flag, owned).allows_hiding(),
                    "flag={flag} owned={owned} 时两个入口结论不一致"
                );
            }
        }
    }

    /// `apply_user_choice` 写完之后的 flag/owned 必须落在同一个「有主」结论上：
    /// visible=true → UserWantsVisible；visible=false → OwnedByUs。
    #[test]
    fn user_choice_lands_in_a_claimed_state() {
        use super::{classify, HideIntent};
        for visible in [true, false] {
            let after = classify(visible, !visible);
            assert_ne!(
                after,
                HideIntent::Unclaimed,
                "visible={visible} 写完之后不该是无人认领态"
            );
            assert_eq!(after.allows_hiding(), !visible);
        }
    }

    /// 逃生口标志的读写契约。全程只碰临时目录，不碰真实的 icons-visible。
    #[test]
    fn flag_round_trip() {
        let dir = std::env::temp_dir().join(format!("desk-flag-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("nested").join("icons-visible");

        // 缺省 = 没要求（连父目录都不存在时也必须安全返回 false）
        assert!(!flag_exists_at(&p));
        // 置位要顺手建父目录，否则首次点击会失败
        set_flag_at(&p, true).expect("set true");
        assert!(flag_exists_at(&p));
        set_flag_at(&p, false).expect("set false");
        assert!(!flag_exists_at(&p));
        // 幂等：重复清一个不存在的标志不算错
        set_flag_at(&p, false).expect("clear twice");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
