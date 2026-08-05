//! The editor's open, in this process.
//!
//! The shell fetches the RAW from the library and prepares it here rather than asking the
//! library to prepare it, and the reason is the wire: a 61MP RAW is tens of megabytes
//! compressed, where the frame it decodes to is 361. Sending the smaller of the two and
//! doing the work locally is the whole point of there being a desktop build.
//!
//! It answers as `GET /image/:id/prepared` would have - a status, and a body of the frame's
//! own JSON followed by its samples - because that is the contract the page already reads,
//! and the browser still gets its copy the other way.

use std::collections::HashMap;

/// `GET /image/:id/prepared`, answered here.
///
/// Off the IPC thread: this is LibRaw plus a camera fit plus a denoise, which is seconds,
/// and holding the invoke handler for it would freeze the webview waiting on it.
pub async fn prepared(path: &str) -> Result<Vec<u8>, String> {
    let (photo_id, long_edge) = parse(path)?;

    // Before the download rather than around the decode alone.
    //
    // `edit::prepare_bytes` already admits one open at a time, so the decodes could not pile
    // up - but an invoke cannot be cancelled, so a reader who opens the editor and changes
    // their mind leaves this running, and everything above that lock still ran. Ten of those
    // is ten RAWs pulled off the library and held, tens of megabytes each, waiting for a turn
    // to be decoded that the reader stopped wanting several photographs ago.
    //
    // Held across the fetch, so a queued open is a parked task holding nothing.
    static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _open = ONE_AT_A_TIME.lock().await;

    // The RAW and the library's grade settings, both from the server. Sequentially rather
    // than joined: the settings are a few hundred bytes and the RAW is tens of megabytes,
    // so overlapping them saves nothing and doubles what is held at once on a failure.
    let settings = crate::api::get("/api/settings").await?;
    let settings: serde_json::Value =
        serde_json::from_slice(&settings).map_err(|e| format!("bad settings: {e}"))?;
    let raw = crate::api::get(&format!("/image/{photo_id}/download/original")).await?;

    let request = rawshim::edit::EditRequest {
        // Not read: `prepare_bytes` has the file already. Named for the error messages the
        // path-taking form produces, which nothing here can produce.
        raw_file_path: String::new(),
        long_edge,
        grade: rawshim::hdr::Grade {
            peak_nits: number(&settings, "hdr_peak_nits")?,
            reference_white_nits: number(&settings, "hdr_reference_white_nits")?,
            white_quantile: number(&settings, "hdr_white_quantile")?,
        },
        strengths: rawshim::image::Strengths {
            luma: number(&settings, "raw_denoise_luma")?,
            chroma: number(&settings, "raw_denoise_chroma")?,
            sharpen: number(&settings, "raw_sharpen")?,
            defringe: number(&settings, "raw_defringe")?,
        },
    };

    let prepared = tauri::async_runtime::spawn_blocking(move || {
        rawshim::edit::prepare_bytes(&raw, &request)
    })
    .await
    .map_err(|e| format!("the open panicked: {e}"))??;

    // The same `encode` the HTTP route's frame comes out of, rather than a second copy of
    // the framing here: the page has one reader for both transports, and two writers of a
    // padded length prefix is how they drift apart.
    let bytes = rawshim::edit::encode(&prepared)?;
    Ok(crate::api::reply(200, HashMap::new(), &bytes))
}

/// `/image/<id>/prepared?longEdge=<n>`.
fn parse(path: &str) -> Result<(String, u32), String> {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    let photo_id = route
        .strip_prefix("/image/")
        .and_then(|rest| rest.strip_suffix("/prepared"))
        .ok_or_else(|| format!("not a prepared path: {path}"))?;

    let long_edge = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("longEdge="))
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    Ok((photo_id.to_string(), long_edge))
}

/// One setting, or a failed open.
///
/// No fallback, deliberately. There were seven, and three of them had drifted from the
/// schema that resolves these - `raw_denoise_luma` 1.0 against 0.5, `raw_sharpen` 1.0
/// against 0.6, `hdr_white_quantile` 0.995 against 0.9 - so the shell and the library
/// could grade the same photograph differently and nothing would say so. `/api/settings`
/// answers with every value already resolved, so a key missing here is a version
/// disagreement worth reporting rather than a number worth guessing.
fn number(settings: &serde_json::Value, key: &str) -> Result<f64, String> {
    settings
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| format!("the library's settings carry no {key}"))
}
