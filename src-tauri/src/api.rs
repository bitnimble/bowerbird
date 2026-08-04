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
use tauri::ipc::Response;

/// Where the library lives. One env var rather than a setting, because the shell has to
/// know it before it can ask anything for a setting.
fn origin() -> String {
    std::env::var("BOWERBIRD_SERVER").unwrap_or_else(|_| "http://127.0.0.1:3000".into())
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
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| format!("bad method {}: {e}", request.method))?;

    let mut send = reqwest::Client::new().request(method, &url);
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
fn frame(head: &Head, body: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(head).unwrap_or_else(|_| b"{\"status\":500,\"headers\":{}}".to_vec());
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
pub fn asset(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let path = request
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let url = format!("{}{}", origin(), path);

    let fetched = tauri::async_runtime::block_on(async {
        let reply = reqwest::Client::new().get(&url).send().await?;
        let status = reply.status();
        let kind = reply
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        Ok::<_, reqwest::Error>((status, kind, reply.bytes().await?))
    });

    match fetched {
        Ok((status, kind, body)) => tauri::http::Response::builder()
            .status(status)
            .header("content-type", kind)
            .body(body.to_vec())
            .unwrap_or_else(|_| bad_gateway("the reply could not be built")),
        Err(e) => bad_gateway(&format!("could not reach {url}: {e}")),
    }
}

fn bad_gateway(why: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(502)
        .header("content-type", "text/plain")
        .body(why.as_bytes().to_vec())
        .expect("a 502 with a literal body always builds")
}
