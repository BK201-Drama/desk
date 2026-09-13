//! 桌面项的**写操作**：新建 / 改名 / 删除 / 剪切复制粘贴 / 发送到 / 压缩 / 属性 /
//! 打开方式 / 在资源管理器中定位。
//!
//! 这是整个 fence 子系统里唯一会动**用户文件**的模块。Task 12 之后 desk 对桌面的写
//! 只剩「记 `fence.json`」和「抽图标 png」，旧的 `move_path` / 改名 / 删除路径是 vault
//! 时代的产物 —— 那时操作的是我们自己的保险箱，现在操作的是用户的桌面。三个推论：
//!
//! 1. **输入要先过闸。** `path` 参数来自前端。前端是我们自己的代码，但一个拼错的路径
//!    就是一次 `SHFileOperationW` 删掉用户别处的目录。每个接受 `path` 的命令第一件事
//!    都是 `locate()`（`ensure_inside_desktop` 的实现），只放行「某个桌面根的**直接**
//!    子项」。嵌套路径不放行 —— 看板只显示顶层项，嵌套路径只可能来自 bug。
//! 2. **先写 `fence.json`，再动文件。** 见 `fence_rename` 的注释：反过来的话，
//!    watcher 可能在 meta 落盘前就重扫并推送，那一帧会把改名的项暂时算进
//!    `guess_fence` 的猜测围栏，而指纹稳定后第二拍不会再来 —— 用户看得见且不可自愈。
//! 3. **破坏性动作要能撤销。** 删除进回收站（`FOF_ALLOWUNDO`）而不是抹掉；
//!    重名一律 `(2)`（`unique_name`）而不是覆盖。本模块**没有一处覆盖已有文件**。
//!
//! # 为什么不用 `IFileOperation` / OLE
//!
//! 计划原本指定删除用 `IFileOperation`、剪贴板未指定实现。两者都是 COM 对象，
//! 而 COM 要求调用线程有 apartment —— Tauri 命令跑在哪个线程上不是我们能一口咬定的
//! （同步命令与 `async` 命令的调度不同）。要安全就得自己 `CoInitializeEx` +
//! 保证配对 `CoUninitialize` + 决定 STA/MTA，**为一个删除动作引入一套线程模型**。
//!
//! 换成的两条路语义完全相同，且零 COM：
//! 删除 → `SHFileOperationW`（同样是 shell32 官方导出，`FOF_ALLOWUNDO` 同样进回收站）；
//! 剪贴板 → `OpenClipboard` + `SetClipboardData(CF_HDROP)`（资源管理器认的就是这个格式，
//! 「剪切还是复制」用注册格式 `"Preferred DropEffect"` 传，这也是它的原始约定）。
//!
//! 本模块**只在 Windows 上编译**（整个 crate 事实上就是），所以函数不加
//! `#[cfg(windows)]` 门 —— 加了只会多一堆「另一个分支写什么」的噪音。

use super::meta::{self, key as meta_key};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- 护栏

/// 把 `path` 认到一个桌面根的**直接**子项上，返回 `(meta key, 项的文件名)`。
///
/// 用 `canonicalize` 的结果取文件名而不是原参数：NTFS 大小写不敏感但**大小写保持**，
/// `canonicalize` 给出的是盘上的真实拼写，和 `index::scan_root`（走 `read_dir`）一致 ——
/// key 必须和扫描出来的那一份逐字节相同，否则 meta 记账会对不上。
fn locate(path: &Path, roots: &[(String, PathBuf)]) -> Result<(String, String), String> {
    let real = path
        .canonicalize()
        .map_err(|e| format!("路径无法解析（{}）：{e}", path.display()))?;
    for (origin, root) in roots {
        let Ok(r) = root.canonicalize() else { continue };
        // parent 而不是 starts_with：**嵌套路径不放行**。桌面子目录里的东西不在看板上，
        // 能进来的嵌套路径只可能是调用点写错了。
        if real.parent() == Some(r.as_path()) {
            let name = real
                .file_name()
                .ok_or_else(|| "路径没有文件名".to_string())?
                .to_string_lossy()
                .to_string();
            return Ok((meta_key(origin, &name), name));
        }
    }
    Err(format!(
        "只允许操作桌面上的顶层项：{}",
        path.display()
    ))
}

/// 命令入口的统一第一句。桌面根读不出来时直接失败 —— 认不出路径就不许动它。
///
/// `pub(crate)` 是为了真机测试能拿**真实路径**验一次护栏：`locate` 的单元测试跑在
/// tempdir 上，而这条链上有一步 `canonicalize`，真桌面上才可能出现临时目录里
/// 造不出来的形状（junction / 大小写不一致 / 8.3 短名）。
pub(crate) fn gate(path: &Path) -> Result<(String, String), String> {
    locate(path, &super::paths::desktop_roots()?)
}

/// 新建 / 改名用的名字检查。
fn check_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("名字不能为空".into());
    }
    if n == "." || n == ".." {
        return Err("名字不合法".into());
    }
    if n.chars()
        .any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err(r#"名字里不能出现 \ / : * ? " < > |"#.into());
    }
    // Windows 会**悄悄**吃掉结尾的点和空格：`a.` 会变成 `a`。与其让用户看到一个
    // 和自己输入不符的结果，不如直接说不行。
    if n.ends_with('.') || n.ends_with(' ') {
        return Err("名字不能以点或空格结尾".into());
    }
    Ok(())
}

/// `a.txt` → `("a", "txt")`；`新建文件夹` → `("新建文件夹", "")`；
/// `.gitignore` → `(".gitignore", "")`（开头的点是名字的一部分，不是扩展名）。
fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(i) if i > 0 => (name[..i].to_string(), name[i + 1..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 重名时按资源管理器的习惯加 ` (2)` / ` (3)`…，**绝不覆盖**已有项。
fn unique_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = split_name(name);
    for i in 2..10_000 {
        let cand = if ext.is_empty() {
            format!("{stem} ({i})")
        } else {
            format!("{stem} ({i}).{ext}")
        };
        let p = dir.join(cand);
        if !p.exists() {
            return p;
        }
    }
    first // 一万个重名，随便挑一个让上层去撞错误信息
}

// ---------------------------------------------------------------- PowerShell

/// 跑一段内联 PowerShell 脚本，成功返回 `()`。
///
/// 用 `-Command` 而不是同仓 `extract_icon_png` 那种「写临时文件 + `-File`」：
/// `-File` 那条路要求脚本**纯 ASCII**（PS 5.1 按 ANSI 解码无 BOM 文件，见 `mod.rs:120`），
/// 而这里必然要带用户的中文路径。`-Command` 的命令行走 `CreateProcessW`，是 UTF-16，
/// 中文安全。代价是得自己躲引号 —— 单引号字符串里的 `'` 写成 `''` 即可。
fn run_ps(script: &str) -> Result<(), String> {
    let out = crate::proc::command("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|e| format!("起 PowerShell 失败：{e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        return Err(if err.is_empty() {
            "PowerShell 执行失败".into()
        } else {
            err.to_string()
        });
    }
    Ok(())
}

/// PS 单引号字符串转义。
fn psq(s: &str) -> String {
    s.replace('\'', "''")
}

/// 造一个 `.lnk`。`fence_create(kind="lnk")` 与 `fence_send_to` 共用这一份实现 ——
/// 所以这条能力在真机上一定被走到，不是一条没人走的分支。
fn create_shortcut(target: &str, lnk: &Path) -> Result<(), String> {
    let script = format!(
        "$ErrorActionPreference='Stop';\
         $w=New-Object -ComObject WScript.Shell;\
         $s=$w.CreateShortcut('{}');\
         $s.TargetPath='{}';\
         $s.Save()",
        psq(&lnk.to_string_lossy()),
        psq(target)
    );
    run_ps(&script)
}

// ---------------------------------------------------------------- 新建 / 改名

/// `fence_create` 的实现主体。`dir` 是注入的，测试才好在 tempdir 上跑。
fn create_in(
    dir: &Path,
    name: &str,
    kind: &str,
    target: Option<&str>,
) -> Result<PathBuf, String> {
    check_name(name)?;
    let path = match kind {
        "folder" => {
            let p = unique_name(dir, name);
            std::fs::create_dir(&p).map_err(|e| format!("新建文件夹失败：{e}"))?;
            p
        }
        "txt" => {
            let n = with_ext(name, "txt");
            let p = unique_name(dir, &n);
            std::fs::write(&p, b"").map_err(|e| format!("新建文本文档失败：{e}"))?;
            p
        }
        "lnk" => {
            // 没有目标的新建快捷方式只能是个空壳。**不**造指到桌面的占位符 ——
            // 那是在替用户编一个他没要求的意思。缺 target 就说缺 target。
            let t = target
                .filter(|t| !t.trim().is_empty())
                .ok_or("快捷方式需要一个目标")?;
            let n = with_ext(name, "lnk");
            let p = unique_name(dir, &n);
            create_shortcut(t, &p)?;
            p
        }
        other => return Err(format!("不认识的新建类型：{other}")),
    };
    Ok(path)
}

/// 用户输入 `简历` 也要能建出 `简历.txt`，输入 `简历.txt` 不该变成 `简历.txt.txt`。
fn with_ext(name: &str, ext: &str) -> String {
    if name.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        name.to_string()
    } else {
        format!("{name}.{ext}")
    }
}

/// `fence_rename` 的实现主体（只做文件系统那一半，meta 由调用方按顺序处理）。
fn rename_in(path: &Path, new_name: &str) -> Result<PathBuf, String> {
    check_name(new_name)?;
    let parent = path.parent().ok_or("路径没有父目录")?;
    let dest = parent.join(new_name);
    // 改名**不**自动加序号：用户明确打了一个名字，撞名就说撞名（资源管理器同此）。
    if dest.exists() {
        return Err(format!("已存在同名项：{new_name}"));
    }
    std::fs::rename(path, &dest).map_err(|e| format!("改名失败：{e}"))?;
    Ok(dest)
}

// ---------------------------------------------------------------- 删除

/// 进回收站（可撤销），不抹掉。
fn recycle(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, SHFILEOPSTRUCTW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION,
        FOF_NOERRORUI, FOF_SILENT,
    };

    // SHFileOperationW 要的是**双 \0 结尾**的路径列表 —— 只有一个路径也要多补一个 \0。
    // 这是这个 API 最经典的坑：少补一个它就读到缓冲区外面去了。
    let mut buf: Vec<u16> = path.as_os_str().encode_wide().collect();
    buf.push(0);
    buf.push(0);

    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(buf.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };

    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("删除失败（错误码 {rc}）"));
    }
    if op.fAnyOperationsAborted.as_bool() {
        return Err("删除被中止".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- 剪贴板

/// `CF_HDROP` 的内存布局：`DROPFILES` 头 + 宽字符路径列表（每项各自 \0）+ 收尾的 \0。
///
/// 抽成纯函数是为了能测 —— 这个布局一个字节错位就是「粘贴出来是乱码/空」，
/// 而它无法在单测里真的过一遍系统剪贴板（那是全局资源，测试会踩用户的剪贴板）。
fn hdrop_bytes(paths: &[PathBuf]) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::DROPFILES;

    let mut wide: Vec<u16> = Vec::new();
    for p in paths {
        wide.extend(p.as_os_str().encode_wide());
        wide.push(0);
    }
    wide.push(0); // 列表结束

    let head = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        pt: Default::default(),
        fNC: false.into(),
        fWide: true.into(), // 必须是真，否则系统按 ANSI 去读我们写的 UTF-16
    };

    let mut out = Vec::with_capacity(head.pFiles as usize + wide.len() * 2);
    // DROPFILES 是 `repr(C, packed(1))`，不是对齐结构 —— 逐字节抄，别用 transmute。
    let bytes = unsafe {
        std::slice::from_raw_parts(
            &head as *const _ as *const u8,
            std::mem::size_of::<DROPFILES>(),
        )
    };
    out.extend_from_slice(bytes);
    for c in wide {
        out.extend_from_slice(&c.to_le_bytes());
    }
    out
}

/// 写剪贴板：`paths` + 「是剪切吗」。
fn clipboard_put(paths: &[PathBuf], cut: bool) -> Result<(), String> {
    use windows::core::w;
    use windows::Win32::Foundation::{HANDLE, HWND};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::{CF_HDROP, DROPEFFECT_COPY, DROPEFFECT_MOVE};

    if paths.is_empty() {
        return Err("没有要复制的项".into());
    }

    let bytes = hdrop_bytes(paths);
    let hmem = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }
        .map_err(|e| format!("分配剪贴板内存失败：{e}"))?;
    unsafe {
        let p = GlobalLock(hmem);
        if p.is_null() {
            return Err("锁定剪贴板内存失败".into());
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p as *mut u8, bytes.len());
        let _ = GlobalUnlock(hmem);
    }

    unsafe { OpenClipboard(HWND::default()) }.map_err(|e| format!("打不开剪贴板：{e}"))?;
    let out = (|| -> Result<(), String> {
        unsafe {
            EmptyClipboard().map_err(|e| format!("清空剪贴板失败：{e}"))?;
            // SetClipboardData 成功之后这块内存**归系统所有**，我们不能再释放它。
            SetClipboardData(CF_HDROP.0 as u32, HANDLE(hmem.0))
                .map_err(|e| format!("写剪贴板失败：{e}"))?;

            // 「是剪切吗」靠 Preferred DropEffect —— 资源管理器就是这么传的，
            // 少了它系统一律按「复制」处理。
            let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
            if fmt != 0 {
                let eff = if cut {
                    DROPEFFECT_MOVE.0
                } else {
                    DROPEFFECT_COPY.0
                };
                if let Ok(hm) = GlobalAlloc(GMEM_MOVEABLE, 4) {
                    let pe = GlobalLock(hm);
                    if !pe.is_null() {
                        *(pe as *mut u32) = eff;
                        let _ = GlobalUnlock(hm);
                        // 这一步失败不该让整个复制失败：退化成「复制」是可接受的。
                        let _ = SetClipboardData(fmt, HANDLE(hm.0));
                    }
                }
            }
        }
        Ok(())
    })();
    unsafe { let _ = CloseClipboard(); }
    out
}

/// 读剪贴板，返回 `(路径, 是不是剪切)`。
fn clipboard_take() -> Result<(Vec<PathBuf>, bool), String> {
    use windows::core::w;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        RegisterClipboardFormatW,
    };
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::{CF_HDROP, DROPEFFECT_MOVE};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_err() {
            return Err("剪贴板里没有文件".into());
        }
        OpenClipboard(windows::Win32::Foundation::HWND::default())
            .map_err(|e| format!("打不开剪贴板：{e}"))?;

        let out = (|| -> Result<(Vec<PathBuf>, bool), String> {
            let h = GetClipboardData(CF_HDROP.0 as u32)
                .map_err(|e| format!("读剪贴板失败：{e}"))?;
            let hdrop = HDROP(h.0);

            // u32::MAX = 「给我个数」，标准两趟调用。
            let n = DragQueryFileW(hdrop, u32::MAX, None);
            let mut paths = Vec::with_capacity(n as usize);
            for i in 0..n {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                let got = DragQueryFileW(hdrop, i, Some(&mut buf)) as usize;
                buf.truncate(got);
                paths.push(PathBuf::from(String::from_utf16_lossy(&buf)));
            }

            let cut = {
                let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
                let mut cut = false;
                if fmt != 0 {
                    if let Ok(hm) = GetClipboardData(fmt) {
                        // GetClipboardData 给的是 HANDLE，GlobalLock 要 HGLOBAL。
                        // 两个 newtype 包的都是 `*mut c_void`，但类型不同，得显式转。
                        let hg = HGLOBAL(hm.0);
                        let p = GlobalLock(hg);
                        if !p.is_null() {
                            cut = (*(p as *const u32)) & DROPEFFECT_MOVE.0 != 0;
                            let _ = GlobalUnlock(hg);
                        }
                    }
                }
                cut
            };
            Ok((paths, cut))
        })();

        let _ = CloseClipboard();
        out
    }
}

/// 递归复制（`fs::copy` 只管单个文件）。没有引 `walkdir` —— 这里只走一层桌面项，
/// 自己写十行比多一个依赖划算。
fn copy_into(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for ent in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let ent = ent.map_err(|e| e.to_string())?;
            copy_into(&ent.path(), &dest.join(ent.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------- 命令

/// 在**用户桌面**新建一项。返回新项的完整路径。
///
/// 只在用户桌面建：公共桌面（`C:\Users\Public\Desktop`）写进去要管理员权限，
/// 而用户桌面覆盖了全部实际场景。
#[tauri::command]
pub fn fence_create(
    name: String,
    kind: String,
    target: Option<String>,
) -> Result<String, String> {
    let p = create_in(&super::paths::desktop_dir()?, &name, &kind, target.as_deref())?;
    Ok(p.to_string_lossy().to_string())
}

/// 改名。**围栏归属跟着走**（`meta::rename_key`），所以
/// 「改名后项跳到别的围栏去」这件事不会发生（spec §11-3）。
///
/// ⚠️ 顺序是**先 meta、再动文件**，不能反 ——
/// 反过来的话 watcher 的 250 ms 防抖窗口里就可能已经完成一次重扫并推送，
/// 那一帧里新名字还没有 meta 记录，`fence_of` 会把它算进 `guess_fence` 猜的围栏，
/// 而**推送之后指纹就稳定了，第二拍不会再来**（第二拍按定义只管图标）。
/// 结果就是用户看得见、且永远不会自己回来的错分栏。
///
/// 先写 meta 的代价是「可能短暂存在一个指向不存在文件的 key」——
/// 这个代价是零：`build_fences` 只遍历扫到的项，孤儿 entry 不可见，
/// 而它正好能被冷启动的 `meta::prune` 收走。
#[tauri::command]
pub fn fence_rename(path: String, new_name: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let (old_key, _) = gate(&p)?;
    check_name(&new_name)?;

    let mut m = meta::load()?;
    let new_key = old_key
        .split_once(':')
        .map(|(origin, _)| meta_key(origin, &new_name))
        .ok_or("meta key 形状不对")?;
    let moved = meta::rename_key(&mut m, &old_key, &new_key);
    if moved {
        meta::save(&m)?;
    }

    match rename_in(&p, &new_name) {
        Ok(dest) => {
            // 图标缓存是按 key 命名的，旧 key 的那张 png 现在没人引用了。
            // 不删也不算错（下次同名项会撞上一张旧图），但删掉更干净。
            let _ = std::fs::remove_file(super::index::icon_file(&old_key));
            Ok(dest.to_string_lossy().to_string())
        }
        Err(e) => {
            if moved {
                // 回滚：文件没动，meta 也不该动。
                if let Ok(mut m2) = meta::load() {
                    meta::rename_key(&mut m2, &new_key, &old_key);
                    let _ = meta::save(&m2);
                }
            }
            Err(e)
        }
    }
}

/// 删除。走回收站（`FOF_ALLOWUNDO`），可撤销。
///
/// 和 `fence_rename` 同样**先 meta、再动文件**，失败回滚。meta 这一侧是
/// **单键 `remove`** 而不是 `meta::prune` —— 「刚删的是谁」是调用方自己知道的，
/// 不需要（也不该）靠一次扫描去反推（Task 13 驳回 watcher prune 的正是这条理由）。
#[tauri::command]
pub fn fence_delete(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let (key, _) = gate(&p)?;

    let mut m = meta::load()?;
    let backup = m.entries.remove(&key);
    if backup.is_some() {
        meta::save(&m)?;
    }

    match recycle(&p) {
        Ok(()) => {
            let _ = std::fs::remove_file(super::index::icon_file(&key));
            Ok(())
        }
        Err(e) => {
            if let Some(e2) = backup {
                if let Ok(mut m2) = meta::load() {
                    m2.entries.insert(key, e2);
                    let _ = meta::save(&m2);
                }
            }
            Err(e)
        }
    }
}

/// 系统的「属性」对话框。用**原路径**而不是 canonicalize 过的 —— `\\?\` 前缀
/// 那套扩展长度形式 shell 不认。
#[tauri::command]
pub fn fence_properties(path: String) -> Result<(), String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let p = PathBuf::from(&path);
    gate(&p)?;

    let h = HSTRING::from(path.as_str());
    let rc = unsafe {
        ShellExecuteW(HWND::default(), w!("properties"), &h, None, None, SW_SHOWNORMAL)
    };
    ok_shell(rc.0 as usize)
}

/// 「打开方式」对话框。
///
/// 不用 `ShellExecuteW` 的 `openas` verb —— 它在 Win10 上不可靠（常常直接按默认程序
/// 打开、根本不弹选择框）。`OpenAs_RunDLL` 才是这个对话框的实际入口。
#[tauri::command]
pub fn fence_open_with(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    gate(&p)?;

    crate::proc::command("rundll32.exe")
        .args(["shell32.dll,OpenAs_RunDLL", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开「打开方式」失败：{e}"))
}

/// 在资源管理器中定位（选中该项）。
#[tauri::command]
pub fn fence_reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    gate(&p)?;

    crate::proc::command("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("定位失败：{e}"))
}

/// 把这批项放进剪贴板。`cut = true` 就是剪切。
#[tauri::command]
pub fn fence_clipboard(paths: Vec<String>, cut: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有选中任何项".into());
    }
    let roots = super::paths::desktop_roots()?;
    let mut ps = Vec::with_capacity(paths.len());
    for s in &paths {
        let p = PathBuf::from(s);
        locate(&p, &roots)?;
        ps.push(p);
    }
    clipboard_put(&ps, cut)
}

/// 把剪贴板里的项贴到桌面上，返回落点。
///
/// **不主动清空剪贴板**：资源管理器的行为是「剪切粘贴完才清」，
/// 而什么时候算「粘贴完」不该由我们猜 —— 让系统按它自己的约定处理。
#[tauri::command]
pub fn fence_paste() -> Result<Vec<String>, String> {
    let (srcs, cut) = clipboard_take()?;
    if srcs.is_empty() {
        return Err("剪贴板里没有可粘贴的项".into());
    }
    let desktop = super::paths::desktop_dir()?;
    let mut placed = Vec::new();
    let mut failed = Vec::new();

    for src in srcs {
        if !src.exists() {
            continue; // 剪贴板里可能留着早就删掉的路径，跳过而不是报错
        }
        let name = match src.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        // 剪切的源本来就在这个桌面上 → 原地不动，别自己跟自己较劲
        if cut && src.parent() == Some(desktop.as_path()) {
            continue;
        }
        let dest = unique_name(&desktop, &name);
        let r = if cut {
            super::migrate::move_path(&src, &dest).map_err(|e| e.to_string())
        } else {
            copy_into(&src, &dest)
        };
        match r {
            Ok(()) => placed.push(dest.to_string_lossy().to_string()),
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }

    if !failed.is_empty() {
        if placed.is_empty() {
            return Err(failed.join("；"));
        }
        // 部分成功：落点照常返回，失败的记一笔（前端拿不到逐项结果，但至少不进也不藏）
        eprintln!("desk: paste 部分失败：{}", failed.join("；"));
    }
    Ok(placed)
}

/// 发送到 ▸ 桌面快捷方式：在桌面上造一个指向 `path` 的 `.lnk`。
#[tauri::command]
pub fn fence_send_to(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    gate(&p)?;

    let label = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("路径没有名字")?;
    let lnk = unique_name(&super::paths::desktop_dir()?, &format!("{label} - 快捷方式.lnk"));
    create_shortcut(&p.to_string_lossy(), &lnk)
}

/// 发送到 ▸ 压缩包：在旁边生成 `<名字>.zip`。
///
/// 不用 shell 的 `Compress` verb —— 它没文档化、随系统版本漂移。
/// `Compress-Archive` 是文档化 cmdlet，本仓已有大量 PowerShell 先例。
/// 目标重名走 `(2)`，不覆盖已有的 zip。
#[tauri::command]
pub fn fence_compress(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    gate(&p)?;

    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("路径没有名字")?;
    let (stem, _) = split_name(&name);
    let parent = p.parent().ok_or("路径没有父目录")?;
    let zip = unique_name(parent, &format!("{stem}.zip"));

    let script = format!(
        "$ErrorActionPreference='Stop';Compress-Archive -LiteralPath '{}' -DestinationPath '{}'",
        psq(&p.to_string_lossy()),
        psq(&zip.to_string_lossy())
    );
    run_ps(&script)
}

/// `ShellExecuteW` 的返回值约定：**> 32 才算成功**（这是它的历史包袱，
/// 小于等于 32 的数是错误码，跟 `GetLastError` 不是一套）。
fn ok_shell(rc: usize) -> Result<(), String> {
    if rc <= 32 {
        Err(format!("调用失败（错误码 {rc}）"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn fakes(dir: &Path) -> Vec<(String, PathBuf)> {
        vec![("user".to_string(), dir.to_path_buf())]
    }

    // ---- locate / 护栏 ----

    #[test]
    fn locate_accepts_a_direct_child_of_the_root() {
        let d = scratch();
        let f = d.path().join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        let (key, name) = locate(&f, &fakes(d.path())).unwrap();
        assert_eq!(key, "user:a.txt");
        assert_eq!(name, "a.txt");
    }

    #[test]
    fn locate_refuses_nested_paths() {
        // 桌面上的子目录**里面**的东西不在看板上：能走到这里的嵌套路径只可能是 bug。
        let d = scratch();
        let sub = d.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let f = sub.join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(locate(&f, &fakes(d.path())).is_err());
    }

    #[test]
    fn locate_refuses_the_root_itself() {
        let d = scratch();
        assert!(locate(d.path(), &fakes(d.path())).is_err());
    }

    #[test]
    fn locate_refuses_a_path_outside_every_root() {
        let d = scratch();
        let other = scratch();
        let f = other.path().join("a.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(locate(&f, &fakes(d.path())).is_err());
    }

    // ---- 名字 ----

    #[test]
    fn check_name_rejects_windows_hostile_names() {
        for bad in ["", "  ", ".", "..", "a/b", r"a\b", "a:b", "a*b", "a?b", "a.b."] {
            assert!(check_name(bad).is_err(), "{bad:?} 应该被拒");
        }
        assert!(check_name("新建文件夹").is_ok());
        assert!(check_name("a.b").is_ok());
    }

    #[test]
    fn split_name_keeps_a_leading_dot_as_part_of_the_name() {
        assert_eq!(split_name("a.txt"), ("a".into(), "txt".into()));
        assert_eq!(split_name("新建文件夹"), ("新建文件夹".into(), "".into()));
        assert_eq!(split_name(".gitignore"), (".gitignore".into(), "".into()));
    }

    // ---- 新建 ----

    #[test]
    fn create_folder_lands_and_suffixes_on_collision() {
        let d = scratch();
        let a = create_in(d.path(), "新建文件夹", "folder", None).unwrap();
        assert!(a.is_dir());
        // 资源管理器的习惯：`新建文件夹` 已存在 → `新建文件夹 (2)`
        let b = create_in(d.path(), "新建文件夹", "folder", None).unwrap();
        assert_eq!(b.file_name().unwrap().to_string_lossy(), "新建文件夹 (2)");
        assert!(b.is_dir());
    }

    #[test]
    fn create_txt_does_not_double_the_extension() {
        let d = scratch();
        let a = create_in(d.path(), "简历", "txt", None).unwrap();
        let b = create_in(d.path(), "简历.txt", "txt", None).unwrap();
        assert_eq!(a.file_name().unwrap().to_string_lossy(), "简历.txt");
        assert_eq!(b.file_name().unwrap().to_string_lossy(), "简历 (2).txt");
        assert!(a.exists() && a.metadata().unwrap().len() == 0);
    }

    #[test]
    fn create_lnk_without_a_target_is_an_error_not_a_placeholder() {
        // 「新建快捷方式」没有目标就只能是个空壳。宁可明确报错，也不替用户编一个意思。
        let d = scratch();
        assert!(create_in(d.path(), "快捷方式", "lnk", None).is_err());
        assert!(create_in(d.path(), "快捷方式", "lnk", Some("   ")).is_err());
    }

    #[test]
    fn create_rejects_an_unknown_kind() {
        let d = scratch();
        assert!(create_in(d.path(), "x", "zip", None).is_err());
    }

    // ---- 改名 ----

    #[test]
    fn rename_moves_the_file_and_refuses_collisions() {
        let d = scratch();
        let a = d.path().join("a.txt");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(d.path().join("b.txt"), b"y").unwrap();

        let dest = rename_in(&a, "c.txt").unwrap();
        assert!(dest.exists() && !a.exists());

        // 撞名直接报错 —— 改名不自动加序号（用户明确打了一个名字）
        assert!(rename_in(&dest, "b.txt").is_err());
        assert!(dest.exists());
    }

    #[test]
    fn rename_rejects_a_name_with_a_separator() {
        let d = scratch();
        let a = d.path().join("a.txt");
        std::fs::write(&a, b"x").unwrap();
        assert!(rename_in(&a, r"sub\b.txt").is_err());
        assert!(a.exists());
    }

    // ---- 删除 ----

    #[test]
    fn recycle_sends_the_item_to_the_bin() {
        // 唯一一个真的走 `SHFileOperationW` 的测试。它会在回收站里留一个带进程号的小
        // 文件/空目录 —— 这是这个测试的代价，可以接受：**不测它的话，那个「双 \0 结尾」
        // 的缓冲区就完全没有机器判据**，而那正是这个 API 最经典的坑（少补一个 \0
        // 它就读出缓冲区边界）。宁可让回收站多个探针，也不能让删除路径靠肉眼保证。
        let pid = std::process::id();
        let d = scratch();

        let f = d.path().join(format!("desk-recycle-probe-{pid}.txt"));
        std::fs::write(&f, b"x").unwrap();
        recycle(&f).unwrap();
        assert!(!f.exists(), "文件应该已经进回收站");

        let sub = d.path().join(format!("desk-recycle-probe-dir-{pid}"));
        std::fs::create_dir(&sub).unwrap();
        recycle(&sub).unwrap();
        assert!(!sub.exists(), "目录也应该已经进回收站");
    }

    #[test]
    fn recycle_reports_an_error_for_a_path_that_is_not_there() {
        let d = scratch();
        let ghost = d.path().join("不存在的东西.txt");
        assert!(recycle(&ghost).is_err());
    }

    // ---- 剪贴板内存布局 ----

    #[test]
    fn hdrop_layout_is_what_the_shell_expects() {
        let paths = vec![PathBuf::from(r"C:\a\b.txt"), PathBuf::from(r"C:\c")];
        let buf = hdrop_bytes(&paths);

        // DROPFILES.pFiles = 路径列表的起点偏移
        let off = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        assert_eq!(off, std::mem::size_of::<windows::Win32::UI::Shell::DROPFILES>());
        // fWide 必须为真，否则系统按 ANSI 去读我们写的 UTF-16
        assert_eq!(u32::from_le_bytes(buf[16..20].try_into().unwrap()), 1);

        let wide: Vec<u16> = buf[off..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        // 结尾必须是双 \0（列表项自己的 \0 + 收尾 \0）
        assert!(wide.len() >= 2);
        assert_eq!(&wide[wide.len() - 2..], &[0, 0]);

        let text = String::from_utf16_lossy(&wide[..wide.len() - 2]);
        assert_eq!(
            text.split('\0').collect::<Vec<_>>(),
            vec![r"C:\a\b.txt", r"C:\c"]
        );
    }

    #[test]
    fn hdrop_of_one_path_is_still_double_terminated() {
        let buf = hdrop_bytes(&[PathBuf::from(r"C:\x")]);
        let off = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        let tail = &buf[buf.len() - 4..];
        assert_eq!(tail, &[0, 0, 0, 0]);
        assert!(off < buf.len());
    }

    // ---- 复制 ----

    #[test]
    fn copy_into_walks_a_directory_tree() {
        let d = scratch();
        let src = d.path().join("src");
        std::fs::create_dir_all(src.join("inner")).unwrap();
        std::fs::write(src.join("a.txt"), b"a").unwrap();
        std::fs::write(src.join("inner").join("b.txt"), b"b").unwrap();

        let dest = d.path().join("dest");
        copy_into(&src, &dest).unwrap();
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"a");
        assert_eq!(std::fs::read(dest.join("inner").join("b.txt")).unwrap(), b"b");
        // 源还在（复制不是移动）
        assert!(src.join("a.txt").exists());
    }

    // ---- 真造一个 .lnk / 一个 .zip（各一次 PowerShell，慢但不碰真桌面） ----

    #[test]
    fn create_shortcut_writes_a_real_lnk() {
        let d = scratch();
        let target = d.path().join("目标文件夹");
        std::fs::create_dir(&target).unwrap();
        let lnk = d.path().join("指过去.lnk");

        create_shortcut(&target.to_string_lossy(), &lnk).unwrap();
        assert!(lnk.exists(), "WScript.Shell 应该造出一个 .lnk");
        assert!(lnk.metadata().unwrap().len() > 0);
    }

    #[test]
    fn compress_produces_a_zip_next_to_the_item() {
        let d = scratch();
        let src = d.path().join("要压缩.txt");
        std::fs::write(&src, b"hello").unwrap();
        let zip = d.path().join("要压缩.zip");

        let script = format!(
            "$ErrorActionPreference='Stop';Compress-Archive -LiteralPath '{}' -DestinationPath '{}'",
            psq(&src.to_string_lossy()),
            psq(&zip.to_string_lossy())
        );
        run_ps(&script).unwrap();
        assert!(zip.exists());
        assert!(zip.metadata().unwrap().len() > 0);
    }
}
