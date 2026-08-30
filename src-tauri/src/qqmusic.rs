use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
pub struct QqmusicNowPlaying {
    pub active: bool,
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// playing | paused | stopped | unknown
    pub status: String,
    pub artwork_path: Option<String>,
    pub can_play_pause: bool,
    pub can_next: bool,
    pub can_prev: bool,
    pub installed: bool,
    pub install_path: Option<String>,
    pub hint: String,
}

fn candidate_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if p.exists() {
            out.push(p);
        }
    };
    if let Ok(pf) = std::env::var("ProgramFiles") {
        push(PathBuf::from(&pf).join(r"Tencent\QQMusic\QQMusic.exe"));
        push(PathBuf::from(&pf).join(r"Tencent\QQMusic\QQMusicApp.exe"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        push(PathBuf::from(&pf86).join(r"Tencent\QQMusic\QQMusic.exe"));
        push(PathBuf::from(&pf86).join(r"Tencent\QQMusic\QQMusicApp.exe"));
    }
    if let Some(local) = dirs::data_local_dir() {
        push(local.join(r"Programs\QQMusic\QQMusic.exe"));
        push(local.join(r"Tencent\QQMusic\QQMusic.exe"));
    }
    out
}

fn find_install() -> Option<PathBuf> {
    candidate_paths().into_iter().next()
}

fn artwork_cache_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join("desk").join("qqmusic-art.bin"))
}

fn empty_np(hint: &str) -> QqmusicNowPlaying {
    let path = find_install();
    QqmusicNowPlaying {
        active: false,
        app_id: String::new(),
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        status: "stopped".into(),
        artwork_path: None,
        can_play_pause: true,
        can_next: true,
        can_prev: true,
        installed: path.is_some(),
        install_path: path.map(|p| p.to_string_lossy().to_string()),
        hint: hint.into(),
    }
}

/// Never call WinRT `.get()` on the UI/IPC thread — it deadlocks and freezes the window.
fn on_worker<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static, timeout: Duration) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(timeout).ok()
}

#[cfg(windows)]
mod smtc {
    use super::*;
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession,
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Storage::Streams::{Buffer, InputStreamOptions};

    fn is_qqmusic_app(id: &str) -> bool {
        let s = id.to_lowercase();
        s.contains("qqmusic") || s.contains("qq音乐") || s.contains("tencent.qqmusic")
    }

    fn pick_session(
        manager: &GlobalSystemMediaTransportControlsSessionManager,
    ) -> windows::core::Result<Option<GlobalSystemMediaTransportControlsSession>> {
        if let Ok(sessions) = manager.GetSessions() {
            let len = sessions.Size().unwrap_or(0);
            for i in 0..len {
                if let Ok(s) = sessions.GetAt(i) {
                    if let Ok(id) = s.SourceAppUserModelId() {
                        if is_qqmusic_app(&id.to_string()) {
                            return Ok(Some(s));
                        }
                    }
                }
            }
        }
        if let Ok(cur) = manager.GetCurrentSession() {
            if let Ok(id) = cur.SourceAppUserModelId() {
                if is_qqmusic_app(&id.to_string()) {
                    return Ok(Some(cur));
                }
            }
        }
        Ok(None)
    }

    fn status_label(
        st: GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    ) -> &'static str {
        match st {
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing => "playing",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused => "paused",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped => "stopped",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Opened => "opened",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Closed => "closed",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus::Changing => "changing",
            _ => "unknown",
        }
    }

    fn save_thumbnail(
        session: &GlobalSystemMediaTransportControlsSession,
        title: &str,
        artist: &str,
    ) -> Option<String> {
        let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let thumb_ref = props.Thumbnail().ok()?;
        let stream = thumb_ref.OpenReadAsync().ok()?.get().ok()?;
        let size = stream.Size().ok()? as u32;
        if size == 0 || size > 8_000_000 {
            return None;
        }
        let buffer = Buffer::Create(size).ok()?;
        let _ = stream
            .ReadAsync(&buffer, size, InputStreamOptions::None)
            .ok()?
            .get()
            .ok()?;
        use windows::Storage::Streams::DataReader;
        let reader = DataReader::FromBuffer(&buffer).ok()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes).ok()?;

        let base = artwork_cache_path()?;
        if let Some(parent) = base.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let ext = if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
            "png"
        } else {
            "jpg"
        };
        // 固定路径会让前端/WebView 缓存旧封面；按曲目身份分文件。
        let mut hash: u64 = 5381;
        for b in title.bytes().chain(artist.bytes()).chain(bytes.iter().take(64).copied()) {
            hash = hash.wrapping_mul(33).wrapping_add(b as u64);
        }
        let out = base.with_file_name(format!("qqmusic-art-{hash:x}.{ext}"));
        std::fs::write(&out, &bytes).ok()?;
        Some(out.to_string_lossy().to_string())
    }

    fn now_playing_blocking() -> QqmusicNowPlaying {
        // Worker thread needs COM; without it RequestAsync can hang or fail oddly.
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            );
        }
        let install = find_install();
        let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
            Ok(op) => match op.get() {
                Ok(m) => m,
                Err(_) => return empty_np("无法访问系统媒体会话"),
            },
            Err(_) => return empty_np("无法访问系统媒体会话"),
        };

        let session = match pick_session(&manager) {
            Ok(Some(s)) => s,
            Ok(None) => {
                let installed = install.is_some();
                return QqmusicNowPlaying {
                    active: false,
                    app_id: String::new(),
                    title: String::new(),
                    artist: String::new(),
                    album: String::new(),
                    status: "stopped".into(),
                    artwork_path: None,
                    can_play_pause: true,
                    can_next: true,
                    can_prev: true,
                    installed,
                    install_path: install.map(|p| p.to_string_lossy().to_string()),
                    hint: if installed {
                        "在 QQ 音乐里点播放，这里会显示曲目"
                    } else {
                        "未安装 QQ 音乐客户端"
                    }
                    .into(),
                };
            }
            Err(_) => return empty_np("读取播放会话失败"),
        };

        let app_id = session
            .SourceAppUserModelId()
            .map(|s| s.to_string())
            .unwrap_or_default();

        let props = match session.TryGetMediaPropertiesAsync().and_then(|op| op.get()) {
            Ok(p) => p,
            Err(_) => return empty_np("读取曲目信息失败"),
        };

        let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
        let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
        let album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();

        let status = match session.GetPlaybackInfo() {
            Ok(info) => info
                .PlaybackStatus()
                .map(status_label)
                .unwrap_or("unknown")
                .to_string(),
            Err(_) => "unknown".into(),
        };

        let artwork_path = save_thumbnail(&session, &title, &artist);

        QqmusicNowPlaying {
            active: !title.is_empty() || status == "playing" || status == "paused",
            app_id,
            title: if title.is_empty() {
                "未知曲目".into()
            } else {
                title
            },
            artist,
            album,
            status,
            artwork_path,
            can_play_pause: true,
            can_next: true,
            can_prev: true,
            installed: install.is_some(),
            install_path: install.map(|p| p.to_string_lossy().to_string()),
            hint: String::new(),
        }
    }

    pub fn now_playing() -> QqmusicNowPlaying {
        on_worker(now_playing_blocking, Duration::from_millis(1200))
            .unwrap_or_else(|| empty_np("读取超时（已跳过，避免卡死）"))
    }
}

#[cfg(windows)]
mod mediakey {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
        VIRTUAL_KEY,
    };

    const VK_MEDIA_NEXT_TRACK: u16 = 0xB0;
    const VK_MEDIA_PREV_TRACK: u16 = 0xB1;
    const VK_MEDIA_PLAY_PAUSE: u16 = 0xB3;

    fn send(vk: u16) -> Result<(), String> {
        unsafe {
            let inputs = [
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk),
                            wScan: 0,
                            dwFlags: KEYBD_EVENT_FLAGS(0),
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
                INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT {
                            wVk: VIRTUAL_KEY(vk),
                            wScan: 0,
                            dwFlags: KEYEVENTF_KEYUP,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                },
            ];
            let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            if sent == 0 {
                Err("SendInput 失败".into())
            } else {
                Ok(())
            }
        }
    }

    pub fn toggle() -> Result<(), String> {
        send(VK_MEDIA_PLAY_PAUSE)
    }
    pub fn next() -> Result<(), String> {
        send(VK_MEDIA_NEXT_TRACK)
    }
    pub fn prev() -> Result<(), String> {
        send(VK_MEDIA_PREV_TRACK)
    }
}

#[tauri::command]
pub fn qqmusic_now_playing() -> QqmusicNowPlaying {
    #[cfg(windows)]
    {
        smtc::now_playing()
    }
    #[cfg(not(windows))]
    {
        empty_np("仅 Windows 支持")
    }
}

#[cfg(windows)]
const QQ_EXES: &[&str] = &["QQMusic.exe", "QQMusicApp.exe"];

/// 点播控前：若已退出则后台拉起并等到进程就绪。返回是否刚冷启动。
#[cfg(windows)]
fn ensure_ready_for_control() -> Result<bool, String> {
    if process_running(QQ_EXES) {
        return Ok(false);
    }
    launch_quiet(false)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    while std::time::Instant::now() < deadline {
        if process_running(QQ_EXES) {
            // 给客户端初始化，同时持续藏窗
            for _ in 0..12 {
                hide_qq_main_windows();
                std::thread::sleep(Duration::from_millis(180));
            }
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("QQ 音乐启动超时，请确认已安装".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct QqmusicControlResult {
    /// 本次是否先冷启动了客户端
    pub cold_started: bool,
}

#[tauri::command]
pub fn qqmusic_toggle() -> Result<QqmusicControlResult, String> {
    #[cfg(windows)]
    {
        let cold = ensure_ready_for_control()?;
        mediakey::toggle()?;
        Ok(QqmusicControlResult {
            cold_started: cold,
        })
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows".into())
    }
}

#[tauri::command]
pub fn qqmusic_next() -> Result<QqmusicControlResult, String> {
    #[cfg(windows)]
    {
        let cold = ensure_ready_for_control()?;
        if cold {
            // 刚起来先播起来，再切下一首才有意义
            mediakey::toggle()?;
            std::thread::sleep(Duration::from_millis(600));
        }
        mediakey::next()?;
        Ok(QqmusicControlResult {
            cold_started: cold,
        })
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows".into())
    }
}

#[tauri::command]
pub fn qqmusic_prev() -> Result<QqmusicControlResult, String> {
    #[cfg(windows)]
    {
        let cold = ensure_ready_for_control()?;
        if cold {
            mediakey::toggle()?;
            std::thread::sleep(Duration::from_millis(600));
        }
        mediakey::prev()?;
        Ok(QqmusicControlResult {
            cold_started: cold,
        })
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows".into())
    }
}

#[cfg(windows)]
fn qq_pids() -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
                if QQ_EXES.iter().any(|n| name == n.to_lowercase()) {
                    out.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(windows)]
fn process_running(names: &[&str]) -> bool {
    let _ = names;
    !qq_pids().is_empty()
}

/// 把 QQ 主窗口藏到后台（无官方静默参数，只能启动后强藏）。
#[cfg(windows)]
fn hide_qq_main_windows() {
    use std::sync::Mutex;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE,
    };

    static PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
    {
        let mut g = PIDS.lock().unwrap_or_else(|e| e.into_inner());
        *g = qq_pids();
        if g.is_empty() {
            return;
        }
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, _: LPARAM) -> BOOL {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let hit = PIDS
                .lock()
                .map(|g| g.contains(&pid))
                .unwrap_or(false);
            if !hit || !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() {
                return BOOL(1);
            }
            let w = rect.right - rect.left;
            let h = rect.bottom - rect.top;
            // 只藏主界面；托盘/桌面歌词等小窗放过
            if w >= 320 && h >= 240 {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            BOOL(1)
        }
    }

    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(0));
    }
}

/// 冷启动后几秒内反复藏窗，挡住 QQ 异步弹出的主界面。
#[cfg(windows)]
fn spawn_background_hider() {
    std::thread::spawn(|| {
        for _ in 0..25 {
            hide_qq_main_windows();
            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

#[cfg(windows)]
fn restore_qq_windows() {
    use std::sync::Mutex;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowThreadProcessId, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    static PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());
    {
        let mut g = PIDS.lock().unwrap_or_else(|e| e.into_inner());
        *g = qq_pids();
        if g.is_empty() {
            return;
        }
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, _: LPARAM) -> BOOL {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let hit = PIDS
                .lock()
                .map(|g| g.contains(&pid))
                .unwrap_or(false);
            if !hit {
                return BOOL(1);
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                let w = rect.right - rect.left;
                let h = rect.bottom - rect.top;
                if w >= 320 && h >= 240 {
                    let _ = ShowWindow(hwnd, SW_RESTORE);
                    let _ = SetForegroundWindow(hwnd);
                }
            }
            BOOL(1)
        }
    }

    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(0));
    }
}

#[cfg(windows)]
fn launch_quiet(foreground: bool) -> Result<&'static str, String> {
    use windows::core::{w, HSTRING};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWMINNOACTIVE, SW_SHOWNORMAL};

    if process_running(QQ_EXES) {
        if !foreground {
            hide_qq_main_windows();
        }
        return Ok("already");
    }
    let show = if foreground {
        SW_SHOWNORMAL
    } else {
        // QQ 会无视 show 参数自己弹窗，后面靠 hide 循环压下去
        SW_SHOWMINNOACTIVE
    };
    if let Some(exe) = find_install() {
        let path = HSTRING::from(exe.to_string_lossy().as_ref());
        let rc = unsafe { ShellExecuteW(HWND::default(), w!("open"), &path, None, None, show) };
        if (rc.0 as usize) <= 32 {
            return Err(format!("ShellExecute 失败: {}", rc.0 as usize));
        }
        if !foreground {
            spawn_background_hider();
        }
        return Ok("started");
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED: u32 = 0x00000008;
    Command::new("cmd")
        .args(["/C", "start", "", "qqmusic://"])
        .creation_flags(CREATE_NO_WINDOW | DETACHED)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    if !foreground {
        spawn_background_hider();
    }
    Ok("protocol")
}

/// 兼容保留：主动后台拉起 QQ。面板挂载不再调用（会弹窗/拖慢开机）。
#[tauri::command]
pub fn qqmusic_ensure_running() -> Result<String, String> {
    #[cfg(windows)]
    {
        launch_quiet(false).map(|s| s.into())
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows".into())
    }
}

/// 用户点「前台」：未跑则正常启动；已跑时再调一次让单实例拉前台。
#[tauri::command]
pub fn qqmusic_launch() -> Result<String, String> {
    #[cfg(windows)]
    {
        if process_running(QQ_EXES) {
            // 进程在但窗被我们藏了：恢复前台
            restore_qq_windows();
            return Ok("focus".into());
        }
        launch_quiet(true).map(|s| s.into())
    }
    #[cfg(not(windows))]
    {
        Err("仅 Windows".into())
    }
}

#[tauri::command]
pub fn qqmusic_status() -> QqmusicNowPlaying {
    qqmusic_now_playing()
}
