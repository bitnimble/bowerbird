//! What the page keeps about this device, as files in the app's data folder.
//!
//! The page's own storage is per origin, and its origin carries the port the server was given,
//! which is a new one each launch.

use std::path::PathBuf;
use tauri::Manager;

// Async, so a pipeline recipes file megabytes long is read and written off the window's thread.
#[tauri::command(async)]
pub fn read_device_file(
    app: tauri::AppHandle<crate::Runtime>,
    name: String,
) -> Result<Option<String>, String> {
    let path = path(&app, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("could not read {}: {err}", path.display())),
    }
}

#[tauri::command(async)]
pub fn write_device_file(
    app: tauri::AppHandle<crate::Runtime>,
    name: String,
    contents: String,
) -> Result<(), String> {
    let path = path(&app, &name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("could not make {}: {err}", parent.display()))?;
    }
    // Renamed into place, so a write the app is killed in the middle of leaves the last whole one.
    let partial = path.with_extension("partial");
    std::fs::write(&partial, contents)
        .and_then(|()| std::fs::rename(&partial, &path))
        .map_err(|err| format!("could not write {}: {err}", path.display()))
}

fn path(app: &tauri::AppHandle<crate::Runtime>, name: &str) -> Result<PathBuf, String> {
    if !named_plainly(name) {
        return Err(format!("{name:?} is not a device file name"));
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("device").join(format!("{name}.json")))
        .map_err(|err| format!("could not locate the app's data directory: {err}"))
}

/// A name the page sends, kept to one file inside the folder.
fn named_plainly(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_name_cannot_reach_outside_the_folder() {
        assert!(super::named_plainly("pipeline-recipes"));
        for name in ["", "../config", "a/b", "a\\b", "..", "Prefs", "a.json"] {
            assert!(!super::named_plainly(name), "{name:?}");
        }
    }
}
