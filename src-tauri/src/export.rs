//! Taking photographs out of the library and onto the disk (§10.5.1).
//!
//! The one part of an export the page cannot do for itself. A browser asks for a directory
//! handle and writes through it; this app has a filesystem, so the reader picks a folder in
//! their own file manager's dialog and the shell writes there.
//!
//! **The bytes never reach the page.** A reply crosses IPC as a binary body (`api.rs`), but a
//! command's *arguments* are JSON - so the page fetching a render and handing it to a writer
//! command would put a 60MP TIFF through that leg as an array of decimal numbers. The render
//! is fetched and written here instead, which is one hop rather than three.

use std::path::Path;

use crate::export_paths::{filename_from, free};

/// What asking for a folder came back with.
///
/// Three answers rather than an `Option`, because the page does something different with
/// each: `Unsupported` falls back to the webview's own downloads, `Dismissed` is a reader
/// saying no and reports nothing at all.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Folder {
    /// Built only off the desktop, so a desktop build is where it reads as dead.
    #[cfg_attr(desktop, allow(dead_code))]
    Unsupported,
    Dismissed,
    Picked { path: String },
}

/// The reader's own folder dialog.
///
/// Asynchronous because the portal on Linux is a D-Bus round trip: the blocking form would
/// hold the IPC thread for as long as the reader took to choose.
#[tauri::command]
pub async fn pick_export_folder() -> Folder {
    picked().await
}

#[cfg(desktop)]
async fn picked() -> Folder {
    rfd::AsyncFileDialog::new().pick_folder().await.map_or(Folder::Dismissed, |folder| {
        Folder::Picked { path: folder.path().to_string_lossy().into_owned() }
    })
}

/// Android has no folder to pick: storage is scoped, a folder is a granted tree rather than
/// a path, and `rfd` has no backend for the platform at all.
#[cfg(not(desktop))]
async fn picked() -> Folder {
    Folder::Unsupported
}

/// Renders one photograph at the reader's settings and writes it into `folder`, answering
/// with the path it was written to.
///
/// `options` is carried through opaquely: what a container can hold is the server's table
/// (`schemas/export.ts`), and a second copy of it here would be a second answer to the same
/// question.
#[tauri::command]
pub async fn export_to_folder(
    folder: String,
    photo_id: String,
    options: serde_json::Value,
    run_id: String,
) -> Result<String, String> {
    let url = format!("{}/api/export", crate::api::origin());
    let reply = crate::api::request(reqwest::Method::POST, &url)
        // The run is carried into the render because the history's tile is a second size off
        // it; where the file then lands is reported by the page, which is what knows.
        .json(&serde_json::json!({ "photoId": photo_id, "options": options, "runId": run_id }))
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    let status = reply.status();
    let named = reply
        .headers()
        .get("content-disposition")
        .and_then(|value| value.to_str().ok())
        .and_then(filename_from);
    let bytes = reply
        .bytes()
        .await
        .map_err(|e| format!("{url} answered {status} and then stopped: {e}"))?;
    if !status.is_success() {
        return Err(String::from_utf8_lossy(&bytes).into_owned());
    }
    // Refused rather than invented. The route names every export, so nothing here is a name
    // this could improve on - and a file written under a guess is one the reader has to
    // identify by opening it.
    let named = named.ok_or_else(|| format!("{url} did not name the file it answered with"))?;

    let path = free(Path::new(&folder), &named);
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write {path:?}: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}
