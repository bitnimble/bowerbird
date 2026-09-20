// Prevents an additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! One executable, two roles (DESIGN §23.3).
//!
//! Started by the operating system, this is the supervisor. Started by that supervisor -
//! which is the only thing that sets `BOWERBIRD_PAYLOAD` - it is the app.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

/// `tauri.conf.json`'s `identifier`. Only the folder the versions live in is named by
/// it, so the two disagreeing costs a second directory and nothing else - but this runs
/// before there is a Tauri context to ask.
const IDENTIFIER: &str = "dev.kumo.bowerbird";

fn main() -> ExitCode {
    if std::env::var_os("BOWERBIRD_PAYLOAD").is_some() {
        app_lib::run();
        return ExitCode::SUCCESS;
    }

    match supervise() {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(why) => {
            eprintln!("[bowerbird] {why}");
            ExitCode::FAILURE
        }
    }
}

fn supervise() -> Result<i32, String> {
    let exe = std::env::current_exe().map_err(|err| format!("could not find this executable: {err}"))?;
    let installed = exe.parent().ok_or("this executable has no directory")?.to_path_buf();
    let home = updates_home()?;
    let bundled = installed.clone();

    launcher::supervise(&home, &installed, move |payload| {
        // The version that came with the install is this executable, in the bundle it was
        // packaged in: Tauri's own resolution of resources and of the sidecar is correct
        // there, and saying so again from here would only be a chance to say it wrong.
        let mut command = if payload == bundled {
            Command::new(&exe)
        } else {
            let Layout { app, server, resources } = layout(payload);
            let mut command = Command::new(app);
            command.env("BOWERBIRD_SIDECAR", server);
            command.env("BOWERBIRD_RESOURCES", resources);
            command
        };
        // Whatever this process was started with. The app is a Chromium either way, and its
        // switches arrive on the command line - `--remote-debugging-port` is how the desktop
        // e2e suite attaches at all, and `--no-sandbox` is how it starts on a headless box.
        // Dropped here, both would be set on a process that does no browsing.
        command.args(std::env::args_os().skip(1));
        command
    })
}

struct Layout {
    app: PathBuf,
    server: PathBuf,
    resources: PathBuf,
}

/// What a downloaded payload holds, which `scripts/build-payload.ts` writes.
///
/// macOS keeps a whole `.app` inside it rather than a bare binary, and that is not
/// tidiness: a window, a menu bar and a dock icon come from being inside a bundle, so an
/// executable run loose out of Application Support is a different application to look at.
#[cfg(target_os = "macos")]
fn layout(payload: &Path) -> Layout {
    let macos = payload.join("Bowerbird.app").join("Contents").join("MacOS");
    Layout {
        app: macos.join("Bowerbird"),
        server: macos.join("bowerbird-server"),
        resources: payload.join("Bowerbird.app").join("Contents").join("Resources").join("resources"),
    }
}

#[cfg(not(target_os = "macos"))]
fn layout(payload: &Path) -> Layout {
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    Layout {
        app: payload.join(format!("bowerbird-app{suffix}")),
        server: payload.join(format!("bowerbird-server{suffix}")),
        resources: payload.join("resources"),
    }
}

/// Where the versions live: writable without an administrator, and on the same disk as
/// the catalogue, which is what makes unpacking one a rename rather than a copy.
fn updates_home() -> Result<PathBuf, String> {
    if let Some(named) = std::env::var_os("BOWERBIRD_HOME") {
        return Ok(PathBuf::from(named));
    }
    Ok(app_data_dir()?.join(IDENTIFIER).join("updates"))
}

#[cfg(target_os = "windows")]
fn app_data_dir() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA").map(PathBuf::from).ok_or_else(|| "APPDATA is not set".into())
}

#[cfg(target_os = "macos")]
fn app_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join("Library").join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(xdg));
    }
    let home = std::env::var_os("HOME").ok_or("neither XDG_DATA_HOME nor HOME is set")?;
    Ok(PathBuf::from(home).join(".local").join("share"))
}
