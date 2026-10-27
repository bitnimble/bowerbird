//! How far past SDR white the window's screen shows light.
//!
//! WKWebView answers `(dynamic-range: high)` "no" on a screen that does, where Safari on the same
//! screen answers "yes", and no page API reads the headroom at all, so the page asks the shell.

#[derive(serde::Serialize)]
pub struct DynamicRange {
    hdr: bool,
    /// Whether this platform reads `headroom` for this screen at all.
    measures: bool,
    /// Right now, as a multiple of SDR white. Null until macOS or Android open the headroom, which
    /// they do only once something on screen asks for HDR.
    headroom: Option<f64>,
    /// The most `headroom` reaches as brightness moves. Null where the platform cannot say.
    potential: Option<f64>,
    /// The panel's own brightest, in nits, whatever the brightness. Null where the platform
    /// cannot say.
    peak: Option<f64>,
}

/// Null where the shell has no better answer than the page's own media query.
#[tauri::command]
pub async fn display_range(window: tauri::WebviewWindow<crate::Runtime>) -> Option<DynamicRange> {
    range(window).await
}

#[cfg(target_os = "macos")]
async fn range(window: tauri::WebviewWindow<crate::Runtime>) -> Option<DynamicRange> {
    let (answer, answered) = tokio::sync::oneshot::channel();
    let asked = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = answer.send(screen_range(&asked));
        })
        .ok()?;
    answered.await.ok().flatten()
}

#[cfg(target_os = "macos")]
const EDR_REFERENCE_WHITE_NITS: f64 = 100.0;

/// Called on the main thread, which AppKit requires of every call below.
#[cfg(target_os = "macos")]
fn screen_range(window: &tauri::WebviewWindow<crate::Runtime>) -> Option<DynamicRange> {
    use objc2_app_kit::NSWindow;
    let raw = window.ns_window().ok()?;
    // Safety: Tauri's own NSWindow for `window`, which outlives this call.
    let ns_window = unsafe { &*raw.cast::<NSWindow>() };
    let screen = ns_window.screen()?;
    let potential = screen.maximumPotentialExtendedDynamicRangeColorComponentValue();
    let headroom = screen.maximumExtendedDynamicRangeColorComponentValue();
    Some(DynamicRange {
        // What WebKit's own `(dynamic-range: high)` reads, and Safari answers from.
        hdr: potential > 1.0,
        measures: true,
        headroom: (headroom > 1.0).then_some(headroom),
        potential: Some(potential),
        // Potential is over a 100-nit white, not the slider's: an XDR panel's 1600 reads 16.
        peak: (potential > 1.0).then_some(potential * EDR_REFERENCE_WHITE_NITS),
    })
}

/// Android's WebView answers `(dynamic-range: high)` "no" on a screen that does, even in a window
/// set to HDR, so the display is asked directly.
#[cfg(target_os = "android")]
async fn range(window: tauri::WebviewWindow<crate::Runtime>) -> Option<DynamicRange> {
    // A method the device's Android predates leaves a Java exception pending.
    macro_rules! unless_missing {
        ($env:ident, $call:expr) => {{
            let answer = $call;
            if answer.is_err() {
                let _ = $env.exception_clear();
            }
            answer.ok()
        }};
    }
    let (answer, answered) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let display = env
                    .call_method(
                        activity,
                        "getWindowManager",
                        "()Landroid/view/WindowManager;",
                        &[],
                    )
                    .and_then(|manager| manager.l())
                    .and_then(|manager| {
                        env.call_method(
                            &manager,
                            "getDefaultDisplay",
                            "()Landroid/view/Display;",
                            &[],
                        )
                    })
                    .and_then(|display| display.l());
                let Some(display) = unless_missing!(env, display) else {
                    let _ = answer.send(None);
                    return;
                };
                let hdr = unless_missing!(
                    env,
                    env.call_method(&display, "isHdr", "()Z", &[])
                        .and_then(|hdr| hdr.z())
                );
                let measures = unless_missing!(
                    env,
                    env.call_method(&display, "isHdrSdrRatioAvailable", "()Z", &[])
                        .and_then(|available| available.z())
                ) == Some(true);
                let headroom = if measures {
                    unless_missing!(
                        env,
                        env.call_method(&display, "getHdrSdrRatio", "()F", &[])
                            .and_then(|ratio| ratio.f())
                    )
                    .filter(|&ratio| ratio > 1.0)
                } else {
                    None
                };
                let potential = unless_missing!(
                    env,
                    env.call_method(&display, "getHighestHdrSdrRatio", "()F", &[])
                        .and_then(|ratio| ratio.f())
                );
                let capabilities = unless_missing!(
                    env,
                    env.call_method(
                        &display,
                        "getHdrCapabilities",
                        "()Landroid/view/Display$HdrCapabilities;",
                        &[],
                    )
                    .and_then(|capabilities| capabilities.l())
                )
                .filter(|capabilities| !capabilities.is_null());
                let peak = capabilities.and_then(|capabilities| {
                    unless_missing!(
                        env,
                        env.call_method(&capabilities, "getDesiredMaxLuminance", "()F", &[])
                            .and_then(|nits| nits.f())
                    )
                    .filter(|&nits| nits > 0.0)
                });
                let _ = answer.send(hdr.map(|hdr| DynamicRange {
                    hdr,
                    measures,
                    headroom: headroom.map(f64::from),
                    potential: potential.map(f64::from),
                    peak: peak.map(f64::from),
                }));
            });
        })
        .ok()?;
    answered.await.ok().flatten()
}

#[cfg(target_os = "windows")]
async fn range(window: tauri::WebviewWindow<crate::Runtime>) -> Option<DynamicRange> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match window.window_handle().ok()?.as_raw() {
        RawWindowHandle::Win32(handle) => output_range(handle.hwnd.get()),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn output_range(hwnd: isize) -> Option<DynamicRange> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput6};
    use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MonitorFromWindow};
    use windows::core::Interface;

    // Safety: Tauri's own window, alive for this call.
    let monitor = unsafe { MonitorFromWindow(HWND(hwnd as *mut _), MONITOR_DEFAULTTONEAREST) };
    // Made per ask: a factory describes its outputs as they were when it was created.
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.ok()?;
    let output = (0..)
        .map_while(|at| unsafe { factory.EnumAdapters1(at) }.ok())
        .flat_map(|adapter| (0..).map_while(move |at| unsafe { adapter.EnumOutputs(at) }.ok()))
        .filter_map(|output| unsafe { output.cast::<IDXGIOutput6>().ok()?.GetDesc1().ok() })
        .find(|output| output.Monitor == monitor)?;
    let hdr = output.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
    let peak = f64::from(output.MaxLuminance);
    // Zero where the EDID names no luminance.
    let headroom = sdr_white_nits(&output.DeviceName)
        .filter(|_| peak > 0.0)
        .map(|white| if hdr { (peak / white).max(1.0) } else { 1.0 });
    Some(DynamicRange {
        hdr,
        measures: headroom.is_some(),
        headroom,
        potential: None,
        peak: (hdr && peak > 0.0).then_some(peak),
    })
}

/// Where the user's SDR content brightness slider puts SDR white on the GDI display `gdi_name`.
#[cfg(target_os = "windows")]
fn sdr_white_nits(gdi_name: &[u16; 32]) -> Option<f64> {
    use std::mem::size_of;
    use windows::Win32::Devices::Display::{
        DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
        DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
        DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
        DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS,
        QueryDisplayConfig,
    };
    use windows::Win32::Foundation::ERROR_SUCCESS;

    let (mut path_count, mut mode_count) = (0u32, 0u32);
    let sized = unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
    };
    if sized != ERROR_SUCCESS {
        return None;
    }
    let mut paths =
        vec![unsafe { std::mem::zeroed::<DISPLAYCONFIG_PATH_INFO>() }; path_count as usize];
    let mut modes =
        vec![unsafe { std::mem::zeroed::<DISPLAYCONFIG_MODE_INFO>() }; mode_count as usize];
    // Safety: each array holds as many entries as its count says.
    let queried = unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
    };
    if queried != ERROR_SUCCESS {
        return None;
    }
    paths.truncate(path_count as usize);
    let path = paths.iter().find(|path| {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
            header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId,
                id: path.sourceInfo.id,
            },
            viewGdiDeviceName: [0; 32],
        };
        // Safety: the header heads a packet of the size it states.
        let asked = unsafe { DisplayConfigGetDeviceInfo(&mut source.header) };
        asked == 0 && up_to_nul(&source.viewGdiDeviceName) == up_to_nul(gdi_name)
    })?;
    let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL {
        header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
            size: size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32,
            adapterId: path.targetInfo.adapterId,
            id: path.targetInfo.id,
        },
        SDRWhiteLevel: 0,
    };
    let asked = unsafe { DisplayConfigGetDeviceInfo(&mut white.header) };
    (asked == 0 && white.SDRWhiteLevel > 0).then(|| f64::from(white.SDRWhiteLevel) / 1000.0 * 80.0)
}

#[cfg(target_os = "windows")]
fn up_to_nul(name: &[u16]) -> &[u16] {
    &name[..name
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(name.len())]
}

#[cfg(not(any(target_os = "macos", target_os = "android", target_os = "windows")))]
async fn range(_window: tauri::WebviewWindow<crate::Runtime>) -> Option<DynamicRange> {
    None
}
