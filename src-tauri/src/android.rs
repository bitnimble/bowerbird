//! What starting the server needs on Android that it does not on a desktop.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The Bun runtime, under a library's name because the package installer unpacks nothing else.
pub(crate) const RUNTIME: &str = "libbun.so";

/// A hash of the bundle and the page, which `build-sidecar.ts` writes beside them.
const PAYLOAD_ID: &str = "payload-id";

/// Written last into an unpacked payload, so one cut short by the app being killed is unpacked again.
const UNPACKED: &str = ".unpacked";

/// Where the package installer unpacked this app's libraries: `nativeLibraryDir`, read from where
/// this one is mapped rather than asked of Java.
pub(crate) fn native_dir() -> Result<PathBuf, String> {
    let maps = std::fs::read_to_string("/proc/self/maps")
        .map_err(|err| format!("could not read this process's mappings: {err}"))?;
    maps.lines()
        .filter_map(|line| line.split_whitespace().nth(5))
        .find(|path| path.ends_with("/libapp_lib.so"))
        .and_then(|path| Path::new(path).parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| "could not find where this app's libraries were unpacked".to_string())
}

/// The server bundle and the page, written out of the app's assets once per build.
pub(crate) fn unpacked(
    app: &tauri::AppHandle<crate::Runtime>,
    root: &Path,
) -> Result<PathBuf, String> {
    let assets = app.asset_resolver();
    let id = assets
        .get(format!("/{PAYLOAD_ID}"))
        .ok_or("this build carries no payload id. Run `bun run build:sidecar` before packaging.")?;
    let dir = root.join(String::from_utf8_lossy(&id.bytes).trim());
    if dir.join(UNPACKED).exists() {
        return Ok(dir);
    }
    let _ = std::fs::remove_dir_all(root);
    for (key, _) in assets.iter() {
        let asset = assets
            .get(key.to_string())
            .ok_or_else(|| format!("the app's asset {key} would not read"))?;
        let path = dir.join(key.trim_start_matches('/'));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("could not make {}: {err}", parent.display()))?;
        }
        std::fs::write(&path, asset.bytes)
            .map_err(|err| format!("could not write {}: {err}", path.display()))?;
    }
    std::fs::write(dir.join(UNPACKED), "")
        .map_err(|err| format!("could not finish unpacking {}: {err}", dir.display()))?;
    Ok(dir)
}

pub(crate) fn environment(command: &mut Command, data: &Path) -> Result<(), String> {
    let tmp = data.join("tmp");
    std::fs::create_dir_all(&tmp)
        .map_err(|err| format!("could not make {}: {err}", tmp.display()))?;
    let native = native_dir()?;
    command
        // The native addons' loaders in the bundle, which `build-sidecar.ts` writes.
        .env("BOWERBIRD_ADDON_DIR", &native)
        // Bun is an executable rather than the app, so the linker does not search the app's own
        // libraries for the shared libc++ an addon needs.
        .env("LD_LIBRARY_PATH", &native)
        .env("TMPDIR", tmp)
        .env("HOME", data)
        .env("BOWERBIRD_PLATFORM", "android-arm64");
    Ok(())
}
