//! Showing a file where it lives, in the reader's own file manager.
//!
//! The file rather than the folder: every platform's manager can select one, which is what
//! makes this worth a button at all when a folder holds four hundred photos.

use std::path::Path;

#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    reveal(Path::new(&path))
}

/// Where the server's disk is not this machine's - a hosted library - there is nothing here to show.
#[tauri::command]
pub async fn reveal_original(photo_id: String) -> Result<(), String> {
    reveal(&crate::open_with::original_path(&photo_id).await?)
}

/// The folder itself, opened, rather than selected in its parent.
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("{} is not a folder on this device", dir.display()));
    }
    crate::server::open_folder(dir).map_err(|e| format!("could not open {}: {e}", dir.display()))
}

fn reveal(file: &Path) -> Result<(), String> {
    // Handed a path that is not there, a manager opens somebody's home folder instead.
    if !file.exists() {
        return Err(format!("{} is not on this device", file.display()));
    }
    select(file).map_err(|e| format!("could not show {}: {e}", file.display()))
}

// Spawned rather than waited on, throughout: the command is a file manager, and `status`
// would hold the IPC thread for as long as the reader leaves the window open.
#[cfg(target_os = "macos")]
fn select(file: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg("-R").arg(file).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn select(file: &Path) -> std::io::Result<()> {
    // One argument, comma and all: `explorer` parses `/select,<path>` itself.
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", file.display()))
        .spawn()
        .map(|_| ())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn select(file: &Path) -> std::io::Result<()> {
    // `xdg-open` has no notion of selecting a file, and opening the file itself would hand
    // it to an image viewer rather than showing where it is.
    //
    // A bare name's parent is `Some("")` rather than `None`, and `xdg-open ""` opens nothing
    // and reports nothing - so the empty one is filtered out rather than spawned.
    let folder = file.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(file);
    std::process::Command::new("xdg-open").arg(folder).spawn().map(|_| ())
}
