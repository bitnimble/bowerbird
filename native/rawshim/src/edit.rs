// The open half of the editor.
//
// Everything before the first slider tick - decode, prepare, fit the camera match,
// materialise the lens warp, denoise and sharpen - with none of the per-tick half, which
// runs as shader dispatches on the client (`docs/raw-edit-gpu.md` §6). What crosses is
// this module's `Prepared`: the scene-linear frame the grade reads, plus the numbers the
// grade needs and cannot re-derive from pixels.
//
// This half is where the threads are worth having - measured at 3.2x between one and
// twelve - against a tick that is entirely the GPU's.

use crate::hdr::{self, Prepared as HdrPrepared};
use crate::hdr_fit::{ChromaMap, HdrColour};
use crate::image::Strengths;
use serde::{Deserialize, Serialize};

/// What the client has to be told to open a RAW, which is the library's settings and
/// nothing about this machine.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditRequest {
    pub raw_file_path: String,
    /// Longest edge the decode is fitted to, which is the size every tick then grades.
    pub long_edge: u32,
    pub grade: hdr::Grade,
    pub strengths: Strengths,
}

/// The camera match, flattened into what a shader can index.
///
/// `HdrColour` carries `Vec<f64>` curves and an optional lattice; both become plain arrays
/// here because the client uploads them as buffers and reads them with the same
/// interpolation the CPU uses.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColourPayload {
    /// Per channel, `BINS` samples spanning render values 0 to `trustCeiling`.
    pub curves: [Vec<f32>; 3],
    pub matrix: [[f32; 3]; 3],
    pub saturation: f32,
    pub trust_ceiling: f32,
    /// Flattened `ChromaMap`, or `None` where the fit did not support one.
    pub chroma: Option<ChromaPayload>,
}

/// `ChromaMap`'s lattice, flat, with the axis constants the shader needs to walk it.
///
/// Four values per node, level-major then `d2` then `d0`, which is the order `correct`
/// indexes them in. The scales travel with the nodes rather than being hardcoded on the
/// client so a change to the grid shape cannot leave the two disagreeing about which node
/// a colour belongs to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromaPayload {
    pub nodes: Vec<f32>,
    pub chroma_count: u32,
    pub level_count: u32,
    pub chroma_low: f32,
    pub chroma_scale: f32,
    pub level_scale: f32,
}

/// The header that travels in front of the samples.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedHeader {
    /// Always true here; a failed open sends the same framing with false and no samples,
    /// so the caller has one parse rather than two shapes to tell apart.
    pub ok: bool,
    pub width: usize,
    pub height: usize,
    /// `tone::Levels`: the frame's own diffuse white and peak, in input levels.
    pub white: f64,
    pub peak: f64,
    pub grade: hdr::Grade,
    pub strengths: Strengths,
    /// False where the file embeds no preview or the fit found too few pairs, in which
    /// case the client grades the neutral arm exactly as a rendition does.
    pub matched: bool,
    pub colour: Option<ColourPayload>,
    /// Bytes of `u16` little-endian RGB following the header.
    pub samples_len: usize,
}

pub struct Prepared {
    pub header: PreparedHeader,
    pub samples: Vec<u16>,
}

impl ColourPayload {
    fn from(colour: &HdrColour) -> Self {
        let curve = |c: usize| colour.curves[c].iter().map(|v| *v as f32).collect::<Vec<f32>>();
        ColourPayload {
            curves: [curve(0), curve(1), curve(2)],
            matrix: std::array::from_fn(|r| std::array::from_fn(|c| colour.matrix[r][c] as f32)),
            saturation: colour.saturation as f32,
            trust_ceiling: crate::hdr_fit::TRUST_CEILING as f32,
            chroma: colour.chroma.as_ref().map(ChromaPayload::from),
        }
    }
}

impl ChromaPayload {
    fn from(map: &ChromaMap) -> Self {
        let shape = map.shape();
        ChromaPayload {
            nodes: map.nodes_flat().iter().map(|v| *v as f32).collect(),
            chroma_count: shape.chroma_count as u32,
            level_count: shape.level_count as u32,
            chroma_low: shape.chroma_low as f32,
            chroma_scale: shape.chroma_scale as f32,
            level_scale: shape.level_scale as f32,
        }
    }
}

/// Decodes, prepares, fits and warps, leaving the frame a tick can grade from.
///
/// Prepare once to measure the levels, fit the match from the embedded JPEG, then rebuild
/// the prepared frame so the warp the match was fitted through is materialised into the
/// buffer the client uploads. Grading an unwarped frame through a curve fitted from warped
/// pairs is the bug that arrangement exists to prevent.
pub fn prepare(request: &EditRequest) -> Result<Prepared, String> {
    let bytes = std::fs::read(&request.raw_file_path)
        .map_err(|e| format!("could not read {}: {e}", request.raw_file_path))?;
    prepare_bytes(&bytes, request)
}

/// The same open, for a caller that already holds the file.
///
/// The desktop shell does: it fetches the RAW from the library and prepares it in its own
/// process, which is the point - the RAW is tens of megabytes and the prepared frame is
/// hundreds, so the smaller of the two is the one worth putting on a network.
pub fn prepare_bytes(bytes: &[u8], request: &EditRequest) -> Result<Prepared, String> {
    {
        let frame = crate::decode_frame_bytes(bytes, 16, true, request.long_edge)
            .ok_or("LibRaw could not decode this file")?;
        let samples = frame.samples16().ok_or("the decode was not 16-bit")?;
        let source = hdr::Source { samples, width: frame.width, height: frame.height };

        let matched = fit(bytes, &source, request);
        let mut prepared = hdr::prepare(&source, None, &request.grade);

        // The same refusal `tone::grade` makes, and for the same reason: the grade divides
        // by diffuse white, and `tone::levels` reports zero when the white quantile lands on
        // level 0 - a frame that is essentially all black, a lens cap, a failed exposure.
        //
        // A rendition ships such a frame ungraded. The editor cannot: `white` crosses to the
        // shader, and both arms of the colour transform divide by it, so what the reader
        // would get is `level / 0` rolling every pixel to display peak and `0 / 0` leaving
        // the black ones indeterminate - a flat white canvas reporting itself live. Better
        // to say so.
        if prepared.levels.white <= 0.0 {
            return Err("this frame is too dark to read an exposure from".to_string());
        }
        if let Some(colour) = matched.as_ref() {
            if let Some(warped) = crate::hdr_fit::apply_lens(
                &prepared.samples,
                prepared.width,
                prepared.height,
                colour,
            ) {
                prepared.samples = warped;
            }
        }

        // Filtered here, so a tick is the grade alone.
        filter_once(&mut prepared, request);
        Ok(payload(prepared, matched.as_ref(), request))
    }
}

/// The camera match, or `None` where there is nothing to fit against.
///
/// Declining is not an error: `hdr::fit_all_from_preview` returns `None` for a file with
/// no embedded preview and for one whose fit found too few usable pairs, and the grade
/// then takes its neutral arm exactly as a rendition's does.
fn fit(
    raw: &[u8],
    source: &hdr::Source<'_>,
    request: &EditRequest,
) -> Option<crate::hdr_fit::HdrMatch> {
    // A decode narrower than the preview cannot be paired against it: `fit_plane` clamps
    // its target to the source's own width, so the two grids come out different sizes and
    // `pairs` asserts on it. Renditions never reach this because they decode at thousands
    // of pixels; the editor can, because the client asks for the size its stage can show
    // (`docs/raw-edit-gpu.md` §4.1). Declining is already a supported outcome - the grade
    // takes its neutral arm - so this is one more reason to decline rather than a failure.
    if source.width.max(source.height) < crate::hdr_fit::sample_long_edge() {
        return None;
    }
    let jpeg = crate::embedded_jpeg_bytes(raw)?;
    // Bounded on the way out, as `hdr::fit_all` bounds it: the fit linearises the preview
    // whole into f64 before resampling, so a full-size one is 576MB.
    let preview = crate::jpeg::decode(&jpeg, crate::hdr_fit::sample_long_edge()).ok()?;
    let recorded = crate::lens::read_distortion(raw);
    let geometry = match (recorded.applied, recorded.spline) {
        (Some(false), _) => crate::fit::Geometry::Uncorrected,
        (_, Some(knots)) => crate::fit::Geometry::Recorded(knots),
        (_, None) => crate::fit::Geometry::Unstated,
    };
    hdr::fit_all_from_preview(
        source,
        request.grade.white_quantile,
        geometry,
        // Without the sharpen, which is what a rendition fits with too: it deconvolves the
        // resample's blur and so has not run at the point the match is measured.
        request.strengths.before_the_fit(),
        &preview,
        recorded.lateral,
    )
    .map(|(_, matched)| matched)
}

/// Denoises, defringes and sharpens the frame once, here, rather than on every tick.
///
/// **In PQ against the scene's own diffuse white, not in linear and not in the grade's
/// output.** Linear is the wrong domain and `image.rs` says why: a difference taken there
/// is proportional to absolute luminance, so a filter calibrated on the bright end of a
/// frame reads the whole shadow region as flat. Measured, it flattens shadow texture by a
/// factor of forty (`examples/predenoise.rs`).
///
/// But the filter never needed the *grade's* output either - it needed a perceptual domain,
/// and PQ against a fixed anchor is one that has nothing to do with the exposure. So the
/// frame goes into PQ, is filtered, and comes back to scene-linear for the grade to read.
/// Measured against filtering per tick, at three exposures: the mid-tones, which are 29.5M
/// of a 29.6M-sample frame, land within 20 counts of 65535, and the grain that survives
/// matches within a few percent.
///
/// What that buys is the whole point: a tick is the grade alone, 16ms against 645ms, and a
/// rendition can cut every size it needs from one filtered base.
///
/// f32 throughout rather than the `u16` the frame arrives as, so the round trip costs one
/// quantisation at the end instead of three.
fn filter_once(prepared: &mut HdrPrepared, request: &EditRequest) {
    if !request.strengths.does_anything() {
        return;
    }
    // Both round trips are threaded, and they are the reason an open sat at a fraction of a
    // core for half its time: `pq` and its inverse are transcendental, one call per sample,
    // and at 61MP that is 183M of them each way with `finish_with`'s own threading in
    // between - so the process alternated between using the machine and using one lane of
    // it. They are per-sample and order-free, which is the easiest thing rayon ever splits.
    use crate::parallel::*;

    let scale = request.grade.reference_white_nits / prepared.levels.white.max(1.0);
    let mut perceptual: Vec<f32> = Vec::with_capacity(prepared.samples.len());
    prepared
        .samples
        .par_iter()
        .map(|s| crate::tone::pq(f64::from(*s) * scale) as f32)
        .collect_into_vec(&mut perceptual);

    let (sigma, defocus) =
        crate::image::measurements(&perceptual, prepared.width, prepared.height, request.strengths);
    crate::image::finish_with(
        &mut perceptual,
        prepared.width,
        prepared.height,
        request.strengths,
        sigma,
        defocus,
    );

    prepared
        .samples
        .par_iter_mut()
        .zip(perceptual.par_iter())
        .for_each(|(sample, filtered)| {
            let nits = crate::tone::pq_inv(f64::from(*filtered));
            *sample = (nits / scale).clamp(0.0, 65535.0).round() as u16;
        });
}

fn payload(
    prepared: HdrPrepared,
    matched: Option<&crate::hdr_fit::HdrMatch>,
    request: &EditRequest,
) -> Prepared {
    let header = PreparedHeader {
        ok: true,
        width: prepared.width,
        height: prepared.height,
        white: prepared.levels.white,
        peak: prepared.levels.peak,
        grade: request.grade,
        strengths: request.strengths,
        matched: matched.is_some(),
        colour: matched.map(|m| ColourPayload::from(&m.colour)),
        samples_len: prepared.samples.len() * 2,
    };
    Prepared { header, samples: prepared.samples }
}

/// The wire form: a little-endian `u32` header length, that many bytes of JSON, then the
/// samples as little-endian `u16`.
///
/// One buffer rather than two calls, because the FFI hands back one buffer and the HTTP
/// route hands back one body, and splitting the header into a second request would let the
/// two disagree about which frame they describe.
pub fn encode(prepared: &Prepared) -> Result<Vec<u8>, String> {
    let header = serde_json::to_vec(&prepared.header).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + header.len() + prepared.samples.len() * 2);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    for sample in &prepared.samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(out)
}
