//! The Bowerbird server this app carries, and its life.
//!
//! Two things travel beside the executable and neither can be inside it. The server
//! is a bundle run by the Bun runtime, because a compiled single file cannot start a
//! worker and this one reads every RAW header on one. The native library is a shared
//! object opened by `dlopen`. Both are found here and handed over by environment,
//! rather than guessed at by the server, because a packaged app has no source tree to
//! sit beside.

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
    fn sign_in(&self, url: &tauri::Url) -> Option<tauri::Url> {
        if !self.serves(url.as_str()) {
            return None;
        }
        let mut signed_in = url.clone();
        signed_in
            .query_pairs_mut()
            .clear()
            .extend_pairs(url.query_pairs().filter(|(name, _)| name != SIGN_IN_PARAM))
            .append_pair(SIGN_IN_PARAM, &self.token);
        Some(signed_in)
    }

    fn serves(&self, url: &str) -> bool {
        url.strip_prefix(&self.origin)
            .is_some_and(|path| path.starts_with('/'))
    }
}

/// A request the shell makes of the local server, signed in.
pub(crate) fn request(
    method: reqwest::Method,
    path: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let held = LOCAL
        .lock()
        .map_err(|_| "the local server's address is locked".to_string())?;
    let local = held.as_ref().ok_or("the local server is not running")?;
    Ok(client()
        .request(method, format!("{}{path}", local.origin))
        .bearer_auth(&local.token))
}

/// One client for the process, because a client is a connection pool.
fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn recover(webview: &tauri::Webview<crate::Runtime>) {
    if webview.label() != "main" {
        return;
    }
    crate::app_log::warn("web content process terminated; restoring the page");
    let current = webview.url().ok();
    let signed_in = LOCAL.lock().ok().and_then(|held| {
        let local = held.as_ref()?;
        let current = current.or_else(|| tauri::Url::parse(&local.origin).ok())?;
        local.sign_in(&current)
    });
    let Some(signed_in) = signed_in else {
        crate::app_log::error("could not sign the page in after its content process terminated");
        return;
    };
    if webview.navigate(signed_in).is_err() {
        crate::app_log::error("could not restore the page after its content process terminated");
    }
}

fn fresh_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|err| format!("no randomness for the server's token: {err}"))?;
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

/// Where everything the server is made of landed.
struct Layout {
    runtime: PathBuf,
    /// The bundle's directory, which every worker is a file in.
    server: PathBuf,
    native: PathBuf,
    web: PathBuf,
}

#[cfg(desktop)]
fn layout(app: &tauri::AppHandle<crate::Runtime>, _data: &Path) -> Result<Layout, String> {
    let resources = resource_root(app)?;
    Ok(Layout {
        runtime: sidecar_path().map_err(|err| format!("could not locate the server: {err}"))?,
        server: resources.join("server"),
        // In a directory of its own, with every library it needs: what finds those is a relative
        // search path on the library itself, so they have to be siblings.
        native: resources.join("native").join(library_name()),
        web: web_root(app)?,
    })
}

/// Android executes only what its package installer unpacked, so the runtime and every native
/// library ship as `jniLibs` beside this one, and the bundle and the page, which are only read,
/// are unpacked from the app's assets.
#[cfg(target_os = "android")]
fn layout(app: &tauri::AppHandle<crate::Runtime>, data: &Path) -> Result<Layout, String> {
    let native = crate::android::native_dir()?;
    let payload = crate::android::unpacked(app, &data.join("payload"))?;
    Ok(Layout {
        runtime: native.join(crate::android::RUNTIME),
        server: payload.join("server"),
        native: native.join(library_name()),
        web: payload.join("web"),
    })
}

/// Where Tauri put a sidecar: beside the executable, with the target triple gone.
///
/// `BOWERBIRD_SIDECAR` overrides it, because that copying only happens for a
/// packaged build - a run straight out of `target/` has no server beside it, and
/// pointing at one is how the desktop app is exercised without bundling it first.
#[cfg(desktop)]
fn sidecar_path() -> std::io::Result<PathBuf> {
    if let Ok(named) = std::env::var("BOWERBIRD_SIDECAR") {
        return Ok(PathBuf::from(named));
    }
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "the executable has no directory",
        )
    })?;
    let name = if cfg!(windows) {
        "bowerbird-server.exe"
    } else {
        "bowerbird-server"
    };
    Ok(dir.join(name))
}

/// Where the bundle and the native library landed, on the same terms.
#[cfg(desktop)]
fn resource_root(app: &tauri::AppHandle<crate::Runtime>) -> Result<PathBuf, String> {
    if let Ok(named) = std::env::var("BOWERBIRD_RESOURCES") {
        return Ok(PathBuf::from(named));
    }
    bundled(app, "resources")
}

/// The page the server serves, on the same terms: `BOWERBIRD_WEB` for a run out of `target/`.
#[cfg(desktop)]
fn web_root(app: &tauri::AppHandle<crate::Runtime>) -> Result<PathBuf, String> {
    if let Ok(named) = std::env::var("BOWERBIRD_WEB") {
        return Ok(PathBuf::from(named));
    }
    bundled(app, "web")
}

#[cfg(desktop)]
fn bundled(app: &tauri::AppHandle<crate::Runtime>, name: &str) -> Result<PathBuf, String> {
    app.path()
        .resource_dir()
        .map(|dir| without_verbatim_prefix(dir).join(name))
        .map_err(|err| format!("could not locate the app's resources: {err}"))
}

/// Tauri canonicalises the resource directory, which on Windows yields `\\?\C:\...`, and Bun's
/// resolver cannot open a worker at such a path: every worker fails with `Module not found`.
#[cfg(desktop)]
fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|p| p.strip_prefix(r"\\?\")) {
        Some(disk) if disk.as_bytes().get(1) == Some(&b':') => PathBuf::from(disk),
        _ => path,
    }
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
    // A second start in one process would otherwise leave the first server holding the catalogue.
    stop();
    let data = data_dir(app)?;
    std::fs::create_dir_all(&data)
        .map_err(|err| format!("could not make {}: {err}", data.display()))?;
    let layout = layout(app, &data)?;
    if !layout.runtime.exists() {
        return Err(format!(
            "this build carries no server at {}. Run `bun run build:sidecar` before packaging.",
            layout.runtime.display()
        ));
    }
    let bundle = layout.server.join("index.js");
    if !bundle.exists() {
        return Err(format!(
            "this build carries no server bundle at {}. Run `bun run build:sidecar` before packaging.",
            bundle.display()
        ));
    }

    let port = free_port().map_err(|err| format!("no port to start the server on: {err}"))?;
    let token = fresh_token()?;
    let mut command = Command::new(&layout.runtime);
    // A release shell has no console (`windows_subsystem`), so Windows would open one for Bun.
    #[cfg(all(windows, not(debug_assertions)))]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(updates) = crate::update::home(app) {
        command.env("BOWERBIRD_UPDATES", updates);
    }
    #[cfg(mobile)]
    command
        .env("BOWERBIRD_LIBRARIES_DIR", data.join("libraries"))
        .env(
            "BOWERBIRD_DEFAULT_SETTINGS",
            r#"{"disk_space_limit_gb":50,"watch_enabled":false,"full_sync_at":""}"#,
        );
    #[cfg(target_os = "android")]
    crate::android::environment(&mut command, &data)?;
    let child = command
        // Windows' sidecar is a compiled stub carrying our name and icon; without this it runs
        // the stub rather than the bundle (`build-sidecar.ts`).
        .env("BUN_BE_BUN", "1")
        .arg(&bundle)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        // Env, not an argument: any user on the machine can read another's argv.
        .env("BOWERBIRD_API_TOKEN", &token)
        .env("DB_PATH", data.join("bowerbird.db"))
        .env("DATA_DIR", data.join("data"))
        .env("WEB_DIST", &layout.web)
        .env("BOWERBIRD_WORKER_DIR", &layout.server)
        .env("BOWERBIRD_NATIVE_LIB", &layout.native)
        .env(
            "BOWERBIRD_REFERENCE_FRAME",
            data.join("reference_frame.ARW"),
        )
        .stdout(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(server_stderr(&data))
        .spawn()
        .map_err(|err| {
            format!(
                "could not start the server at {}: {err}",
                layout.runtime.display()
            )
        })?;

    let origin = format!("http://127.0.0.1:{port}");
    if let Ok(mut held) = RUNNING.lock() {
        *held = Some(child);
    }
    watch_for_update(app.clone());
    wait_until_answering(&origin)?;
    crate::app_log::info(format!("serving this library locally on {origin}"));
    let root =
        tauri::Url::parse(&origin).map_err(|err| format!("{origin} is not an address: {err}"))?;
    let local = Local { origin, token };
    let signed_in = local
        .sign_in(&root)
        .ok_or("the local server refused its own address")?;
    if let Ok(mut held) = LOCAL.lock() {
        *held = Some(local);
    }
    Ok(signed_in)
}

/// The terminal running a debug build. The server writes its own `server.log`; a shipped app
/// keeps stderr too, the only record of a crash in Bun or the native library.
fn server_stderr(data: &Path) -> Stdio {
    if cfg!(debug_assertions) {
        return Stdio::inherit();
    }
    let log = data.join("server.stderr.log");
    // The crash it records is the previous run's, which the relaunch after it would truncate.
    let _ = std::fs::rename(&log, data.join("server.stderr.log.1"));
    std::fs::File::create(log)
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

/// Hands the app to the updater once the server has staged an update and exited.
///
/// Polled rather than waited on, because `stop()` needs the same `Child` to kill it and
/// only one of them can own it. Half a second is nothing against an update that has just
/// downloaded a hundred megabytes, and the thread ends with the server it is watching.
fn watch_for_update(app: tauri::AppHandle<crate::Runtime>) {
    std::thread::spawn(move || {
        loop {
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
                            crate::app_log::error(why);
                            // Without its server this window can do nothing, so it starts over rather than stay.
                            app.restart();
                        }
                    }
                    return;
                }
                Ok(None) => drop(held),
                Err(_) => return,
            }
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
        if let Some(exited) = exited() {
            stop();
            return Err(format!(
                "the server stopped before it answered ({exited}); its server.stderr.log says why"
            ));
        }
        // Long enough not to spin, short enough that a fast start is not held up.
        std::thread::sleep(Duration::from_millis(100));
    }
    stop();
    Err(format!(
        "the server did not answer on {origin} within {READY_TIMEOUT:?}"
    ))
}

/// How the server ended, if it has; `watch_for_update` may already have taken its exit.
fn exited() -> Option<String> {
    let mut held = RUNNING.lock().ok()?;
    match held.as_mut() {
        None => Some("exited".into()),
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => Some(status.to_string()),
            _ => None,
        },
    }
}

/// The folder to offer the reader, or nothing where there would be nothing to open it with -
/// which is what the settings page renders no row at all on.
#[tauri::command]
pub fn app_data_dir(app: tauri::AppHandle<crate::Runtime>) -> Option<String> {
    reachable_data_dir(&app)
}

#[cfg(desktop)]
fn reachable_data_dir(app: &tauri::AppHandle<crate::Runtime>) -> Option<String> {
    data_dir(app)
        .ok()
        .map(|dir| dir.to_string_lossy().into_owned())
}

/// A mobile app's storage is private: the folder is real and nothing on the device can open it.
#[cfg(not(desktop))]
fn reachable_data_dir(_app: &tauri::AppHandle<crate::Runtime>) -> Option<String> {
    None
}

/// Opens that folder in the reader's own file manager.
#[tauri::command]
pub fn open_app_data_dir(app: tauri::AppHandle<crate::Runtime>) -> Result<(), String> {
    let dir = data_dir(&app)?;
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
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/api/require_token.ts");
        let server = std::fs::read_to_string(path).unwrap();
        assert!(server.contains(&format!("SIGN_IN_PARAM = '{}'", super::SIGN_IN_PARAM)));
    }

    #[test]
    fn workers_get_a_path_bun_can_resolve() {
        use super::without_verbatim_prefix;
        use std::path::PathBuf;
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\C:\Users\me\AppData\Local\Bowerbird")),
            PathBuf::from(r"C:\Users\me\AppData\Local\Bowerbird")
        );
        for untouched in [
            r"\\?\UNC\server\share\Bowerbird",
            r"C:\Program Files\Bowerbird",
            "/Applications/Bowerbird.app/Contents/Resources",
        ] {
            assert_eq!(
                without_verbatim_prefix(PathBuf::from(untouched)),
                PathBuf::from(untouched)
            );
        }
    }

    #[test]
    fn the_token_goes_only_to_the_local_server() {
        let local = Local {
            origin: "http://127.0.0.1:1234".into(),
            token: "secret".into(),
        };
        assert!(local.serves("http://127.0.0.1:1234/api/libraries"));
        assert!(!local.serves("http://127.0.0.1:12345/api/libraries"));
        assert!(!local.serves("http://127.0.0.1:1234.evil.test/api"));
        assert!(!local.serves("https://library.example/api/libraries"));
    }

    #[test]
    fn signing_in_keeps_the_open_photo_and_its_query_and_fragment() {
        let local = Local {
            origin: "http://127.0.0.1:1234".into(),
            token: "secret".into(),
        };
        let here = tauri::Url::parse(
            "http://127.0.0.1:1234/photos/abc12345?from=library&sort=taken_desc#detail",
        )
        .unwrap();
        let signed_in = local.sign_in(&here).unwrap();
        assert_eq!(
            signed_in.as_str(),
            "http://127.0.0.1:1234/photos/abc12345?from=library&sort=taken_desc&token=secret#detail"
        );
        assert_eq!(
            here.as_str(),
            "http://127.0.0.1:1234/photos/abc12345?from=library&sort=taken_desc#detail"
        );
    }

    #[test]
    fn signing_in_replaces_every_token_from_a_previous_attempt() {
        let local = Local {
            origin: "http://127.0.0.1:1234".into(),
            token: "secret".into(),
        };
        let here = tauri::Url::parse("http://127.0.0.1:1234/photos/abc12345?token=expired&sort=taken_desc&token=wrong#detail").unwrap();
        assert_eq!(
            local.sign_in(&here).unwrap().as_str(),
            "http://127.0.0.1:1234/photos/abc12345?sort=taken_desc&token=secret#detail"
        );
    }

    #[test]
    fn signing_in_refuses_every_other_origin() {
        let local = Local {
            origin: "http://127.0.0.1:1234".into(),
            token: "secret".into(),
        };
        for address in [
            "http://127.0.0.1:12345/photos/abc12345",
            "http://127.0.0.1.evil.test:1234/photos/abc12345",
            "https://127.0.0.1:1234/photos/abc12345",
            "https://library.example/photos/abc12345",
            "http://127.0.0.1:1234@evil.test/photos/abc12345",
        ] {
            let here = tauri::Url::parse(address).unwrap();
            assert!(local.sign_in(&here).is_none());
        }
    }
}
