//! What a page calls: a WebGPU device it can share, a decode of bytes it already holds, and the
//! whole open the editor needs in front of its first tick.
//!
//! The exports are independent - a browser with no WebGPU still decodes, on the CPU
//! demosaic `decode_rawler` falls through to (`gpu::device` says why the device is not offered
//! to the decode).
//!
//! Nothing here converts a picture. The frame is left in wasm memory as the `u16` the decode
//! produced and JS reads it in place, because the whole reason to decode in the tab is to not
//! move a frame across a boundary: 366MB at 61MP, and a copy either side of it.

use wasm_bindgen::prelude::*;

/// Opens rawshim's device and hands back the `GPUDevice` behind it.
///
/// **Outbound, because wgpu 30 has no inbound seam** - see [`crate::gpu::page_device`] for why
/// this is the direction rather than taking a device that already exists.
///
/// Nothing shares the device it returns: the module runs in a worker (`local_open_worker.ts`) and a
/// `GPUDevice` does not cross that boundary, so the caller uses this to learn whether an adapter
/// was offered at all - a browser with none decodes on the CPU rather than not at all, and the
/// fall-through is otherwise a picture that merely looks worse.
///
/// Rejects rather than panics where the browser has no adapter, which is a browser the product
/// still opens.
#[wasm_bindgen(js_name = openGpuDevice)]
pub async fn open_gpu_device() -> Result<GpuDevice, JsValue> {
    let gpu = crate::gpu::page_device()
        .await
        .ok_or_else(|| JsValue::from_str("rawshim: this browser offered no WebGPU adapter"))?;
    gpu.device
        .as_webgpu()
        .cloned()
        .map(|device| JsValue::from(device).unchecked_into())
        .ok_or_else(|| JsValue::from_str("rawshim: the device is not on the WebGPU backend"))
}

#[wasm_bindgen]
extern "C" {
    /// Declared only so the generated `.d.ts` says `GPUDevice` rather than `any`. wgpu's own
    /// handle type is its private binding, and a `web_sys::GpuDevice` would be a third copy of
    /// the same JS object's Rust wrapper.
    #[wasm_bindgen(typescript_type = "GPUDevice")]
    pub type GpuDevice;
}

/// Decodes a RAW the page is holding, to interleaved scene-linear Rec.2020 `u16`.
///
/// `at_least_long_edge` is a floor rather than a size ([`crate::decode_frame_bytes`]): a frame
/// with at least twice it to spare is halved, and 0 asks for the sensor's own.
///
/// **A promise because the frame stays on the GPU.** The conditioning, GALOSH and RCD all run here
/// on the device [`open_gpu_device`] opened, and the one readback at the end of that chain cannot
/// be blocked for in a tab ([`crate::gpu::read_back`]). Opened here as well as there, so a page
/// that only decodes still gets RCD rather than the CPU's PPG.
#[wasm_bindgen(js_name = decodeRaw)]
pub async fn decode_raw(bytes: &[u8], at_least_long_edge: u32) -> Result<Decoded, JsValue> {
    if crate::gpu::page_device().await.is_none() {
        // Not fatal: the decode falls through to the CPU conditioning and PPG, which is a worse
        // reconstruction and announces itself rather than being quietly taken.
        crate::warn("rawshim: this browser offered no WebGPU adapter, so the decode is on the CPU");
    }
    crate::decode_rawler::decode_bytes_async(
        bytes,
        crate::galosh::Amounts::default(),
        at_least_long_edge,
        crate::galosh::Fit::Only,
    )
    .await
    .map(|frame| Decoded { frame })
    .ok_or_else(|| JsValue::from_str("rawshim: no decoder read these bytes"))
}

/// Opens a RAW the page is holding for editing: the frame every tick then grades, and the numbers
/// the grade needs and cannot re-derive from pixels.
///
/// `request` is [`crate::edit::EditRequest`] as JSON, without the file path - the bytes are here.
/// What comes back is byte for byte what `/image/:id/prepared` serves ([`crate::edit::encode`]): a
/// little-endian `u32` header length, that many bytes of JSON, then the samples as `u16`. One wire
/// shape, so the page has one reader whichever host prepared the frame.
///
/// Rejects rather than framing a refusal, since a page that cannot open here has the server to ask.
#[wasm_bindgen(js_name = prepareRaw)]
pub async fn prepare_raw(bytes: &[u8], request: &str) -> Result<Vec<u8>, JsValue> {
    // Opened here as `decode_raw` opens it, and for the same reason: the decode asks for the
    // device rather than opening one, so without this the tab quietly takes the CPU's PPG.
    if crate::gpu::page_device().await.is_none() {
        crate::warn("rawshim: this browser offered no WebGPU adapter, so the open is on the CPU");
    }
    let request: crate::edit::EditRequest = serde_json::from_str(request)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this open request is malformed: {e}")))?;
    let prepared = crate::edit::prepare_bytes_async(bytes, &request)
        .await
        .map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))?;
    crate::edit::encode(&prepared).map_err(|e| JsValue::from_str(&e))
}

/// One rectangle of a photograph at rendition quality, for the loupe to magnify.
///
/// **Pixels, not a picture.** The server encodes its tile as an HDR AVIF because the bytes have to
/// survive a wire; nothing crosses here but a pointer, so what comes back is the window the grade
/// reads - normalised PQ Rec.2020, coded, denoised on the mosaic, warped and sharpened - and the
/// page grades it with the shaders it grades every tick with. Encoding one here to decode it again
/// in the same process would be a picture built twice for no reader.
///
/// `request` is [`crate::tile::TileRequest`] as JSON. Rejects rather than falling through to a
/// worse tile: the editor's own render is already under the glass, so a tile that cannot be built
/// is a magnifier that stays soft rather than one that lies.
#[wasm_bindgen(js_name = renderTile)]
pub async fn render_tile(bytes: &[u8], request: &str) -> Result<Tile, JsValue> {
    // Opened here as the decode and the open open it, and for the same reason: the decode asks
    // for the device rather than opening one, so without this a tile is quietly the CPU's.
    if crate::gpu::page_device().await.is_none() {
        crate::warn("rawshim: this browser offered no WebGPU adapter, so the tile is on the CPU");
    }
    let request: crate::tile::TileRequest = serde_json::from_str(request)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this tile request is malformed: {e}")))?;
    let window = crate::tile::prepared_async(crate::tile::Source::Bytes(bytes), &request)
        .await
        .map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))?;
    // At rest on everything a tick moves, exactly as `edit::payload` leaves the frame's own words:
    // the page copies these and overwrites the exposure, the sliders, the region and the canvas.
    let identity = crate::hdr_fit::HdrColour::identity();
    let scene = window.scene(0.0, crate::gpu::Adjust::none());
    let grade = window.grade(&scene, request.grade.peak_nits, crate::gpu::Output::Pq);
    let edits = crate::gpu::uniform_words(&grade, grade.colour.unwrap_or(&identity));
    Ok(Tile { window, edits })
}

/// A tile's window, left in wasm memory for JS to upload from.
#[wasm_bindgen]
pub struct Tile {
    window: crate::tile::Prepared,
    edits: Vec<u32>,
}

#[wasm_bindgen]
impl Tile {
    /// The window, which is the rectangle asked for plus the margin every stage after the gather
    /// reads. The grade runs over all of it and `keep` is what is drawn.
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.window.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.window.height as u32
    }

    /// `[left, top, width, height]` of the rectangle asked for, inside that window.
    #[wasm_bindgen(getter)]
    pub fn keep(&self) -> Vec<u32> {
        self.window.keep.iter().map(|value| *value as u32).collect()
    }

    /// `struct Edit`'s frame half for this window ([`crate::edit::PreparedHeader::edits`]).
    #[wasm_bindgen(getter)]
    pub fn edits(&self) -> Vec<u32> {
        self.edits.clone()
    }

    /// The working texture `detail.wgsl` blurs on for a window this size, which is not the size a
    /// whole frame of these dimensions would take: the step is the photograph's.
    #[wasm_bindgen(getter)]
    pub fn detail(&self) -> Vec<u32> {
        let size = crate::gpu::detail_within(
            self.window.width,
            self.window.height,
            self.window.photograph.0.max(self.window.photograph.1),
        );
        vec![size.width, size.height]
    }

    /// Where the samples begin, for `new Uint16Array(memory.buffer, ptr, length)`. [`Decoded::ptr`]
    /// says how long that view lives.
    #[wasm_bindgen(getter)]
    pub fn ptr(&self) -> u32 {
        self.window.samples.as_ptr() as usize as u32
    }

    /// Samples, not bytes and not pixels: three to a pixel.
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> u32 {
        self.window.samples.len() as u32
    }
}

/// A decoded frame, left where it was decoded for JS to read without a copy.
#[wasm_bindgen]
pub struct Decoded {
    frame: crate::frame::Frame,
}

#[wasm_bindgen]
impl Decoded {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.frame.width as u32
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.frame.height as u32
    }

    /// Whether the frame was combined off 2x2 sites rather than demosaiced (10.4).
    #[wasm_bindgen(getter)]
    pub fn halved(&self) -> bool {
        self.frame.halved
    }

    /// Where the samples begin, for `new Uint16Array(memory.buffer, ptr, length)`.
    ///
    /// That view dies the next time wasm memory grows, which any later call into this module can
    /// cause and which detaches every `ArrayBuffer` JS holds over it. Read or copy it before
    /// calling back in, and drop this with `free()` when done.
    #[wasm_bindgen(getter)]
    pub fn ptr(&self) -> u32 {
        self.frame.samples16().map_or(0, |samples| samples.as_ptr() as usize as u32)
    }

    /// Samples, not bytes and not pixels: three to a pixel.
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> u32 {
        self.frame.samples16().map_or(0, |samples| samples.len() as u32)
    }
}
