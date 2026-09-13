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

pub(crate) mod hide;
pub(crate) mod index;
pub(crate) mod meta;
pub(crate) mod migrate;
pub(crate) mod ops;
pub(crate) mod watch;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FenceLayoutDto {
    pub name: String,
    pub ids: Vec<String>,
}

/// Installer / manual setup may drop `desk.lnk` on the desktop — never vault it.
fn is_self_desk_shortcut(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "desk.lnk" || lower == "desk.url" || lower == "desk.lnk.lnk"
}

pub(super) fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_local_dir().ok_or("no local app data")?;
    let dir = base.join("desk");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn icons_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir()?.join("icons");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
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

/// 落盘前给 PowerShell 脚本加 **UTF-8 BOM**。两个抽取函数都必须经它。
///
/// 完整因果写在 `extract_icon_png` 里那段 ⚠️ 注释，这里只说结论：
/// **无 BOM 的 `.ps1` 会被 Windows PowerShell 5.1 按 ANSI 解码**（本机实测代码页 936），
/// 于是插值进脚本的中文路径变成乱码 —— 抽取静默失败，看板上留一个空方块。
fn with_bom(script: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(script.len() + 3);
    body.extend_from_slice("\u{feff}".as_bytes());
    body.extend_from_slice(script.as_bytes());
    body
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
        // ⚠️ 这个 BOM **不是装饰**：少了它，名字带非 ASCII 的项一个都抽不出图标（实测）。
        //
        // `fs::write` 写的是 UTF-8 **无 BOM**，而 `powershell.exe` 是 **5.1**：读无 BOM
        // 文件时按 **ANSI** 解码（本机 cp936 / gb2312）。上面那条「脚本必须保持纯 ASCII」
        // 的规矩管住了**脚本文本**，却管不住**插值进 `$src` / `$dest` 的路径** ——
        // 而 Task 10 把读源换成真桌面之后（INV-1），路径头一回带上了真中文名：
        // `C:\...\Desktop\微信.lnk` 的 6 个 UTF-8 字节被劈成 3 个乱码字，
        // `Test-Path` 当场为假 → 脚本 `exit 1` → 看板上永远是一个空方块。
        //
        // 量过的对照（同一份脚本，只差 BOM）：无 BOM → `exists=False`、名字解成
        // 3 个乱码字；带 BOM → `exists=True`、码点 `24494,20449` = 「微信」。
        // 真机全量：修前 `real_icons_extract_from_real_files` 失败 14 / 成功 24，
        // 失败的 14 个**全是中文名**，成功的 24 个**全是 ASCII 名**。
        //
        // 旧 vault 时代这颗雷是睡着的 —— 那时喂进来的是 `vault_name`
        // （`user-________-23.lnk`，**纯 ASCII 下划线**，中文只留在 `original_name` 里）。
        // vault 层一直在替这条路径挡中文，拆掉它才露出来。
        if fs::write(&tmp, with_bom(&script)).is_err() {
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
        // 同样要 BOM，理由见 `with_bom`。（这里当前的输入 `imageres.dll` 与
        // `sys-*.png` 都是 ASCII，所以这颗雷在这个函数里还没响过 —— 但**同一个坑**，
        // 谁把 dest 换成带中文的名字就会中。一并堵上，免得下一个人照抄走错的那半。）
        if fs::write(&tmp, with_bom(&script)).is_err() {
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
    let roots = desktop_roots()?;
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
#[tauri::command]
pub fn fence_icons_visible() -> Result<bool, String> {
    Ok(hide::is_enabled()? != Some(true))
}

/// 逃生开关：立即切换桌面图标可见性，并记住这个选择（重启 desk 不反弹）。
///
/// 除切换注册表外还要维护两处本地状态，缺一个都会让「用户的选择」跟
/// 别的机制打架：
///   - 标志文件 `icons-visible`：让 `fence_list` 的启动隐藏路径不再动 `HideIcons`。
///     **这个文件是逃生口的唯一权威** —— 它必须独立于 desk 进程健康与注册表状态
///     存在（设计 §6.2 第 3 条），所以哪怕 `fence.json` 坏了也不影响它被读到。
///   - `fence.json` 的 `hide.owned`：让启动时的孤儿自检知道这个 `HideIcons` 有主。
///     只置位不清除的话，「visible=true 但 owned 仍是 true」这条过期记录会把
///     孤儿自检的判据带偏。（v1 里这是 `vault.json` 的 `hide_icons_applied`，
///     Task 12 随 vault 读路径搬到了 `meta::HideState`。）
#[tauri::command]
pub fn fence_set_icons_visible(visible: bool) -> Result<bool, String> {
    if visible {
        hide::disable()?;
    } else {
        hide::enable()?;
    }
    hide::set_user_wants_visible(visible)?;

    let mut m = meta::load()?;
    if m.hide.owned != !visible {
        m.hide.owned = !visible;
        meta::save(&m)?;
    }
    Ok(visible)
}

/// 真机验收（默认 `#[ignore]`）：读**真实桌面**。
///
/// 跑法：`cargo test -- --ignored real_machine`
///
/// ⚠️ 其中 `real_machine_migrate_vault_to_desktop` 是**不可逆**的那一条，必须**单独**跑
/// （`cargo test -- --ignored real_machine_migrate`）：它搬真实文件，和别的真机测试并行会互相打架。
/// 迁移（Task 11）已经跑过了，所以现在走的是它的幂等分支 —— 只读、可重复，不再搬任何东西。
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
    #[ignore = "真机：读真实桌面"]
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
        // 路径手工拼，**刻意不调 `migrate::vault_dir()`** —— 那个函数带 `create_dir_all`，
        // 在一条只读验收里凭空造出一个空 vault 目录就本末倒置了。
        let vault = desk_file("vault");
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
        // 迁移完 vault 层就该整个空掉/不存在 —— Task 12 删掉读源之后，这一层再没有任何
        // 生产用途（只剩 `migrate` 的回滚路径认得它）。有东西 = 有旧构建在往回吸。
        assert!(
            before.is_empty(),
            "vault 目录里还有 {} 项，迁移之后它应该永远是空的：{before:?}",
            before.len()
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
        let vault = migrate::vault_dir().expect("vault dir");
        let meta_p = migrate::meta_path().expect("meta path");

        // ① 先取快照 —— 只能在 run() 之前，跑完 vault.json 就改名了，真相只剩这份内存里的
        let before = migrate::load_meta().expect("vault meta").items;

        if before.is_empty() {
            // 幂等分支：上一次已经迁完（或从没搬过图标）。**不重跑** —— `run()` 本来也是
            // 空操作，但这里连文件系统都不该再碰一下。
            //
            // 但"不重跑"不等于"少验收"：旧账本 `vault.json.migrated` **还在盘上**，
            // 迁移前每一项的 (origin, 文件名, 围栏) 都能从它读回来。于是重跑这条测试
            // 依然能做**逐项**复核 —— 而且是只读的，可以随便多跑几遍。
            //
            // Task 12 之前这里只能断言「危险的形状不存在」（items 非空 = 有旧构建把桌面
            // 吸回 vault 了），因为 `hide_desktop_icons_on_start` 每次启动都会往 vault.json
            // 里写 `hide_icons_applied`，把归档掉的账本重新造出来（真机实测：一天内两次）。
            // Task 12 把那笔 hide 记账搬进 `fence.json` 之后，**v2 的生产路径上再没有
            // 任何 vault.json 的写者**，所以这里收紧成最直接的断言：文件不该存在。
            assert!(
                !meta_p.exists(),
                "{} 又出现了 —— 已经归档的旧账本被重新创建，v2 不该再有它的写者：{}",
                meta_p.display(),
                std::fs::read_to_string(&meta_p).unwrap_or_else(|e| format!("<读不到：{e}>"))
            );
            let archived = meta_p.with_extension("json.migrated");
            assert!(
                archived.exists(),
                "vault.json 不在、归档的 vault.json.migrated 也不在 —— 旧账本两边都没了"
            );
            assert_eq!(count_entries(&vault), 0, "vault 目录里还有残留");

            let s = std::fs::read_to_string(&archived).expect("读归档账本");
            let old: migrate::VaultMeta =
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

    /// 看板上 `label` 这一项落在哪个围栏。「系统」围栏排除在外 ——
    /// 那几个 shell 项的 label 是写死的，同名碰撞只会让断言说谎。
    fn fence_of_label(label: &str) -> Option<String> {
        collect_fences()
            .expect("collect_fences")
            .into_iter()
            .find(|f| f.name != "系统" && f.items.iter().any(|i| i.label == label))
            .map(|f| f.name)
    }

    /// Task 14 的真机验收：新建 → 改名 → 删除，全走**真实桌面**上的生产入口
    /// （`ops::fence_create` / `fence_rename` / `fence_delete` 就是右键菜单点下去调的那三个）。
    ///
    /// 计划 Task 14 §4 的手工验收里，有三条是「在真机上看结果」，这里把它们变成断言：
    /// 文件夹真的出现在用户桌面上（落在**看板的读源**里，而不只是"某个地方"）/
    /// 改名后**围栏归属不变** —— 这一条是 §1.5「先写 meta 再动文件」那个顺序的
    /// 唯一可测形式 / 删除后账实两清、`fence.json` 不多不少回到原样。
    /// 剩下一条（剪贴板与资源管理器**双向**）只能留给手：剪贴板是全局资源，
    /// 机器跑一遍会踩掉用户当时正拿着的东西。
    ///
    /// 跑法：`cargo test -- --ignored real_machine_ops --nocapture`
    #[test]
    #[ignore = "真机：在真实桌面上建/改名/删一个探针文件夹"]
    fn real_machine_ops_create_rename_delete() {
        /// 探针文件夹。`Drop` 用**裸 `remove_dir_all`**、不用 `fence_delete` ——
        /// 兜底那一手不能依赖被测代码本身：它要是坏了，兜底也跟着坏，
        /// 探针就永远留在用户桌面上。
        struct DirProbe {
            paths: Vec<PathBuf>,
        }

        impl Drop for DirProbe {
            fn drop(&mut self) {
                for p in &self.paths {
                    let _ = std::fs::remove_dir_all(p);
                    let _ = std::fs::remove_file(p);
                }
            }
        }

        let entries_before = meta::load().expect("fence.json").entries.len();
        let root = desktop_dir().expect("desktop dir");

        // ① 新建 —— 右键「新建文件夹」
        let name = "__desk_task14_probe__";
        let path = PathBuf::from(
            ops::fence_create(name.into(), "folder".into(), None).expect("fence_create"),
        );
        // 新名字先算出来推进兜底清单，再动文件：这样从改名**那一刻**起两个路径
        // 都在兜底范围内，中间不留窗口。
        let renamed = root.join(format!("{name}_renamed"));
        // `_probe` 只为它的 `Drop` 活着（`let _ = …` 会当场析构，那就不兜底了）。
        let _probe = DirProbe {
            paths: vec![path.clone(), renamed.clone()],
        };

        assert!(path.is_dir(), "新建的文件夹没落到盘上：{}", path.display());
        assert_eq!(
            path.parent(),
            Some(root.as_path()),
            "新建的东西不在用户桌面上（看板读的是 {}）",
            root.display()
        );
        // 它得同时过得了护栏 —— 建得出来却删不掉会是个很闷的 bug。
        assert!(
            ops::gate(&path).is_ok(),
            "刚建出来的项自己过不了护栏：{}",
            path.display()
        );

        // ② 给它记一笔偏好：「工具」。选这个围栏是**故意的** —— 目录没有 meta 时
        //    `fence_of` 兜到「文件夹」，所以「落在工具里」和「没落任何围栏」不会长得一样。
        let old_key = meta::key("user", name);
        {
            let mut m = meta::load().expect("fence.json");
            m.entries.insert(
                old_key.clone(),
                meta::Entry {
                    fence: "工具".into(),
                    order: 0,
                    mtime: 0,
                },
            );
            meta::save(&m).expect("save fence.json");
        }
        assert_eq!(
            fence_of_label(name).as_deref(),
            Some("工具"),
            "记了偏好的项没落在「工具」围栏里"
        );

        // ③ 改名 —— 围栏归属必须跟着走（spec §11-3）
        let new_name = format!("{name}_renamed");
        let returned = ops::fence_rename(path.to_string_lossy().to_string(), new_name.clone())
            .expect("fence_rename");

        assert!(!path.exists(), "改名后旧路径还在：{}", path.display());
        assert!(renamed.is_dir(), "改名后新路径不存在：{}", renamed.display());
        assert_eq!(
            Path::new(&returned),
            renamed.as_path(),
            "fence_rename 返回的路径和盘上的对不上"
        );

        let m = meta::load().expect("fence.json");
        let new_key = meta::key("user", &new_name);
        assert!(
            !m.entries.contains_key(&old_key),
            "改名后旧 key 还留在 fence.json 里：{old_key}"
        );
        assert_eq!(
            m.entries.get(&new_key).map(|e| e.fence.as_str()),
            Some("工具"),
            "改名把围栏归属弄丢了（fence.json 这一侧）—— meta::rename_key 没生效"
        );
        assert_eq!(
            fence_of_label(&new_name).as_deref(),
            Some("工具"),
            "改名后项跳到了别的围栏（看板这一侧）—— 用户看得见的错分栏，且不会自己回来"
        );

        // ④ 删除 —— 进回收站（可撤销），账实两清
        ops::fence_delete(renamed.to_string_lossy().to_string()).expect("fence_delete");
        assert!(!renamed.exists(), "删完还在盘上：{}", renamed.display());
        assert!(
            !meta::load().expect("fence.json").entries.contains_key(&new_key),
            "删完还剩一条 meta —— 下次冷启动会被 prune 收走，但眼下它是个孤儿 {new_key}"
        );
        assert_eq!(
            fence_of_label(&new_name),
            None,
            "删完看板上还留着这一项"
        );

        // ⑤ 账目回到原样：这一趟没在 fence.json 里留下任何痕迹
        assert_eq!(
            meta::load().expect("fence.json").entries.len(),
            entries_before,
            "fence.json 的条目数没回到起点，这一趟留下了残留"
        );

        eprintln!(
            "新建 → 改名 → 删除 全程通过；探针文件夹现在在**回收站**里（可撤销），\
             fence.json {} 条（与开始时一致）",
            entries_before
        );
    }
}
