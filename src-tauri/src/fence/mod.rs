//! 围栏 = **真桌面的只读索引**（INV-1）。
//!
//! 图标就住在 Windows 桌面上，desk 只是把它们分组显示出来 —— 不搬、不藏、不复制。
//! 唯一会移动文件的路径是一次性的 `migrate`（把旧 vault 里的 33 项搬回桌面，
//! 见 `migrate.rs`），跑完就再没有下一次。
//!
//! ⚠️ 过渡期：`vault.json` / `list_fences_inner` 这条旧读路径还在（Task 10 保留，
//! Task 12 删），为的是从旧架构切过来的过程中，用户的图标一刻都不会消失。

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

/// 启动路径的隐藏：**同步记下意图，后台真去隐藏**（取代旧 `fence_takeover` 里那两处调用）。
///
/// 记账不能省（INV-3）：`hide_icons_applied` 不落盘的话，下次启动的孤儿自检会把
/// 这个 `HideIcons=1` 判成无主、自己清掉 —— 用户会看到桌面图标在两次启动之间闪回来。
///
/// 隐藏本身不能同步做：`reg add` 之后还要刷 Explorer，同步跑会卡住首屏
/// （旧 takeover 的冷启动快路径就是为了这个才把隐藏丢后台的）。
fn hide_desktop_icons_on_start() {
    if let Ok(mut meta) = load_meta() {
        if !meta.hide_icons_applied {
            meta.hide_icons_applied = true;
            if let Err(e) = save_meta(&meta) {
                eprintln!("mark hide intent: {e}");
            }
        }
    }
    std::thread::spawn(hide_unless_user_wants_visible);
}

/// 桌面上的全部项（用户桌面 + 公共桌面）。**纯读**：不移动、不创建、不删除。
fn scan_desktop() -> Result<Vec<index::ScannedItem>, String> {
    let mut items: Vec<index::ScannedItem> = Vec::new();
    for (origin, root) in desktop_roots()? {
        items.extend(index::scan_root(&origin, &root));
    }
    Ok(items)
}

/// 现在的真相源是「真桌面」（INV-1）。**全程只读** —— 本函数不移动任何文件。
///
/// 迁移（Task 11）完成前，vault 里的项也一并列出：用户的图标在切换读源的
/// 过程中一刻都不会消失。
fn collect_fences() -> Result<Vec<FenceDto>, String> {
    let items = scan_desktop()?;

    // 图标不在这里抽 —— 每缺一个就是一次 PowerShell，会把首屏卡死。
    // 由 fence_list / fence_rescan 决定前台还是后台，见 refresh_icons_once。
    let mut fences = index::build_fences(&items, &meta::load()?);

    let mut meta_old = load_meta()?;
    if !meta_old.items.is_empty() {
        // vault 里还有东西（旧架构遗留）→ 先修补账本，再并进读源。
        // 这两步只是在维护旧账本，Task 12 删掉 vault 读路径时一并消失。
        let mut dirty = purge_self_desk_entries(&mut meta_old)?;
        dirty |= reconcile_orphan_vault_files(&mut meta_old)?;
        if dirty {
            save_meta(&meta_old)?;
        }
        merge_fences(&mut fences, list_fences_inner(&meta_old)?);
    }
    Ok(fences)
}

/// 把 vault 读出来的围栏并进桌面读出来的围栏：同名围栏合到一起，
/// vault 项追加在桌面项之后，**按 id 去重**。
///
/// 去重是必须的：迁移跑到一半时同一项两边都在（桌面已搬回一份、账本还没记完），
/// 不去重就会画两遍。
fn merge_fences(dst: &mut Vec<FenceDto>, src: Vec<FenceDto>) {
    for f in src {
        match dst.iter().position(|d| d.name == f.name) {
            Some(i) => {
                for it in f.items {
                    if !dst[i].items.iter().any(|e| e.id == it.id) {
                        dst[i].items.push(it);
                    }
                }
            }
            None => dst.push(f),
        }
    }
}

/// 补齐图标缓存：桌面项按需抽取，旧 vault 项走 marker 驱动的刷新。
///
/// 旧实现是在 `fence_takeover` 搬文件时顺手 `extract_icon_png` 的；takeover 没了之后
/// 抽取变成索引的附属步骤（`index::ensure_icons`，缺什么补什么，对迁移后的新 key 自愈）。
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
    // marker 在时是一次 exists() 就返回；缺了才重建（旧 vault 项的 png）。
    // Task 12 之后 vault 读路径整个消失，这里就只剩 ensure_icons。
    if let Ok(m) = load_meta() {
        if let Err(e) = refresh_icon_cache_if_needed(&m) {
            eprintln!("icon cache: {e}");
        }
    }
}

/// 冷启动走这条：图标丢后台，首屏先用「有就用、没有就空着」的列表渲染。
fn refresh_icons_in_background() {
    std::thread::spawn(refresh_icons_once);
}

#[tauri::command]
pub fn fence_list() -> Result<Vec<FenceDto>, String> {
    // 冷启动主路径：**先给列表，再做重活**。隐藏桌面图标与抽图标都在后台。
    let fences = collect_fences()?;
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
    // 返回的是**合并读源**（桌面 + vault），不是 `list_fences_inner(&meta)`。
    // 拖一下图标就只回吐 vault 那一半的话，桌面项的图标会当场从看板上消失 ——
    // 前端 persistOrder 是拿这个返回值直接 setFences 的。
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
        let _ = hide::disable();
    }
    Ok(serde_json::json!({ "moved": r.moved, "skipped": r.skipped }))
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
///   - 标志文件 `icons-visible`：让 `fence_list` 的启动隐藏路径不再动 `HideIcons`。
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

#[cfg(test)]
mod tests {
    use super::{merge_fences, FenceDto, FenceItemDto};

    fn item(id: &str, path: &str) -> FenceItemDto {
        FenceItemDto {
            id: id.into(),
            label: id.into(),
            path: path.into(),
            icon: None,
        }
    }

    fn fence(name: &str, ids: &[&str]) -> FenceDto {
        FenceDto {
            name: name.into(),
            items: ids.iter().map(|i| item(i, &format!("p/{i}"))).collect(),
        }
    }

    fn shape(dst: &[FenceDto]) -> Vec<(String, Vec<String>)> {
        dst.iter()
            .map(|f| (f.name.clone(), f.items.iter().map(|i| i.id.clone()).collect()))
            .collect()
    }

    #[test]
    fn merge_appends_vault_items_after_desktop_ones() {
        // 桌面项在前、vault 项在后：顺序稳定，用户看到的既有排列不会因为合并而跳
        let mut dst = vec![fence("工具", &["user:a.lnk"])];
        merge_fences(&mut dst, vec![fence("工具", &["old-a"])]);
        assert_eq!(
            shape(&dst),
            vec![("工具".to_string(), vec!["user:a.lnk".into(), "old-a".into()])]
        );
    }

    #[test]
    fn merge_dedupes_items_present_on_both_sides() {
        // 迁移跑到一半的真实形态：文件已经搬回桌面（新 key 能扫到），
        // vault.json 里那条旧记录还没销账 → 两边都在。必须只画一次。
        let mut dst = vec![fence("工具", &["user:a.lnk", "user:b.lnk"])];
        merge_fences(&mut dst, vec![fence("工具", &["user:a.lnk"])]);
        assert_eq!(
            shape(&dst),
            vec![(
                "工具".to_string(),
                vec!["user:a.lnk".into(), "user:b.lnk".into()]
            )]
        );
    }

    #[test]
    fn merge_keeps_fences_only_the_vault_side_has() {
        // 迁移未完成时 vault 那边独有的围栏（还一项都没搬）不能被丢掉，
        // 否则那一组图标会从看板上整组消失。
        let mut dst = vec![fence("工具", &["user:a.lnk"])];
        merge_fences(&mut dst, vec![fence("游戏", &["old-game"])]);
        assert_eq!(
            shape(&dst),
            vec![
                ("工具".to_string(), vec!["user:a.lnk".into()]),
                ("游戏".to_string(), vec!["old-game".into()]),
            ]
        );
    }

    #[test]
    fn merge_into_empty_is_a_copy() {
        // 迁移完成后（vault 空）走的就是这条：fence_list 直接是桌面读源
        let mut dst: Vec<FenceDto> = Vec::new();
        merge_fences(&mut dst, vec![fence("系统", &["sys-pc"])]);
        assert_eq!(shape(&dst), vec![("系统".to_string(), vec!["sys-pc".into()])]);
    }
}

/// 真机验收（默认 `#[ignore]`）：读**真实桌面 + 真实 vault**。
///
/// 跑法：`cargo test -- --ignored real_machine`
///
/// ⚠️ 其中 `real_machine_migrate_vault_to_desktop` 是**不可逆**的那一条，必须**单独**跑
/// （`cargo test -- --ignored real_machine_migrate`）：它搬真实文件，和别的真机测试并行会互相打架。
///
/// 计划 Task 10 Step 7 的四条手工验收，要的都是「读一次真数据看看」——
/// 那就没必要非得开 `tauri dev` 用眼睛看：这里直接调生产函数 `collect_fences()`，
/// 读的是同一份真实数据，还比肉眼多两条断言（图标仍在桌面上、vault 一个文件都没动）。
///
/// 唯一真需要人看的是「界面画出来什么样」—— 那部分归 e2e 的样式审查，
/// 以及迁移后（Task 11）打开看板亲眼确认。
#[cfg(test)]
mod real_machine_tests {
    use super::*;

    /// 探针文件：`Drop` 时删掉 —— 断言失败 / panic 也不会在真桌面上留垃圾。
    struct Probe {
        path: PathBuf,
    }

    impl Probe {
        fn new() -> Probe {
            let (_origin, root) = desktop_roots().expect("desktop roots")[0].clone();
            let path = root.join("__desk_task10_probe__.txt");
            std::fs::write(&path, b"desk index probe").expect("write probe");
            Probe { path }
        }
    }

    impl Drop for Probe {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    fn all_items() -> Vec<FenceItemDto> {
        collect_fences()
            .expect("collect_fences")
            .into_iter()
            .flat_map(|f| f.items)
            .collect()
    }

    #[test]
    #[ignore = "真机：读真实桌面 + 真实 vault"]
    fn real_machine_desktop_file_is_indexed_left_in_place_and_gone_after_delete() {
        // 一条测试走完整个生命周期，而不是拆成两条 —— 拆开的话两个 test 线程会
        // 同时往桌面写同名探针，`read_dir` 计数当场互相打架（实测踩过）。
        let probe = Probe::new();
        let desktop = probe.path.parent().unwrap().to_path_buf();
        let before = std::fs::read_dir(&desktop).unwrap().count();

        let items = all_items();
        let found = items
            .iter()
            .find(|i| Path::new(&i.path) == probe.path)
            .unwrap_or_else(|| {
                panic!(
                    "桌面上的探针没进围栏（共 {} 项，没一项对上 {}）",
                    items.len(),
                    probe.path.display()
                )
            });

        // ① 它在看板里，label 是文件名去掉扩展名
        assert_eq!(found.label, "__desk_task10_probe__");
        // ② 它**还在桌面上** —— 这一条就是 Task 10 的全部意义
        assert!(probe.path.exists(), "图标被搬走了");
        // ③ 整个过程中桌面不多不少
        assert_eq!(
            before,
            std::fs::read_dir(&desktop).unwrap().count(),
            "collect_fences 改动了桌面目录"
        );

        // ④ 删掉文件 → 下一次读就不再出现：读源是实时的，不是缓存
        let path = probe.path.clone();
        drop(probe);
        assert!(!path.exists());
        assert!(
            !all_items().iter().any(|i| Path::new(&i.path) == path),
            "文件都删了还留在看板上 —— 读源不是实时的"
        );
    }

    /// 迁移**之后**的稳态：看板上一个 vault 项都不该再有。
    ///
    /// 这条取代了迁移前的 `real_machine_vault_items_still_listed_and_untouched`
    /// （它断言 `from_vault > 0`）。那条是过渡期的守卫 —— 「切读源的那一刻图标不能消失」，
    /// 现在这件事由迁移测试的 `desktop_item_count() == 迁移前 + 34` 直接守住，
    /// 原断言留在原地只会变成一个必然失败的假警报。改成守反方向：
    /// **vault 层已经不在读路径上了**，Task 12 删掉读源之后这条仍是有效的回归网。
    #[test]
    #[ignore = "真机：读真实桌面"]
    fn real_machine_no_item_comes_from_vault() {
        let vault = vault_dir().expect("vault dir");
        let listing = |d: &PathBuf| -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(d)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            v.sort();
            v
        };
        let before = listing(&vault);

        let items = all_items();
        let from_vault: Vec<&String> = items
            .iter()
            .filter(|i| Path::new(&i.path).parent() == Some(vault.as_path()))
            .map(|i| &i.id)
            .collect();

        assert_eq!(before, listing(&vault), "collect_fences 动了 vault 目录");
        eprintln!("围栏共 {} 项，其中 vault 来的 {} 项", items.len(), from_vault.len());
        assert!(
            from_vault.is_empty(),
            "迁移（Task 11）之后读源只剩桌面，这些项却还从 vault 来：{from_vault:?}"
        );
    }

    /// `%LOCALAPPDATA%\desk` 下的两个文件路径，测试直接读盘核对（不经过 recent:: 的私有类型）。
    fn desk_file(name: &str) -> PathBuf {
        dirs::data_local_dir()
            .expect("local app data")
            .join("desk")
            .join(name)
    }

    /// 目录里的条目数（文件 + 子目录）。
    fn count_entries(d: &Path) -> usize {
        std::fs::read_dir(d).map(|it| it.flatten().count()).unwrap_or(0)
    }

    /// 另一个桌面根。迁移时公共桌面不可写会退回用户桌面，key 里的 origin 也就跟着变。
    fn other_origin(origin: &str) -> &'static str {
        if origin == "public" {
            "user"
        } else {
            "public"
        }
    }

    /// 逐项核对：迁移前在哪个围栏，迁移后还在哪个围栏。
    ///
    /// `expected` 是 `(迁移前 origin, 原文件名, 迁移前围栏)`。**只读**，所以首次跑和
    /// 事后重跑都能用同一份断言 —— 重跑时 `expected` 从归档的 `vault.json.migrated` 读回来。
    fn check_each_item_kept_its_fence(
        fences: &[FenceDto],
        m: &meta::FenceMeta,
        expected: &[(String, String, String)],
    ) {
        let where_is: std::collections::HashMap<&str, &str> = fences
            .iter()
            .flat_map(|f| f.items.iter().map(move |it| (it.id.as_str(), f.name.as_str())))
            .collect();

        for (origin, name, fence) in expected {
            // 落点在哪个桌面根上，代码自己可能改主意（公共桌面不可写时退回用户桌面），
            // 所以两个 origin 都试一遍。
            //
            // ⚠️ key 必须从**看板**里挑，不能从迁移账本里挑。看板是扫桌面算出来的 ——
            // 「文件躺在哪个根上」对它来说是地面真相；从账本里挑等于让被告自己作证：
            // 账本把 key 写错（public 项退回用户桌面却记 public:）时，两边"自洽"地
            // 一起错，断言照样通过。真机迁移就是这么放过去一条的（星云.lnk）。
            let want = meta::key(origin, name);
            let k = [want.clone(), meta::key(other_origin(origin), name)]
                .into_iter()
                .find(|k| where_is.contains_key(k.as_str()))
                .unwrap_or_else(|| {
                    panic!(
                        "{name} 不在看板里 —— 迁移后这个图标看不见了\
                         （围栏账本里记的是 {origin} 一侧的 key：{:?}）",
                        m.entries
                            .keys()
                            .filter(|x| x.as_str().ends_with(name.as_str()))
                            .collect::<Vec<_>>()
                    )
                });
            if k != want {
                eprintln!("注意：{name} 的落点换了桌面根（期望 {want}，实际 {k}），围栏不变");
            }
            assert_eq!(
                m.entries.get(&k).map(|e| e.fence.as_str()),
                Some(fence.as_str()),
                "fence.json 里 {k} 的围栏归属和迁移前不一致"
            );
            assert_eq!(
                where_is.get(k.as_str()).copied(),
                Some(fence.as_str()),
                "{k} 没落在「{fence}」围栏里（看板这一侧）"
            );
        }
    }

    /// 看板上的每一项（系统项除外）都得在 `fence.json` 里有账。
    ///
    /// 孤儿 id = 这一项丢了围栏偏好，只能靠 `guess_fence` 碰运气 —— 正是
    /// 「public 项退回用户桌面、账本却记 public:」那个 bug 的形状。
    fn check_no_orphan_ids(fences: &[FenceDto], m: &meta::FenceMeta) {
        let orphans: Vec<&str> = fences
            .iter()
            .flat_map(|f| f.items.iter())
            .map(|it| it.id.as_str())
            .filter(|id| !id.starts_with("sys-") && !m.entries.contains_key(*id))
            .collect();
        assert!(
            orphans.is_empty(),
            "这些项在 fence.json 里没有账，围栏偏好已丢：{orphans:?}"
        );
    }

    /// 「最近」那一行不该指向已经不存在的条目。
    ///
    /// 这里只能查**单向**（id 在 fence.json 里有账），因为重跑时拿不到原来的 id 映射 ——
    /// 「旧 id 已被改写」那条更强的断言只在首次跑的路径上做（那里才有 `id_map`）。
    fn check_recent_ids_are_backed(m: &meta::FenceMeta) {
        for id in recent_file_ids() {
            if id.starts_with("sys-") {
                continue;
            }
            assert!(
                m.entries.contains_key(&id),
                "最近列表里的 {id} 在 fence.json 里没有账 —— 这一行指向一条不存在的条目"
            );
        }
    }

    /// 两个桌面根上的**真项**数：排除 `desktop.ini`（系统自己放的，不算图标）。
    fn desktop_item_count() -> usize {
        desktop_roots()
            .expect("desktop roots")
            .iter()
            .map(|(_, root)| {
                std::fs::read_dir(root)
                    .map(|it| {
                        it.flatten()
                            .filter(|e| {
                                e.file_name() != std::ffi::OsStr::new("desktop.ini")
                            })
                            .count()
                    })
                    .unwrap_or(0)
            })
            .sum()
    }

    /// `recent-launches.json` 里的 id 列表。**故意直接读文件、不调 `recent_list()`** ——
    /// 要验的是磁盘上到底存了什么，`recent_list()` 会顺手 normalize，把问题洗掉。
    fn recent_file_ids() -> Vec<String> {
        let p = desk_file("recent-launches.json");
        if !p.exists() {
            return Vec::new();
        }
        let s = std::fs::read_to_string(&p).expect("read recent");
        let v: serde_json::Value = serde_json::from_str(&s).expect("parse recent");
        v.get("ids")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Task 11 的真机迁移。**本仓库唯一会动真实数据的测试。**
    ///
    /// 走的是 `migrate::run()` —— 和工具栏「还原到系统桌面」按钮点下去**同一个生产入口**，
    /// 区别只是验收由机器做。计划 Task 11 Step 5 那七条手工核对，这里逐条变成断言：
    /// vault 清零 / 桌面多出且只多出 34 项 / `vault.json` 归档 / `fence.json` 记账逐项不串 /
    /// 看板这一侧归属一致 / 「最近」没被清空。
    ///
    /// 跑法（**单独跑，别和别的真机测试并行**）：
    /// `cargo test -- --ignored real_machine_migrate --nocapture`
    #[test]
    #[ignore = "真机：不可逆，把 vault 里的文件搬回真桌面"]
    fn real_machine_migrate_vault_to_desktop() {
        let vault = vault_dir().expect("vault dir");
        let meta_p = meta_path().expect("meta path");

        // ① 先取快照 —— 只能在 run() 之前，跑完 vault.json 就改名了，真相只剩这份内存里的
        let before = load_meta().expect("vault meta").items;

        if before.is_empty() {
            // 幂等分支：上一次已经迁完（或从没搬过图标）。**不重跑** —— `run()` 本来也是
            // 空操作，但这里连文件系统都不该再碰一下。
            //
            // 但"不重跑"不等于"少验收"：旧账本 `vault.json.migrated` **还在盘上**，
            // 迁移前每一项的 (origin, 文件名, 围栏) 都能从它读回来。于是重跑这条测试
            // 依然能做**逐项**复核 —— 而且是只读的，可以随便多跑几遍。
            // `vault.json` 会被**每次启动**重新创建出来 —— `hide_desktop_icons_on_start`
            // 还在往它里面写 `hide_icons_applied`（Task 12 要连这块记账一起搬走，
            // 见完成记录里那条「第三个写者」）。所以这里不硬断言「文件不存在」，
            // 而是断言**危险的形状不存在**：一个非空的 items 才是真出事 ——
            // 那意味着有旧构建把桌面重新吸回 vault 了。
            if meta_p.exists() {
                let residual = load_meta().expect("读残留的 vault.json");
                assert!(
                    residual.items.is_empty(),
                    "vault.json 里出现了 {} 条接管记录 —— 桌面被重新吸回 vault 了：{:?}",
                    residual.items.len(),
                    residual
                        .items
                        .iter()
                        .map(|e| e.original_name.as_str())
                        .collect::<Vec<_>>()
                );
                eprintln!(
                    "注意：vault.json 被重新创建为空账本（hide 记账仍在写它，Task 12 搬走）"
                );
            }
            let archived = meta_p.with_extension("json.migrated");
            assert!(
                archived.exists(),
                "vault.json 不在、归档的 vault.json.migrated 也不在 —— 旧账本两边都没了"
            );
            assert_eq!(count_entries(&vault), 0, "vault 目录里还有残留");

            let s = std::fs::read_to_string(&archived).expect("读归档账本");
            let old: VaultMeta =
                serde_json::from_str(&s).expect("解析 vault.json.migrated（归档的是原始 JSON）");
            let expected: Vec<(String, String, String)> = old
                .items
                .iter()
                .map(|e| (e.origin.clone(), e.original_name.clone(), e.fence.clone()))
                .collect();
            assert_eq!(
                expected.len(),
                34,
                "归档账本里应有 34 项 —— 少了说明归档的不是迁移前那份"
            );

            let fences = collect_fences().expect("collect_fences");
            let m = meta::load().expect("fence.json");
            check_each_item_kept_its_fence(&fences, &m, &expected);
            check_no_orphan_ids(&fences, &m);
            check_recent_ids_are_backed(&m);

            let total: usize = fences.iter().map(|f| f.items.len()).sum();
            eprintln!(
                "迁移此前已完成（vault.json 已归档）；幂等复核**逐项**通过：\
                 看板 {total} 项、fence.json {} 条、34 项归属与归档账本一致",
                m.entries.len()
            );
            return;
        }

        let recent_before = recent_file_ids();
        let desktop_before = desktop_item_count();
        let expected: Vec<(String, String, String)> = before
            .iter()
            .map(|e| (e.origin.clone(), e.original_name.clone(), e.fence.clone()))
            .collect();

        // ② 不可逆的那一下
        let r = migrate::run().expect("migrate::run");
        eprintln!(
            "migrate: moved={} skipped={} failed={} id_map={}",
            r.moved,
            r.skipped,
            r.failed.len(),
            r.id_map.len()
        );

        // ③ 一个都没失败，且搬走的数量等于快照
        assert!(r.failed.is_empty(), "有迁移失败的项：{:?}", r.failed);
        assert_eq!(r.moved, expected.len(), "搬走的数量和 vault 里的项数对不上");
        assert_eq!(r.skipped, 0, "全新迁移不该有 skipped（重跑才会出现）");

        // ④ 文件全到了桌面、vault 清空 —— 「一个图标都不会消失」的可测形式
        assert_eq!(
            desktop_item_count(),
            desktop_before + expected.len(),
            "桌面上的项数对不上：应该只多出 {} 项",
            expected.len()
        );
        assert_eq!(count_entries(&vault), 0, "vault 目录里还有残留");

        // ⑤ 旧账本归档、新账本（fence.json）第一次落地
        assert!(!meta_p.exists(), "vault.json 应该已经改名");
        assert!(
            meta_p.with_extension("json.migrated").exists(),
            "找不到 vault.json.migrated"
        );
        let m = meta::load().expect("fence.json");

        // ⑥ 逐项核对：迁移前在哪个围栏，迁移后还在哪个围栏
        let fences = collect_fences().expect("collect_fences");
        check_each_item_kept_its_fence(&fences, &m, &expected);
        check_no_orphan_ids(&fences, &m);
        // 系统围栏的项数和实现耦合，所以只打印不硬断言 —— 硬编码会在以后变成假失败
        let total: usize = fences.iter().map(|f| f.items.len()).sum();
        eprintln!(
            "看板共 {total} 项（桌面 {} + 系统 {}）",
            expected.len(),
            total.saturating_sub(expected.len())
        );

        // ⑦ 「最近」没被清空：旧 id 必须已被 remap，且新 id 还在原位
        let recent_after = recent_file_ids();
        let moved_old_ids: std::collections::HashSet<&str> =
            before.iter().map(|e| e.id.as_str()).collect();
        for id in &recent_after {
            assert!(
                !moved_old_ids.contains(id.as_str()),
                "最近列表里还留着旧 id {id} —— remap_ids 没生效，这一行会指向不存在的条目"
            );
        }
        for old in &recent_before {
            if let Some(new) = r.id_map.get(old) {
                assert!(
                    recent_after.iter().any(|x| x == new),
                    "最近列表里的 {old} 应该被改写成 {new} 后留在原位"
                );
            }
        }
        eprintln!("最近：{recent_before:?} → {recent_after:?}");
    }
}
