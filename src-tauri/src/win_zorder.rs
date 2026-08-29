//! Keep desk under normal apps without restacking every frame.
//! Repeated SetWindowPos(HWND_BOTTOM) on a transparent WebView2 causes DWM flicker.

#![cfg(windows)]

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

static KEYBOARD_INPUT: AtomicBool = AtomicBool::new(false);

type BOOL = i32;
type HWND = *mut c_void;
type DWORD = u32;

const GWL_EXSTYLE: i32 = -20;
const WS_EX_NOACTIVATE: i32 = 0x0800_0000;
const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;
const WS_EX_APPWINDOW: i32 = 0x0004_0000;
const HWND_BOTTOM: HWND = 1 as HWND;
const SWP_NOSIZE: u32 = 0x0001;
const SWP_NOMOVE: u32 = 0x0002;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOREDRAW: u32 = 0x0008;
const SWP_NOACTIVATE: u32 = 0x0010;
const SWP_FRAMECHANGED: u32 = 0x0020;
const GW_HWNDNEXT: u32 = 2;

type WndEnumProc = unsafe extern "system" fn(HWND, isize) -> BOOL;

#[link(name = "user32")]
unsafe extern "system" {
    fn GetWindowLongW(hwnd: HWND, index: i32) -> i32;
    fn SetWindowLongW(hwnd: HWND, index: i32, value: i32) -> i32;
    fn SetWindowPos(
        hwnd: HWND,
        insert_after: HWND,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> BOOL;
    fn IsWindow(hwnd: HWND) -> BOOL;
    fn IsWindowVisible(hwnd: HWND) -> BOOL;
    fn IsIconic(hwnd: HWND) -> BOOL;
    fn EnumWindows(cb: WndEnumProc, lparam: isize) -> BOOL;
    fn GetWindowThreadProcessId(hwnd: HWND, pid: *mut DWORD) -> DWORD;
    fn GetWindow(hwnd: HWND, cmd: u32) -> HWND;
    fn GetClassNameW(hwnd: HWND, buf: *mut u16, max: i32) -> i32;
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

fn is_shell_chrome(hwnd: HWND) -> bool {
    matches!(
        class_name(hwnd).as_str(),
        "Progman"
            | "WorkerW"
            | "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "NotifyIconOverflowWindow"
            | "Button"
            | "XamlExplorerHostIslandWindow"
            | "Windows.UI.Core.CoreWindow"
            | "ApplicationFrameWindow"
    )
}

fn set_noactivate_flag(hwnd: HWND, noactivate: bool) {
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if noactivate {
            if ex & WS_EX_NOACTIVATE == 0 {
                SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE);
            }
        } else if ex & WS_EX_NOACTIVATE != 0 {
            SetWindowLongW(hwnd, GWL_EXSTYLE, ex & !WS_EX_NOACTIVATE);
        }
    }
}

/// Allow keyboard/IME into WebView2 inputs (clears WS_EX_NOACTIVATE while active).
pub fn set_keyboard_input_mode(hwnd: isize, active: bool) {
    KEYBOARD_INPUT.store(active, Ordering::SeqCst);
    if hwnd == 0 {
        return;
    }
    set_noactivate_flag(hwnd as HWND, !active);
}

/// Keep desk off the taskbar (config skipTaskbar is not always enough on WebView2).
pub fn hide_from_taskbar(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let hwnd = hwnd as HWND;
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        let next = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
        if next == ex {
            return;
        }
        SetWindowLongW(hwnd, GWL_EXSTYLE, next);
        let _ = SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

fn apply_noactivate(hwnd: HWND) {
    if KEYBOARD_INPUT.load(Ordering::SeqCst) {
        set_noactivate_flag(hwnd, false);
        return;
    }
    unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_NOACTIVATE == 0 {
            SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE);
        }
    }
}

fn sink_one(hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOREDRAW,
        );
    }
}

/// True if a visible foreign window sits below `hwnd` in z-order.
fn has_app_below(hwnd: HWND) -> bool {
    let self_pid = std::process::id();
    unsafe {
        let mut cur = GetWindow(hwnd, GW_HWNDNEXT);
        while !cur.is_null() {
            if IsWindow(cur) != 0 && IsWindowVisible(cur) != 0 && IsIconic(cur) == 0 {
                let mut pid: DWORD = 0;
                GetWindowThreadProcessId(cur, &mut pid);
                if pid != 0 && pid != self_pid && !is_shell_chrome(cur) {
                    return true;
                }
            }
            cur = GetWindow(cur, GW_HWNDNEXT);
        }
    }
    false
}

unsafe extern "system" fn enum_noactivate(hwnd: HWND, lparam: isize) -> BOOL {
    let target_pid = lparam as DWORD;
    let mut pid: DWORD = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid == target_pid {
        if KEYBOARD_INPUT.load(Ordering::SeqCst) {
            set_noactivate_flag(hwnd, false);
        } else {
            apply_noactivate(hwnd);
        }
    }
    1
}

pub fn apply_noactivate_all() {
    let pid = std::process::id();
    unsafe {
        EnumWindows(enum_noactivate, pid as isize);
    }
}

/// Only restack when another app is actually underneath (avoids DWM flicker).
pub fn sink_if_needed(hwnd: isize) {
    if hwnd == 0 {
        return;
    }
    let hwnd = hwnd as HWND;
    unsafe {
        if IsWindow(hwnd) == 0 {
            return;
        }
    }
    apply_noactivate(hwnd);
    apply_noactivate_all();
    if has_app_below(hwnd) {
        sink_one(hwnd);
    }
}
