//! 从 `.lnk` / `.url` / 目录 / DLL 里把图标抠成 PNG。**本文件是 fence 里唯一碰 PE 与
//! PowerShell 的地方**。脚本要落盘再 `powershell -File` 跑，所以有两条**别动的规矩**：
//!   1. 脚本**内容**必须保持纯 ASCII（含注释与内嵌 C# 源码）—— Windows PowerShell 5.1
//!      读无 BOM 文件时按 ANSI 解码。
//!   2. 落盘必须经 `with_bom` —— 规矩 1 管得住脚本文本，管不住**插值进去的路径**。
//!
//! ⚠️ 两处 `-ExecutionPolicy Bypass` 是既有代码，**不是本轮加的** —— 要动它请单开一轮。

use std::fs;
use std::path::Path;

/// 落盘前给 PowerShell 脚本加 **UTF-8 BOM**。两个抽取函数都必须经它 ——
/// **无 BOM 的 `.ps1` 会被 PowerShell 5.1 按 ANSI 解码**，插值的中文路径变乱码、抽取静默失败。
fn with_bom(script: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(script.len() + 3);
    body.extend_from_slice("\u{feff}".as_bytes());
    body.extend_from_slice(script.as_bytes());
    body
}

/// 把一个 `.lnk` / `.url` / `.exe` / 目录的图标抠成 PNG 写到 `dest`。
/// 返回 `false` 表示**没抠出来**（调用方按「没有图标」处理，不是错误）。
pub(super) fn extract_icon_png(src: &Path, dest: &Path) -> bool {
    #[cfg(windows)]
    {
        // ⚠️ 下面 `script` 里的内容**必须保持纯 ASCII**（含注释和 C# 源码）：Windows PowerShell 5.1
        // 读无 BOM 文件按 **ANSI** 解码，非 ASCII 字节轻则字符串变样，重则把 `@'...'@` here-string
        // 的边界冲掉（报满屏 `ParserError`）。中文解释写在这层 Rust 注释里，别写进脚本。
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
        // ⚠️ 这个 BOM **不是装饰**：`fs::write` 写的是无 BOM 的 UTF-8，而 `powershell.exe` 5.1
        // 读无 BOM 文件按 **ANSI** 解码（本机 cp936）—— 插值进 `$src` / `$dest` 的中文路径被劈成
        // 乱码字，`Test-Path` 当场为假 → 脚本 `exit 1` → 看板上永远是一个空方块。
        // 实测：修前中文名 14 个全败、ASCII 名 24 个全成，差别只有这颗 BOM。
        if fs::write(&tmp, with_bom(&script)).is_err() {
            return false;
        }
        let ok = crate::proc::command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &tmp.to_string_lossy(),
            ])
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
/// 调用方是 `system_shell_items`（回收站 / 此电脑两个系统图标）。
pub(super) fn extract_dll_icon(dll: &str, index: i32, dest: &Path) -> bool {
    #[cfg(windows)]
    {
        if dest.exists() {
            return true;
        }
        let dest_s = dest.to_string_lossy().replace('\'', "''");
        let dll_s = dll.replace('\'', "''");
        // Script goes to a temp file to avoid nested-quote hell in -Command.
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
        // 同样要 BOM，理由见 `with_bom`：这里当前的输入都是 ASCII，但谁把 dest 换成带中文的名字就会中。
        if fs::write(&tmp, with_bom(&script)).is_err() {
            return false;
        }
        let ok = crate::proc::command("powershell")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &tmp.to_string_lossy(),
            ])
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
