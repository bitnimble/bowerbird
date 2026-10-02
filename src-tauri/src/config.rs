//! What this app remembers for itself, as opposed to what the library remembers.

/// The interface scale is this window's, applied before the page has loaded anything to ask.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_scale: Option<f64>,
}

static CONFIG: std::sync::RwLock<Option<Config>> = std::sync::RwLock::new(None);

/// Beside the executable where that is writable, and in the app's config directory
/// otherwise.
///
/// Which makes an unpacked build portable: everything it remembers is in the folder it was
/// unpacked into, so deleting the folder is uninstalling it. That is what a dev build handed to
/// someone should do.
///
/// The fallback is not theoretical - an app installed under `Program Files` or
/// `/Applications` sits somewhere it may not write to, and would otherwise fail to save at
/// all. Decided by trying rather than by a marker file or a permissions check, because on
/// Windows the answer depends on which directory it landed in and on who is running it.
fn config_file(app: &tauri::AppHandle<crate::Runtime>) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Some(beside) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("config.json")))
    {
        if writable(&beside) {
            return Some(beside);
        }
    }
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("config.json"))
}

/// Whether this path can be created and written. Leaves the file behind if it already
/// holds something, and removes the one it made if it did not.
fn writable(path: &std::path::Path) -> bool {
    if path.exists() {
        return std::fs::OpenOptions::new().append(true).open(path).is_ok();
    }
    match std::fs::write(path, "") {
        Ok(()) => {
            let _ = std::fs::remove_file(path);
            true
        }
        Err(_) => false,
    }
}

/// Reads the config at startup.
///
/// A file that will not parse is treated as one that is not there. It holds preferences
/// rather than anything a reader would grieve, and refusing to start over a stray comma
/// would be the worse failure.
pub fn load(app: &tauri::AppHandle<crate::Runtime>) {
    let held = config_file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default();
    if let Ok(mut config) = CONFIG.write() {
        *config = Some(held);
    }
}

/// Saved before it is adopted, so a write that fails leaves the running app and the file
/// still agreeing on the old value rather than disagreeing until a restart.
fn update(
    app: &tauri::AppHandle<crate::Runtime>,
    change: impl FnOnce(&mut Config),
) -> Result<(), String> {
    let mut held = CONFIG
        .write()
        .map_err(|_| "the config is locked".to_string())?;
    let mut next = (*held).clone().unwrap_or_default();
    change(&mut next);
    save(app, &next)?;
    *held = Some(next);
    Ok(())
}

fn save(app: &tauri::AppHandle<crate::Runtime>, config: &Config) -> Result<(), String> {
    let Some(path) = config_file(app) else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not make {parent:?}: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("could not save {path:?}: {e}"))
}

const UI_SCALES: std::ops::RangeInclusive<f64> = 0.5..=2.0;

#[tauri::command]
pub fn ui_scale() -> f64 {
    CONFIG
        .read()
        .ok()
        .and_then(|held| held.as_ref().and_then(|c| c.ui_scale))
        .unwrap_or(1.0)
}

#[tauri::command]
pub fn set_ui_scale(app: tauri::AppHandle<crate::Runtime>, value: f64) -> Result<(), String> {
    if !UI_SCALES.contains(&value) {
        return Err(format!(
            "an interface scale of {value} is outside {UI_SCALES:?}"
        ));
    }
    update(&app, |config| config.ui_scale = Some(value))?;
    apply_ui_scale(&app)
}

pub fn apply_ui_scale(app: &tauri::AppHandle<crate::Runtime>) -> Result<(), String> {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window
        .set_zoom(ui_scale())
        .map_err(|e| format!("could not scale the window: {e}"))
}
