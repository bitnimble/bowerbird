//! Starting Bowerbird, so that Bowerbird itself can be replaced.
//!
//! Nothing here knows what a release is, what GitHub is, or how to download anything.
//! The app does all of that, unpacks what it downloaded into `staged/`, and exits
//! [`RESTART`]; this swaps the directories and starts it again. That division is the
//! whole design: the code that replaces the app is not the code being replaced, so an
//! update never rewrites a file that is currently open - which Windows refuses outright
//! and which, half done, leaves nothing that can finish the job.
//!
//! ```text
//! <home>/
//!   versions/<version>/   payloads, unpacked
//!   current               which of them to run, or empty for the one that was installed
//!   previous              what to fall back to when a new one will not start
//!   staged/               a payload the app has just unpacked
//!   staged.version        written last, and what says `staged/` is complete
//! ```
//!
//! One implementation, two entry points: `main.rs` is the container's PID 1, and
//! `src-tauri/src/main.rs` calls [`supervise`] before it becomes the desktop app.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// What the app exits with to ask for a restart.
///
/// `src/services/updates/update_service.ts` exits with this number and there is no way
/// for the two to share it. Changed on one side alone, an update stages itself and then
/// the app simply stops.
pub const RESTART: i32 = 75;

/// How soon after starting a failure is taken as "this version does not work".
///
/// A payload that runs for an hour and then crashes is not a bad update, it is a crash,
/// and rolling back would throw away whatever the reader did in that hour.
const INFANCY: Duration = Duration::from_secs(30);

/// Runs the app, applies whatever it staged, and runs it again.
///
/// `build` is handed the payload directory and returns the command that starts the app
/// out of it; the environment every payload is told about is added here, so the two
/// callers cannot disagree about it.
pub fn supervise<F>(home: &Path, fallback: &Path, build: F) -> Result<i32, String>
where
    F: Fn(&Path) -> Command,
{
    fs::create_dir_all(home).map_err(|err| format!("could not make {}: {err}", home.display()))?;

    loop {
        if let Err(why) = apply_staged(home) {
            // Not fatal: the install that is already there still works, and refusing to
            // start because a *new* version could not be moved into place would turn a
            // failed update into no app at all.
            eprintln!("[bowerbird-launcher] could not apply the staged update: {why}");
        }

        let payload = resolve_payload(home, fallback);
        let mut command = build(&payload);
        command.env("BOWERBIRD_PAYLOAD", &payload);
        command.env("BOWERBIRD_HOME", home);
        // What the app reads to decide whether to offer an in-place update at all.
        // Without a supervisor there is nowhere to unpack one and nothing to restart it.
        command.env("BOWERBIRD_SUPERVISED", "1");

        let started = Instant::now();
        let code = match spawn(&mut command) {
            Ok(code) => code,
            // A payload whose executable is missing or will not load is a version that
            // does not start, which is the case below - and it is the one that would
            // otherwise be terminal, since nothing here would ever get to run again.
            Err(why) => {
                eprintln!("[bowerbird-launcher] {why}");
                if step_back(home)? {
                    continue;
                }
                return Err(why);
            }
        };

        // A restart is only a restart when there is something to restart *into*. 75 is
        // BSD's `EX_TEMPFAIL` and this is not the only thing that can produce it: taken on
        // trust, an app that exits 75 for any other reason is restarted onto the payload
        // that just did it, as fast as this loop can go, for ever - and because the
        // `continue` is above the check below, the crash rollback never gets a look in.
        if code == RESTART && path_of(home, Slot::Marker).exists() {
            continue;
        }
        if code != 0 && started.elapsed() < INFANCY && step_back(home)? {
            eprintln!("[bowerbird-launcher] that version exited {code} on startup; going back to the last one");
            continue;
        }
        return Ok(code);
    }
}

/// Everything this crate keeps under `home`.
///
/// Nothing else in this file joins a path onto `home`. That is the point: [`path_of`] is
/// the only thing that decides what a name means, and [`remove`] is the only thing that
/// deletes - so what can be deleted is this list, and reviewing that is reviewing all of
/// it. No caller is ever holding a path it could get wrong.
enum Slot<'a> {
    /// Which version to run, or empty for the one that was installed.
    Current,
    /// Which to step back to, or empty once there is nowhere left.
    Previous,
    /// A payload the app has unpacked and not yet had installed.
    Staged,
    /// Written last, and what says [`Slot::Staged`] is complete.
    Marker,
    Versions,
    /// One installed version, under the name it is filed by.
    Version(&'a OsStr),
    /// A version being replaced, held aside until the new one is in.
    Stale(&'a str),
}

fn path_of(home: &Path, slot: Slot<'_>) -> PathBuf {
    match slot {
        Slot::Current => home.join("current"),
        Slot::Previous => home.join("previous"),
        Slot::Staged => home.join("staged"),
        Slot::Marker => home.join("staged.version"),
        Slot::Versions => home.join("versions"),
        Slot::Version(name) => home.join("versions").join(name),
        Slot::Stale(version) => home.join("versions").join(format!("{version}.stale")),
    }
}

/// The only thing in this crate that deletes.
///
/// Called with [`Slot::Staged`], [`Slot::Marker`], [`Slot::Version`] and [`Slot::Stale`].
/// `Current` and `Previous` are emptied rather than removed and `Versions` is never
/// removed at all, so passing one of those is a mistake rather than a case - and it fails
/// loudly, the wrong `remove_*` for the kind of thing it is.
///
/// Missing is not a failure: every caller is making sure of a thing's absence.
///
/// **Nothing outside `home` is deletable through this, whatever it is handed.** `Slot`
/// bounds the leaf and `sanitise` bounds the one part of it that arrives over the network,
/// but neither bounds the root - so the directory the target sits in is resolved and
/// checked to be inside `home` before anything is unlinked. Belt and braces on purpose:
/// this is the one function in the crate that destroys, and it should not be depending on
/// every one of its callers having got the name right.
fn remove(home: &Path, slot: Slot<'_>) -> std::io::Result<()> {
    let file = matches!(slot, Slot::Marker);
    let target = path_of(home, slot);
    // A directory that is not there holds nothing to delete, so the absence this was called
    // for is already true. Said here rather than left to the caller because the check below
    // resolves that directory, and `NotFound` out of it would otherwise be the one way this
    // reports a failure for something already in the state it was asked to reach.
    let target = match contained(home, &target) {
        Ok(resolved) => resolved,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    // `remove_dir_all` is what bounds this to the one entry: measured, on a symlink to a
    // directory it unlinks the *link* and leaves the target and its contents alone. A
    // rewrite into a walk that opens each entry and recurses would follow one instead, and
    // `prune` hands this every name it does not recognise - so a link planted under
    // `versions/` would take whatever it points at with it.
    let outcome = if file { fs::remove_file(&target) } else { fs::remove_dir_all(&target) };
    match outcome {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// `target` with its directory resolved, once that directory is known to be inside `home`.
///
/// **The directory, not the target.** `canonicalize` follows symlinks, so resolving the
/// target itself would turn a `versions/x -> /etc` into `/etc`, fail the check below, and
/// refuse - leaving a planted link there for ever, when unlinking it is both safe and the
/// whole job. Resolving the parent instead catches a `home` or a `versions/` that is itself
/// a link out of the tree, and leaves the last component alone.
///
/// `starts_with` on a `Path` compares components rather than text, so `/data/updates2` does
/// not pass for `/data/updates`. Both sides are canonical because on Windows one side would
/// otherwise carry a `\\?\` prefix the other does not.
fn contained(home: &Path, target: &Path) -> std::io::Result<PathBuf> {
    let invalid = |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidInput, what.to_string());
    let parent = target.parent().ok_or_else(|| invalid("that has no directory to remove it from"))?;
    let leaf = target.file_name().ok_or_else(|| invalid("that names no entry to remove"))?;
    let root = home.canonicalize()?;
    let within = parent.canonicalize()?;
    if !within.starts_with(&root) {
        return Err(invalid(&format!(
            "refusing to remove {}: {} is outside {}",
            target.display(),
            within.display(),
            root.display()
        )));
    }
    Ok(within.join(leaf))
}

/// One step back: the version before this one, then the one that was installed, then
/// nowhere.
///
/// `previous` is emptied as it is used, so each step is taken once and a version whose
/// predecessor is also bad ends rather than flipping between the two. Reaching the
/// installed version is `previous` empty while `current` is not; having nowhere left is the
/// two being equal, which is what stops this being a loop. Emptied rather than removed
/// because that equality is the guard - a removal that failed and was ignored used to leave
/// `previous` naming the version just stepped over, and the next early failure started it
/// again.
fn step_back(home: &Path) -> Result<bool, String> {
    let selected = path_of(home, Slot::Current);
    let current = read_trimmed(&selected).unwrap_or_default();
    let previous = read_trimmed(&path_of(home, Slot::Previous)).unwrap_or_default();

    // Two rungs and then the ground. `previous` naming what `current` already does is a
    // version re-installed over itself - not somewhere to go, but not the end either, since
    // the one that came with the install is still under this.
    let target = if previous != current {
        previous
    } else if current.is_empty() {
        return Ok(false);
    } else {
        String::new()
    };

    // **`current` first.** These are two writes and a kill can land between them, so what
    // matters is which half-written state a restart reads correctly. Selecting the target
    // first leaves `previous` stale at a value that now equals `current`, which the rung
    // above reads as a re-install and steps past - the target is tried, and nothing is
    // skipped. The other order leaves `current` still naming the version that just failed
    // with the record of its predecessor already erased: that version is started once more
    // for nothing, and then the ladder jumps to the installed one, never trying the rung in
    // between.
    write_line(&selected, &target)?;
    write_line(&path_of(home, Slot::Previous), "")?;
    if target.is_empty() {
        eprintln!("[bowerbird-launcher] falling back to the version this was installed with");
    }
    Ok(true)
}

/// The payload to run: whatever `current` names, or the one that was installed.
///
/// Falling back rather than failing is what makes a lost or corrupted versions directory
/// survivable - deleting it is a supported way back to the version that was installed.
fn resolve_payload(home: &Path, fallback: &Path) -> PathBuf {
    if let Some(version) = read_trimmed(&path_of(home, Slot::Current)).filter(|v| !v.is_empty()) {
        let candidate = path_of(home, Slot::Version(OsStr::new(&version)));
        if candidate.is_dir() {
            return candidate;
        }
    }
    fallback.to_path_buf()
}

/// Moves a completed `staged/` into `versions/`, and points `current` at it.
///
/// `staged.version` is what says the directory is finished, so it is read first and
/// removed last: a kill anywhere in here leaves either the old version selected or the
/// new one, never a mixture of the two.
fn apply_staged(home: &Path) -> Result<(), String> {
    let Ok(raw) = fs::read_to_string(path_of(home, Slot::Marker)) else {
        return Ok(());
    };
    let version = sanitise(raw.trim());
    let staged = path_of(home, Slot::Staged);
    if version.is_empty() || !staged.is_dir() {
        let _ = remove(home, Slot::Marker);
        let _ = remove(home, Slot::Staged);
        return Err("the staged update is incomplete, so it was discarded".into());
    }

    fs::create_dir_all(path_of(home, Slot::Versions)).map_err(|err| err.to_string())?;
    let destination = path_of(home, Slot::Version(OsStr::new(&version)));
    // **Moved aside, never deleted in place.** `destination` can legitimately already exist
    // - a re-installed version, one left behind by a rollback, or on a case-insensitive
    // filesystem a version string that differs only in case from the live one. Deleting it
    // first looks equivalent and is not: `remove_dir_all` can fail part way through (a file
    // still locked moments after the app that was running out of that very directory
    // exited, which is routine on Windows), leaving it gutted, and the rename onto a
    // directory that still exists then fails too. `current` would still name it. The
    // previously good version would be gone with nothing in its place.
    //
    // Renaming is atomic, so every step below leaves the old contents or the new under some
    // name, never neither - and `prune` sweeps a `.stale` any failure left behind.
    let stale = path_of(home, Slot::Stale(&version));
    let _ = remove(home, Slot::Stale(&version));
    let displaced = destination.exists();
    if displaced {
        fs::rename(&destination, &stale)
            .map_err(|err| format!("could not move the version being replaced aside: {err}"))?;
    }
    if let Err(err) = fs::rename(&staged, &destination) {
        // Back where it was, so `current` still names a directory that runs.
        if displaced {
            let _ = fs::rename(&stale, &destination);
        }
        return Err(format!("could not move the staged update into place: {err}"));
    }
    let _ = remove(home, Slot::Stale(&version));

    let was = read_trimmed(&path_of(home, Slot::Current)).unwrap_or_default();
    write_line(&path_of(home, Slot::Previous), &was)?;
    write_line(&path_of(home, Slot::Current), &version)?;
    remove(home, Slot::Marker).map_err(|err| err.to_string())?;
    prune(home, &version, &was);
    eprintln!("[bowerbird-launcher] installed {version}");
    Ok(())
}

/// Everything under `versions/` but the one running and the one to step back to.
///
/// Compared as `OsStr` rather than through `to_string_lossy`: a name that is not valid
/// UTF-8 would otherwise compare equal to whatever it lossily became, and the version being
/// kept is the one that would be deleted.
fn prune(home: &Path, keep: &str, also: &str) {
    let Ok(entries) = fs::read_dir(path_of(home, Slot::Versions)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name != OsStr::new(keep) && name != OsStr::new(also) {
            let _ = remove(home, Slot::Version(&name));
        }
    }
}

fn spawn(command: &mut Command) -> Result<i32, String> {
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not start {:?}: {err}", command.get_program()))?;
    forward_signals(child.id());
    let status = child.wait().map_err(|err| format!("could not wait for the app: {err}"))?;
    reap_orphans();
    Ok(exit_code(&status))
}

/// Anything the app left behind, now that it is gone.
///
/// PID 1 inherits a dead process's children, and nothing else in a container will ever
/// reap them. The app reaps its own while it is alive, so what lands here is what it was
/// still waiting on when it died - and this runs at exactly that moment.
///
/// ponytail: at the restart boundary rather than continuously. A SIGCHLD handler reaping
/// `-1` is the complete answer and cannot be had cheaply: it would race `child.wait()`
/// above for the app's own status and leave the supervisor with `ECHILD` instead of an
/// exit code. If something is ever found accumulating zombies *while* the app runs, the
/// upgrade is to drop `Child::wait` and drive a `waitpid(-1)` loop that picks its own
/// child's status out of the stream.
#[cfg(unix)]
fn reap_orphans() {
    loop {
        // Safety: `waitpid` with WNOHANG over this process's children, which is all this
        // asks of it. -1 is "any", and 0/-1 back means there is nothing left to reap.
        let reaped = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
        if reaped <= 0 {
            return;
        }
    }
}

#[cfg(not(unix))]
fn reap_orphans() {}

#[cfg(unix)]
fn exit_code(status: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    // A signalled child has no exit code, and is reported the way a shell reports one.
    status.code().unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(not(unix))]
fn exit_code(status: &std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Passes `docker stop` on to the app.
///
/// Load-bearing in a container and harmless elsewhere: PID 1 has no default disposition
/// for SIGTERM, so without this the signal is discarded, the app never hears it, and
/// every stop takes the full ten seconds and ends in SIGKILL.
#[cfg(unix)]
fn forward_signals(child: u32) {
    use std::sync::atomic::{AtomicI32, Ordering};
    static CHILD: AtomicI32 = AtomicI32::new(0);
    CHILD.store(child as i32, Ordering::SeqCst);

    extern "C" fn relay(signal: i32) {
        let pid = CHILD.load(Ordering::SeqCst);
        if pid > 0 {
            // Safety: `kill` on a process this one started, from a handler that touches
            // nothing else. Reaping the child turns the signal into an exit code.
            unsafe { libc::kill(pid, signal) };
        }
    }

    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        // Safety: installing a handler that does nothing but `kill`.
        unsafe { libc::signal(signal, relay as *const () as libc::sighandler_t) };
    }
}

#[cfg(not(unix))]
fn forward_signals(_child: u32) {}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|text| text.trim().to_string())
}

fn write_line(path: &Path, value: &str) -> Result<(), String> {
    fs::write(path, format!("{value}\n")).map_err(|err| format!("could not write {}: {err}", path.display()))
}

/// A version names a directory, and it arrives over the network.
///
/// Dropping the separators is not enough on its own: `.` and `-` have to survive for
/// `1.2.0-rc1` to, and a version of exactly `..` then survives whole - at which point
/// `versions.join("..")` is the home directory itself, and installing it deletes every
/// version, `current` and `previous` before renaming the payload over the top. Empty for
/// anything that is not a name, which `apply_staged` refuses.
fn sanitise(version: &str) -> String {
    let kept: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    if kept.chars().all(|c| c == '.') { String::new() } else { kept }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    /// A home of this test's own, emptied first.
    ///
    /// The emptying is asserted rather than attempted: one of these tests deliberately
    /// makes a directory undeletable, and a run that cannot clean up after itself used to
    /// leave that behind for the *next* run to inherit - which then failed somewhere else
    /// entirely, for a reason nothing pointed at.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bowerbird-launcher-{name}"));
        if let Err(err) = fs::remove_dir_all(&dir) {
            assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{} is left over and will not go: {err}", dir.display());
        }
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stage(home: &Path, version: &str) {
        let staged = home.join("staged");
        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("marker"), version).unwrap();
        fs::write(home.join("staged.version"), format!("{version}\n")).unwrap();
    }

    #[test]
    fn a_staged_payload_becomes_the_current_version() {
        let home = scratch("apply");
        let bundled = home.join("bundled");
        assert_eq!(resolve_payload(&home, &bundled), bundled);

        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        assert_eq!(resolve_payload(&home, &bundled), home.join("versions/0.2.0"));
        assert!(!home.join("staged.version").exists());
    }

    // The whole ladder: the version before this one, then the one that was installed, then
    // nowhere. Each step taken once, which is what stops it being a loop.
    #[test]
    fn stepping_back_ends_at_the_installed_version() {
        let home = scratch("stepback");
        let bundled = home.join("bundled");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        stage(&home, "0.3.0");
        apply_staged(&home).unwrap();

        assert!(step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), home.join("versions/0.2.0"));
        assert!(step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
        assert!(!step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
    }

    // Reaching the installed version has to be the end of it. Re-installing the version
    // already running is the one thing that leaves `previous` naming it too - and with that
    // left on disk, the step after this one reads it as somewhere still to go and starts
    // the version just stepped over all over again.
    #[test]
    fn a_reinstalled_version_is_not_stepped_back_into() {
        let home = scratch("reinstall");
        let bundled = home.join("bundled");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        assert_eq!(read_trimmed(&home.join("previous")).unwrap(), "0.2.0");

        assert!(step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
        assert!(!step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
    }

    // Re-installing the version already running replaces its directory rather than emptying
    // it in place: the old contents are moved aside and only removed once the new ones are
    // in, so a failure part way leaves the version `current` names still runnable.
    #[test]
    fn reinstalling_the_live_version_replaces_its_contents() {
        let home = scratch("reinstall-contents");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        fs::write(home.join("versions/0.2.0/only-in-the-first"), "old").unwrap();

        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        let installed = home.join("versions/0.2.0");
        assert!(installed.join("marker").is_file());
        // Replaced, not merged: what the first install left is gone.
        assert!(!installed.join("only-in-the-first").exists());
        // And nothing is left aside once it has worked.
        assert!(!home.join("versions/0.2.0.stale").exists());
        assert_eq!(read_trimmed(&home.join("current")).unwrap(), "0.2.0");
    }

    // Falling back to the installed version is the end of the line.
    //
    // This covers the ordinary path only. What made `previous` worth *emptying* rather than
    // removing is a removal that fails - the file then survives naming the version just
    // stepped over, and the next early failure starts it again - and an unlink that fails
    // while its directory stays writable cannot be arranged here without root.
    #[test]
    fn falling_back_to_the_installed_version_cannot_be_undone() {
        let home = scratch("no-resurrect");
        let bundled = home.join("bundled");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();

        assert!(step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
        // The bundled one failing too must not send it back to 0.2.0.
        assert!(!step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
    }

    /// The case the aside-and-rename exists for: something under the version being replaced
    /// cannot be deleted.
    ///
    /// A locked file is what this looks like in the wild, most often on Windows moments
    /// after the app that was running out of that directory exited. Here it is a
    /// subdirectory with its write bit off, which makes the unlink inside it fail the same
    /// way. Deleting in place would get part way, leave the live version gutted, and then
    /// fail the rename onto what was left - losing a working version and installing
    /// nothing. Renaming aside does not care what is inside.
    #[cfg(unix)]
    #[test]
    fn a_version_whose_files_will_not_delete_is_still_replaced() {
        use std::os::unix::fs::PermissionsExt;

        let home = scratch("undeletable");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();

        let installed = home.join("versions/0.2.0");
        fs::write(installed.join("plain.txt"), "deletable").unwrap();
        let locked = installed.join("locked");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("held.txt"), "not deletable").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();

        stage(&home, "0.2.0");
        let outcome = apply_staged(&home);

        // Restore before asserting, so a failure here does not leave a directory behind
        // that nothing can remove. Both places, because a successful install is precisely
        // the one that moved it: `versions/0.2.0/locked` becomes `versions/0.2.0.stale/locked`.
        for at in [&locked, &home.join("versions/0.2.0.stale/locked")] {
            if at.is_dir() {
                fs::set_permissions(at, fs::Permissions::from_mode(0o755)).unwrap();
            }
        }

        outcome.unwrap();
        assert_eq!(read_trimmed(&home.join("current")).unwrap(), "0.2.0");
        assert!(installed.join("marker").is_file());
        assert!(!installed.join("plain.txt").exists());
    }

    // The backstop under `Slot` and `sanitise`: whatever name reaches `remove`, the
    // directory it would delete from has to be inside `home`.
    #[test]
    fn nothing_outside_home_can_be_removed() {
        let home = scratch("contained");
        let outside = home.parent().unwrap().join("bowerbird-launcher-contained-outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.txt"), "must survive").unwrap();
        fs::create_dir_all(path_of(&home, Slot::Versions)).unwrap();

        // A traversal, were one ever to get past `sanitise` or arrive as a new `Slot`.
        let escape = OsString::from("../../bowerbird-launcher-contained-outside");
        let refused = remove(&home, Slot::Version(&escape));
        assert_eq!(refused.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert!(outside.join("precious.txt").exists());

        let _ = fs::remove_dir_all(&outside);
    }

    // ...and the case the check must NOT refuse. Resolving the target rather than its
    // directory would read this as a request to delete what it points at, refuse, and leave
    // a planted link under `versions/` there for ever.
    #[cfg(unix)]
    #[test]
    fn a_symlink_under_versions_is_unlinked_rather_than_followed() {
        use std::os::unix::fs::symlink;

        let home = scratch("symlink");
        let outside = home.parent().unwrap().join("bowerbird-launcher-symlink-outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("precious.txt"), "must survive").unwrap();

        let versions = path_of(&home, Slot::Versions);
        fs::create_dir_all(&versions).unwrap();
        let planted = OsString::from("planted");
        symlink(&outside, versions.join(&planted)).unwrap();

        remove(&home, Slot::Version(&planted)).unwrap();
        assert!(!versions.join(&planted).exists());
        assert!(outside.join("precious.txt").exists());

        let _ = fs::remove_dir_all(&outside);
    }

    // Missing is not a failure, and a missing *directory* is the same statement: the check
    // that bounds this resolves that directory, so without saying so `NotFound` out of it
    // would be the one way `remove` reports failure for something already absent.
    #[test]
    fn removing_from_a_directory_that_is_not_there_is_not_a_failure() {
        let home = scratch("no-parent");
        // `versions/` deliberately never created.
        remove(&home, Slot::Stale("0.2.0")).unwrap();
        remove(&home, Slot::Version(OsStr::new("0.2.0"))).unwrap();
        // And the ordinary absence, where the directory is there and the entry is not.
        remove(&home, Slot::Staged).unwrap();
        remove(&home, Slot::Marker).unwrap();
    }

    /// Every state the ladder can be asked to step from, and where each one goes.
    ///
    /// The whole table rather than a walk through it, because `step_back` is two functions
    /// merged into one and the reachable states are few enough to say outright. `None` is
    /// the file absent, `Some("")` is it present and empty - a distinction the old pair
    /// treated differently in one arm and this does not, so it is spelled out here.
    #[test]
    fn where_each_state_steps_back_to() {
        // (previous, current) -> (stepped, current afterwards)
        let table = [
            ((None, None), (false, "")),
            ((None, Some("")), (false, "")),
            ((None, Some("1.0")), (true, "")),
            ((Some(""), None), (false, "")),
            ((Some(""), Some("")), (false, "")),
            ((Some(""), Some("1.0")), (true, "")),
            ((Some("0.9"), None), (true, "0.9")),
            ((Some("0.9"), Some("1.0")), (true, "0.9")),
            // The same version either side is a re-install: not somewhere to go, but the
            // one that came with the install is still under it.
            ((Some("1.0"), Some("1.0")), (true, "")),
        ];

        for ((previous, current), (stepped, settled)) in table {
            let home = scratch("table");
            for (slot, value) in [(Slot::Previous, previous), (Slot::Current, current)] {
                if let Some(value) = value {
                    write_line(&path_of(&home, slot), value).unwrap();
                }
            }

            let what = format!("previous={previous:?} current={current:?}");
            assert_eq!(step_back(&home).unwrap(), stepped, "stepped, for {what}");
            assert_eq!(
                read_trimmed(&path_of(&home, Slot::Current)).unwrap_or_default(),
                settled,
                "current afterwards, for {what}",
            );
            // Whatever happened, there is never a `previous` left naming somewhere to go:
            // that is what stops a second failure walking back up the ladder.
            if stepped {
                assert_eq!(
                    read_trimmed(&path_of(&home, Slot::Previous)).unwrap_or_default(),
                    "",
                    "previous afterwards, for {what}",
                );
            }
        }
    }

    // The other half of resolving the parent: a leaf symlink is unlinked (above), but a
    // symlink *in the chain* is what would take the deletion out of the tree entirely. This
    // is the case the containment check is really for, and the one the leaf test cannot
    // reach - without it the comment on `contained` claims something nothing demonstrates.
    #[cfg(unix)]
    #[test]
    fn a_versions_directory_that_is_a_link_out_of_the_tree_is_refused() {
        use std::os::unix::fs::symlink;

        let home = scratch("versions-link");
        let outside = home.parent().unwrap().join("bowerbird-launcher-versions-link-outside");
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(outside.join("0.2.0")).unwrap();
        fs::write(outside.join("0.2.0/precious.txt"), "must survive").unwrap();

        // `versions` is not a directory here - it is a way out of `home`.
        symlink(&outside, path_of(&home, Slot::Versions)).unwrap();

        let refused = remove(&home, Slot::Version(OsStr::new("0.2.0")));
        assert_eq!(refused.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
        assert!(outside.join("0.2.0/precious.txt").exists());

        let _ = fs::remove_dir_all(&outside);
    }

    /// The state a kill between `step_back`'s two writes leaves, and what a restart makes
    /// of it.
    ///
    /// It pins the *reading*, not the ordering: which of the two writes went first is not
    /// observable to anything that cannot kill the process between two syscalls, so the
    /// order is reasoned rather than pinned. What this does hold is the half-written state
    /// being the one worth arriving at - the target selected, rather than the version that
    /// just failed still selected with its predecessor already forgotten.
    #[test]
    fn a_kill_midway_through_stepping_back_still_selects_the_target() {
        let home = scratch("half-stepped");
        let bundled = home.join("bundled");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();
        stage(&home, "0.3.0");
        apply_staged(&home).unwrap();

        // What is on disk after the first write and before the second.
        write_line(&path_of(&home, Slot::Current), "0.2.0").unwrap();
        assert_eq!(read_trimmed(&path_of(&home, Slot::Previous)).unwrap(), "0.2.0");

        // The target is what runs, rather than 0.3.0 being started a second time.
        assert_eq!(resolve_payload(&home, &bundled), home.join("versions/0.2.0"));
        // And if it fails too, the ladder carries on down rather than round.
        assert!(step_back(&home).unwrap());
        assert_eq!(resolve_payload(&home, &bundled), bundled);
    }

    // The loop itself, which nothing else reaches: a payload that cannot even be started is
    // a version that does not start, and with nowhere left to step back to it has to end
    // rather than spin.
    #[test]
    fn a_payload_that_cannot_be_started_ends_rather_than_looping() {
        let home = scratch("unstartable");
        let outcome = supervise(&home, &home.join("bundled"), |payload| {
            Command::new(payload.join("there-is-no-such-binary"))
        });
        assert!(outcome.is_err(), "expected a failure to start, got {outcome:?}");
    }

    #[test]
    fn a_staged_directory_with_no_marker_is_never_installed() {
        let home = scratch("incomplete");
        let bundled = home.join("bundled");
        fs::create_dir_all(home.join("staged")).unwrap();
        apply_staged(&home).unwrap();
        assert_eq!(resolve_payload(&home, &bundled), bundled);

        // And a marker naming files that are not there takes the marker with it.
        fs::write(home.join("staged.version"), "0.2.0\n").unwrap();
        fs::remove_dir_all(home.join("staged")).unwrap();
        assert!(apply_staged(&home).is_err());
        assert!(!home.join("staged.version").exists());
    }

    #[test]
    fn a_version_cannot_name_a_directory_outside_the_versions_folder() {
        assert_eq!(sanitise("../../etc/0.2.0"), "....etc0.2.0");
        // The one that is not merely odd but destructive: `versions/..` is the home
        // directory, and installing onto it removes every version there is first.
        assert_eq!(sanitise(".."), "");
        assert_eq!(sanitise("."), "");
        assert_eq!(sanitise("..@@"), "");
    }

    #[test]
    fn a_version_of_dots_alone_is_refused_rather_than_installed_over_the_home_directory() {
        let home = scratch("dots");
        stage(&home, "0.2.0");
        apply_staged(&home).unwrap();

        let staged = home.join("staged");
        fs::create_dir_all(&staged).unwrap();
        fs::write(home.join("staged.version"), "..\n").unwrap();
        assert!(apply_staged(&home).is_err());
        // And the version that was already installed is still there to run.
        assert!(home.join("versions/0.2.0").is_dir());
        assert_eq!(read_trimmed(&home.join("current")).unwrap(), "0.2.0");
    }
}
