//! The viewer's HDR photo on a TV. Android 11's WebView composites in SDR, so `StagePlugin.kt`
//! puts a window behind the transparent page and librawshim draws the rendition into it as scRGB
//! (`gpu::surface_stage`).

/// Where the page's stage is, in device pixels of the page, and how to light what goes in it.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageShow {
    /// The page's count of its asks, so one overtaken on the way here is ignored.
    sequence: u64,
    url: String,
    left: i32,
    top: i32,
    width: i32,
    height: i32,
    /// The display's peak against its SDR white.
    headroom: f32,
    /// The scRGB value the display shows SDR white at.
    white: f32,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct StageHide {
    sequence: u64,
}

/// Resolves once the photo is on screen behind the page, true, or false where the page has to
/// draw it itself: another photo was asked for first, or this one could not be drawn.
#[tauri::command]
pub async fn stage_show(
    app: tauri::AppHandle<crate::Runtime>,
    stage: StageShow,
) -> Result<bool, String> {
    platform::show(&app, stage).await
}

#[tauri::command]
pub async fn stage_hide(
    app: tauri::AppHandle<crate::Runtime>,
    stage: StageHide,
) -> Result<(), String> {
    platform::hide(&app, stage).await
}

#[cfg(target_os = "android")]
pub(crate) use platform::plugin;

#[cfg(target_os = "android")]
mod platform {
    use std::ffi::{c_int, c_void};
    use std::sync::OnceLock;

    use tauri::Manager;
    use tauri::plugin::PluginHandle;
    use tauri::wry::prelude::jni::JNIEnv;
    use tauri::wry::prelude::jni::objects::{JByteArray, JClass, JIntArray, JObject};
    use tauri::wry::prelude::jni::sys::{jboolean, jfloat, jint, jlong};
    use tauri::wry::prelude::ndk::native_window::NativeWindow;

    use super::{StageHide, StageShow};
    use crate::Runtime;

    struct Stage(PluginHandle<Runtime>);

    #[derive(serde::Deserialize)]
    struct Shown {
        drawn: bool,
    }

    pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<Runtime> {
        tauri::plugin::Builder::new("stage")
            .setup(|app, api| {
                let package = app.config().identifier.replace('-', "_");
                let handle = api.register_android_plugin(&package, "StagePlugin")?;
                app.manage(Stage(handle));
                Ok(())
            })
            .build()
    }

    pub(super) async fn show(
        app: &tauri::AppHandle<Runtime>,
        stage: StageShow,
    ) -> Result<bool, String> {
        app.state::<Stage>()
            .0
            .run_mobile_plugin_async::<Shown>("show", stage)
            .await
            .map(|shown| shown.drawn)
            .map_err(|err| format!("could not draw the photo behind the page: {err}"))
    }

    pub(super) async fn hide(
        app: &tauri::AppHandle<Runtime>,
        stage: StageHide,
    ) -> Result<(), String> {
        app.state::<Stage>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>("hide", stage)
            .await
            .map(drop)
            .map_err(|err| format!("could not hide the photo behind the page: {err}"))
    }

    /// librawshim's `tv_stage.rs`, which the app carries for its server and loads here too.
    struct Rawshim {
        picture: unsafe extern "C" fn(*const u8, usize, *mut u32, *mut u32) -> *mut c_void,
        picture_free: unsafe extern "C" fn(*mut c_void),
        attach: unsafe extern "C" fn(*mut c_void, u32, u32) -> *mut c_void,
        present: unsafe extern "C" fn(*mut c_void, *const c_void, u32, u32, f32, f32) -> c_int,
        detach: unsafe extern "C" fn(*mut c_void),
        take_log: unsafe extern "C" fn(*mut u8, usize) -> usize,
    }

    const LOG_BYTES: usize = 64 * 1024;

    impl Rawshim {
        /// Moves the library's held lines into the shell's log: unclaimed, they go to a stderr
        /// Android discards.
        fn drain_log(&self) {
            let mut buffer = vec![0u8; LOG_BYTES];
            loop {
                // SAFETY: `buffer` is `LOG_BYTES` writable bytes.
                let written = unsafe { (self.take_log)(buffer.as_mut_ptr(), LOG_BYTES) };
                if written == 0 {
                    return;
                }
                for line in String::from_utf8_lossy(&buffer[..written]).lines() {
                    match line.strip_prefix('I') {
                        Some(info) => crate::app_log::info(info),
                        None => crate::app_log::warn(line.get(1..).unwrap_or(line)),
                    }
                }
            }
        }
    }

    fn rawshim() -> Option<&'static Rawshim> {
        static LOADED: OnceLock<Option<Rawshim>> = OnceLock::new();
        LOADED
            .get_or_init(|| {
                // SAFETY: librawshim's initialisers only set up statics.
                let library = unsafe { libc::dlopen(c"librawshim.so".as_ptr(), libc::RTLD_NOW) };
                if library.is_null() {
                    crate::app_log::error("could not load librawshim for the HDR stage");
                    return None;
                }
                // SAFETY: each name is a function of the type it is read as (`tv_stage.rs`).
                let loaded = unsafe {
                    Rawshim {
                        picture: std::mem::transmute(symbol(library, c"bb_stage_picture")?),
                        picture_free: std::mem::transmute(symbol(
                            library,
                            c"bb_stage_picture_free",
                        )?),
                        attach: std::mem::transmute(symbol(library, c"bb_stage_attach")?),
                        present: std::mem::transmute(symbol(library, c"bb_stage_present")?),
                        detach: std::mem::transmute(symbol(library, c"bb_stage_detach")?),
                        take_log: std::mem::transmute(symbol(library, c"bb_take_log")?),
                    }
                };
                // The first take claims the log, so lines after it are held rather than printed.
                loaded.drain_log();
                Some(loaded)
            })
            .as_ref()
    }

    unsafe fn symbol(library: *mut c_void, name: &std::ffi::CStr) -> Option<*mut c_void> {
        let found = unsafe { libc::dlsym(library, name.as_ptr()) };
        if found.is_null() {
            crate::app_log::error(format!("librawshim has no {name:?}"));
        }
        (!found.is_null()).then_some(found)
    }

    /// The window and the stage drawing into it, which holds a reference on it.
    struct Attached {
        stage: *mut c_void,
        _window: NativeWindow,
    }

    #[no_mangle]
    pub extern "system" fn Java_photos_bowerbird_StagePlugin_attach(
        env: JNIEnv,
        _class: JClass,
        surface: JObject,
        width: jint,
        height: jint,
    ) -> jlong {
        let Some(rawshim) = rawshim() else { return 0 };
        // SAFETY: `surface` is a live `android.view.Surface`, `StagePlugin.kt`'s.
        let Some(window) =
            (unsafe { NativeWindow::from_surface(env.get_raw().cast(), surface.as_raw()) })
        else {
            return 0;
        };
        // SAFETY: `window` is held until the stage is detached.
        let stage =
            unsafe { (rawshim.attach)(window.ptr().as_ptr().cast(), width as u32, height as u32) };
        rawshim.drain_log();
        if stage.is_null() {
            return 0;
        }
        Box::into_raw(Box::new(Attached {
            stage,
            _window: window,
        })) as jlong
    }

    #[no_mangle]
    pub extern "system" fn Java_photos_bowerbird_StagePlugin_detach(
        _env: JNIEnv,
        _class: JClass,
        attached: jlong,
    ) {
        let (Some(rawshim), false) = (rawshim(), attached == 0) else {
            return;
        };
        // SAFETY: from `attach`, and not used again.
        let attached = unsafe { Box::from_raw(attached as *mut Attached) };
        // SAFETY: the stage goes before the window it draws into.
        unsafe { (rawshim.detach)(attached.stage) };
    }

    /// 0 where the stage does not draw this file; `size` takes its shown width and height.
    #[no_mangle]
    pub extern "system" fn Java_photos_bowerbird_StagePlugin_picture(
        env: JNIEnv,
        _class: JClass,
        avif: JByteArray,
        size: JIntArray,
    ) -> jlong {
        let Some(rawshim) = rawshim() else { return 0 };
        let Ok(bytes) = env.convert_byte_array(&avif) else {
            return 0;
        };
        let (mut width, mut height) = (0u32, 0u32);
        // SAFETY: `bytes` is `len` bytes, and both sizes are writable.
        let picture =
            unsafe { (rawshim.picture)(bytes.as_ptr(), bytes.len(), &mut width, &mut height) };
        rawshim.drain_log();
        if picture.is_null() {
            return 0;
        }
        if env
            .set_int_array_region(&size, 0, &[width as jint, height as jint])
            .is_err()
        {
            // SAFETY: from `picture` above, and not used again.
            unsafe { (rawshim.picture_free)(picture) };
            return 0;
        }
        picture as jlong
    }

    #[no_mangle]
    pub extern "system" fn Java_photos_bowerbird_StagePlugin_pictureFree(
        _env: JNIEnv,
        _class: JClass,
        picture: jlong,
    ) {
        let Some(rawshim) = rawshim() else { return };
        // SAFETY: from `picture`, and not used again; null is ignored.
        unsafe { (rawshim.picture_free)(picture as *mut c_void) };
    }

    /// Whether `picture` is on screen, drawn over the whole of a `width` by `height` window.
    #[no_mangle]
    pub extern "system" fn Java_photos_bowerbird_StagePlugin_present(
        _env: JNIEnv,
        _class: JClass,
        attached: jlong,
        picture: jlong,
        width: jint,
        height: jint,
        headroom: jfloat,
        white: jfloat,
    ) -> jboolean {
        let (Some(rawshim), false) = (rawshim(), attached == 0 || picture == 0) else {
            return 0;
        };
        // SAFETY: both live, from `attach` and `picture`, and only the plugin's worker draws.
        let attached = unsafe { &*(attached as *const Attached) };
        let drawn = unsafe {
            (rawshim.present)(
                attached.stage,
                picture as *const c_void,
                width as u32,
                height as u32,
                headroom,
                white,
            )
        };
        rawshim.drain_log();
        jboolean::from(drawn == 0)
    }
}

#[cfg(not(target_os = "android"))]
mod platform {
    use super::{StageHide, StageShow};

    pub(super) async fn show(
        _app: &tauri::AppHandle<crate::Runtime>,
        _stage: StageShow,
    ) -> Result<bool, String> {
        Ok(false)
    }

    pub(super) async fn hide(
        _app: &tauri::AppHandle<crate::Runtime>,
        _stage: StageHide,
    ) -> Result<(), String> {
        Ok(())
    }
}
