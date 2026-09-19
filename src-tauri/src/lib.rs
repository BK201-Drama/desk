mod cursor;
mod desk_tidy;
mod fence;
mod github;
mod multica;
mod paths;
mod plugins;
mod proc;
mod qqmusic;
mod recent;
mod remind;
mod stock;
mod sys_res;
mod wallpaper;
#[cfg(windows)]
mod win_zorder;
// 命令清单解析器的测试；解析器本身在 `src-tauri/cmd_manifest.rs`，与 `build.rs` `include!` 共享。
#[cfg(test)]
mod manifest_tests;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn sink_below_apps(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let h = hwnd.0 as isize;
        win_zorder::hide_from_taskbar(h);
        win_zorder::sink_if_needed(h);
        return;
    }
    let _ = window.set_always_on_bottom(true);
}

fn autostart_off_flag() -> Result<std::path::PathBuf, String> {
    Ok(crate::paths::app_data_dir()?.join("autostart-off"))
}

/// Align the window's right edge to ~40% of the work area width; vertically center (excludes taskbar).
fn place_left(window: &tauri::WebviewWindow) -> Option<(i32, i32)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let wa = monitor.work_area();
    let ws = window.outer_size().ok()?;
    let anchor = ((wa.size.width as f64) * 0.40).round() as i32;
    let x = wa.position.x + anchor - ws.width as i32;
    let y = wa.position.y + (wa.size.height as i32 - ws.height as i32).max(0) / 2;
    let _ = window.set_position(PhysicalPosition::new(x, y));
    Some((x, y))
}

#[tauri::command]
fn set_cursor(app: tauri::AppHandle, icon: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let icon = match icon.as_str() {
        "pointer" => tauri::CursorIcon::Hand,
        "grab" => tauri::CursorIcon::Grab,
        "grabbing" => tauri::CursorIcon::Grabbing,
        _ => tauri::CursorIcon::Default,
    };
    window.set_cursor_icon(icon).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_keyboard_input(app: tauri::AppHandle, active: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        win_zorder::set_keyboard_input_mode(hwnd.0 as isize, active);
    }
    if active {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    // Stay under other apps even while the board is interactive.
    sink_below_apps(&window);
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Frontend reports plugins-ready ms for cold-start tuning.
#[tauri::command]
fn boot_mark(ms: u32) -> Result<(), String> {
    let dir = crate::paths::app_data_dir()?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = format!("{{\"ms\":{ms},\"at\":{secs}}}\n");
    std::fs::write(dir.join("boot-last.json"), body).map_err(|e| e.to_string())
}

/// `tauri dev` 用 `--no-default-features` 编出来的 exe 走 `devUrl`（localhost:1420）。
/// 把它写进开机启动，下次登录就是黑窗 + ERR_CONNECTION_REFUSED。
fn uses_embedded_frontend() -> bool {
    cfg!(feature = "custom-protocol")
}

const DEV_AUTOSTART_ERR: &str =
    "开发版没有内嵌页面，开机启动会去连 localhost:1420 然后失败。请用安装版（npm run tauri build）再开开机自启。";

/// HKCU Run 里的 desk 项是不是指向当前这个开发版 exe。
#[cfg(windows)]
fn run_entry_points_at_current_exe() -> bool {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        REG_VALUE_TYPE,
    };

    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe_l = exe.display().to_string().to_ascii_lowercase();

    unsafe {
        let mut hkey = Default::default();
        let sub = windows::core::w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
        if RegOpenKeyExW(HKEY_CURRENT_USER, sub, 0, KEY_READ, &mut hkey).is_err() {
            return false;
        }
        let name = windows::core::w!("desk");
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let _ = RegQueryValueExW(hkey, name, None, Some(&mut ty), None, Some(&mut size));
        if size == 0 || ty != REG_SZ {
            let _ = RegCloseKey(hkey);
            return false;
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
            return false;
        }
        let u16s: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&c| c != 0)
            .collect();
        let val = String::from_utf16_lossy(&u16s).to_ascii_lowercase();
        val.contains(&exe_l) || val.contains("target\\debug\\desk.exe")
    }
}

#[cfg(not(windows))]
fn run_entry_points_at_current_exe() -> bool {
    false
}

#[tauri::command]
fn autostart_get(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    if enabled && !uses_embedded_frontend() {
        return Err(DEV_AUTOSTART_ERR.into());
    }
    let mgr = app.autolaunch();
    if enabled {
        if let Ok(flag) = autostart_off_flag() {
            let _ = std::fs::remove_file(flag);
        }
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        if let Ok(flag) = autostart_off_flag() {
            let _ = std::fs::write(&flag, b"1");
        }
        mgr.disable().map_err(|e| e.to_string())?;
    }
    mgr.is_enabled().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_skip_taskbar(true);
                let _ = window.show();
                let _ = window.set_focus();
                sink_below_apps(&window);
                let _ = place_left(&window);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    match shortcut.key {
                        Code::KeyD => {
                            let _ = app.emit("desk:toggle-edit", ());
                        }
                        Code::KeyK => {
                            let _ = app.emit("desk:open-cmdk", ());
                        }
                        _ => {}
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            set_keyboard_input,
            set_cursor,
            boot_mark,
            autostart_get,
            autostart_set,
            multica::multica_app_url,
            multica::multica_snapshot,
            github::github_cached,
            github::github_snapshot,
            github::github_set_token,
            remind::remind_list,
            remind::remind_add,
            remind::remind_toggle,
            remind::remind_remove,
            fence::fence_rescan,
            fence::fence_list,
            fence::fence_launch,
            fence::fence_restore,
            fence::fence_status,
            fence::fence_icons_visible,
            fence::fence_set_icons_visible,
            fence::fence_save_order,
            fence::fence_save_ui,
            // 右键菜单的文件操作：全仓**唯一**会动用户文件的命令组，
            // 每个入口先过 `ops::locate`（只放行桌面根的直接子项）。
            fence::ops::fence_create,
            fence::ops::fence_rename,
            fence::ops::fence_delete,
            fence::ops::fence_properties,
            fence::ops::fence_open_with,
            fence::ops::fence_reveal,
            fence::ops::fence_clipboard,
            fence::ops::fence_paste,
            fence::ops::fence_send_to,
            fence::ops::fence_compress,
            recent::recent_list,
            recent::recent_push,
            plugins::plugin_list_user,
            plugins::plugin_get_config,
            plugins::plugin_set_disabled,
            plugins::plugin_set_order,
            plugins::plugin_list_presets,
            plugins::plugin_apply_preset,
            plugins::plugin_apply_scheme,
            plugins::plugin_create_scheme,
            plugins::plugin_update_scheme,
            plugins::plugin_delete_scheme,
            plugins::plugin_save_custom,
            plugins::plugin_discard_custom_draft,
            plugins::plugin_storage_get,
            plugins::plugin_storage_set,
            qqmusic::qqmusic_status,
            qqmusic::qqmusic_now_playing,
            qqmusic::qqmusic_ensure_running,
            qqmusic::qqmusic_launch,
            qqmusic::qqmusic_toggle,
            qqmusic::qqmusic_next,
            qqmusic::qqmusic_prev,
            stock::stock_cached,
            stock::stock_quotes,
            cursor::cursor_cached,
            cursor::cursor_usage,
            sys_res::sys_res_snapshot,
            wallpaper::wallpaper_sample,
            desk_tidy::desk_tidy_status,
            desk_tidy::desk_tidy_run,
        ])
        .setup(|app| {
            let locked: Arc<Mutex<Option<(i32, i32)>>> = Arc::new(Mutex::new(None));

            if let Some(window) = app.get_webview_window("main") {
                // Sit under normal apps but stay interactive — full ignore_cursor_events makes the board dead.
                let _ = window.set_skip_taskbar(true);
                sink_below_apps(&window);
                let _ = window.set_always_on_bottom(true);
                let _ = window.set_ignore_cursor_events(false);
                let _ = window.set_resizable(false);
                if let Some(pos) = place_left(&window) {
                    if let Ok(mut g) = locked.lock() {
                        *g = Some(pos);
                    }
                }

                let win = window.clone();
                let locked_ev = locked.clone();
                window.on_window_event(move |event| {
                    match event {
                        WindowEvent::Moved(pos) => {
                            let target = locked_ev.lock().ok().and_then(|g| *g);
                            if let Some((x, y)) = target {
                                if pos.x != x || pos.y != y {
                                    let _ = win.set_position(PhysicalPosition::new(x, y));
                                }
                            }
                        }
                        WindowEvent::Resized(_) => {
                            if let Some(pos) = place_left(&win) {
                                if let Ok(mut g) = locked_ev.lock() {
                                    *g = Some(pos);
                                }
                            }
                        }
                        WindowEvent::Focused(true) => {
                            sink_below_apps(&win);
                        }
                        _ => {}
                    }
                });

                // Rare fallback: another HWND_BOTTOM app (QQ Music) may slip under us. Blind restacking
                // flickers, so this only re-sinks us periodically.
                let win_keep = window.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_secs(4));
                        let w = win_keep.clone();
                        let _ = win_keep.run_on_main_thread(move || sink_below_apps(&w));
                    }
                });
            }

            // 自启注册延后：不挡首帧 / setup 临界路径。
            // 开发版（无 custom-protocol）禁止写 HKCU\Run：那个 exe 只认 localhost。
            // 若上次已经被写成 target\debug\desk.exe，启动时把这条删掉。
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let mgr = app_handle.autolaunch();
                if !uses_embedded_frontend() {
                    if run_entry_points_at_current_exe() {
                        let _ = mgr.disable();
                        eprintln!("autostart: removed debug exe from HKCU\\Run");
                    }
                    return;
                }
                let opted_out = autostart_off_flag().map(|p| p.exists()).unwrap_or(false);
                if !opted_out {
                    // Re-register so HKCU\Run tracks current_exe().
                    let _ = mgr.enable();
                }
            });

            // HideIcons 孤儿态自检：后台跑，不挡首帧（要起 reg 进程 + 可能刷 Explorer）
            let app_handle_recover = app.handle().clone();
            std::thread::spawn(move || {
                match fence::hide::recover_orphan_hidden_state() {
                    Ok(true) => {
                        eprintln!("recovered orphan HideIcons=1 -> 0");
                        let _ = app_handle_recover.emit("fence:hide-recovered", ());
                    }
                    Ok(false) => {}
                    Err(e) => eprintln!("recover_orphan_hidden_state: {e}"),
                }
            });

            // 真桌面的变化监听：没有它，看板就是冷启动那一刻的快照。
            // 失败只记一笔 —— 监听坏掉只是退化回快照，不该连累整个应用起不来。
            if let Err(e) = fence::watch::start(app.handle().clone()) {
                eprintln!("fence::watch::start: {e}");
            }

            let edit_sc =
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);
            if let Err(e) = app.global_shortcut().register(edit_sc) {
                eprintln!("global shortcut Win+Shift+D: {e}");
            }
            // Board sits under apps — in-page Ctrl+K never fires without focus; these global ones always reach desk.
            let cmdk_sc =
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyK);
            if let Err(e) = app.global_shortcut().register(cmdk_sc) {
                eprintln!("global shortcut Ctrl+Shift+K: {e}");
            }
            let cmdk_win =
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyK);
            if let Err(e) = app.global_shortcut().register(cmdk_win) {
                eprintln!("global shortcut Win+Shift+K: {e}");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                // INV-3：desk 不运行时，HideIcons 必须是 0。
                // 关机/注销时会话正在拆，绝不能再 CreateProcess(reg/powershell) → 0xc0000142。
                if let Err(e) = fence::hide::disable_for_exit() {
                    eprintln!("hide::disable_for_exit: {e}");
                }
            }
        });
}
