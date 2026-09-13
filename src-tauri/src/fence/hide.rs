//! Windows「显示桌面图标」全局开关（HKCU\...\Explorer\Advanced\HideIcons）的生命周期管理。
//! 这是新版围栏唯一还碰系统的地方 —— 所有写入都收敛在本文件内。

use std::path::{Path, PathBuf};
use std::process::Command;

const REG_PATH: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced";

/// 从 `reg query` 的输出里取出 HideIcons 的值。
/// 只认行首第一个 token 恰好是 `HideIcons` 的行 —— 同一 key 下还有 HideFileExt 等 DWORD。
fn parse_hide_icons(stdout: &str) -> Option<bool> {
    for line in stdout.lines() {
        let mut it = line.split_whitespace();
        if it.next() != Some("HideIcons") {
            continue;
        }
        let Some(_ty) = it.next() else { continue }; // REG_DWORD
        let Some(raw) = it.next() else { continue };
        let n = match raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
            Some(hex) => i64::from_str_radix(hex, 16).ok(),
            None => raw.parse::<i64>().ok(),
        };
        let Some(n) = n else { continue };
        return Some(n != 0);
    }
    None
}

/// Hide all desktop icons (including Recycle Bin / This PC shell icons).
pub(crate) fn set_desktop_icons_hidden(hidden: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let value = if hidden { "1" } else { "0" };
        let status = Command::new("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced",
                "/v",
                "HideIcons",
                "/t",
                "REG_DWORD",
                "/d",
                value,
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("reg HideIcons failed".into());
        }
        // refresh desktop icons
        let _ = Command::new("ie4uinit.exe")
            .arg("-show")
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let _ = Command::new("Rundll32.exe")
            .args(["user32.dll,UpdatePerUserSystemParameters"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        // Force explorer to re-read Advanced\HideIcons
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(New-Object -ComObject Shell.Application).ToggleDesktop(); Start-Sleep -Milliseconds 200; (New-Object -ComObject Shell.Application).ToggleDesktop()",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = hidden;
        Err("Windows only".into())
    }
}

/// 当前 HideIcons 的值。`None` 表示该值在注册表里不存在（等价于未隐藏）。
///
/// ⚠️ `CREATE_NO_WINDOW` 不是可有可无的美化。desk 是 **GUI 子系统**
/// （`main.rs` 的 `windows_subsystem = "windows"`，实测 PE Subsystem=2），
/// **自己没有控制台可继承**，而 `reg.exe` 是**控制台程序** —— 不带这个 flag，
/// Windows 会给它**新分配一个控制台窗口**，界面上就是一个「黑窗一闪而过」。
///
/// 2026-09-13 的真机缺陷就是漏在这里：这条命令经 `fence_icons_visible`
/// （`mod.rs`）挂在围栏面板的 setup effect 里，于是**每次点围栏标题收起/展开都闪一次**。
/// 护栏见 `src/lib/spawnFlags.test.ts`，它扫的就是这一段。
pub(crate) fn is_enabled() -> Result<Option<bool>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let out = Command::new("reg")
            .args(["query", REG_PATH, "/v", "HideIcons"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("reg query 启动失败：{e}"))?;
        if !out.status.success() {
            return Ok(None);
        }
        Ok(parse_hide_icons(&String::from_utf8_lossy(&out.stdout)))
    }
    // 非 Windows 上没有 `HideIcons` 这个值 —— 语义上等价于「从没隐藏过」。
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

pub(crate) fn enable() -> Result<(), String> {
    set_desktop_icons_hidden(true)
}

pub(crate) fn disable() -> Result<(), String> {
    set_desktop_icons_hidden(false)
}

// ── 逃生口的持久化标志 ──────────────────────────────────────────────────────
// spec §6.2 第 3 条：不依赖 desk 进程健康、不依赖注册表状态，只要用户能看见看板
// 就能一键把桌面图标要回来。标志文件存在 = 用户明确要求「显示桌面图标」。
//
// 用独立文件而不是 fence.json，是为了让本功能独立于 Task 6 的 meta v2 上线。
//
// 读写拆成「纯函数收路径」+「薄封装解析真路径」两层：下面两个纯函数能拿临时目录
// 单测，**不会去碰真实的 %LOCALAPPDATA%\desk\icons-visible** ——
// 单测里误建那个文件会让 desk 以为用户要求显示图标，是个很隐蔽的副作用。

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
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    Ok(base.join("desk").join("icons-visible"))
}

/// 用户是否明确要求「显示桌面图标」。
/// 读不到路径 / 文件不存在都算「没要求」—— 逃生口的默认值是「不干预」。
pub(crate) fn user_wants_visible() -> bool {
    visible_flag_path().map(|p| flag_exists_at(&p)).unwrap_or(false)
}

pub(crate) fn set_user_wants_visible(v: bool) -> Result<(), String> {
    set_flag_at(&visible_flag_path()?, v)
}

/// INV-3 兜底：注册表里是 1，但本地没有任何认领它的接管记录 → 说明上次异常退出
/// 且状态已无人负责。主动置 0，宁可少隐藏一次，也不让系统停在无人认领的改造状态。
///
/// 返回 true 表示执行了恢复。
pub(crate) fn recover_orphan_hidden_state() -> Result<bool, String> {
    if is_enabled()? != Some(true) {
        return Ok(false);
    }
    // 用户明确按过「显示桌面图标」→ 这个 1 一定是残留，不用再看别的证据。
    // 必须排在接管记录检查**前面**：`hide.owned` 是过期的 true 时，
    // 只看 meta 会把「用户要求显示」误判成「有主」，逃生口就失效了。
    if user_wants_visible() {
        disable()?;
        return Ok(true);
    }
    // fence.json 里有「这个 1 是我收的」这条认领记录 → 有主人，不动。
    // v1 查的是 vault.json 的 items/hide_icons_applied；Task 12 之后接管不复存在，
    // 认领记录只剩 `hide.owned` 一项（`hide_desktop_icons_on_start` / 逃生开关写它）。
    // 读不到 fence.json（不存在 / 坏了）按「没有认领」处理，和 v1 的 `if let Ok` 一致。
    if let Ok(m) = crate::fence::meta::load() {
        if m.hide.owned {
            return Ok(false);
        }
    }
    disable()?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{flag_exists_at, parse_hide_icons, set_flag_at};

    #[test]
    fn parse_empty_is_none() {
        assert_eq!(parse_hide_icons(""), None);
    }

    #[test]
    fn parse_enabled() {
        let out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\r\n    HideIcons    REG_DWORD    0x1\r\n";
        assert_eq!(parse_hide_icons(out), Some(true));
    }

    #[test]
    fn parse_disabled() {
        let out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\r\n    HideIcons    REG_DWORD    0x0\r\n";
        assert_eq!(parse_hide_icons(out), Some(false));
    }

    #[test]
    fn parse_ignores_other_dword() {
        // 同一个 key 下还有别的 DWORD；必须只认 HideIcons 这一行
        let out = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced\r\n    HideFileExt    REG_DWORD    0x1\r\n";
        assert_eq!(parse_hide_icons(out), None);
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
        // 幂等：重复清一个不存在的标志不算错（卸载/重复点击都会走到）
        set_flag_at(&p, false).expect("clear twice");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
