//! Minimise, maximise and close for the Windows app, which has no title bar.
//!
//! `caption_buttons.tsx` draws them, but WebView2's window over the client area takes their input,
//! and Windows 11 offers snap layouts only to a window answering `WM_NCHITTEST` with `HTMAXBUTTON`.
//! So a window of ours covers the buttons, answers for them, and tells the page which is hovered or
//! pressed.
//!
//! WebView2's Window Controls Overlay draws caption buttons itself and may replace this module
//! once it has snap layouts and a stable SDK. It is experimental-only as of September 2026:
//! https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2experimentalwindowcontrolsoverlay

use crate::Runtime;

/// The buttons' size in physical pixels, measured by the page; zero hides them.
#[tauri::command]
pub fn set_caption_buttons(window: tauri::WebviewWindow<Runtime>, width: i32, height: i32) {
    resize(&window, width, height);
}

#[cfg(not(target_os = "windows"))]
pub fn attach(_window: &tauri::WebviewWindow<Runtime>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn resize(_window: &tauri::WebviewWindow<Runtime>, _width: i32, _height: i32) {}

#[cfg(target_os = "windows")]
pub use win32::attach;
#[cfg(target_os = "windows")]
use win32::resize;

#[cfg(target_os = "windows")]
mod win32 {
    use std::cell::Cell;
    use std::ptr::{null, null_mut};

    use serde::Serialize;
    use tauri::{Emitter, Manager};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CREATESTRUCTW, CreateWindowExW, DefWindowProcW, FindWindowExW, GWLP_USERDATA,
        GetClientRect, GetParent, GetWindowLongPtrW, HTCLOSE, HTMAXBUTTON, HTMINBUTTON, HTNOWHERE,
        HWND_TOP, IDC_ARROW, IsZoomed, LoadCursorW, PostMessageW, RegisterClassW, SM_CYFRAME,
        SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SendMessageW, SetWindowLongPtrW, SetWindowPos,
        ShowWindow, WM_CLOSE, WM_NCCREATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SIZE, WM_USER,
        WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS,
    };
    use windows_sys::core::PCWSTR;

    use crate::Runtime;

    const CLASS: PCWSTR = windows_sys::w!("BowerbirdCaptionButtons");
    const WM_SET_SIZE: u32 = WM_USER + 1;
    const PLACE_ON_RESIZE: usize = 1;

    #[derive(Clone, Copy, PartialEq, Serialize)]
    #[serde(rename_all = "lowercase")]
    enum Button {
        Minimize,
        Maximize,
        Close,
    }

    impl Button {
        fn hit_test(self) -> u32 {
            match self {
                Button::Minimize => HTMINBUTTON,
                Button::Maximize => HTMAXBUTTON,
                Button::Close => HTCLOSE,
            }
        }

        fn from_hit_test(code: WPARAM) -> Option<Button> {
            match code as u32 {
                HTMINBUTTON => Some(Button::Minimize),
                HTMAXBUTTON => Some(Button::Maximize),
                HTCLOSE => Some(Button::Close),
                _ => None,
            }
        }
    }

    #[derive(Clone, Copy, PartialEq, Serialize)]
    struct Pointer {
        hovered: Option<Button>,
        pressed: Option<Button>,
    }

    // Cells, since `SetWindowPos` and `ShowWindow` re-enter `strip_proc` with messages of its own.
    struct Strip {
        app: tauri::AppHandle<Runtime>,
        width: Cell<i32>,
        height: Cell<i32>,
        held: Cell<Option<Button>>,
        shown: Cell<Pointer>,
        tracking: Cell<bool>,
    }

    impl Strip {
        fn hover(&self, hovered: Option<Button>) {
            let pressed = self.held.get().filter(|held| Some(*held) == hovered);
            let pointer = Pointer { hovered, pressed };
            if pointer != self.shown.replace(pointer) {
                let _ = self.app.emit("caption-buttons", pointer);
            }
        }

        fn release(&self) {
            self.tracking.set(false);
            self.held.set(None);
            self.hover(None);
        }
    }

    /// Called on the main thread, whose message loop the strip's messages arrive on.
    pub fn attach(window: &tauri::WebviewWindow<Runtime>) -> Result<(), String> {
        let parent = hwnd(window).ok_or("the window has no HWND")?;
        let strip = Box::new(Strip {
            app: window.app_handle().clone(),
            width: Cell::new(0),
            height: Cell::new(0),
            held: Cell::new(None),
            shown: Cell::new(Pointer {
                hovered: None,
                pressed: None,
            }),
            tracking: Cell::new(false),
        });
        // Safety: `parent` is the live main window; the strip owns its `Strip` from `WM_NCCREATE`
        // until `WM_NCDESTROY`.
        unsafe {
            let instance = GetModuleHandleW(null());
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(strip_proc),
                hInstance: instance,
                hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                lpszClassName: CLASS,
                ..std::mem::zeroed()
            });
            let child = CreateWindowExW(
                0,
                CLASS,
                null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                parent,
                null_mut(),
                instance,
                Box::into_raw(strip).cast(),
            );
            if child.is_null() {
                return Err("could not create the caption buttons' window".into());
            }
            if SetWindowSubclass(parent, Some(parent_proc), PLACE_ON_RESIZE, child as usize) == 0 {
                return Err("could not follow the window's resizes for its caption buttons".into());
            }
        }
        Ok(())
    }

    pub fn resize(window: &tauri::WebviewWindow<Runtime>, width: i32, height: i32) {
        let Some(parent) = hwnd(window) else { return };
        // Safety: a message to our own child of a live window.
        unsafe {
            let strip = FindWindowExW(parent, null_mut(), CLASS, null());
            if !strip.is_null() {
                SendMessageW(
                    strip,
                    WM_SET_SIZE,
                    width.max(0) as WPARAM,
                    height.max(0) as LPARAM,
                );
            }
        }
    }

    fn hwnd(window: &tauri::WebviewWindow<Runtime>) -> Option<HWND> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        match window.window_handle().ok()?.as_raw() {
            RawWindowHandle::Win32(handle) => Some(handle.hwnd.get() as HWND),
            _ => None,
        }
    }

    unsafe extern "system" fn parent_proc(
        parent: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        strip: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            RemoveWindowSubclass(parent, Some(parent_proc), id);
        }
        // After the rest of the chain, which resizes WebView2's window.
        let result = DefSubclassProc(parent, message, wparam, lparam);
        if message == WM_SIZE {
            place(parent, strip as HWND);
        }
        result
    }

    unsafe extern "system" fn strip_proc(
        strip: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_NCCREATE {
            let create = &*(lparam as *const CREATESTRUCTW);
            SetWindowLongPtrW(strip, GWLP_USERDATA, create.lpCreateParams as isize);
            return DefWindowProcW(strip, message, wparam, lparam);
        }
        let state = GetWindowLongPtrW(strip, GWLP_USERDATA) as *mut Strip;
        if state.is_null() {
            return DefWindowProcW(strip, message, wparam, lparam);
        }
        if message == WM_NCDESTROY {
            SetWindowLongPtrW(strip, GWLP_USERDATA, 0);
            drop(Box::from_raw(state));
            return DefWindowProcW(strip, message, wparam, lparam);
        }
        let state = &*state;

        match message {
            WM_SET_SIZE => {
                state.width.set(wparam as i32);
                state.height.set(lparam as i32);
                place(GetParent(strip), strip);
                0
            }
            WM_NCHITTEST => button_at(strip, lparam).map_or(HTNOWHERE, Button::hit_test) as LRESULT,
            WM_NCMOUSEMOVE => {
                // TME_NONCLIENT, or the leave arrives after a hover timeout instead.
                if !state.tracking.get() {
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: strip,
                        dwHoverTime: 0,
                    };
                    state.tracking.set(TrackMouseEvent(&mut track) != 0);
                }
                state.hover(Button::from_hit_test(wparam));
                0
            }
            WM_NCMOUSELEAVE => {
                state.release();
                0
            }
            // Handled here rather than by `DefWindowProcW`, which would run its own caption
            // button loop against the system's metrics. A quick second click arrives as the
            // double-click whatever the class style.
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                state.held.set(Button::from_hit_test(wparam));
                state.hover(state.held.get());
                0
            }
            WM_NCLBUTTONUP => {
                let released = Button::from_hit_test(wparam);
                let held = state.held.take();
                state.hover(released);
                if let Some(button) = released.filter(|button| Some(*button) == held) {
                    click(GetParent(strip), button);
                }
                0
            }
            _ => DefWindowProcW(strip, message, wparam, lparam),
        }
    }

    unsafe fn place(parent: HWND, strip: HWND) {
        let Some(state) = (GetWindowLongPtrW(strip, GWLP_USERDATA) as *const Strip).as_ref() else {
            return;
        };
        // Tauri's undecorated-resize window owns a restored window's top edge.
        let top = if IsZoomed(parent) != 0 {
            0
        } else {
            GetSystemMetricsForDpi(SM_CYFRAME, GetDpiForWindow(parent))
        };
        let (width, height) = (state.width.get(), state.height.get());
        if width == 0 || height <= top {
            state.release();
            SetWindowPos(
                strip,
                null_mut(),
                0,
                0,
                0,
                0,
                SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            return;
        }
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(parent, &mut client);
        SetWindowPos(
            strip,
            HWND_TOP,
            client.right - width,
            top,
            width,
            height - top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        );
    }

    unsafe fn button_at(strip: HWND, lparam: LPARAM) -> Option<Button> {
        let mut point = POINT {
            x: (lparam & 0xffff) as i16 as i32,
            y: ((lparam >> 16) & 0xffff) as i16 as i32,
        };
        let mut client: RECT = std::mem::zeroed();
        if ScreenToClient(strip, &mut point) == 0 || GetClientRect(strip, &mut client) == 0 {
            return None;
        }
        if client.right <= 0 {
            return None;
        }
        match point.x * 3 / client.right {
            0 => Some(Button::Minimize),
            1 => Some(Button::Maximize),
            2 => Some(Button::Close),
            _ => None,
        }
    }

    unsafe fn click(parent: HWND, button: Button) {
        match button {
            Button::Minimize => {
                ShowWindow(parent, SW_MINIMIZE);
            }
            Button::Maximize => {
                ShowWindow(
                    parent,
                    if IsZoomed(parent) != 0 {
                        SW_RESTORE
                    } else {
                        SW_MAXIMIZE
                    },
                );
            }
            Button::Close => {
                PostMessageW(parent, WM_CLOSE, 0, 0);
            }
        }
    }
}
