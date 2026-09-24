//! Opening a photo's RAW in another application the reader picks.
//!
//! The chooser is the platform's own where it has one: the OpenURI portal on Linux, which lists
//! the applications registered for the file's type, and Windows' "open with" dialog. macOS has no
//! chooser to call, so this builds Finder's "Open With" menu out of what Launch Services answers
//! for the file.

use std::path::{Path, PathBuf};

type Window = tauri::Window<crate::Runtime>;

/// A dismissed chooser is not a failure.
#[tauri::command]
pub async fn open_original_with(window: Window, photo_id: String) -> Result<(), String> {
    let file = local_original(&photo_id).await?;
    choose(&window, &file).await
}

/// The RAW itself where the server shares this machine's disk, so another application's sidecar
/// lands beside it; a downloaded copy where the library is hosted elsewhere.
async fn local_original(photo_id: &str) -> Result<PathBuf, String> {
    let path = original_path(photo_id).await?;
    if path.exists() {
        return Ok(path);
    }
    downloaded(photo_id).await
}

/// Where the RAW is on the server's disk, which is this machine's only where the server is local.
pub(crate) async fn original_path(photo_id: &str) -> Result<PathBuf, String> {
    #[derive(serde::Deserialize)]
    struct Original {
        path: PathBuf,
    }
    let url = format!("{}/image/{photo_id}/original", crate::api::origin());
    let (_, bytes) = fetched(&url).await?;
    let original: Original =
        serde_json::from_slice(&bytes).map_err(|e| format!("{url} answered something else: {e}"))?;
    Ok(original.path)
}

/// One folder per photo, so opening it again replaces the copy rather than numbering another.
async fn downloaded(photo_id: &str) -> Result<PathBuf, String> {
    let folder = crate::export::plain(photo_id).ok_or_else(|| format!("not a photo id: {photo_id}"))?;
    let url = format!("{}/image/{photo_id}/download/original", crate::api::origin());
    let (named, bytes) = fetched(&url).await?;
    let named = named.ok_or_else(|| format!("{url} did not name the file it answered with"))?;
    let folder = std::env::temp_dir().join("bowerbird-open").join(folder);
    std::fs::create_dir_all(&folder).map_err(|e| format!("could not make {folder:?}: {e}"))?;
    let path = folder.join(named);
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write {path:?}: {e}"))?;
    Ok(path)
}

/// The body of a successful reply, and the file name it came under if it named one.
async fn fetched(url: &str) -> Result<(Option<String>, Vec<u8>), String> {
    let reply = crate::api::client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    let status = reply.status();
    let named = reply
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .and_then(crate::export::filename_from);
    let bytes = reply
        .bytes()
        .await
        .map_err(|e| format!("{url} answered {status} and then stopped: {e}"))?;
    if !status.is_success() {
        return Err(String::from_utf8_lossy(&bytes).into_owned());
    }
    Ok((named, bytes.to_vec()))
}

#[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
async fn choose(window: &Window, file: &Path) -> Result<(), String> {
    let (window, file) = (window.clone(), file.to_path_buf());
    // A Wayland parent holds raw pointers, so the portal call cannot be a `Send` future.
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(portal(&window, &file))
    })
    .await
    .map_err(|e| format!("the desktop portal did not return: {e}"))?
}

#[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
async fn portal(window: &Window, file: &Path) -> Result<(), String> {
    use ashpd::desktop::open_uri::OpenFileRequest;
    use ashpd::desktop::ResponseError;
    use ashpd::WindowIdentifier;
    use raw_window_handle::{HasDisplayHandle, HasWindowHandle};

    let opened = std::fs::File::open(file).map_err(|e| format!("could not open {file:?}: {e}"))?;
    let parent = match (window.window_handle(), window.display_handle()) {
        (Ok(handle), Ok(display)) => {
            WindowIdentifier::from_raw_handle(&handle.as_raw(), Some(&display.as_raw())).await
        }
        _ => None,
    };
    let request = OpenFileRequest::default()
        .identifier(parent)
        .ask(true)
        .send_file(&opened)
        .await
        .map_err(|e| format!("the desktop portal could not open {file:?}: {e}"))?;
    match request.response() {
        Ok(()) | Err(ashpd::Error::Response(ResponseError::Cancelled)) => Ok(()),
        Err(e) => Err(format!("the desktop portal could not open {file:?}: {e}")),
    }
}

#[cfg(target_os = "windows")]
async fn choose(window: &Window, file: &Path) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use std::os::windows::ffi::OsStrExt;

    // An address rather than an `HWND`, which is a pointer and cannot cross to the dialog's thread.
    let parent = match window.window_handle().map(|handle| handle.as_raw()) {
        Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get(),
        _ => 0,
    };
    let wide: Vec<u16> = file.as_os_str().encode_wide().chain(Some(0)).collect();
    tauri::async_runtime::spawn_blocking(move || open_with_dialog(parent, &wide))
        .await
        .map_err(|e| format!("the open with dialog did not return: {e}"))?
        .map_err(|code| format!("the open with dialog failed for {file:?}: {code:#x}"))
}

/// Modal, so it holds its thread until the reader chooses.
#[cfg(target_os = "windows")]
fn open_with_dialog(parent: isize, file: &[u16]) -> Result<(), i32> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::UI::Shell::{
        SHOpenWithDialog, OAIF_EXEC, OAIF_HIDE_REGISTRATION, OPENASINFO,
    };
    // HRESULT_FROM_WIN32(ERROR_CANCELLED)
    const CANCELLED: i32 = 0x8007_04C7_u32 as i32;

    let info = OPENASINFO {
        pcszFile: file.as_ptr(),
        pcszClass: std::ptr::null(),
        // Opens it once: ticking "always use this app" would change what every RAW opens with.
        oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
    };
    // SAFETY: `file` is NUL-terminated and outlives the call; the parent is a live window or null.
    let result = unsafe {
        let com = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
        let result = SHOpenWithDialog(parent as _, &info);
        // A pool thread another caller already put in a different apartment refuses ours, and
        // uninitialising after a refusal would tear down theirs.
        if com >= 0 {
            CoUninitialize();
        }
        result
    };
    if result >= 0 || result == CANCELLED {
        Ok(())
    } else {
        Err(result)
    }
}

/// A menu at the pointer, which is where the reader just pressed "Open in…". What is picked arrives
/// through `chosen`.
#[cfg(target_os = "macos")]
async fn choose(window: &Window, file: &Path) -> Result<(), String> {
    let (window, file) = (window.clone(), file.to_path_buf());
    // Every menu call waits on the main thread, and the popup's until the menu closes.
    tauri::async_runtime::spawn_blocking(move || popup(&window, &file))
        .await
        .map_err(|e| format!("the applications menu did not return: {e}"))?
}

#[cfg(target_os = "macos")]
fn popup(window: &Window, file: &Path) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::Manager;

    let failed = |e: tauri::Error| format!("could not show the applications for {file:?}: {e}");
    let menu = Menu::new(window).map_err(failed)?;
    for (application, label) in applications_for(file) {
        let id = format!("{MENU_ID}{}", application.display());
        let item = MenuItem::with_id(window, id, label, true, None::<&str>).map_err(failed)?;
        menu.append(&item).map_err(failed)?;
    }
    menu.append(&PredefinedMenuItem::separator(window).map_err(failed)?).map_err(failed)?;
    let other = MenuItem::with_id(window, OTHER_ID, "Other…", true, None::<&str>).map_err(failed)?;
    menu.append(&other).map_err(failed)?;

    *window.state::<Offered>().0.lock().unwrap() = Some(file.to_path_buf());
    window.popup_menu(&menu).map_err(failed)
}

#[cfg(target_os = "macos")]
const MENU_ID: &str = "open-with:";
#[cfg(target_os = "macos")]
const OTHER_ID: &str = "open-with-other";

/// The file the menu on screen was built for.
#[cfg(target_os = "macos")]
#[derive(Default)]
pub struct Offered(std::sync::Mutex<Option<PathBuf>>);

/// Every application Launch Services says can open `file`, labelled as Finder labels them: the
/// default first, then the rest by name.
#[cfg(target_os = "macos")]
fn applications_for(file: &Path) -> Vec<(PathBuf, String)> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::NSURL;

    let Some(url) = NSURL::from_file_path(file) else { return Vec::new() };
    let workspace = NSWorkspace::sharedWorkspace();
    let default = workspace.URLForApplicationToOpenURL(&url).and_then(|app| app.to_file_path());
    let name = |app: &Path| app.file_stem().map(|stem| stem.to_string_lossy().into_owned());

    let mut others: Vec<(PathBuf, String)> = workspace
        .URLsForApplicationsToOpenURL(&url)
        .iter()
        .filter_map(|app| app.to_file_path())
        .filter(|app| Some(app) != default.as_ref())
        .filter_map(|app| name(&app).map(|label| (app, label)))
        .collect();
    others.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));

    let default = default.and_then(|app| name(&app).map(|label| (app, format!("{label} (default)"))));
    default.into_iter().chain(others).collect()
}

/// The menu event for whatever `choose` offered.
#[cfg(target_os = "macos")]
pub fn chosen(app: &tauri::AppHandle<crate::Runtime>, event: tauri::menu::MenuEvent) {
    use tauri::Manager;

    let id = event.id().as_ref();
    if id != OTHER_ID && !id.starts_with(MENU_ID) {
        return;
    }
    let Some(file) = app.state::<Offered>().0.lock().unwrap().take() else { return };
    if let Some(application) = id.strip_prefix(MENU_ID) {
        open_in(Path::new(application), &file);
        return;
    }
    tauri::async_runtime::spawn(async move {
        let picked = rfd::AsyncFileDialog::new()
            .set_directory("/Applications")
            .add_filter("Applications", &["app"])
            .pick_file()
            .await;
        if let Some(application) = picked {
            open_in(application.path(), &file);
        }
    });
}

#[cfg(target_os = "macos")]
fn open_in(application: &Path, file: &Path) {
    // Spawned, never waited on: `open` returns once the application has the file.
    if let Err(e) = std::process::Command::new("open").arg("-a").arg(application).arg(file).spawn() {
        eprintln!("[bowerbird] could not open {file:?} in {application:?}: {e}");
    }
}

#[cfg(not(desktop))]
async fn choose(_window: &Window, file: &Path) -> Result<(), String> {
    Err(format!("this platform has no application chooser for {file:?}"))
}
