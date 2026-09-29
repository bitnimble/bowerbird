//! Replacing an installed Bowerbird with a newer one, from outside it (DESIGN §23.3).
//!
//! The app downloads a payload, unpacks it into `<home>/staged`, starts this helper and exits.
//! The helper waits for it to be gone, swaps the payload's entries into the install, starts the
//! app again, and puts the old entries back if the new version dies on startup.
//!
//! ```text
//! <home>/
//!   staged/            the payload, unpacked: the entries that replace the install's
//!   staged.version     written last, and what says `staged/` is complete
//!   updater.log        what the last updates did, since this runs with nowhere to print
//! <install>/
//!   <entry>                           live
//!   .<entry>.bowerbird-incoming       the payload's copy, moved in before anything is swapped
//!   .<entry>.bowerbird-previous       the copy it replaced, until the new one has started
//! ```

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How soon after starting a failure is taken as "this version does not work".
///
/// A version that runs for an hour and then crashes is not a bad update, it is a crash, and
/// putting the old one back would throw away whatever the reader did in that hour.
const INFANCY: Duration = Duration::from_secs(30);

const WAIT_FOR_APP: Duration = Duration::from_secs(120);

const INCOMING: &str = ".bowerbird-incoming";
const PREVIOUS: &str = ".bowerbird-previous";

/// Where an update comes from and where it goes.
pub struct Plan {
    /// Holds `staged/` and `staged.version`.
    pub home: PathBuf,
    /// The directory whose entries the payload's replace.
    pub install: PathBuf,
    /// A payload entry that is installed under another name: the shell, whose name is the
    /// bundle's or the installer's rather than the payload's.
    pub renames: Vec<(OsString, OsString)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Swap,
    Restore,
    Finish,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Swap => "swap",
            Phase::Restore => "restore",
            Phase::Finish => "finish",
        }
    }

    fn named(name: &OsStr) -> Option<Phase> {
        [Phase::Swap, Phase::Restore, Phase::Finish]
            .into_iter()
            .find(|phase| name == phase.name())
    }
}

#[derive(Debug, PartialEq)]
enum Invocation {
    Update {
        plan: PlanArgs,
        wait: u32,
        relaunch: Vec<OsString>,
    },
    /// One step of an update, run elevated by the unelevated helper that is doing the rest.
    Phase { plan: PlanArgs, phase: Phase },
}

#[derive(Debug, PartialEq)]
struct PlanArgs {
    home: PathBuf,
    install: PathBuf,
    renames: Vec<(OsString, OsString)>,
}

impl PlanArgs {
    fn into_plan(self) -> Plan {
        Plan {
            home: self.home,
            install: self.install,
            renames: self.renames,
        }
    }
}

/// The helper's whole command line:
///
/// ```text
/// bowerbird-updater --wait <pid> --home <dir> --install <dir> [--rename <from>=<to>]... -- <app> [args]...
/// ```
pub fn main(args: impl IntoIterator<Item = OsString>) -> i32 {
    let invocation = match parse(args.into_iter().skip(1)) {
        Ok(invocation) => invocation,
        Err(why) => {
            eprintln!("[bowerbird-updater] {why}");
            return 2;
        }
    };
    match invocation {
        Invocation::Update {
            plan,
            wait,
            relaunch,
        } => {
            let plan = plan.into_plan();
            match update(&plan, wait, &relaunch, INFANCY) {
                Ok(()) => 0,
                Err(why) => {
                    log(&plan.home, &why);
                    1
                }
            }
        }
        Invocation::Phase { plan, phase } => {
            let plan = plan.into_plan();
            match run_phase(&plan, phase) {
                Ok(()) => 0,
                Err(why) => {
                    log(&plan.home, &format!("{}: {why}", phase.name()));
                    1
                }
            }
        }
    }
}

/// Waits for the app to exit, installs what it staged, and starts it again.
///
/// Whatever happens, the reader is left with an app running: a swap that fails is undone and
/// the old version started, and a new version that dies on startup is swapped back out.
pub fn update(
    plan: &Plan,
    wait: u32,
    relaunch: &[OsString],
    infancy: Duration,
) -> Result<(), String> {
    wait_for_exit(wait, WAIT_FOR_APP)?;

    if let Err(why) = in_phase(plan, Phase::Swap) {
        discard_staged(plan);
        return Err(match start(relaunch) {
            Ok(_) => format!(
                "the update could not be installed, so the version that was there is running again: {why}"
            ),
            Err(started) => format!(
                "the update could not be installed ({why}), and the version that was there did not start: {started}"
            ),
        });
    }
    log(&plan.home, "installed the staged update");
    discard_staged(plan);

    match start_and_watch(relaunch, infancy) {
        Started::Healthy => in_phase(plan, Phase::Finish),
        Started::Failed(why) => {
            log(
                &plan.home,
                &format!("the new version failed on startup ({why}); putting the old one back"),
            );
            // Started whether or not the restore worked: whatever is installed now is a better
            // answer than no app at all.
            let restored = in_phase(plan, Phase::Restore);
            let started = start(relaunch).map(|_| ());
            restored.and(started)
        }
    }
}

/// `phase` here, or in an elevated copy of this helper where the install is not writable.
fn in_phase(plan: &Plan, phase: Phase) -> Result<(), String> {
    if writable(&plan.install) {
        return run_phase(plan, phase);
    }
    elevated(plan, phase)
}

fn run_phase(plan: &Plan, phase: Phase) -> Result<(), String> {
    match phase {
        Phase::Swap => swap(plan),
        Phase::Restore => restore(&plan.install),
        Phase::Finish => {
            sweep(&plan.install, PREVIOUS).and_then(|()| sweep(&plan.install, INCOMING))
        }
    }
}

/// Every staged entry into the install, all or none.
///
/// Moved in under a name nothing runs from before anything live is touched, so the slow part -
/// a copy, where the payload is on another volume - happens while the install is still whole.
/// Then each live entry is renamed aside and its replacement renamed in, and a failure part way
/// puts back every one already swapped.
fn swap(plan: &Plan) -> Result<(), String> {
    if !plan.home.join("staged.version").is_file() {
        return Err("no complete update is staged".into());
    }
    let staged = plan.home.join("staged");
    let entries = sorted_entries(&staged)
        .map_err(|err| format!("could not read {}: {err}", staged.display()))?;
    if entries.is_empty() {
        return Err(format!("{} is empty", staged.display()));
    }
    let names: Vec<(OsString, OsString)> = entries
        .into_iter()
        .map(|entry| (installed_name(plan, &entry), entry))
        .collect();

    for (name, entry) in &names {
        let incoming = beside(&plan.install, name, INCOMING);
        let moved = remove_any(&incoming).and_then(|()| move_tree(&staged.join(entry), &incoming));
        if let Err(err) = moved {
            let _ = sweep(&plan.install, INCOMING);
            return Err(format!(
                "could not move {} into {}: {err}",
                entry.to_string_lossy(),
                plan.install.display()
            ));
        }
    }

    let mut swapped: Vec<(&OsStr, bool)> = Vec::new();
    for (name, _) in &names {
        let live = plan.install.join(name);
        let previous = beside(&plan.install, name, PREVIOUS);
        let had = live.symlink_metadata().is_ok();
        let outcome = remove_any(&previous)
            .and_then(|()| {
                if had {
                    rename(&live, &previous)
                } else {
                    Ok(())
                }
            })
            .and_then(|()| rename(&beside(&plan.install, name, INCOMING), &live));
        if let Err(err) = outcome {
            if had && live.symlink_metadata().is_err() {
                let _ = rename(&previous, &live);
            }
            unswap(&plan.install, &swapped);
            let _ = sweep(&plan.install, INCOMING);
            return Err(format!("could not replace {}: {err}", live.display()));
        }
        swapped.push((name.as_os_str(), had));
    }
    Ok(())
}

/// Takes back what [`swap`] did, newest first.
fn unswap(install: &Path, swapped: &[(&OsStr, bool)]) {
    for (name, had) in swapped.iter().rev() {
        let _ = if *had {
            put_back(install, name)
        } else {
            remove_any(&install.join(name))
        };
    }
}

/// Every entry the last swap replaced, back where it was.
///
/// Read off the install rather than remembered, so an elevated copy of this helper can do it
/// with nothing but the directory. An entry the payload added, which replaced nothing, stays.
fn restore(install: &Path) -> Result<(), String> {
    let mut failed = None;
    for (_, name) in marked(install, PREVIOUS)? {
        if let Err(err) = put_back(install, &name) {
            failed.get_or_insert(format!(
                "could not put {} back: {err}",
                install.join(&name).display()
            ));
        }
    }
    failed.map_or(Ok(()), Err)
}

/// The entry held aside as previous, back in place of the live one.
fn put_back(install: &Path, name: &OsStr) -> io::Result<()> {
    let live = install.join(name);
    let aside = beside(install, name, INCOMING);
    remove_any(&aside)?;
    if live.symlink_metadata().is_ok() {
        rename(&live, &aside)?;
    }
    // Aside rather than deleted until the old one is in: a failed rename would otherwise leave no app.
    if let Err(err) = rename(&beside(install, name, PREVIOUS), &live) {
        let _ = rename(&aside, &live);
        return Err(err);
    }
    let _ = remove_any(&aside);
    Ok(())
}

/// Deletes every entry carrying `suffix`.
fn sweep(install: &Path, suffix: &str) -> Result<(), String> {
    for (held, _) in marked(install, suffix)? {
        let path = install.join(held);
        remove_any(&path).map_err(|err| format!("could not remove {}: {err}", path.display()))?;
    }
    Ok(())
}

/// The install's entries carrying `suffix`, with the name each stands beside.
fn marked(install: &Path, suffix: &str) -> Result<Vec<(OsString, OsString)>, String> {
    let entries = sorted_entries(install)
        .map_err(|err| format!("could not read {}: {err}", install.display()))?;
    Ok(entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry
                .to_str()?
                .strip_prefix('.')?
                .strip_suffix(suffix)?
                .to_owned();
            (!name.is_empty()).then(|| (entry, OsString::from(name)))
        })
        .collect())
}

fn installed_name(plan: &Plan, entry: &OsStr) -> OsString {
    plan.renames
        .iter()
        .find(|(from, _)| from == entry)
        .map_or_else(|| entry.to_owned(), |(_, to)| to.clone())
}

fn beside(install: &Path, name: &OsStr, suffix: &str) -> PathBuf {
    let mut held = OsString::from(".");
    held.push(name);
    held.push(suffix);
    install.join(held)
}

fn discard_staged(plan: &Plan) {
    let _ = remove_any(&plan.home.join("staged.version"));
    let _ = remove_any(&plan.home.join("staged"));
}

enum Started {
    Healthy,
    Failed(String),
}

/// Starts the app and watches it through its first moments.
///
/// Exiting cleanly inside them is a reader who opened and closed it, not a failure. Past them the
/// app is left running and this helper exits, which leaves it to whatever adopts orphans.
fn start_and_watch(relaunch: &[OsString], infancy: Duration) -> Started {
    let mut child = match start(relaunch) {
        Ok(child) => child,
        Err(why) => return Started::Failed(why),
    };
    let started = Instant::now();
    while started.elapsed() < infancy {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Started::Healthy,
            Ok(Some(status)) => return Started::Failed(format!("it exited {status}")),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(err) => return Started::Failed(format!("could not watch it: {err}")),
        }
    }
    Started::Healthy
}

fn start(relaunch: &[OsString]) -> Result<std::process::Child, String> {
    let (program, args) = relaunch.split_first().ok_or("there is no app to start")?;
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("could not start {}: {err}", Path::new(program).display()))
}

pub fn writable(dir: &Path) -> bool {
    let probe = dir.join(".bowerbird-write-probe");
    let wrote = fs::write(&probe, b"").is_ok();
    let _ = fs::remove_file(&probe);
    wrote
}

fn sorted_entries(dir: &Path) -> io::Result<Vec<OsString>> {
    let mut names: Vec<OsString> = fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<io::Result<_>>()?;
    names.sort();
    Ok(names)
}

/// Missing is not a failure: every caller is making sure of a thing's absence.
///
/// `remove_dir_all` unlinks a symlink rather than following it, so a link in a bundle takes
/// nothing outside it along.
fn remove_any(path: &Path) -> io::Result<()> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    retrying(|| {
        if metadata.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
    })
}

fn rename(from: &Path, to: &Path) -> io::Result<()> {
    retrying(|| fs::rename(from, to))
}

/// A rename, or a copy where the two are on different volumes.
fn move_tree(from: &Path, to: &Path) -> io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if let Err(err) = copy_tree(from, to) {
        let _ = remove_any(to);
        return Err(err);
    }
    remove_any(from)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let metadata = from.symlink_metadata()?;
    #[cfg(unix)]
    if metadata.file_type().is_symlink() {
        return std::os::unix::fs::symlink(fs::read_link(from)?, to);
    }
    if !metadata.is_dir() {
        return fs::copy(from, to).map(|_| ());
    }
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        copy_tree(&entry.path(), &to.join(entry.file_name()))?;
    }
    fs::set_permissions(to, metadata.permissions())
}

/// On Windows a file stays locked for a moment after the process that had it open exits, and a
/// virus scanner opens every new executable it sees, so a rename or delete there is tried again
/// for a few seconds before it counts as failed.
#[cfg(windows)]
fn retrying(mut attempt: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match attempt() {
            Err(err) if err.kind() != io::ErrorKind::NotFound && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(250));
            }
            outcome => return outcome,
        }
    }
}

#[cfg(not(windows))]
fn retrying(mut attempt: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    attempt()
}

#[cfg(unix)]
fn wait_for_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    let pid = libc::pid_t::try_from(pid).map_err(|_| format!("{pid} is not a process id"))?;
    let deadline = Instant::now() + timeout;
    loop {
        // Safety: signal 0 sends nothing and only asks whether the process exists.
        let alive = unsafe { libc::kill(pid, 0) } == 0
            || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
        if !alive {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the app (process {pid}) did not exit within {timeout:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
fn wait_for_exit(pid: u32, timeout: Duration) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
    };

    // Safety: a handle opened only to wait on, and closed before returning.
    unsafe {
        let process = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if process.is_null() {
            return Ok(());
        }
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        let waited = WaitForSingleObject(process, millis);
        CloseHandle(process);
        if waited == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err(format!(
                "the app (process {pid}) did not exit within {timeout:?}"
            ))
        }
    }
}

/// `phase` in a copy of this helper started through UAC, for an install under Program Files.
#[cfg(windows)]
fn elevated(plan: &Plan, phase: Phase) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, INFINITE, WaitForSingleObject,
    };
    use windows_sys::Win32::UI::Shell::{
        SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW,
    };

    let wide = |text: &OsStr| {
        text.encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let exe =
        std::env::current_exe().map_err(|err| format!("could not find this helper: {err}"))?;
    let parameters = phase_args(plan, phase)
        .iter()
        .map(|arg| quoted(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let verb = wide(OsStr::new("runas"));
    let file = wide(exe.as_os_str());
    let parameters = wide(OsStr::new(&parameters));

    // Safety: every pointer handed over outlives the call, and the process handle it returns is
    // closed below.
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = parameters.as_ptr();
        if ShellExecuteExW(&mut info) == 0 {
            return Err(format!(
                "{} needs an administrator to write to, and none was given: {}",
                plan.install.display(),
                io::Error::last_os_error()
            ));
        }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if code == 0 {
            Ok(())
        } else {
            Err(format!(
                "the elevated {} failed; {} says why",
                phase.name(),
                plan.home.join("updater.log").display()
            ))
        }
    }
}

#[cfg(not(windows))]
fn elevated(plan: &Plan, _phase: Phase) -> Result<(), String> {
    Err(format!("{} is not writable", plan.install.display()))
}

#[cfg(windows)]
fn phase_args(plan: &Plan, phase: Phase) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--phase".into(), phase.name().into()];
    args.extend(plan_args(plan));
    args
}

fn plan_args(plan: &Plan) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "--home".into(),
        plan.home.clone().into(),
        "--install".into(),
        plan.install.clone().into(),
    ];
    for (from, to) in &plan.renames {
        let mut pair = from.clone();
        pair.push("=");
        pair.push(to);
        args.push("--rename".into());
        args.push(pair);
    }
    args
}

/// One argument as `CommandLineToArgvW` reads it back: quoted, with a quote escaped and each run
/// of backslashes doubled wherever a quote follows it.
#[cfg(windows)]
fn quoted(arg: &OsStr) -> String {
    let mut out = String::from("\"");
    let mut backslashes = 0;
    for c in arg.to_string_lossy().chars() {
        if c == '\\' {
            backslashes += 1;
            continue;
        }
        let escaped = if c == '"' {
            backslashes * 2 + 1
        } else {
            backslashes
        };
        out.extend(std::iter::repeat('\\').take(escaped));
        out.push(c);
        backslashes = 0;
    }
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
    out
}

fn parse(args: impl Iterator<Item = OsString>) -> Result<Invocation, String> {
    let mut home = None;
    let mut install = None;
    let mut renames = Vec::new();
    let mut wait = None;
    let mut phase = None;
    let mut relaunch = Vec::new();

    let mut args = args;
    while let Some(arg) = args.next() {
        if arg == "--" {
            relaunch.extend(args.by_ref());
            break;
        }
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("{} needs a value", arg.to_string_lossy()))
        };
        match arg.to_str() {
            Some("--home") => home = Some(PathBuf::from(value()?)),
            Some("--install") => install = Some(PathBuf::from(value()?)),
            Some("--wait") => {
                let pid = value()?;
                wait = Some(
                    pid.to_str()
                        .and_then(|pid| pid.parse::<u32>().ok())
                        .ok_or("--wait takes a process id")?,
                );
            }
            Some("--phase") => {
                phase = Some(Phase::named(&value()?).ok_or("--phase is swap, restore or finish")?)
            }
            Some("--rename") => {
                let pair = value()?;
                let (from, to) = pair
                    .to_str()
                    .and_then(|pair| pair.split_once('='))
                    .ok_or("--rename takes <from>=<to>")?;
                renames.push((OsString::from(from), OsString::from(to)));
            }
            _ => return Err(format!("unexpected {}", arg.to_string_lossy())),
        }
    }

    let plan = PlanArgs {
        home: home.ok_or("--home is required")?,
        install: install.ok_or("--install is required")?,
        renames,
    };
    match (phase, wait) {
        (Some(phase), None) => Ok(Invocation::Phase { plan, phase }),
        (None, Some(wait)) if !relaunch.is_empty() => Ok(Invocation::Update {
            plan,
            wait,
            relaunch,
        }),
        (None, Some(_)) => {
            Err("nothing to start after the update: put the app's command after --".into())
        }
        _ => Err("either --wait <pid> -- <app> or --phase <phase>".into()),
    }
}

/// The helper's command line for an update, less the program: what the app starts it with.
pub fn update_args(plan: &Plan, wait: u32, relaunch: &[OsString]) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--wait".into(), wait.to_string().into()];
    args.extend(plan_args(plan));
    args.push("--".into());
    args.extend(relaunch.iter().cloned());
    args
}

fn log(home: &Path, line: &str) {
    eprintln!("[bowerbird-updater] {line}");
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("updater.log"))
    {
        let _ = writeln!(file, "{seconds} {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch() -> PathBuf {
        static COUNT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bowerbird-updater-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("home")).unwrap();
        fs::create_dir_all(dir.join("install")).unwrap();
        dir
    }

    fn plan(dir: &Path) -> Plan {
        Plan {
            home: dir.join("home"),
            install: dir.join("install"),
            renames: vec![("bowerbird-app".into(), "Bowerbird".into())],
        }
    }

    fn stage(plan: &Plan, files: &[(&str, &str)]) {
        let staged = plan.home.join("staged");
        for (name, body) in files {
            let path = staged.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
        fs::write(plan.home.join("staged.version"), "2.0.0\n").unwrap();
    }

    fn install(plan: &Plan, files: &[(&str, &str)]) {
        for (name, body) in files {
            let path = plan.install.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, body).unwrap();
        }
    }

    fn read(path: impl AsRef<Path>) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn entries(dir: &Path) -> Vec<String> {
        sorted_entries(dir)
            .unwrap()
            .into_iter()
            .map(|name| name.to_string_lossy().into_owned())
            .collect()
    }

    /// A process that has already exited and been reaped, so waiting on it returns at once.
    #[cfg(unix)]
    fn gone() -> u32 {
        let mut child = Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }

    /// An app that records which version started and exits with `code`.
    #[cfg(unix)]
    fn app(plan: &Plan, version: &str, code: i32) -> String {
        let log = plan.home.join("starts");
        format!(
            "#!/bin/sh\necho {version} >> '{}'\nexit {code}\n",
            log.display()
        )
    }

    #[cfg(unix)]
    fn executable(path: &Path) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_swap_replaces_the_payloads_entries_and_leaves_the_rest() {
        let dir = scratch();
        let plan = plan(&dir);
        install(
            &plan,
            &[
                ("Bowerbird", "old shell"),
                ("resources/server.js", "old"),
                ("uninstall", "kept"),
            ],
        );
        stage(
            &plan,
            &[
                ("bowerbird-app", "new shell"),
                ("resources/server.js", "new"),
                ("added.dll", "new"),
            ],
        );

        swap(&plan).unwrap();

        assert_eq!(read(plan.install.join("Bowerbird")), "new shell");
        assert_eq!(read(plan.install.join("resources/server.js")), "new");
        assert_eq!(read(plan.install.join("added.dll")), "new");
        assert_eq!(read(plan.install.join("uninstall")), "kept");
        assert_eq!(
            read(plan.install.join(".Bowerbird.bowerbird-previous")),
            "old shell"
        );

        run_phase(&plan, Phase::Finish).unwrap();
        assert_eq!(
            entries(&plan.install),
            ["Bowerbird", "added.dll", "resources", "uninstall"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_swap_that_fails_part_way_puts_back_what_it_had_swapped() {
        let dir = scratch();
        let plan = plan(&dir);
        install(&plan, &[("a", "old a"), ("b", "old b")]);
        stage(&plan, &[("a", "new a"), ("b", "new b")]);
        // A leftover `b` aside that cannot be cleared, so the second entry fails after the first swapped.
        let stuck = beside(&plan.install, OsStr::new("b"), PREVIOUS);
        install(&plan, &[(".b.bowerbird-previous/locked/file", "")]);
        fs::set_permissions(stuck.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();

        let failed = swap(&plan);
        fs::set_permissions(stuck.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();

        assert!(failed.is_err());
        assert_eq!(read(plan.install.join("a")), "old a");
        assert_eq!(read(plan.install.join("b")), "old b");
        assert!(!beside(&plan.install, OsStr::new("a"), PREVIOUS).exists());
        assert!(marked(&plan.install, INCOMING).unwrap().is_empty());
    }

    #[test]
    fn a_restore_puts_back_every_entry_the_swap_replaced() {
        let dir = scratch();
        let plan = plan(&dir);
        install(
            &plan,
            &[("Bowerbird", "old shell"), ("resources/server.js", "old")],
        );
        stage(
            &plan,
            &[
                ("bowerbird-app", "new shell"),
                ("resources/server.js", "new"),
            ],
        );
        swap(&plan).unwrap();

        run_phase(&plan, Phase::Restore).unwrap();

        assert_eq!(read(plan.install.join("Bowerbird")), "old shell");
        assert_eq!(read(plan.install.join("resources/server.js")), "old");
        assert!(marked(&plan.install, PREVIOUS).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_restore_that_fails_on_one_entry_leaves_it_live_and_restores_the_rest() {
        let dir = scratch();
        let plan = plan(&dir);
        install(&plan, &[("a", "old a"), ("b", "old b")]);
        stage(&plan, &[("a", "new a"), ("b", "new b")]);
        swap(&plan).unwrap();
        // A leftover beside `a` that cannot be cleared, so `a` cannot be put back.
        let stuck = beside(&plan.install, OsStr::new("a"), INCOMING);
        install(&plan, &[(".a.bowerbird-incoming/locked/file", "")]);
        fs::set_permissions(stuck.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();

        let failed = run_phase(&plan, Phase::Restore);
        fs::set_permissions(stuck.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();

        assert!(failed.is_err());
        assert_eq!(read(plan.install.join("a")), "new a");
        assert_eq!(read(plan.install.join("b")), "old b");
    }

    #[test]
    fn nothing_is_swapped_without_the_marker_that_says_the_payload_is_complete() {
        let dir = scratch();
        let plan = plan(&dir);
        install(&plan, &[("Bowerbird", "old shell")]);
        stage(&plan, &[("bowerbird-app", "half")]);
        fs::remove_file(plan.home.join("staged.version")).unwrap();

        assert!(swap(&plan).is_err());
        assert_eq!(read(plan.install.join("Bowerbird")), "old shell");
    }

    #[cfg(unix)]
    #[test]
    fn an_update_that_starts_is_kept_and_its_leftovers_cleared() {
        let dir = scratch();
        let plan = plan(&dir);
        install(&plan, &[("Bowerbird", &app(&plan, "old", 0))]);
        stage(&plan, &[("bowerbird-app", &app(&plan, "new", 0))]);
        executable(&plan.home.join("staged/bowerbird-app"));
        let shell = plan.install.join("Bowerbird");

        update(
            &plan,
            gone(),
            &[shell.clone().into()],
            Duration::from_secs(10),
        )
        .unwrap();

        assert_eq!(read(plan.home.join("starts")), "new\n");
        assert_eq!(entries(&plan.install), ["Bowerbird"]);
        assert!(!plan.home.join("staged").exists());
        assert!(!plan.home.join("staged.version").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_version_that_fails_on_startup_is_swapped_back_out_and_the_old_one_started() {
        let dir = scratch();
        let plan = plan(&dir);
        install(&plan, &[("Bowerbird", &app(&plan, "old", 0))]);
        executable(&plan.install.join("Bowerbird"));
        stage(&plan, &[("bowerbird-app", &app(&plan, "new", 3))]);
        executable(&plan.home.join("staged/bowerbird-app"));
        let shell = plan.install.join("Bowerbird");

        update(
            &plan,
            gone(),
            &[shell.clone().into()],
            Duration::from_secs(10),
        )
        .unwrap();

        // The second start is not watched, so it may still be writing.
        let deadline = Instant::now() + Duration::from_secs(5);
        while read(plan.home.join("starts")) != "new\nold\n" && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(read(plan.home.join("starts")), "new\nold\n");
        assert!(read(&shell).contains("echo old"));
        assert_eq!(entries(&plan.install), ["Bowerbird"]);
    }

    #[test]
    fn a_payload_tree_is_copied_with_its_nested_files() {
        let dir = scratch();
        let from = dir.join("from");
        fs::create_dir_all(from.join("resources/nested")).unwrap();
        fs::write(from.join("app"), "binary").unwrap();
        fs::write(from.join("resources/nested/server.js"), "server").unwrap();

        copy_tree(&from, &dir.join("to")).unwrap();

        assert_eq!(read(dir.join("to/app")), "binary");
        assert_eq!(read(dir.join("to/resources/nested/server.js")), "server");
        assert_eq!(read(from.join("app")), "binary");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_payload_on_another_volume_is_copied_with_its_links_and_modes() {
        let dir = scratch();
        let from = dir.join("from");
        fs::create_dir_all(from.join("Contents/MacOS")).unwrap();
        fs::write(from.join("Contents/MacOS/app"), "binary").unwrap();
        executable(&from.join("Contents/MacOS/app"));
        std::os::unix::fs::symlink("MacOS/app", from.join("Contents/current")).unwrap();

        copy_tree(&from, &dir.join("to")).unwrap();

        let copied = dir.join("to/Contents/MacOS/app");
        assert_eq!(read(&copied), "binary");
        assert_eq!(
            fs::metadata(&copied).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::read_link(dir.join("to/Contents/current")).unwrap(),
            Path::new("MacOS/app")
        );
    }

    #[test]
    fn the_command_line_the_app_writes_is_the_one_the_helper_reads() {
        let plan = Plan {
            home: "/home/u/updates".into(),
            install: "/Applications".into(),
            renames: vec![("Bowerbird.app".into(), "Bowerbird 2.app".into())],
        };
        let relaunch: Vec<OsString> = vec![
            "/Applications/Bowerbird 2.app/Contents/MacOS/app".into(),
            "--flag".into(),
        ];

        let parsed = parse(update_args(&plan, 42, &relaunch).into_iter()).unwrap();

        assert_eq!(
            parsed,
            Invocation::Update {
                plan: PlanArgs {
                    home: plan.home.clone(),
                    install: plan.install.clone(),
                    renames: plan.renames.clone()
                },
                wait: 42,
                relaunch,
            }
        );
    }

    #[test]
    fn a_command_line_with_nothing_to_start_is_refused() {
        let args: Vec<OsString> = ["--wait", "1", "--home", "/h", "--install", "/i"]
            .iter()
            .map(OsString::from)
            .collect();
        assert!(parse(args.into_iter()).is_err());
    }
}
