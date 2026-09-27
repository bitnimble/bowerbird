//! The Bowerbird server this app carries, and its life.
//!
//! A desktop Bowerbird is not a thin client onto somebody's server: it holds a real
//! library of its own, imports and triages and edits with no network at all, and
//! replicates with other copies when it can reach them. So the app starts a server
//! for itself and points the page at that; a remote address, if the reader sets one,
//! is a *replication peer* the local server talks to, not something the page reaches
//! past it.
//!
//! Two things travel beside the executable and neither can be inside it. The server
//! is a bundle run by the Bun runtime, because a compiled single file cannot start a
//! worker and this one reads every RAW header on one. The native library is a shared
//! object opened by `dlopen`. Both are found here and handed over by environment,
//! rather than guessed at by the server, because a packaged app has no source tree to
//! sit beside.

use std::io::ErrorKind;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// How long the server is given to answer before the app gives up on it.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

static RUNNING: Mutex<Option<Child>> = Mutex::new(None);
static LOCAL: Mutex<Option<Local>> = Mutex::new(None);

struct Local {
    origin: String,
    token: String,
}

impl Local {
    fn serves(&self, url: &str) -> bool {
        url.strip_prefix(&self.origin).is_some_and(|path| path.starts_with('/'))
    }
}

/// The local server's address, once it is answering.
pub(crate) fn local_origin() -> Option<String> {
    LOCAL.lock().ok().and_then(|held| held.as_ref().map(|local| local.origin.clone()))
}

/// The secret the local server requires of every request, where `url` is on it.
pub(crate) fn token_for(url: &str) -> Option<String> {
    let held = LOCAL.lock().ok()?;
    held.as_ref().filter(|local| local.serves(url)).map(|local| local.token.clone())
}

fn fresh_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|err| format!("no randomness for the server's token: {err}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// A port nothing else holds.
///
/// Asked of the operating system rather than picked from a range: two copies of the
/// app, or a port some other program happens to want, would otherwise collide and
/// the second would fail to start with nothing on screen to say why. The listener is
/// dropped before the server is told the number, which leaves a moment where
/// something else could take it - small enough to accept, and the alternative is
/// parsing the port back out of the server's own log.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Where Tauri put a sidecar: beside the executable, with the target triple gone.
///
/// `BOWERBIRD_SIDECAR` overrides it, because that copying only happens for a
/// packaged build - a run straight out of `target/` has no server beside it, and
/// pointing at one is how the desktop app is exercised without bundling it first.
fn sidecar_path() -> std::io::Result<PathBuf> {
    if let Ok(named) = std::env::var("BOWERBIRD_SIDECAR") {
        return Ok(PathBuf::from(named));
    }
    let exe = std::env::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::new(ErrorKind::NotFound, "the executable has no directory"))?;
    let name = if cfg!(windows) { "bowerbird-server.exe" } else { "bowerbird-server" };
    Ok(dir.join(name))
}

/// Where the bundle and the native library landed, on the same terms.
fn resource_root(app: &tauri::AppHandle<crate::Runtime>) -> Result<PathBuf, String> {
    if let Ok(named) = std::env::var("BOWERBIRD_RESOURCES") {
        return Ok(PathBuf::from(named));
    }
    app.path()
        .resource_dir()
        .map(|dir| dir.join("resources"))
        .map_err(|err| format!("could not locate the app's resources: {err}"))
}

/// The page the server serves, on the same terms: `BOWERBIRD_WEB` for a run out of `target/`.
fn web_root(app: &tauri::AppHandle<crate::Runtime>) -> Result<PathBuf, String> {
    if let Ok(named) = std::env::var("BOWERBIRD_WEB") {
        return Ok(PathBuf::from(named));
    }
    app.path()
        .resource_dir()
        .map(|dir| dir.join("web"))
        .map_err(|err| format!("could not locate the app's resources: {err}"))
}

/// `SIGN_IN_PARAM` in `src/api/require_token.ts`.
const SIGN_IN_PARAM: &str = "token";

/// Where the catalogue, the renditions and the backups live.
fn data_dir(app: &tauri::AppHandle<crate::Runtime>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("could not locate the app's data directory: {err}"))
}

fn library_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "librawshim.dylib"
    } else if cfg!(windows) {
        "rawshim.dll"
    } else {
        "librawshim.so"
    }
}

/// Starts the server and waits for it to answer, or explains why it could not, and returns the
/// address that signs the page in.
///
/// Blocking on purpose. Everything the page can ask for needs the server, so there is
/// nothing useful to show until it is up; a window that paints and then fails every
/// request looks broken in a way that "starting" does not.
pub(crate) fn start(app: &tauri::AppHandle<crate::Runtime>) -> Result<tauri::Url, String> {
    let sidecar = sidecar_path().map_err(|err| format!("could not locate the server: {err}"))?;
    if !sidecar.exists() {
        return Err(format!(
            "this build carries no server at {}. Run `bun run build:sidecar` before packaging.",
            sidecar.display()
        ));
    }
    let resources = resource_root(app)?;
    let bundle = resources.join("server").join("index.js");
    let workers = resources.join("server");
    // In a directory of its own, with every library it needs: what finds those is a relative
    // search path on the library itself, so they have to be siblings.
    let native = resources.join("native").join(library_name());
    if !bundle.exists() {
        return Err(format!(
            "this build carries no server bundle at {}. Run `bun run build:sidecar` before packaging.",
            bundle.display()
        ));
    }
    let data = data_dir(app)?;
    std::fs::create_dir_all(&data).map_err(|err| format!("could not make {}: {err}", data.display()))?;

    let port = free_port().map_err(|err| format!("no port to start the server on: {err}"))?;
    let token = fresh_token()?;
    let mut command = Command::new(&sidecar);
    if let Some(updates) = crate::update::home(app) {
        command.env("BOWERBIRD_UPDATES", updates);
    }
    if cfg!(desktop) {
        command.env("WEB_DIST", web_root(app)?);
    }
    let child = command
        .arg(&bundle)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        // Env, not an argument: any user on the machine can read another's argv.
        .env("BOWERBIRD_API_TOKEN", &token)
        .env("DB_PATH", data.join("bowerbird.db"))
        .env("DATA_DIR", data.join("data"))
        .env("BOWERBIRD_WORKER_DIR", &workers)
        .env("BOWERBIRD_NATIVE_LIB", &native)
        .env("BOWERBIRD_REFERENCE_FRAME", data.join("reference_frame.ARW"))
        // Inherited so the server's own log lands wherever the app's does, which is
        // the only account of what went wrong when it will not start.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|err| format!("could not start the server at {}: {err}", sidecar.display()))?;

    let origin = format!("http://127.0.0.1:{port}");
    if let Ok(mut held) = RUNNING.lock() {
        *held = Some(child);
    }
    watch_for_update(app.clone());
    wait_until_answering(&origin)?;
    eprintln!("[bowerbird] serving this library locally on {origin}");
    let mut signed_in = tauri::Url::parse(&origin).map_err(|err| format!("{origin} is not an address: {err}"))?;
    signed_in.query_pairs_mut().append_pair(SIGN_IN_PARAM, &token);
    if let Ok(mut held) = LOCAL.lock() {
        *held = Some(Local { origin, token });
    }
    Ok(signed_in)
}

/// Hands the app to the updater once the server has staged an update and exited.
///
/// Polled rather than waited on, because `stop()` needs the same `Child` to kill it and
/// only one of them can own it. Half a second is nothing against an update that has just
/// downloaded a hundred megabytes, and the thread ends with the server it is watching.
fn watch_for_update(app: tauri::AppHandle<crate::Runtime>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let Ok(mut held) = RUNNING.lock() else { return };
        // Read out of the guard before it is written to: `try_wait` borrows the child,
        // and clearing the slot while that borrow is alive does not compile.
        let outcome = match held.as_mut() {
            Some(child) => child.try_wait(),
            None => return,
        };
        match outcome {
            Ok(Some(status)) => {
                let staged = status.code() == Some(crate::update::STAGED);
                *held = None;
                drop(held);
                if !staged {
                    return;
                }
                match crate::update::hand_over(&app) {
                    Ok(()) => app.exit(0),
                    Err(why) => {
                        eprintln!("[bowerbird] {why}");
                        // Without its server this window can do nothing, so it starts over rather than stay.
                        app.restart();
                    }
                }
                return;
            }
            Ok(None) => drop(held),
            Err(_) => return,
        }
    });
}

/// Waits for the port to accept a connection.
///
/// A TCP connect rather than a request, because that is the whole of what is being
/// asked here - the server binds its port once it is ready to answer, and a client
/// would drag `reqwest`'s blocking feature (and a second Tokio runtime) into a
/// startup path that needs neither.
fn wait_until_answering(origin: &str) -> Result<(), String> {
    let address = origin.trim_start_matches("http://").to_string();
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(&address).is_ok() {
            return Ok(());
        }
        // Long enough not to spin, short enough that a fast start is not held up.
        std::thread::sleep(Duration::from_millis(100));
    }
    stop();
    Err(format!("the server did not answer on {origin} within {READY_TIMEOUT:?}"))
}

/// The folder to offer the reader, or nothing where there would be nothing to open it with -
/// which is what the settings page renders no row at all on.
#[tauri::command]
pub fn app_data_dir(app: tauri::AppHandle<crate::Runtime>) -> Option<String> {
    reachable_data_dir(&app)
}

#[cfg(desktop)]
fn reachable_data_dir(app: &tauri::AppHandle<crate::Runtime>) -> Option<String> {
    data_dir(app).ok().map(|dir| dir.to_string_lossy().into_owned())
}

/// Android's storage is app-private: the folder is real and nothing on the device can open it.
#[cfg(not(desktop))]
fn reachable_data_dir(_app: &tauri::AppHandle<crate::Runtime>) -> Option<String> {
    None
}

/// Opens that folder in the reader's own file manager.
#[tauri::command]
pub fn open_app_data_dir(app: tauri::AppHandle<crate::Runtime>) -> Result<(), String> {
    let dir = data_dir(&app)?;
    // A shell pointed at a hosted library never starts a server, so nothing has made this
    // yet - and a file manager handed a path that is not there opens somewhere else instead.
    std::fs::create_dir_all(&dir).map_err(|err| format!("could not make {}: {err}", dir.display()))?;
    open_folder(&dir).map_err(|err| format!("could not open {}: {err}", dir.display()))
}

pub(crate) fn open_folder(dir: &Path) -> std::io::Result<()> {
    let manager = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    // Spawned, never waited on: the manager lives until the reader closes its window.
    Command::new(manager).arg(dir).spawn().map(|_| ())
}

/// Ends the server, which is the app's to do: nothing else knows it is there.
///
/// A killed process leaves its catalogue exactly as WAL recovery expects to find it,
/// so there is nothing to flush - what matters is that it does not outlive the
/// window and hold the catalogue against the next start.
pub(crate) fn stop() {
    let Ok(mut held) = RUNNING.lock() else { return };
    if let Some(mut child) = held.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::Local;

    #[test]
    fn the_page_signs_in_with_the_parameter_the_server_reads() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/api/require_token.ts");
        let server = std::fs::read_to_string(path).unwrap();
        assert!(server.contains(&format!("SIGN_IN_PARAM = '{}'", super::SIGN_IN_PARAM)));
    }

    #[test]
    fn the_token_goes_only_to_the_local_server() {
        let local = Local { origin: "http://127.0.0.1:1234".into(), token: "secret".into() };
        assert!(local.serves("http://127.0.0.1:1234/api/libraries"));
        assert!(!local.serves("http://127.0.0.1:12345/api/libraries"));
        assert!(!local.serves("http://127.0.0.1:1234.evil.test/api"));
        assert!(!local.serves("https://library.example/api/libraries"));
    }
}
