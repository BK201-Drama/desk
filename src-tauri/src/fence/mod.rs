//! Desktop icon vault: icons live only in fences, not on the Windows desktop.

pub(crate) mod hide;
pub(crate) mod index;
pub(crate) mod meta;
pub(crate) mod migrate;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceItemDto {
    pub id: String,
    pub label: String,
    pub path: String,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceDto {
    pub name: String,
    pub items: Vec<FenceItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceLayoutDto {
    pub name: String,
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct VaultMeta {
    /// original desktop path -> vault relative name
    items: Vec<VaultEntry>,
    hide_icons_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultEntry {
    id: String,
    label: String,
    vault_name: String,
    fence: String,
    original_name: String,
    #[serde(default = "default_origin")]
    origin: String,
    #[serde(default)]
    is_dir: bool,
}

fn default_origin() -> String {
    "user".into()
}

/// Installer / manual setup may drop `desk.lnk` on the desktop — never vault it.
fn is_self_desk_shortcut(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "desk.lnk" || lower == "desk.url" || lower == "desk.lnk.lnk"
}

fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn vault_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("vault");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn icons_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("icons");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn meta_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join("vault.json"))
}

fn load_meta() -> Result<VaultMeta, String> {
    let p = meta_path()?;
    if !p.exists() {
        return Ok(VaultMeta::default());
    }
    let s = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn save_meta(meta: &VaultMeta) -> Result<(), String> {
    let p = meta_path()?;
    let s = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(p, s).map_err(|e| e.to_string())
}

fn desktop_dir() -> Result<PathBuf, String> {
    dirs::desktop_dir().ok_or_else(|| "cannot resolve Desktop folder".into())
}

fn public_desktop_dir() -> Option<PathBuf> {
    // C:\Users\Public\Desktop
    let public = std::env::var_os("PUBLIC")?;
    let p = PathBuf::from(public).join("Desktop");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// All desktop roots we clear: user Desktop + Public Desktop.
fn desktop_roots() -> Result<Vec<(String, PathBuf)>, String> {
    let mut roots = vec![("user".into(), desktop_dir()?)];
    if let Some(p) = public_desktop_dir() {
        roots.push(("public".into(), p));
    }
    Ok(roots)
}

fn guess_fence(name: &str) -> &'static str {
    let n = name.to_lowercase();
    let game_keys = [
        "counter-strike",
        "cs2",
        "dota",
        "terraria",
        "yugioh",
        "yu-gi-oh",
        "chess",
        "pvz",
        "穿越火线",
        "英雄联盟",
        "饥荒",
        "黎明杀机",
        "wegame",
        "1.91",
    ];
    if game_keys.iter().any(|k| n.contains(k)) {
        return "游戏";
    }
    let work_keys = ["飞书", "文献", "office", "excel", "word", "outlook"];
    if work_keys.iter().any(|k| n.contains(k)) {
        return "工作";
    }
    "工具"
}

fn safe_id(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c == ' ' {
                '_'
            } else {
                '_'
            }
        })
        .collect()
}

fn extract_icon_png(src: &Path, dest: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // ⚠️ 下面 `script` 里的内容**必须保持纯 ASCII**，包括注释和 C# 源码。
        //
        // 脚本由 `fs::write` 落盘，是 UTF-8 **无 BOM**；Windows PowerShell 5.1
        // 读无 BOM 文件时按 **ANSI** 解码 —— 非 ASCII 字节会被拆成乱码字符，
        // 轻则字符串变样，重则把 `@'...'@` here-string 的边界冲掉，
        // 报满屏 `ParserError: ParentContainsErrorRecordException`（实测踩过）。
        // 中文解释写在这层 Rust 注释里，别写进脚本。
        //
        // Resolve .lnk/.url → target (or IconLocation) so Windows does NOT bake in
        // the shortcut-arrow overlay. ExtractAssociatedIcon(.lnk) always overlays.
        let src_s = src.to_string_lossy().replace('\'', "''");
        let dest_s = dest.to_string_lossy().replace('\'', "''");
        let script = format!(
            r#"
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$src = '{src_s}'
$dest = '{dest_s}'
$ext = [IO.Path]::GetExtension($src).ToLowerInvariant()

function Save-Icon([string]$path, [int]$index) {{
  if (-not (Test-Path -LiteralPath $path)) {{ return $false }}
  $code = @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public static class DeskCleanIcon {{
  [DllImport("User32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string f, int i, int cx, int cy, IntPtr[] ph, uint[] pid, uint n, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  public static bool Save(string file, int index, int px, string dest) {{
    IntPtr[] icons = new IntPtr[1];
    uint[] ids = new uint[1];
    if (PrivateExtractIcons(file, index, px, px, icons, ids, 1, 0) == 0 || icons[0] == IntPtr.Zero) return false;
    using (Icon icon = (Icon)Icon.FromHandle(icons[0]).Clone()) {{
      DestroyIcon(icons[0]);
      using (Bitmap bmp = new Bitmap(px, px, PixelFormat.Format32bppArgb))
      using (Graphics g = Graphics.FromImage(bmp)) {{
        g.Clear(Color.Transparent);
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.DrawIcon(icon, new Rectangle(0, 0, px, px));
        bmp.Save(dest, ImageFormat.Png);
      }}
    }}
    return true;
  }}
}}

// Directory-only: SHGetFileInfo returns the shell's standard folder icon.
// Neither of the other two APIs works on a directory -- PrivateExtractIcons
// returns 0, ExtractAssociatedIcon throws.
public static class DeskShellIcon {{
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct SHFILEINFO {{
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }}
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);
  [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr h);
  public static bool Save(string path, int px, string dest) {{
    const uint SHGFI_ICON = 0x100;
    SHFILEINFO fi = new SHFILEINFO();
    IntPtr r = SHGetFileInfo(path, 0, ref fi, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_ICON);
    if (r == IntPtr.Zero || fi.hIcon == IntPtr.Zero) return false;
    try {{
      using (Icon icon = (Icon)Icon.FromHandle(fi.hIcon).Clone())
      using (Bitmap bmp = new Bitmap(px, px, PixelFormat.Format32bppArgb))
      using (Graphics g = Graphics.FromImage(bmp)) {{
        g.Clear(Color.Transparent);
        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        g.DrawIcon(icon, new Rectangle(0, 0, px, px));
        bmp.Save(dest, ImageFormat.Png);
      }}
    }} finally {{ DestroyIcon(fi.hIcon); }}
    return true;
  }}
}}
'@
  if (-not ("DeskCleanIcon" -as [type])) {{
    Add-Type -TypeDefinition $code -ReferencedAssemblies System.Drawing
  }}
  # Directories go through SHGetFileInfo. Must stay AFTER Add-Type, since the
  # type only exists once the C# above has been compiled.
  #
  # Why not let a directory fall through to ExtractAssociatedIcon below: that API
  # throws on directories, and $ErrorActionPreference='Stop' promotes an exception
  # raised inside a function to a terminating error, so the script dies before
  # reaching its own last-ditch `Save-Icon $src 0` fallback. Measured on
  # user-opc-thinking-14.lnk (points at a directory) -- that is why it had no icon.
  if ((Get-Item -LiteralPath $path -ErrorAction SilentlyContinue).PSIsContainer) {{
    return [DeskShellIcon]::Save($path, 64, $dest)
  }}
  if ([DeskCleanIcon]::Save($path, $index, 64, $dest)) {{ return $true }}
  $i = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  if ($null -eq $i) {{ return $false }}
  $b = $i.ToBitmap()
  $b.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose(); $i.Dispose()
  return $true
}}

$ok = $false
if ($ext -eq '.lnk') {{
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($src)
  $iconLoc = $lnk.IconLocation
  $target = $lnk.TargetPath
  $idx = 0
  $iconPath = $null
  if ($iconLoc -and $iconLoc.Trim() -ne '' -and $iconLoc -ne ',') {{
    $parts = $iconLoc -split ',', 2
    $iconPath = $parts[0].Trim('"')
    if ($parts.Count -gt 1) {{ [void][int]::TryParse($parts[1], [ref]$idx) }}
    if ($idx -lt 0) {{ $idx = [Math]::Abs($idx) }}
  }}
  if ($iconPath -and (Test-Path -LiteralPath $iconPath)) {{
    $ok = Save-Icon $iconPath $idx
  }}
  if (-not $ok -and $target -and (Test-Path -LiteralPath $target)) {{
    $ok = Save-Icon $target 0
  }}
}} elseif ($ext -eq '.url') {{
  $iconFile = $null
  $idx = 0
  foreach ($line in Get-Content -LiteralPath $src -ErrorAction SilentlyContinue) {{
    if ($line -match '^\s*IconFile\s*=\s*(.+)\s*$') {{ $iconFile = $Matches[1].Trim().Trim('"') }}
    if ($line -match '^\s*IconIndex\s*=\s*(-?\d+)\s*$') {{ $idx = [Math]::Abs([int]$Matches[1]) }}
  }}
  if ($iconFile -and (Test-Path -LiteralPath $iconFile)) {{
    $ok = Save-Icon $iconFile $idx
  }}
}}

if (-not $ok) {{
  $ok = Save-Icon $src 0
}}
if (-not $ok) {{ exit 1 }}
"#
        );
        let tmp = std::env::temp_dir().join(format!(
            "desk-clean-icon-{}.ps1",
            dest.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "x".into())
        ));
        if fs::write(&tmp, &script).is_err() {
            return false;
        }
        let ok = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &tmp.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let _ = fs::remove_file(&tmp);
        ok
    }
    #[cfg(not(windows))]
    {
        let _ = (src, dest);
        false
    }
}

/// Extract a DLL resource icon (e.g. imageres.dll,-55) to PNG with alpha.
fn extract_dll_icon(dll: &str, index: i32, dest: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        if dest.exists() {
            return true;
        }
        let dest_s = dest.to_string_lossy().replace('\'', "''");
        let dll_s = dll.replace('\'', "''");
        // Write script to temp to avoid nested-quote hell in -Command
        let script = format!(
            r#"
Add-Type -AssemblyName System.Drawing
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Drawing;
using System.Drawing.Imaging;
public static class DeskPIcon {{
  [DllImport("User32.dll", CharSet = CharSet.Unicode)]
  public static extern uint PrivateExtractIcons(string f, int i, int cx, int cy, IntPtr[] ph, uint[] pid, uint n, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  public static bool Save(string dll, int index, int px, string dest) {{
    IntPtr[] icons = new IntPtr[1];
    uint[] ids = new uint[1];
    if (PrivateExtractIcons(dll, index, px, px, icons, ids, 1, 0) == 0 || icons[0] == IntPtr.Zero) return false;
    using (Icon icon = (Icon)Icon.FromHandle(icons[0]).Clone()) {{
      DestroyIcon(icons[0]);
      using (Bitmap bmp = new Bitmap(px, px, PixelFormat.Format32bppArgb))
      using (Graphics g = Graphics.FromImage(bmp)) {{
        g.Clear(Color.Transparent);
        g.DrawIcon(icon, new Rectangle(0, 0, px, px));
        bmp.Save(dest, ImageFormat.Png);
      }}
    }}
    return true;
  }}
}}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
if (-not [DeskPIcon]::Save('{dll_s}', {index}, 64, '{dest_s}')) {{ exit 1 }}
"#
        );
        let tmp = std::env::temp_dir().join(format!(
            "desk-icon-{}-{}.ps1",
            index.abs(),
            dest.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "x".into())
        ));
        if fs::write(&tmp, &script).is_err() {
            return false;
        }
        let ok = Command::new("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &tmp.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        let _ = fs::remove_file(&tmp);
        ok
    }
    #[cfg(not(windows))]
    {
        let _ = (dll, index, dest);
        false
    }
}

fn system_shell_items(icons: &Path) -> Vec<FenceItemDto> {
    // Windows shell icons live in imageres.dll (resource IDs are negative).
    // Recycle Bin empty = -55; This PC = -109.
    // 冷启动：已有 PNG 绝不再起 PowerShell（否则 fence_list 同步卡死）。
    let imageres = r"C:\Windows\System32\imageres.dll";
    let recycle_icon = icons.join("sys-recycle.png");
    let pc_icon = icons.join("sys-pc.png");
    if !recycle_icon.exists() {
        let _ = extract_dll_icon(imageres, -55, &recycle_icon);
    }
    if !pc_icon.exists() {
        let _ = extract_dll_icon(imageres, -109, &pc_icon);
    }

    vec![
        FenceItemDto {
            id: "sys-recycle".into(),
            label: "回收站".into(),
            path: "shell:RecycleBinFolder".into(),
            icon: recycle_icon
                .exists()
                .then(|| recycle_icon.to_string_lossy().to_string()),
        },
        FenceItemDto {
            id: "sys-pc".into(),
            label: "此电脑".into(),
            path: "shell:MyComputerFolder".into(),
            icon: pc_icon
                .exists()
                .then(|| pc_icon.to_string_lossy().to_string()),
        },
    ]
}

/// Move ALL Desktop items (files + folders) into vault and hide desktop icons.
/// True if user/public Desktop still has icons worth vaulting (not desktop.ini).
fn desktop_has_vaultable_items() -> Result<bool, String> {
    for (_origin, desktop) in desktop_roots()? {
        let entries = match fs::read_dir(&desktop) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            return Ok(true);
        }
    }
    Ok(false)
}

/// 隐藏桌面图标 —— **唯一的隐藏出口**。
///
/// 逃生口是硬约束（spec §6.2 第 3 条）：用户按过「显示桌面图标」之后，
/// 任何路径都不得再把它盖回去。把这个判断收在一个函数里，而不是散在各个
/// 调用点，是为了「以后新增的隐藏路径默认就是安全的」。
///
/// 失败只 `eprintln!` 不返回 Err：spec §8 要求 `HideIcons` 写失败**不阻塞启动**
/// （reg + powershell 刷 Explorer 在有些机器上会卡）。
fn hide_unless_user_wants_visible() {
    if hide::user_wants_visible() {
        return;
    }
    if let Err(e) = hide::set_desktop_icons_hidden(true) {
        eprintln!("hide desktop icons: {e}");
    }
}

#[tauri::command]
pub fn fence_takeover() -> Result<Vec<FenceDto>, String> {
    // 逃生口：用户按过「显示桌面图标」→ 不隐藏，也不再搬文件。
    // 「不再搬文件」是必须的：只不隐藏但仍把图标吸进 vault 的话，
    // 用户的桌面会莫名其妙变空 —— 那比隐藏更糟。
    if hide::user_wants_visible() {
        return list_fences_inner(&load_meta()?);
    }

    let vault = vault_dir()?;
    let icons = icons_dir()?;
    let mut meta = load_meta()?;

    // 冷启动快路径：vault 已有内容且桌面已空 → 不再跑 reg/powershell 刷 Explorer（易卡死）
    if !meta.items.is_empty() && !desktop_has_vaultable_items()? {
        if !meta.hide_icons_applied {
            // 标记意图后后台藏图标，避免首次安装后 list/takeover 同步卡主线程
            meta.hide_icons_applied = true;
            save_meta(&meta)?;
            std::thread::spawn(hide_unless_user_wants_visible);
        }
        return list_fences_inner(&meta);
    }

    let mut errors: Vec<String> = Vec::new();

    for (origin, desktop) in desktop_roots()? {
        let entries = match fs::read_dir(&desktop) {
            Ok(e) => e,
            Err(e) => {
                errors.push(format!("read {}: {e}", desktop.display()));
                continue;
            }
        };
        for ent in entries.flatten() {
            let path = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if name.eq_ignore_ascii_case("desktop.ini") {
                continue;
            }
            // 安装器可能往桌面丢 desk.lnk；desk 本身不该进围栏
            if is_self_desk_shortcut(&name) {
                let _ = fs::remove_file(&path);
                continue;
            }
            // already tracked by original name + origin?
            if let Some(existing) = meta
                .items
                .iter()
                .find(|i| i.original_name == name && i.origin == origin)
            {
                let dest = vault.join(&existing.vault_name);
                if path.exists() && !dest.exists() {
                    let _ = fs::rename(&path, &dest);
                }
                continue;
            }

            let is_dir = path.is_dir();
            let label = if is_dir {
                name.clone()
            } else {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| name.clone())
            };
            let id = format!("{}-{}-{}", origin, safe_id(&label), meta.items.len());
            let vault_name = if is_dir {
                id.clone()
            } else {
                let ext = path
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                format!("{id}{ext}")
            };
            let dest = vault.join(&vault_name);
            if let Err(e) = fs::rename(&path, &dest) {
                errors.push(format!("move {name}: {e}"));
                continue;
            }

            let icon_path = icons.join(format!("{id}.png"));
            let _ = extract_icon_png(&dest, &icon_path);

            meta.items.push(VaultEntry {
                id: id.clone(),
                label,
                vault_name,
                fence: if is_dir {
                    "文件夹".into()
                } else {
                    guess_fence(&name).to_string()
                },
                original_name: name,
                origin: origin.clone(),
                is_dir,
            });
        }
    }

    hide_unless_user_wants_visible();
    meta.hide_icons_applied = true;
    save_meta(&meta)?;
    if !errors.is_empty() {
        eprintln!("fence_takeover partial errors: {:?}", errors);
    }
    list_fences_inner(&meta)
}

#[tauri::command]
pub fn fence_list() -> Result<Vec<FenceDto>, String> {
    let mut meta = load_meta()?;
    if purge_self_desk_entries(&mut meta)? {
        save_meta(&meta)?;
    }
    // vault 里有文件但 meta 丢了（历史截断/异常写盘）→ 找回，避免图标「消失」
    if reconcile_orphan_vault_files(&mut meta)? {
        save_meta(&meta)?;
    }
    // 冷启动：list 不做全量 icon-cache 重建（可能对每项起 PowerShell）。
    // marker 缺失时放到后台，UI 先用已有/缺图标列表。
    let marker = app_data_dir()?.join(format!("icon-cache-v{ICON_CACHE_VER}"));
    if !marker.exists() {
        let meta_bg = meta.clone();
        std::thread::spawn(move || {
            if let Err(e) = refresh_icon_cache_if_needed(&meta_bg) {
                eprintln!("icon cache bg: {e}");
            }
        });
    }
    list_fences_inner(&meta)
}

/// Re-attach vault files that exist on disk but are missing from vault.json.
fn reconcile_orphan_vault_files(meta: &mut VaultMeta) -> Result<bool, String> {
    let vault = vault_dir()?;
    let icons = icons_dir()?;
    let known: std::collections::HashSet<String> =
        meta.items.iter().map(|e| e.vault_name.clone()).collect();
    let mut changed = false;
    let entries = match fs::read_dir(&vault) {
        Ok(e) => e,
        Err(_) => return Ok(false),
    };
    for ent in entries.flatten() {
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if name.eq_ignore_ascii_case("desktop.ini") || known.contains(&name) {
            continue;
        }
        let is_dir = path.is_dir();
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| name.clone());
        let (origin, label, id) = parse_vault_stem(&stem);
        let original_name = if is_dir {
            label.clone()
        } else {
            let ext = path
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            format!("{label}{ext}")
        };
        let icon_path = icons.join(format!("{id}.png"));
        if !icon_path.exists() {
            let _ = extract_icon_png(&path, &icon_path);
        }
        meta.items.push(VaultEntry {
            id,
            label: label.clone(),
            vault_name: name,
            fence: if is_dir {
                "文件夹".into()
            } else {
                guess_fence(&original_name).to_string()
            },
            original_name,
            origin,
            is_dir,
        });
        changed = true;
    }
    Ok(changed)
}

/// `user-PVZ-15` / `public-Foo_Bar-3` → (origin, label, id)
fn parse_vault_stem(stem: &str) -> (String, String, String) {
    let id = stem.to_string();
    if let Some(rest) = stem.strip_prefix("user-") {
        if let Some((label_raw, _)) = rest.rsplit_once('-') {
            if !label_raw.is_empty()
                && rest
                    .rsplit_once('-')
                    .map(|(_, n)| n.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false)
            {
                let label = label_raw.replace('_', " ");
                return ("user".into(), label, id);
            }
        }
        return ("user".into(), rest.replace('_', " "), id);
    }
    if let Some(rest) = stem.strip_prefix("public-") {
        if let Some((label_raw, _)) = rest.rsplit_once('-') {
            if !label_raw.is_empty()
                && rest
                    .rsplit_once('-')
                    .map(|(_, n)| n.chars().all(|c| c.is_ascii_digit()))
                    .unwrap_or(false)
            {
                let label = label_raw.replace('_', " ");
                return ("public".into(), label, id);
            }
        }
        return ("public".into(), rest.replace('_', " "), id);
    }
    ("user".into(), stem.replace('_', " "), id)
}

/// Drop vaulted installer shortcuts to desk itself (and their icon caches).
fn purge_self_desk_entries(meta: &mut VaultMeta) -> Result<bool, String> {
    let vault = vault_dir()?;
    let icons = icons_dir()?;
    let before = meta.items.len();
    meta.items.retain(|e| {
        if is_self_desk_shortcut(&e.original_name)
            || (e.label.eq_ignore_ascii_case("desk")
                && e.vault_name.to_ascii_lowercase().ends_with(".lnk"))
        {
            let _ = fs::remove_file(vault.join(&e.vault_name));
            let _ = fs::remove_file(icons.join(format!("{}.png", e.id)));
            false
        } else {
            true
        }
    });
    Ok(meta.items.len() != before)
}

/// v2 = extract from .lnk target (no Windows shortcut-arrow overlay).
/// v3 = 图标文件名随 meta key 改为「origin_文件名」的转义形式（index.rs::icon_file）。
///      旧名 `user-PVZ-0.png` 和新名对不上，所以这里必须升版；否则 refresh 会以为
///      缓存还在、直接跳过，迁移后就是一堆空白方块。旧文件留着无害。
const ICON_CACHE_VER: &str = "3";

fn refresh_icon_cache_if_needed(meta: &VaultMeta) -> Result<(), String> {
    let marker = app_data_dir()?.join(format!("icon-cache-v{ICON_CACHE_VER}"));
    if marker.exists() {
        return Ok(());
    }
    let vault = vault_dir()?;
    let icons = icons_dir()?;
    for e in &meta.items {
        let src = vault.join(&e.vault_name);
        if !src.exists() {
            continue;
        }
        let dest = icons.join(format!("{}.png", e.id));
        let _ = fs::remove_file(&dest);
        let _ = extract_icon_png(&src, &dest);
    }
    let _ = fs::write(&marker, ICON_CACHE_VER.as_bytes());
    Ok(())
}

fn list_fences_inner(meta: &VaultMeta) -> Result<Vec<FenceDto>, String> {
    let vault = vault_dir()?;
    let icons = icons_dir()?;
    let order = ["游戏", "工具", "工作", "文件夹", "其它"];
    let mut map: std::collections::BTreeMap<String, Vec<FenceItemDto>> =
        std::collections::BTreeMap::new();

    for e in &meta.items {
        let path = vault.join(&e.vault_name);
        if !path.exists() {
            continue;
        }
        let icon_file = icons.join(format!("{}.png", e.id));
        let icon = if icon_file.exists() {
            Some(icon_file.to_string_lossy().to_string())
        } else {
            None
        };
        map.entry(e.fence.clone()).or_default().push(FenceItemDto {
            id: e.id.clone(),
            label: e.label.clone(),
            path: path.to_string_lossy().to_string(),
            icon,
        });
    }

    // ensure system fence with shell items (only visible in board; desktop icons hidden)
    let mut fences: Vec<FenceDto> = Vec::new();
    for name in order {
        if let Some(items) = map.remove(name) {
            if !items.is_empty() {
                fences.push(FenceDto {
                    name: name.to_string(),
                    items,
                });
            }
        }
    }
    for (name, items) in map {
        if !items.is_empty() {
            fences.push(FenceDto { name, items });
        }
    }
    fences.push(FenceDto {
        name: "系统".into(),
        items: system_shell_items(&icons),
    });
    Ok(fences)
}

/// Persist custom icon order (and optional cross-fence moves). System fence is ignored.
#[tauri::command]
pub fn fence_save_order(layout: Vec<FenceLayoutDto>) -> Result<Vec<FenceDto>, String> {
    let mut meta = load_meta()?;
    let mut by_id: std::collections::HashMap<String, VaultEntry> = meta
        .items
        .drain(..)
        .map(|e| (e.id.clone(), e))
        .collect();

    let mut new_items: Vec<VaultEntry> = Vec::new();
    for block in &layout {
        if block.name == "系统" {
            continue;
        }
        for id in &block.ids {
            if id.starts_with("sys-") {
                continue;
            }
            if let Some(mut e) = by_id.remove(id) {
                e.fence = block.name.clone();
                new_items.push(e);
            }
        }
    }
    // keep any leftover entries (shouldn't normally happen)
    new_items.extend(by_id.into_values());
    meta.items = new_items;
    save_meta(&meta)?;
    list_fences_inner(&meta)
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
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            Command::new("explorer")
                .arg(&path)
                .creation_flags(CREATE_NO_WINDOW)
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

/// Restore vault items back to Desktop and show desktop icons again.
#[tauri::command]
pub fn fence_restore() -> Result<(), String> {
    let user_desktop = desktop_dir()?;
    let public_desktop = public_desktop_dir();
    let vault = vault_dir()?;
    let mut meta = load_meta()?;
    let mut errors: Vec<String> = Vec::new();
    let mut remaining: Vec<VaultEntry> = Vec::new();

    for e in meta.items.drain(..) {
        let src = vault.join(&e.vault_name);
        if !src.exists() {
            continue;
        }

        let preferred = if e.origin == "public" {
            public_desktop
                .clone()
                .unwrap_or_else(|| user_desktop.clone())
        } else {
            user_desktop.clone()
        };
        // move_path / unique_dest 已迁进 migrate.rs（Task 9）。这里先跟着改限定路径 ——
        // **行为一字未改**，fence_restore 仍是老的「还原」语义。
        // Task 10 才把它整个换成 migrate::run()（迁移入口）。分两步是为了让 Task 9
        // 只有「搬代码」这一个变量，出问题时能立刻定位。
        let dest = migrate::unique_dest(&preferred, &e.original_name, &e.vault_name);

        match migrate::move_path(&src, &dest) {
            Ok(()) => {}
            Err(_public_denied) if e.origin == "public" => {
                // 公共桌面常需管理员；回退到用户桌面，避免整批失败
                let fallback = migrate::unique_dest(&user_desktop, &e.original_name, &e.vault_name);
                if let Err(err2) = migrate::move_path(&src, &fallback) {
                    errors.push(format!("{}: {err2}", e.original_name));
                    remaining.push(e);
                }
            }
            Err(err) => {
                errors.push(format!("{}: {err}", e.original_name));
                remaining.push(e);
            }
        }
    }

    meta.items = remaining;
    if meta.items.is_empty() && meta.hide_icons_applied {
        hide::set_desktop_icons_hidden(false)?;
        meta.hide_icons_applied = false;
    }
    save_meta(&meta)?;
    if !errors.is_empty() {
        return Err(format!(
            "部分图标未能还原（{}）：{}",
            errors.len(),
            errors.join("；")
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn fence_status() -> Result<serde_json::Value, String> {
    let meta = load_meta()?;
    Ok(serde_json::json!({
        "count": meta.items.len(),
        "hide_icons": meta.hide_icons_applied,
        "vault": vault_dir()?.to_string_lossy(),
    }))
}

/// 当前桌面图标是否可见（= `HideIcons` 为 0 或未设置）。
#[tauri::command]
pub fn fence_icons_visible() -> Result<bool, String> {
    Ok(hide::is_enabled()? != Some(true))
}

/// 逃生开关：立即切换桌面图标可见性，并记住这个选择（重启 desk 不反弹）。
///
/// 除切换注册表外还要维护两处本地状态，缺一个都会让「用户的选择」跟
/// 别的机制打架：
///   - 标志文件 `icons-visible`：让 `fence_takeover` 不再隐藏、不再搬文件。
///   - `meta.hide_icons_applied`：让启动时的孤儿自检知道这个 `HideIcons` 有主。
///     只置位不清除的话，「visible=true 但 hide_icons_applied 仍是 true」这条
///     过期记录会把孤儿自检的判据带偏。
#[tauri::command]
pub fn fence_set_icons_visible(visible: bool) -> Result<bool, String> {
    if visible {
        hide::disable()?;
    } else {
        hide::enable()?;
    }
    hide::set_user_wants_visible(visible)?;

    let mut meta = load_meta()?;
    if meta.hide_icons_applied != !visible {
        meta.hide_icons_applied = !visible;
        save_meta(&meta)?;
    }
    Ok(visible)
}
