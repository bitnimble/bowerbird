//! The editor's open, in this process.
//!
//! The shell fetches the RAW from the library and prepares it here rather than asking the
//! library to prepare it, and the reason is the wire: a 61MP RAW is tens of megabytes
//! compressed, where the frame it decodes to is 361. Sending the smaller of the two and
//! doing the work locally is the whole point of there being a desktop build.
//!
//! It answers as `GET /image/:id/prepared` would have - a status, an `X-Prepared` header
//! and the samples - because that is the contract the page already reads, and the browser
//! still gets its copy the other way.

use std::collections::HashMap;

/// `GET /image/:id/prepared`, answered here.
///
/// Off the IPC thread: this is LibRaw plus a camera fit plus a denoise, which is seconds,
/// and holding the invoke handler for it would freeze the webview waiting on it.
pub async fn prepared(path: &str) -> Result<Vec<u8>, String> {
    let (photo_id, long_edge) = parse(path)?;

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
            peak_nits: number(&settings, "hdr_peak_nits", 1000.0),
            reference_white_nits: number(&settings, "hdr_reference_white_nits", 203.0),
            white_quantile: number(&settings, "hdr_white_quantile", 0.995),
        },
        strengths: rawshim::image::Strengths {
            luma: number(&settings, "raw_denoise_luma", 1.0),
            chroma: number(&settings, "raw_denoise_chroma", 1.0),
            sharpen: number(&settings, "raw_sharpen", 1.0),
            defringe: number(&settings, "raw_defringe", 1.0),
        },
    };

    let prepared = tauri::async_runtime::spawn_blocking(move || {
        rawshim::edit::prepare_bytes(&raw, &request)
    })
    .await
    .map_err(|e| format!("the open panicked: {e}"))??;

    let header = serde_json::to_string(&prepared.header).map_err(|e| e.to_string())?;
    let mut headers = HashMap::new();
    headers.insert("x-prepared".to_string(), header);

    // The samples as they sit, little-endian, which is what the page maps a `Uint16Array`
    // over. Every target this ships to is little-endian; a big-endian one would need this
    // swapped, and would have the same problem with the HTTP route.
    let mut bytes = Vec::with_capacity(prepared.samples.len() * 2);
    for sample in &prepared.samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(crate::api::reply(200, headers, &bytes))
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

fn number(settings: &serde_json::Value, key: &str, fallback: f64) -> f64 {
    settings.get(key).and_then(|v| v.as_f64()).unwrap_or(fallback)
}
