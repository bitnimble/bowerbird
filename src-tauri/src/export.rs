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

use std::path::{Path, PathBuf};

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
    let reply = crate::api::client()
        .post(&url)
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

/// Shows an exported file where it lives, in the reader's own file manager.
///
/// The file rather than the folder: every platform's manager can select one, which is what
/// makes this worth a button at all when a folder holds four hundred exports.
#[tauri::command]
pub fn reveal_export(path: String) -> Result<(), String> {
    let file = Path::new(&path);
    // A path out of the history is a path this app wrote, but the history outlives the file:
    // handing a deleted one to the manager opens somebody's home folder instead.
    if !file.exists() {
        return Err(format!("{path} is no longer there"));
    }
    reveal(file).map_err(|e| format!("could not show {path}: {e}"))
}

// Spawned rather than waited on, throughout: the command is a file manager, and `status`
// would hold the IPC thread for as long as the reader leaves the window open.
#[cfg(target_os = "macos")]
fn reveal(file: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg("-R").arg(file).spawn().map(|_| ())
}

#[cfg(target_os = "windows")]
fn reveal(file: &Path) -> std::io::Result<()> {
    // One argument, comma and all: `explorer` parses `/select,<path>` itself.
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", file.display()))
        .spawn()
        .map(|_| ())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reveal(file: &Path) -> std::io::Result<()> {
    // `xdg-open` has no notion of selecting a file, and opening the export itself would hand
    // it to an image viewer rather than showing where it is.
    //
    // A bare name's parent is `Some("")` rather than `None`, and `xdg-open ""` opens nothing
    // and reports nothing - so the empty one is filtered out rather than spawned.
    let folder = file.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or(file);
    std::process::Command::new("xdg-open").arg(folder).spawn().map(|_| ())
}

/// The name the library gave this render, out of the `Content-Disposition` the route sets.
///
/// **A name from a database column reaching `fs::write`**, so what comes back is one ordinary
/// component or nothing: a folder the reader picked is not a folder anything should be able to
/// climb out of. Asked of `Path` rather than by splitting on separators, because the parser
/// that decides what escapes is the same one `join` uses - on Windows `C:x.jpg` has no
/// separator in it at all and still replaces the folder it is joined to.
pub(crate) fn filename_from(disposition: &str) -> Option<String> {
    let (_, rest) = disposition.split_once("filename=\"")?;
    let (name, _) = rest.split_once('"')?;
    plain(name)
}

/// `name`, where it is one ordinary path component and nothing that could climb out of a folder.
pub(crate) fn plain(name: &str) -> Option<String> {
    let mut parts = Path::new(name).components();
    match (parts.next(), parts.next()) {
        (Some(std::path::Component::Normal(one)), None) => Some(one.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// A path in `folder` that nothing is using yet.
///
/// `fs::write` truncates, and an export is a reader's own files - the one place a silent
/// overwrite cannot be undone. Numbered the same way `export_sink.ts` numbers a directory
/// handle's, so the two destinations behave alike.
fn free(folder: &Path, filename: &str) -> PathBuf {
    let (stem, extension) = match filename.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (filename, String::new()),
    };
    let mut attempt = 1;
    loop {
        let candidate = folder.join(if attempt == 1 {
            filename.to_string()
        } else {
            format!("{stem} ({attempt}){extension}")
        });
        if !candidate.exists() {
            return candidate;
        }
        attempt += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{filename_from, free};

    // The guard between a database column and `fs::write`, so every shape that could climb
    // out of the folder the reader picked is named here.
    #[test]
    fn a_name_that_is_not_one_plain_component_is_refused() {
        let named = |name: &str| filename_from(&format!("attachment; filename=\"{name}\""));

        assert_eq!(named("DSC02981.jpg").as_deref(), Some("DSC02981.jpg"));
        assert_eq!(named(".DS_Store").as_deref(), Some(".DS_Store"));

        assert_eq!(named("../../etc/passwd"), None);
        assert_eq!(named("/etc/passwd"), None);
        assert_eq!(named("Trip/DSC02981.jpg"), None);
        assert_eq!(named(".."), None);
        assert_eq!(named("."), None);
        assert_eq!(named(""), None);
        // Windows-only, and the reason this asks `Path` rather than splitting on separators:
        // a drive-relative name carries no separator and still replaces what it is joined to.
        #[cfg(windows)]
        {
            assert_eq!(named("C:DSC02981.jpg"), None);
            assert_eq!(named(r"..\..\x.jpg"), None);
        }
    }

    #[test]
    fn a_disposition_with_no_quoted_name_is_refused() {
        assert_eq!(filename_from("attachment"), None);
        assert_eq!(filename_from("attachment; filename=DSC02981.jpg"), None);
    }

    #[test]
    fn a_taken_name_is_numbered_rather_than_overwritten() {
        let folder = tempdir("numbered");
        assert_eq!(free(&folder, "DSC02981.jpg"), folder.join("DSC02981.jpg"));

        std::fs::write(folder.join("DSC02981.jpg"), b"first").unwrap();
        assert_eq!(free(&folder, "DSC02981.jpg"), folder.join("DSC02981 (2).jpg"));

        std::fs::write(folder.join("DSC02981 (2).jpg"), b"second").unwrap();
        assert_eq!(free(&folder, "DSC02981.jpg"), folder.join("DSC02981 (3).jpg"));
    }

    // A leading dot is the whole name, not an empty stem with an extension after it - so the
    // number goes on the end rather than turning `.DS_Store` into ` (2).DS_Store`.
    #[test]
    fn a_name_that_is_all_extension_still_numbers() {
        let folder = tempdir("no-extension");
        std::fs::write(folder.join("photo"), b"first").unwrap();
        assert_eq!(free(&folder, "photo"), folder.join("photo (2)"));

        std::fs::write(folder.join(".DS_Store"), b"first").unwrap();
        assert_eq!(free(&folder, ".DS_Store"), folder.join(".DS_Store (2)"));
    }

    fn tempdir(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bowerbird-export-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}
