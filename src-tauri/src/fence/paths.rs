//! fence 会碰的那些路径，集中在这里。**本文件不做 IO 以外的事** —— 不分类、不扫描、
//! 不认识 PE，只回答「那个目录在哪」。

use std::path::PathBuf;

/// desk 的本地数据目录（`%LOCALAPPDATA%\desk`）。**顺手建出来**：调用方几乎都要往里写。
pub(super) fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 抽取出来的图标 PNG 的落脚处。**顺手建出来**。
pub(super) fn icons_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("icons");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub(super) fn desktop_dir() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "cannot resolve Desktop folder".into())
}

pub(super) fn public_desktop_dir() -> Option<PathBuf> {
    let public = std::env::var_os("PUBLIC")?;
    let p = PathBuf::from(public).join("Desktop");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// All desktop roots we clear: user Desktop + Public Desktop.
pub(super) fn desktop_roots() -> Result<Vec<(String, PathBuf)>, String> {
    let mut roots = vec![("user".into(), desktop_dir()?)];
    if let Some(p) = public_desktop_dir() {
        roots.push(("public".into(), p));
    }
    Ok(roots)
}
