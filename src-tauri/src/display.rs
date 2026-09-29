//! Whether the window's screen shows light past SDR white.
//!
//! WKWebView answers `(dynamic-range: high)` "no" on a screen that does, where Safari on the same
//! screen answers "yes", so the page asks the shell instead of the media query.

/// Null where the shell has no better answer than the page's own media query.
#[tauri::command]
pub async fn display_is_hdr(window: tauri::WebviewWindow<crate::Runtime>) -> Option<bool> {
    hdr(window).await
}

#[cfg(target_os = "macos")]
async fn hdr(window: tauri::WebviewWindow<crate::Runtime>) -> Option<bool> {
    let (answer, answered) = tokio::sync::oneshot::channel();
    let asked = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = answer.send(screen_is_hdr(&asked));
        })
        .ok()?;
    answered.await.ok().flatten()
}

/// Called on the main thread, which AppKit requires of every call below.
#[cfg(target_os = "macos")]
fn screen_is_hdr(window: &tauri::WebviewWindow<crate::Runtime>) -> Option<bool> {
    use objc2_app_kit::NSWindow;
    let raw = window.ns_window().ok()?;
    // Safety: Tauri's own NSWindow for `window`, which outlives this call.
    let ns_window = unsafe { &*raw.cast::<NSWindow>() };
    // What WebKit's own `(dynamic-range: high)` reads, and Safari answers from.
    Some(
        ns_window
            .screen()?
            .maximumPotentialExtendedDynamicRangeColorComponentValue()
            > 1.0,
    )
}

#[cfg(not(target_os = "macos"))]
async fn hdr(_window: tauri::WebviewWindow<crate::Runtime>) -> Option<bool> {
    None
}
