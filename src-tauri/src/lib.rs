mod fence;
mod github;
mod multica;
mod remind;
#[cfg(windows)]
mod win_zorder;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, PhysicalPosition, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

fn sink_below_apps(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        win_zorder::sink_if_needed(hwnd.0 as isize);
        return;
    }
    let _ = window.set_always_on_bottom(true);
}

fn autostart_off_flag() -> Option<std::path::PathBuf> {
    dirs::data_local_dir().map(|d| d.join("desk").join("autostart-off"))
}

/// Align the window's right edge to ~40% of the work area width;
/// vertically center within the work area (excludes taskbar).
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
fn set_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    // Keep under other apps even when the board is interactive.
    sink_below_apps(&window);
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn autostart_get(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn autostart_set(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let mgr = app.autolaunch();
    if enabled {
        if let Some(flag) = autostart_off_flag() {
            let _ = std::fs::remove_file(flag);
        }
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        if let Some(flag) = autostart_off_flag() {
            if let Some(parent) = flag.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&flag, b"1");
        }
        mgr.disable().map_err(|e| e.to_string())?;
    }
    mgr.is_enabled().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            set_cursor,
            autostart_get,
            autostart_set,
            multica::multica_app_url,
            multica::multica_snapshot,
            github::github_snapshot,
            github::github_set_token,
            remind::remind_list,
            remind::remind_add,
            remind::remind_toggle,
            remind::remind_remove,
            fence::fence_takeover,
            fence::fence_list,
            fence::fence_launch,
            fence::fence_restore,
            fence::fence_status,
            fence::fence_save_order,
        ])
        .setup(|app| {
            let locked: Arc<Mutex<Option<(i32, i32)>>> = Arc::new(Mutex::new(None));

            if let Some(window) = app.get_webview_window("main") {
                // Sit under normal apps, but stay interactive — fence icons / 编辑
                // must receive clicks. Full ignore_cursor_events made the board dead.
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

                // Rare fallback: another HWND_BOTTOM app (QQ Music) may slip under us.
                // Do not restack unless a foreign window is actually below — that flicker.
                let win_keep = window.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_secs(4));
                        let w = win_keep.clone();
                        let _ = win_keep.run_on_main_thread(move || sink_below_apps(&w));
                    }
                });
            }

            let mgr = app.autolaunch();
            if !mgr.is_enabled().unwrap_or(false) {
                let opted_out = autostart_off_flag().map(|p| p.exists()).unwrap_or(false);
                if !opted_out {
                    let _ = mgr.enable();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
