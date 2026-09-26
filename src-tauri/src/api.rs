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
/// The server address cannot live with the library's settings because those are on the far
/// side of it: asking the server where the server is does not work. The interface scale is
/// this window's, applied before the page has loaded anything to ask. One JSON object, and
/// `serde` ignores what it does not know, so an older build reading a newer config keeps the
/// fields it understands.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Absent until the reader sets one, which is different from set-to-empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_scale: Option<f64>,
}

static CONFIG: std::sync::RwLock<Option<Config>> = std::sync::RwLock::new(None);

const DEFAULT_ORIGIN: &str = "http://127.0.0.1:3000";

/// A server the reader (or a test run) has named, as opposed to the one this app runs.
///
/// `BOWERBIRD_SERVER` wins, so a test run does not disturb what the reader saved.
pub(crate) fn configured_origin() -> Option<String> {
    if let Ok(from_env) = std::env::var("BOWERBIRD_SERVER") {
        return Some(from_env);
    }
    CONFIG
        .read()
        .ok()
        .and_then(|held| held.as_ref().and_then(|c| c.server.clone()))
}

/// Where the page's requests go.
///
/// A named server first, then the one this app started for itself. The fallback
/// below is what a development run reaches, where the reader is running a server by
/// hand on the usual port and this app carries none.
pub(crate) fn origin() -> String {
    configured_origin()
        .or_else(crate::server::local_origin)
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
fn config_file(app: &tauri::AppHandle<crate::Runtime>) -> Option<std::path::PathBuf> {
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
pub fn load_config(app: &tauri::AppHandle<crate::Runtime>) {
    let held = config_file(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default();
    if let Ok(mut config) = CONFIG.write() {
        *config = Some(held);
    }
}

/// Saved before it is adopted, so a write that fails leaves the running app and the file
/// still agreeing on the old value rather than disagreeing until a restart.
fn update(app: &tauri::AppHandle<crate::Runtime>, change: impl FnOnce(&mut Config)) -> Result<(), String> {
    let mut held = CONFIG.write().map_err(|_| "the config is locked".to_string())?;
    let mut next = (*held).clone().unwrap_or_default();
    change(&mut next);
    save(app, &next)?;
    *held = Some(next);
    Ok(())
}

/// Writes the whole object back, so a field added later is not dropped by this one.
fn save(app: &tauri::AppHandle<crate::Runtime>, config: &Config) -> Result<(), String> {
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
pub fn set_server_origin(
    app: tauri::AppHandle<crate::Runtime>,
    value: String,
) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/').to_string();
    let server = if trimmed.is_empty() { None } else { Some(trimmed) };
    update(&app, |config| config.server = server)?;
    // The event stream is following the old address and will not notice on its own: it
    // re-reads the origin only when a connection ends, and a server that is still running
    // never ends one.
    crate::events::address_changed();
    Ok(origin())
}

const UI_SCALES: std::ops::RangeInclusive<f64> = 0.5..=2.0;

#[tauri::command]
pub fn ui_scale() -> f64 {
    CONFIG
        .read()
        .ok()
        .and_then(|held| held.as_ref().and_then(|c| c.ui_scale))
        .unwrap_or(1.0)
}

#[tauri::command]
pub fn set_ui_scale(app: tauri::AppHandle<crate::Runtime>, value: f64) -> Result<(), String> {
    if !UI_SCALES.contains(&value) {
        return Err(format!("an interface scale of {value} is outside {UI_SCALES:?}"));
    }
    update(&app, |config| config.ui_scale = Some(value))?;
    apply_ui_scale(&app)
}

pub fn apply_ui_scale(app: &tauri::AppHandle<crate::Runtime>) -> Result<(), String> {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else { return Ok(()) };
    window.set_zoom(ui_scale()).map_err(|e| format!("could not scale the window: {e}"))
}

/// Every request the shell makes, so none reaches the local server without its token.
pub(crate) fn request(method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
    let send = client().request(method, url);
    match crate::server::token_for(url) {
        Some(token) => send.bearer_auth(token),
        None => send,
    }
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
    /// What the caller asked for, by name. Unused while everything proxies; carried
    /// because it is the seam a local handler dispatches on.
    #[allow(dead_code)]
    cmd: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    activity: Option<RequestActivity>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum RequestActivity {
    Interactive,
    Background,
}

impl Request {
    fn into_http(self, url: &str) -> Result<reqwest::RequestBuilder, String> {
        let method = reqwest::Method::from_bytes(self.method.as_bytes())
            .map_err(|e| format!("bad method {}: {e}", self.method))?;
        let mut send = request(method, url);
        if let Some(activity) = self.activity {
            send = send.header("X-Bowerbird-Activity", match activity {
                RequestActivity::Interactive => "interactive",
                RequestActivity::Background => "background",
            });
        }
        if let Some(body) = self.body {
            send = send.json(&body);
        }
        Ok(send)
    }
}

#[derive(serde::Serialize)]
struct Head {
    status: u16,
    headers: HashMap<String, String>,
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

    let url = format!("{}{}", origin(), request.path);
    let reply = request.into_http(&url)?
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
/// An `<img>` or a download fetches its own bytes and cannot go through a command, so those
/// URLs carry this scheme instead and land here with the same path the API serves.
/// Registered rather than left to `http://` so the page holds no origin, and the shell stays
/// the one thing that knows where the library is.
///
/// Not the event stream, which cannot be answered this way at all and is `events.rs`.
///
/// Asynchronous, and that is not a detail: the synchronous form runs on the thread that
/// draws, so a grid of thumbnails would freeze the window for as long as the library took
/// to answer - which for a remote one is the whole point of the app being responsive.
pub fn asset(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let cors_origin = asset_cors_origin(request.headers()).map(str::to_owned);
    if let Some(reply) = asset_preflight(request.method(), cors_origin.as_deref()) {
        responder.respond(reply);
        return;
    }
    let path = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let url = format!("{}{}", origin(), path);

    // Whatever the page sent, so a conditional request stays conditional and a range stays a
    // range. An `<img>` revalidating sends `If-None-Match` and the viewer's seek sends
    // `Range`; dropping them turned every one into a plain GET.
    let forwarded = asset_headers(request.headers());

    tauri::async_runtime::spawn(async move {
        let response = match fetch(&url, &forwarded).await {
            Ok(reply) => {
                let mut built = tauri::http::Response::builder().status(reply.status);
                for (name, value) in &reply.headers {
                    built = built.header(name, value);
                }
                built
                    .body(reply.body)
                    .unwrap_or_else(|_| bad_gateway("the reply could not be built"))
            }
            Err(e) => bad_gateway(&format!("could not reach {url}: {e}")),
        };
        responder.respond(with_asset_cors(response, cors_origin.as_deref()));
    });
}

fn asset_preflight(
    method: &tauri::http::Method,
    origin: Option<&str>,
) -> Option<tauri::http::Response<Vec<u8>>> {
    if method != tauri::http::Method::OPTIONS {
        return None;
    }
    let response = tauri::http::Response::builder()
        .status(204)
        .header("access-control-allow-methods", "GET, OPTIONS")
        .header("access-control-allow-headers", FORWARDED_TO_LIBRARY.join(", "))
        .body(Vec::new())
        .expect("fixed preflight headers are valid");
    Some(with_asset_cors(response, origin))
}

fn asset_cors_origin(headers: &tauri::http::HeaderMap) -> Option<&str> {
    let origin = headers.get("origin")?.to_str().ok()?;
    WEBVIEW_ORIGINS.contains(&origin).then_some(origin)
}

fn with_asset_cors(
    mut response: tauri::http::Response<Vec<u8>>,
    origin: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    if let Some(origin) = origin {
        response.headers_mut().insert(
            "access-control-allow-origin",
            origin.parse().expect("trusted webview origins are valid headers"),
        );
        response.headers_mut().insert("vary", tauri::http::HeaderValue::from_static("Origin"));
    }
    response
}

fn asset_headers(headers: &tauri::http::HeaderMap) -> Vec<(String, String)> {
    headers.iter()
        .filter(|(name, _)| FORWARDED_TO_LIBRARY.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

/// What a reply has to keep for the element that asked for it to behave.
///
/// `content-type` so it is decoded as what it is; `content-disposition` so a download saves
/// under the library's name rather than navigating the window to bytes; `etag` and
/// `last-modified` and `cache-control` so a rendition rebuilt behind a stable URL is
/// re-fetched and one that was not is left alone; the range trio so the viewer can seek.
///
/// Not `content-length`: the body handed on is the one this decoded, and a length copied
/// from the reply that produced it is a claim about different bytes.
const KEPT_FROM_LIBRARY: [&str; 7] = [
    "content-type",
    "content-disposition",
    "cache-control",
    "etag",
    "last-modified",
    "accept-ranges",
    "content-range",
];

/// And what the page's own request has to carry through for those to mean anything.
const FORWARDED_TO_LIBRARY: [&str; 6] =
    ["accept", "range", "if-none-match", "if-modified-since", "cache-control", "x-bowerbird-activity"];
const WEBVIEW_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "tauri://localhost",
    "http://localhost:5199",
];

struct Fetched {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn fetch(url: &str, forwarded: &[(String, String)]) -> Result<Fetched, reqwest::Error> {
    let mut send = request(reqwest::Method::GET, url);
    for (name, value) in forwarded {
        send = send.header(name, value);
    }
    let reply = send.send().await?;

    // A stream cannot come back this way, so say so rather than wait for it forever.
    //
    // `UriSchemeResponder` takes a whole `Response<Vec<u8>>`, so the only way to answer is to
    // read the body to its end, and a stream has none. Nothing in the app asks for one here
    // any more - `events.rs` holds the library's stream and forwards it over IPC - so this
    // is a backstop for the next URL somebody routes through the scheme without noticing
    // what it serves. Left in because the failure it replaces was silence: the task, its
    // connection and the page's `EventSource` sat in CONNECTING for the life of the process
    // without ever erroring, so nothing anywhere reported it.
    if reply
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|kind| kind.starts_with("text/event-stream"))
    {
        return Ok(Fetched {
            status: 501,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: b"the desktop shell cannot proxy an event stream".to_vec(),
        });
    }

    let status = reply.status().as_u16();
    let mut headers: Vec<(String, String)> = reply
        .headers()
        .iter()
        .filter(|(name, _)| KEPT_FROM_LIBRARY.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            value.to_str().ok().map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();
    if !headers.iter().any(|(name, _)| name == "content-type") {
        headers.push(("content-type".to_string(), "application/octet-stream".to_string()));
    }
    Ok(Fetched { status, headers, body: reply.bytes().await?.to_vec() })
}

fn bad_gateway(why: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(502)
        .header("content-type", "text/plain")
        .body(why.as_bytes().to_vec())
        .expect("a 502 with a literal body always builds")
}

#[cfg(test)]
mod tests {
    use super::{asset_cors_origin, asset_headers, asset_preflight, with_asset_cors, Request};

    #[test]
    fn asset_get_forwards_activity_and_range_without_unrelated_headers() {
        let request = tauri::http::Request::builder()
            .header("X-Bowerbird-Activity", "background")
            .header("Range", "bytes=0-99")
            .header("Cookie", "private=value")
            .body(Vec::<u8>::new()).unwrap();
        let mut forwarded = asset_headers(request.headers());
        forwarded.sort();
        assert_eq!(forwarded, vec![
            ("range".to_string(), "bytes=0-99".to_string()),
            ("x-bowerbird-activity".to_string(), "background".to_string()),
        ]);
    }

    #[test]
    fn asset_activity_preflight_is_answered_without_fetching_a_picture() {
        let request = tauri::http::Request::builder()
            .header("Origin", "http://tauri.localhost")
            .body(Vec::<u8>::new()).unwrap();
        let origin = asset_cors_origin(request.headers());
        let response = asset_preflight(&tauri::http::Method::OPTIONS, origin);
        assert_eq!(response.as_ref().map(|reply| reply.status().as_u16()), Some(204));
        let response = response.unwrap();
        assert_eq!(response.headers()["access-control-allow-origin"], "http://tauri.localhost");
        assert_eq!(response.headers()["vary"], "Origin");
        assert_eq!(response.headers()["access-control-allow-methods"], "GET, OPTIONS");
        let allowed = response.headers()["access-control-allow-headers"].to_str().unwrap();
        for header in ["x-bowerbird-activity", "range", "if-none-match", "cache-control"] {
            assert!(allowed.split(", ").any(|value| value == header));
        }
        assert!(response.body().is_empty());
        assert!(asset_preflight(&tauri::http::Method::GET, origin).is_none());

        let untrusted = tauri::http::Request::builder()
            .header("Origin", "https://attacker.example")
            .body(Vec::<u8>::new()).unwrap();
        let response = asset_preflight(
            &tauri::http::Method::OPTIONS,
            asset_cors_origin(untrusted.headers()),
        ).unwrap();
        assert!(!response.headers().contains_key("access-control-allow-origin"));
    }

    #[test]
    fn asset_get_allows_only_the_requesting_webview_origin() {
        let response = tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
        let response = with_asset_cors(response, Some("tauri://localhost"));
        assert_eq!(response.headers()["access-control-allow-origin"], "tauri://localhost");
        assert_eq!(response.headers()["vary"], "Origin");
    }

    #[test]
    fn proxy_forwards_request_activity_and_body() {
        for activity in ["interactive", "background"] {
            let input = serde_json::json!({
                "cmd": "post:photos/neighbours", "method": "POST", "path": "/api/photos/neighbours",
                "body": { "id": "photo" }, "activity": activity,
            });
            let request: Request = serde_json::from_value(input).unwrap();
            let http = request.into_http("http://localhost/api/photos/neighbours").unwrap().build().unwrap();
            assert_eq!(http.headers().get("X-Bowerbird-Activity").and_then(|value| value.to_str().ok()), Some(activity));
            assert_eq!(http.headers().get("content-type").unwrap(), "application/json");
            assert_eq!(http.body().and_then(|body| body.as_bytes()).unwrap(), b"{\"id\":\"photo\"}");
        }
    }
}
