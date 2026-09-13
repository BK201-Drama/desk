mod cursor;
mod fence;
mod github;
mod multica;
mod plugins;
mod proc;
mod qqmusic;
mod recent;
mod remind;
mod stock;
mod sys_res;
#[cfg(windows)]
mod win_zorder;
// 命令清单解析器的自校验测试。解析器本身在 `src-tauri/cmd_manifest.rs`，
// 由 `build.rs` 与这里 `include!` 共享（不复制第二份）。
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
    // Keep under other apps even when the board is interactive.
    sink_below_apps(&window);
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Frontend reports plugins-ready ms for cold-start tuning.
#[tauri::command]
fn boot_mark(ms: u32) -> Result<(), String> {
    let dir = dirs::data_local_dir()
        .ok_or("no local app data")?
        .join("desk");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let body = format!("{{\"ms\":{ms},\"at\":{secs}}}\n");
    std::fs::write(dir.join("boot-last.json"), body).map_err(|e| e.to_string())
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
                    // Match by key — we only register D (edit) and K (cmdk).
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
            // 2026-09-13：只写显示偏好（收起 / 高度），不碰归属与顺序。
            fence::fence_save_ui,
            // Task 14：右键菜单的文件操作。这是全仓**唯一**会动用户文件的命令组，
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
        ])
        .setup(|app| {
            let locked: Arc<Mutex<Option<(i32, i32)>>> = Arc::new(Mutex::new(None));

            if let Some(window) = app.get_webview_window("main") {
                // Sit under normal apps, but stay interactive — fence icons / 编辑
                // must receive clicks. Full ignore_cursor_events made the board dead.
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

            // 自启注册延后：不挡首帧 / setup 临界路径
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                let mgr = app_handle.autolaunch();
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

            // 真桌面的变化监听（Task 13）：在 desk 外面新建 / 删除 / 改名之后，
            // 看板要自己跟上，而不是干等重启 —— 没有它，看板就是冷启动那一刻的快照。
            // 失败只记一笔：监听坏掉的后果是「退化回快照」，不该连累整个应用起不来。
            if let Err(e) = fence::watch::start(app.handle().clone()) {
                eprintln!("fence::watch::start: {e}");
            }

            let edit_sc =
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyD);
            if let Err(e) = app.global_shortcut().register(edit_sc) {
                eprintln!("global shortcut Win+Shift+D: {e}");
            }
            // Board sits under apps — in-page Ctrl+K never fires without focus.
            // Global Ctrl+Shift+K (+ Win+Shift+K) always reaches desk.
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
                // INV-3：desk 不运行时，HideIcons 必须是 0
                if let Err(e) = fence::hide::disable() {
                    eprintln!("hide::disable on exit: {e}");
                }
            }
        });
}
