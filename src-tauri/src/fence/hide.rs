//! Windows「显示桌面图标」全局开关（HKCU\...\Explorer\Advanced\HideIcons）的生命周期管理。
//! 这是新版围栏唯一还碰系统的地方 —— 所有写入都收敛在本文件内。

// Task 2 只落地「读写能力」本身，调用方在后面的任务：
//   Task 3 → is_enabled（启动自检）、disable（退出恢复）
//   Task 5 → is_enabled / enable / disable（看板开关）
// 在那之前整条链都是 dead code，而基线是零警告 —— 所以临时压一下。
// ⚠️ **Task 3 接上调用方后请删掉这一行**，让警告重新可见。
#![allow(dead_code)]

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
pub(crate) fn is_enabled() -> Result<Option<bool>, String> {
    let out = std::process::Command::new("reg")
        .args(["query", REG_PATH, "/v", "HideIcons"])
        .output()
        .map_err(|e| format!("reg query 启动失败：{e}"))?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(parse_hide_icons(&String::from_utf8_lossy(&out.stdout)))
}

pub(crate) fn enable() -> Result<(), String> {
    set_desktop_icons_hidden(true)
}

pub(crate) fn disable() -> Result<(), String> {
    set_desktop_icons_hidden(false)
}

#[cfg(test)]
mod tests {
    use super::parse_hide_icons;

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
}
