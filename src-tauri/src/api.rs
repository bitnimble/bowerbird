//! One request contract, two transports - this is the shell's end of it.
//!
//! The page hands every call to `api` rather than to `fetch`, and today every one of them
//! is forwarded to the hosted Bowerbird server. That is deliberately the dull
//! implementation: the point of the seam is that offline mode can answer some commands
//! from a local library later without a single call site above changing, and `Request::cmd`
//! is the name it will match on.
//!
//! The convergence is on HTTP's own shape - a status, some headers, some bytes - because
//! that is what the server already answers with, so the proxy is the identity function and
//! a local handler has an obvious contract to meet.

use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::ipc::Response;

/// What this app remembers for itself, as opposed to what the library remembers.
///
/// Only the server address so far, and that one cannot live with the library's settings
/// because those are on the far side of it: asking the server where the server is does not
/// work. A JSON object rather than that one string, because the next app-local setting
/// should be a field rather than a second file - `serde` ignores what it does not know, so
/// an older build reading a newer config keeps the fields it understands.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Absent until the reader sets one, which is different from set-to-empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
}

static CONFIG: std::sync::RwLock<Option<Config>> = std::sync::RwLock::new(None);

const DEFAULT_ORIGIN: &str = "http://127.0.0.1:3000";

/// `BOWERBIRD_SERVER` wins, so a test run does not disturb what the reader saved.
fn origin() -> String {
    if let Ok(from_env) = std::env::var("BOWERBIRD_SERVER") {
        return from_env;
    }
    CONFIG
        .read()
        .ok()
        .and_then(|held| held.as_ref().and_then(|c| c.server.clone()))
        .unwrap_or_else(|| DEFAULT_ORIGIN.into())
}

/// Beside the executable where that is writable, and in the app's config directory
/// otherwise.
///
/// Which makes an unpacked build portable: everything it remembers is in the folder it was
/// unpacked into, so deleting the folder is uninstalling it, and two copies do not fight
/// over one address. That is what a dev build handed to someone should do.
///
/// The fallback is not theoretical - an app installed under `Program Files` or
/// `/Applications` sits somewhere it may not write to, and would otherwise fail to save at
/// all. Decided by trying rather than by a marker file or a permissions check, because on
/// Windows the answer depends on which directory it landed in and on who is running it.
fn config_file(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    if let Some(beside) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("config.json")))
    {
        if writable(&beside) {
            return Some(beside);
        }
    }
    app.path().app_config_dir().ok().map(|dir| dir.join("config.json"))
}

/// Whether this path can be created and written. Leaves the file behind if it already
/// holds something, and removes the one it made if it did not.
fn writable(path: &std::path::Path) -> bool {
    if path.exists() {
        return std::fs::OpenOptions::new().append(true).open(path).is_ok();
    }
    match std::fs::write(path, "") {
        Ok(()) => {
            let _ = std::fs::remove_file(path);
            true
        }
        Err(_) => false,
    }
}

/// Reads the config at startup, so the first request already knows where to go.
///
/// A file that will not parse is treated as one that is not there. It holds preferences
/// rather than anything a reader would grieve, and refusing to start over a stray comma
/// would be the worse failure.
pub fn load_config(app: &tauri::AppHandle) {
    let held = config_file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default();
    if let Ok(mut config) = CONFIG.write() {
        *config = Some(held);
    }
}

/// Writes the whole object back, so a field added later is not dropped by this one.
fn save(app: &tauri::AppHandle, config: &Config) -> Result<(), String> {
    let Some(path) = config_file(app) else { return Ok(()) };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not make {parent:?}: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{text}\n")).map_err(|e| format!("could not save {path:?}: {e}"))
}

/// What the settings screen shows. The effective one, so an env override is visible
/// rather than silently disagreeing with what the reader saved.
#[tauri::command]
pub fn server_origin() -> String {
    origin()
}

/// Trailing slashes trimmed, because every path this is joined to starts with one and
/// `//api` is a different route to the server that answers it.
#[tauri::command]
pub fn set_server_origin(app: tauri::AppHandle, value: String) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/').to_string();
    let server = if trimmed.is_empty() { None } else { Some(trimmed) };

    {
        let mut held = CONFIG.write().map_err(|_| "the config is locked".to_string())?;
        // Saved before it is adopted, so a write that fails leaves the running app and the
        // file still agreeing on the old address rather than disagreeing until a restart.
        let mut next = (*held).clone().unwrap_or_default();
        next.server = server;
        save(&app, &next)?;
        *held = Some(next);
    }
    // Outside the guard: `origin` takes the read lock, and this one is not reentrant.
    Ok(origin())
}

/// One client for the process, because a client is a connection pool.
///
/// A grid is a hundred thumbnails at once; building a pool per request means a hundred TCP
/// handshakes, and a hundred TLS ones against a remote library.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    /// What the caller asked for, by name. The seam a locally-answered command dispatches
    /// on, which `get:prepared` already does.
    cmd: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
pub struct Head {
    pub status: u16,
    pub headers: HashMap<String, String>,
}

/// What a command answered with, framed for the page. Shared with `edit`, which builds a
/// reply rather than forwarding one.
pub fn reply(status: u16, headers: HashMap<String, String>, body: &[u8]) -> Vec<u8> {
    frame(&Head { status, headers }, body)
}

/// A GET against the library, for a command answering locally off its bytes.
pub async fn get(path: &str) -> Result<Vec<u8>, String> {
    let url = format!("{}{}", origin(), path);
    let reply = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;
    if !reply.status().is_success() {
        return Err(format!("{url} answered {}", reply.status()));
    }
    Ok(reply
        .bytes()
        .await
        .map_err(|e| format!("{url} stopped mid-reply: {e}"))?
        .to_vec())
}

/// Forwards a request and frames the reply.
///
/// Off the IPC thread: an editor open is seconds of decoding on the far side and hundreds
/// of megabytes back, and holding the invoke handler for it would freeze the webview that
/// is waiting on it.
#[tauri::command]
pub async fn api(request: String) -> Result<Response, String> {
    let request: Request =
        serde_json::from_str(&request).map_err(|e| format!("bad request: {e}"))?;

    // The first command this shell answers itself rather than forwarding, and the seam
    // `cmd` was carried for. Everything else still proxies.
    if request.cmd == "get:prepared" {
        return crate::edit::prepared(&request.path).await.map(Response::new);
    }

    let url = format!("{}{}", origin(), request.path);
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| format!("bad method {}: {e}", request.method))?;

    let mut send = client().request(method, &url);
    if let Some(body) = request.body {
        send = send.header("content-type", "application/json").json(&body);
    }
    let reply = send
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    let status = reply.status().as_u16();
    // Lower-cased, because the page reads them by name and `reqwest` preserves whatever
    // casing the server chose.
    let headers = reply
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect();
    let body = reply
        .bytes()
        .await
        .map_err(|e| format!("{url} answered {status} and then stopped: {e}"))?;

    Ok(Response::new(frame(&Head { status, headers }, &body)))
}

/// A `u32` length, that much JSON, then the body.
///
/// Tauri carries a `Response` as a binary body rather than as base64, which is what makes
/// an open of several hundred megabytes viable over IPC at all - but a binary body is all
/// it carries, so the status and headers travel in front of it.
///
/// The JSON is padded with spaces to a multiple of four, which JSON ignores and the reader
/// depends on: it puts the body at a four-byte offset, so the page can take a *view* over
/// those bytes rather than copying them. At 61MP that is the difference between one 361MB
/// array and three.
fn frame(head: &Head, body: &[u8]) -> Vec<u8> {
    let mut json =
        serde_json::to_vec(head).unwrap_or_else(|_| b"{\"status\":500,\"headers\":{}}".to_vec());
    json.resize(json.len().next_multiple_of(4), b' ');

    let mut out = Vec::with_capacity(4 + json.len() + body.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(body);
    out
}

/// The same proxy for what the browser loads itself.
///
/// An `<img>` or an `EventSource` fetches its own bytes and cannot go through a command,
/// so those URLs carry this scheme instead and land here with the same path the API
/// serves. Registered rather than left to `http://` so the page holds no origin, and the
/// shell stays the one thing that knows where the library is.
///
/// Asynchronous, and that is not a detail: the synchronous form runs on the thread that
/// draws, so a grid of thumbnails would freeze the window for as long as the library took
/// to answer - which for a remote one is the whole point of the app being responsive.
pub fn asset(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let path = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let url = format!("{}{}", origin(), path);

    tauri::async_runtime::spawn(async move {
        responder.respond(match fetch(&url).await {
            Ok((status, kind, body)) => tauri::http::Response::builder()
                .status(status)
                .header("content-type", kind)
                .body(body)
                .unwrap_or_else(|_| bad_gateway("the reply could not be built")),
            Err(e) => bad_gateway(&format!("could not reach {url}: {e}")),
        });
    });
}

async fn fetch(url: &str) -> Result<(u16, String, Vec<u8>), reqwest::Error> {
    let reply = client().get(url).send().await?;
    let status = reply.status().as_u16();
    let kind = reply
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    Ok((status, kind, reply.bytes().await?.to_vec()))
}

fn bad_gateway(why: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(502)
        .header("content-type", "text/plain")
        .body(why.as_bytes().to_vec())
        .expect("a 502 with a literal body always builds")
}
