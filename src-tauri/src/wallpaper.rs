//! 读当前 Windows 壁纸路径并采样平均色（供左侧 wallpaper-tint 插件）。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct WallpaperSampleDto {
    pub ok: bool,
    pub path: String,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub hint: String,
}

fn fail(hint: impl Into<String>) -> WallpaperSampleDto {
    WallpaperSampleDto {
        ok: false,
        path: String::new(),
        r: 0,
        g: 0,
        b: 0,
        hint: hint.into(),
    }
}

#[cfg(windows)]
fn path_from_spi() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };

    let mut buf = vec![0u16; 2048];
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    if ok.is_err() {
        return None;
    }
    let nul = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let path = String::from_utf16_lossy(&buf[..nul]);
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

#[cfg(windows)]
fn path_from_registry() -> Option<String> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        REG_VALUE_TYPE,
    };

    unsafe {
        let mut hkey = Default::default();
        let sub = windows::core::w!("Control Panel\\Desktop");
        if RegOpenKeyExW(HKEY_CURRENT_USER, sub, 0, KEY_READ, &mut hkey).is_err() {
            return None;
        }
        let name = windows::core::w!("WallPaper");
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let _ = RegQueryValueExW(hkey, name, None, Some(&mut ty), None, Some(&mut size));
        if size == 0 || ty != REG_SZ {
            let _ = RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let q = RegQueryValueExW(
            hkey,
            name,
            None,
            Some(&mut ty),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if q != ERROR_SUCCESS {
            return None;
        }
        let u16s: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&c| c != 0)
            .collect();
        let path = String::from_utf16_lossy(&u16s);
        let path = path.trim();
        if path.is_empty() {
            None
        } else {
            Some(path.to_string())
        }
    }
}

#[cfg(windows)]
fn transcoded_wallpaper() -> Option<PathBuf> {
    let base = dirs::config_dir()?.join("Microsoft\\Windows\\Themes\\TranscodedWallpaper");
    if base.is_file() {
        Some(base)
    } else {
        None
    }
}

/// 候选路径：SPI → 注册表 → TranscodedWallpaper；过滤不存在的。
fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        for s in [path_from_spi(), path_from_registry()].into_iter().flatten() {
            let p = PathBuf::from(s);
            if p.is_file() {
                out.push(p);
            }
        }
        if let Some(t) = transcoded_wallpaper() {
            if !out.iter().any(|p| p == &t) {
                out.push(t);
            }
        }
    }
    out
}

fn sample_average(path: &Path) -> Result<(u8, u8, u8), String> {
    // 无扩展名的 TranscodedWallpaper 也要能猜格式
    let img = image::ImageReader::open(path)
        .map_err(|e| format!("open wallpaper: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("guess wallpaper format: {e}"))?
        .decode()
        .map_err(|e| format!("decode wallpaper: {e}"))?;
    let small = img.thumbnail(48, 48).to_rgb8();
    let (w, h) = small.dimensions();
    if w == 0 || h == 0 {
        return Err("wallpaper thumbnail empty".into());
    }
    let mut sum_r: u64 = 0;
    let mut sum_g: u64 = 0;
    let mut sum_b: u64 = 0;
    let n = (w as u64) * (h as u64);
    for p in small.pixels() {
        sum_r += u64::from(p[0]);
        sum_g += u64::from(p[1]);
        sum_b += u64::from(p[2]);
    }
    Ok(((sum_r / n) as u8, (sum_g / n) as u8, (sum_b / n) as u8))
}

#[tauri::command]
pub fn wallpaper_sample() -> WallpaperSampleDto {
    let candidates = candidate_paths();
    if candidates.is_empty() {
        return fail("找不到可用的壁纸文件（SPI/注册表/TranscodedWallpaper）");
    }
    let mut last_err = String::new();
    for path in &candidates {
        match sample_average(path) {
            Ok((r, g, b)) => {
                return WallpaperSampleDto {
                    ok: true,
                    path: path.display().to_string(),
                    r,
                    g,
                    b,
                    hint: String::new(),
                };
            }
            Err(e) => last_err = format!("{}: {e}", path.display()),
        }
    }
    fail(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail_shape() {
        let d = fail("x");
        assert!(!d.ok);
        assert_eq!(d.hint, "x");
    }
}
