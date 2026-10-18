//! Handing this app over to `bowerbird-updater`, which replaces it while it is not running
//! (DESIGN §23.3).

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::Manager;

/// What the server exits with once it has staged an update.
///
/// `src/services/updates/update_service.ts` exits with this number and there is no way for the
/// two to share it. Changed on one side alone, an update stages itself and the app simply stops.
pub(crate) const STAGED: i32 = 75;

/// The shell's name in a payload, as `scripts/build-payload.ts` writes it.
const MACOS_PAYLOAD_SHELL: &str = "Bowerbird.app";
const WINDOWS_PAYLOAD_SHELL: &str = "bowerbird-app.exe";
const LINUX_PAYLOAD_SHELL: &str = "Bowerbird.AppImage";
const PAYLOAD_SHELL: &str = if cfg!(target_os = "macos") {
    MACOS_PAYLOAD_SHELL
} else if cfg!(windows) {
    WINDOWS_PAYLOAD_SHELL
} else {
    LINUX_PAYLOAD_SHELL
};

const HELPER: &str = if cfg!(windows) {
    "bowerbird-updater.exe"
} else {
    "bowerbird-updater"
};

/// Where an update is staged, where this install can replace itself at all.
pub(crate) fn home(app: &tauri::AppHandle<crate::Runtime>) -> Option<PathBuf> {
    Installed::here()?;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("updates"))
}

/// Starts the helper on what the server staged, for this process to exit into.
pub(crate) fn hand_over(app: &tauri::AppHandle<crate::Runtime>) -> Result<(), String> {
    let installed = Installed::here().ok_or("this install cannot replace itself")?;
    let home = home(app).ok_or("this app has no data directory to stage an update in")?;
    // A copy, because the helper in the install is one of the files the update replaces.
    let running = home.join(HELPER);
    let _ = std::fs::remove_file(&running);
    std::fs::copy(&installed.helper, &running)
        .map_err(|err| format!("could not copy {HELPER} out of the install: {err}"))?;

    let plan = updater::Plan {
        home,
        install: installed.install,
        renames: vec![(PAYLOAD_SHELL.into(), installed.shell)],
    };
    let relaunch: Vec<OsString> = std::iter::once(installed.exe.into_os_string())
        .chain(std::env::args_os().skip(1))
        .collect();
    Command::new(&running)
        .args(updater::update_args(&plan, std::process::id(), &relaunch))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("could not start {}: {err}", running.display()))
}

/// Where this app is installed, in the terms an update replaces it in.
struct Installed {
    /// The directory the payload's entries go into.
    install: PathBuf,
    /// What the payload's shell is called here.
    shell: OsString,
    exe: PathBuf,
    helper: PathBuf,
}

impl Installed {
    /// The bundle and the folder it is in, where that folder is one this user can write to. A
    /// bundle run from its disk image or from Downloads is started from a read-only copy, which
    /// is not writable either, and so is offered the installer.
    #[cfg(target_os = "macos")]
    fn here() -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let bundle = exe.ancestors().nth(3)?;
        if bundle.extension()? != "app" {
            return None;
        }
        let install = bundle.parent()?;
        if !updater::writable(install) {
            return None;
        }
        Some(Self {
            install: install.to_path_buf(),
            shell: bundle.file_name()?.to_owned(),
            helper: exe.with_file_name(HELPER),
            exe,
        })
    }

    /// The installer's directory, writable or not: the helper asks for an administrator where it
    /// is not.
    #[cfg(windows)]
    fn here() -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let install = exe.parent()?.to_path_buf();
        Some(Self {
            install,
            shell: exe.file_name()?.to_owned(),
            helper: exe.with_file_name(HELPER),
            exe,
        })
    }

    /// The AppImage and the folder it is in, where this user can write to it. A deb or rpm
    /// installs under `/usr`, which its package manager owns, and is offered the installer.
    #[cfg(target_os = "linux")]
    fn here() -> Option<Self> {
        // `APPIMAGE` is inherited by anything an AppImage starts, so it names this app only
        // while this binary is inside the mount `APPDIR` names.
        let mount = PathBuf::from(std::env::var_os("APPDIR")?);
        if !std::env::current_exe().ok()?.starts_with(&mount) {
            return None;
        }
        let exe = PathBuf::from(std::env::var_os("APPIMAGE")?);
        let install = exe.parent()?;
        if !updater::writable(install) {
            return None;
        }
        Some(Self {
            install: install.to_path_buf(),
            shell: exe.file_name()?.to_owned(),
            exe,
            // Not `bin/`, whose entries are all links to sharun, which finds the binary it starts
            // relative to itself and so cannot run once copied out.
            helper: mount.join("shared/bin").join(HELPER),
        })
    }

    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    fn here() -> Option<Self> {
        None
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_shell_is_named_as_the_payload_names_it() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/build-payload.ts"),
        )
        .unwrap();
        for shell in [
            super::MACOS_PAYLOAD_SHELL,
            super::WINDOWS_PAYLOAD_SHELL,
            super::LINUX_PAYLOAD_SHELL,
        ] {
            assert!(
                script.contains(&format!("'{shell}'")),
                "build-payload.ts no longer writes {shell}"
            );
        }
    }

    #[test]
    fn the_server_exits_with_the_code_the_shell_hands_over_on() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/services/updates/update_service.ts");
        let service = std::fs::read_to_string(path).unwrap();
        assert!(service.contains(&format!("STAGED_EXIT_CODE = {};", super::STAGED)));
    }
}
