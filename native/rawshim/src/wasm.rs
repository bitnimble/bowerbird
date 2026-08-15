//! What a page calls: a WebGPU device it can share, and a decode of bytes it already holds.
//!
//! Two exports, and they are independent - a browser with no WebGPU still decodes, on the CPU
//! demosaic `decode_rawler` falls through to (`gpu::device` says why the device is not offered
//! to the decode).
//!
//! Nothing here converts a picture. The frame is left in wasm memory as the `u16` the decode
//! produced and JS reads it in place, because the whole reason to decode in the tab is to not
//! move a frame across a boundary: 366MB at 61MP, and a copy either side of it.

use wasm_bindgen::prelude::*;

/// Opens rawshim's device and hands the page the `GPUDevice` behind it.
///
/// **Outbound, because wgpu 30 has no inbound seam** - see [`crate::gpu::page_device`] for why
/// this is the direction rather than taking the page's own device. The page's pipelines and
/// anything this crate uploads then sit on one device, with nothing read back between them.
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
