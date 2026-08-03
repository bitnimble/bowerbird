//! The editor's open, as a Tauri command.
//!
//! The frame comes back as raw bytes rather than JSON: it is tens of megabytes, and Tauri
//! v2 carries a `tauri::ipc::Response` as a binary body rather than base64. The header
//! travels beside it as JSON, exactly as the HTTP route puts it in a response header, so
//! the client has one shape to parse whichever transport it arrived on.

use tauri::ipc::Response;

/// Decodes, prepares, fits the camera match and materialises the lens warp.
///
/// Seconds of work on a thread pool this process owns.
#[tauri::command]
pub async fn prepare_edit(request: String) -> Result<Response, String> {
    // Off the IPC thread: this is LibRaw plus a fit, and holding the invoke handler for a
    // second or two would freeze the webview that is waiting on it.
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let request: rawshim::edit::EditRequest =
            serde_json::from_str(&request).map_err(|e| format!("bad edit request: {e}"))?;
        rawshim::edit::prepare(&request)
    })
    .await
    .map_err(|e| format!("the open panicked: {e}"))??;

    // The same framing `bb_prepare_edit` uses: a u32 header length, the header, the
    // samples. One buffer, so the two cannot describe different frames.
    rawshim::edit::encode(&prepared).map(Response::new)
}
