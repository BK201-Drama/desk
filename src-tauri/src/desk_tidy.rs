//! 桌面散文件：列出 + 一键挪到「桌面/整理/日期」。

use serde::Serialize;
use std::path::{Path, PathBuf};

const TIDY_ROOT_NAME: &str = "整理";

#[derive(Debug, Clone, Serialize)]
pub struct DeskTidyStatusDto {
    pub clutter: u32,
    /// 将被整理的文件/文件夹名（桌面根下直接子项）
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeskTidyRunDto {
    pub moved: u32,
    pub dest: String,
}

fn user_desktop() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "cannot resolve Desktop folder".into())
}

fn is_office_doc(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "doc" | "docx" | "docm"
                    | "xls" | "xlsx" | "xlsm" | "xlsb"
                    | "ppt" | "pptx" | "pptm"
                    // WPS 常见后缀
                    | "wps" | "et" | "dps"
            )
        })
}

fn is_clutter_entry(path: &Path, name: &str) -> bool {
    if name.eq_ignore_ascii_case("desktop.ini") {
        return false;
    }
    if name == TIDY_ROOT_NAME {
        return false;
    }
    // 只收 Word / Excel / PPT（及 WPS 对应格式）；文件夹与其它散件不动
    if !path.is_file() {
        return false;
    }
    is_office_doc(path)
}

/// 桌面根下的 Office 文档（排除整理目录）。
pub fn list_clutter(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut items = Vec::new();
    let entries = std::fs::read_dir(root).map_err(|e| format!("read desktop: {e}"))?;
    for e in entries.flatten() {
        let name = e.file_name();
        let name_str = name.to_string_lossy();
        let path = e.path();
        if is_clutter_entry(&path, &name_str) {
            items.push(path);
        }
    }
    items.sort_by(|a, b| {
        a.file_name()
            .cmp(&b.file_name())
    });
    Ok(items)
}

fn unique_dest(dir: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "item".into());
    let ext = Path::new(file_name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..10_000 {
        let name = format!("{stem} ({i}){ext}");
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-dup{ext}"))
}

fn today_folder_name() -> String {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetLocalTime;
        let st = unsafe { GetLocalTime() };
        return format!("{:04}-{:02}-{:02}", st.wYear, st.wMonth, st.wDay);
    }
    #[cfg(not(windows))]
    {
        "tidy".into()
    }
}

/// 把散文件挪进 `桌面/整理/YYYY-MM-DD/`。
pub fn tidy_into_folder(root: &Path) -> Result<(u32, PathBuf), String> {
    let items = list_clutter(root)?;
    if items.is_empty() {
        return Ok((0, root.join(TIDY_ROOT_NAME)));
    }
    let dest_dir = root.join(TIDY_ROOT_NAME).join(today_folder_name());
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("create tidy folder: {e}"))?;
    let mut moved = 0u32;
    for src in items {
        let name = src
            .file_name()
            .ok_or_else(|| format!("bad path: {}", src.display()))?;
        let dest = unique_dest(&dest_dir, name);
        std::fs::rename(&src, &dest).map_err(|e| {
            format!(
                "move {} → {}: {e}",
                src.display(),
                dest.display()
            )
        })?;
        moved = moved.saturating_add(1);
    }
    Ok((moved, dest_dir))
}

#[tauri::command]
pub fn desk_tidy_status() -> Result<DeskTidyStatusDto, String> {
    let root = user_desktop()?;
    let paths = list_clutter(&root)?;
    let items: Vec<String> = paths
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    Ok(DeskTidyStatusDto {
        clutter: items.len() as u32,
        items,
    })
}

#[tauri::command]
pub fn desk_tidy_run() -> Result<DeskTidyRunDto, String> {
    let root = user_desktop()?;
    let (moved, dest) = tidy_into_folder(&root)?;
    Ok(DeskTidyRunDto {
        moved,
        dest: dest.display().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn clutter_only_office_docs() {
        let d = tempdir().unwrap();
        fs::write(d.path().join("desktop.ini"), b"").unwrap();
        fs::write(d.path().join("App.lnk"), b"").unwrap();
        fs::write(d.path().join("notes.txt"), b"x").unwrap();
        fs::write(d.path().join("报告.docx"), b"x").unwrap();
        fs::write(d.path().join("表.xlsx"), b"x").unwrap();
        fs::write(d.path().join("演示.pptx"), b"x").unwrap();
        fs::create_dir(d.path().join("folder")).unwrap();
        fs::create_dir(d.path().join(TIDY_ROOT_NAME)).unwrap();
        let items = list_clutter(d.path()).unwrap();
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn tidy_moves_into_dated_folder() {
        let d = tempdir().unwrap();
        fs::write(d.path().join("a.docx"), b"1").unwrap();
        fs::write(d.path().join("b.xlsx"), b"2").unwrap();
        fs::write(d.path().join("skip.txt"), b"3").unwrap();
        let (n, dest) = tidy_into_folder(d.path()).unwrap();
        assert_eq!(n, 2);
        assert!(dest.join("a.docx").is_file());
        assert!(dest.join("b.xlsx").is_file());
        assert!(d.path().join("skip.txt").is_file());
        assert!(list_clutter(d.path()).unwrap().is_empty());
    }
}
