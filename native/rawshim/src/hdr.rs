// HDR renditions of one photo, end to end (DESIGN 10.7).
//
// One call does the whole job: decode the RAW scene-linear, fit the camera's colour in
// the grade's own domain, fit to size, warp, grade, and hand the samples to ffmpeg -
// and avifenc after it, for a still. That is deliberate rather than convenient. The
// graded frame is ~115MB at 24MP and ~366MB at 61MP, and it used to be built in
// TypeScript and written to a child process from there, which meant every one of those
// bytes crossing the FFI boundary for a consumer that is not this side of it.
//
// The still is an AVIF, which Chrome renders as HDR on Android 14+ and on desktop, and
// Safari renders on macOS - including at 4:4:4, confirmed on an HDR display. Firefox
// honours no HDR image tagging at all and is served the same file: it rewraps the
// bitstream as an MP4 in the page, its video pipeline being the one that composites
// HDR (§10.7).

use crate::hdr_args::{self, EncodeOptions};
use crate::hdr_fit::{self, HdrMatch};
use crate::image;
use crate::tone;
use serde::{Deserialize, Serialize};
// The `avifenc` fallback's, which only a rendition build has.
#[cfg(feature = "renditions")]
use std::io::Write;
#[cfg(feature = "renditions")]
use std::process::{Command, Stdio};

/// How a scene-linear decode is anchored to a display (DESIGN 10.7).
///
/// One value rather than three loose numbers because the three are only meaningful
/// together: the quantile picks the sample diffuse white is read from, and the two nits
/// figures say where that sample and the highlights above it land. A rendition and a
/// slider tick that disagreed on any one of them would be grading different pictures.
#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Grade {
    /// Display peak the grade rolls highlights into, and the declared mastering peak.
    pub peak_nits: f64,
    /// Nits diffuse white maps to (BT.2408 HDR Reference White).
    pub reference_white_nits: f64,
    /// Quantile of the frame taken as diffuse white.
    pub white_quantile: f64,
}

/// A frame and its dimensions: the scene-linear decode where a caller has just decoded, and
/// the coded base everywhere below `tone::encode_base`.
pub struct Source<'a> {
    pub samples: &'a [u16],
    pub width: usize,
    pub height: usize,
}

/// Denoises and defringes the coded base in place.
///
/// **In PQ against the scene's own diffuse white, not in linear and not in the grade's
/// output.** Linear is the wrong domain and `image.rs` says why: a difference taken there is
/// proportional to absolute luminance, so a filter calibrated on the bright end of a frame
/// reads the whole shadow region as flat. Measured, it flattens shadow texture by a factor of
/// forty. But the filter never needed the *grade's* output either - it needed a perceptual
/// domain, and PQ against a fixed anchor is one that has nothing to do with the exposure.
///
/// That domain is the buffer's own now (`tone::encode_base`), so this is pointwise on what it
/// holds. It used to borrow the domain and give it back, through an `image::Coding` that put a
/// table on the way in and a `pq_inv` on the way out of each pass - and there are two passes.
///
/// **Ahead of the geometric warp, which is what the sharpen is not.** Noise is generated at
/// the sensor and so is spatially uniform in sensor space; the lens warp resamples
/// non-uniformly by radius and breaks that, and `image::measure_noise` takes one global
/// median and applies one sigma everywhere - an estimator for a uniform field. Measured on a
/// synthetic flat field, the warp alone takes corner-to-centre noise from 1.00x to 0.76x;
/// denoising after it compounds that to 0.59x, where denoising first adds nothing to the
/// warp's own 0.75x and removes ~35% more noise besides.
///
/// Which stages run is the caller's, and the split is always the same one: everything but
/// the sharpen ahead of the warp, and the sharpen after it. Both hosts take it in those two
/// halves - a rendition through `Cut::sharpen`, the editor through its own second call.
pub fn filter_base(
    samples: &mut [u16],
    width: usize,
    height: usize,
    strengths: image::Strengths,
) {
    if !strengths.does_anything() {
        return;
    }
    image::finish(samples, width, height, strengths);
}

/// Fits the camera's colour for the HDR grade, reusing geometry the SDR fit resolved.
///
/// For a job that renders SDR too, where that geometry has already been paid for off an
/// 8-bit render. Where nothing renders SDR, `fit_all` does both halves in one pass.
///
/// The preview is decoded here rather than passed in, so the JPEG never leaves this
/// side. None when the file embeds no preview, or when there are too few usable pairs.
#[cfg(feature = "renditions")]
pub fn fit_match(
    raw_path: &str,
    source: &Source<'_>,
    quantile: f64,
    lens: crate::fit::Lens,
) -> Option<HdrMatch> {
    let preview = crate::decode_embedded_rgb(raw_path, hdr_fit::sample_long_edge())?;
    fit_match_from(source, quantile, &preview, lens)
}

pub fn fit_match_from(
    source: &Source<'_>,
    quantile: f64,
    preview: &crate::rgb::Rgb,
    lens: crate::fit::Lens,
) -> Option<HdrMatch> {
    let anchor = tone::levels(source.samples, quantile).white;
    let plane = hdr_fit::fit_plane(source.samples, source.width, source.height, preview.width);
    hdr_fit::fit(&plane, anchor, &preview, lens)
}

/// The whole camera match for an HDR rendition - the geometry and the colour - off one
/// pass over the decode.
///
/// Both halves want the same three things: the frame's levels, the camera's preview,
/// and the decode box-averaged to twice that preview's width. Asked for as two calls
/// they each measured the levels, each pulled the 5-14MB preview back out of the file,
/// and each walked the whole frame to build the same average.
///
/// Both normalise it by diffuse white, the geometry search included. The peak stood in
/// for LibRaw's auto-brightening once, and it is a maximum over a strided subsample: one
/// specular sample drags the whole render toward black by the peak/white ratio, `pairs`
/// drops anything whose darkest channel lands on 1 or below, and a frame can fall under
/// `MIN_PAIRS` and lose its colour match entirely. Diffuse white is a percentile, so it
/// is also what keeps the fit stable across decode sizes.
///
/// Geometry first and colour second, which is not negotiable: the colour is fitted from
/// pixel pairs that only correspond through the warp (10.8).
///
/// **The geometry search reads a *finished* render, for the reason the SDR path records at
/// its own call site: the defringe and the lateral tier remove the same error.** Measured
/// on the raw render, the tier corrects a fringe the defringe at the end of `encode_still`
/// then removes as well, and the two together overshoot. Handed the frame as it will
/// actually look, the tier finds nothing left and declines on its own - no rule needed.
///
/// The colour half still reads `plane`, which is scene-linear and cannot be finished in the
/// same way: the denoise takes a difference against a blur, and a difference taken in
/// linear light follows absolute luminance rather than what the eye reads. What makes that
/// tolerable here and not on the SDR path is `fit_plane` itself - it box-averages the
/// decode down to twice the preview's width, which already removes most of the chroma noise
/// a denoise would have.
///
/// None when the file embeds no preview, when the fit found nothing worth applying, or
/// when there were too few usable pairs - in each case the caller grades neutrally.
#[cfg(feature = "renditions")]
pub fn fit_all(
    raw_path: &str,
    source: &Source<'_>,
    quantile: f64,
    geometry: crate::fit::Geometry,
    finished: image::Strengths,
) -> Option<(crate::fit::Profile, HdrMatch)> {
    let fitted = {
        crate::with_embedded_jpeg(raw_path, |jpeg| {
            // One decode, read by both halves: the geometry fit takes it below and the
            // colour fit takes it again for the plane. Sharing was rejected once, when
            // this was DCT-shrunk almost to the fit grid and arrived barely filtered; at
            // twice the grid it is shrunk to 1500 and brought down by a real reduce, and
            // sharing costs the set 4.605 to 4.622 mean chroma deltaE against ~90ms saved
            // (`fit::fit_from_preview`).
            let preview = crate::jpeg::decode(jpeg, hdr_fit::sample_long_edge()).ok()?;
            let lateral = crate::ffi::recorded_lateral(raw_path);
            fit_all_from_preview(source, quantile, geometry, finished, &preview, lateral)
        })
    };
    fitted.flatten()
}

pub fn fit_all_from_preview(
    source: &Source<'_>,
    quantile: f64,
    geometry: crate::fit::Geometry,
    finished: image::Strengths,
    preview: &crate::rgb::Rgb,
    lateral: Option<[Vec<f64>; 2]>,
) -> Option<(crate::fit::Profile, HdrMatch)> {
    let levels = tone::levels(source.samples, quantile);
    if !(levels.white > 0.0) {
        return None;
    }
    let plane = hdr_fit::fit_plane(source.samples, source.width, source.height, preview.width);
    let mut render = hdr_fit::render_srgb8(&plane, levels.white);
    image::finish(&mut render.data, render.width, render.height, finished);
    let mut profile = crate::fit::fit_from_preview(render.as_ref(), preview.as_ref(), geometry)
        .ok()
        .flatten()?;
    crate::fit::with_lateral(&mut profile, render.as_ref(), lateral);
    let matched = hdr_fit::fit(&plane, levels.white, preview, profile.lens())?;
    Some((profile, matched))
}

/// A decode carried as far as it can go without knowing the exposure.
///
/// Fit to size and measured. A one-shot rendition gathers the lens inside the grade; an
/// editor materialises the warp into this buffer once (`apply_lens`) and re-grades on
/// every slider tick, which is the whole reason they are a value rather than a phase of
/// `graded`.
pub struct Prepared {
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    /// The frame's own, read before the grade so exposure can move against them instead
    /// of being folded into them (the `exposure` uniform in `edit.wgsl`).
    pub levels: tone::Levels,
}

/// Everything a grade needs that the exposure does not change.
///
/// `fit_to` is the size to resample to, or `None` for a decode that already arrived at
/// one - LibRaw bounds the browser's decode on the way out, so there is nothing left to
/// resize there.
///
/// Leaves the lens alone: the one-shot encode gathers it inside the grade, and the
/// editor materialises it into the returned buffer when it wants to re-grade without
/// re-warping.
pub fn prepare(source: &Source<'_>, fit_to: Option<(usize, usize)>, grade: &Grade) -> Prepared {
    // Measured wherever the decode happens to be, which is safe now that both ends are
    // quantiles over a fixed sample count: the anchor no longer moves with the frame's
    // resolution, so the decode is free to arrive already fitted (`copy_processed`).
    prepare_with(source, fit_to, tone::levels(source.samples, grade.white_quantile))
}

/// [`prepare`] against levels the caller has already read.
///
/// The levels are the photo's, not the target's: `tone::levels` reads the *unresized* decode
/// and a job cutting several sizes off one photo would otherwise measure the same frame once
/// per rendition for the same answer.
pub fn prepare_with(
    source: &Source<'_>,
    fit_to: Option<(usize, usize)>,
    levels: tone::Levels,
) -> Prepared {
    // Fit before grading, not after. zscale would have done the same resize in the
    // same linear light, but only once the whole frame had been graded - so a 61MP
    // decode was tone-mapped in full to produce a 3840px rendition and 15/16 of that
    // work was thrown away. After the resize because the lens model is in normalised
    // radii, so warping 61MP to make a 3840px rendition is the same picture for
    // sixteen times the work.
    let fitted = fit_to.and_then(|(width, height)| {
        image::box_resize_u16(source.samples, source.width, source.height, width, height)
    });
    let (width, height) = match (fitted.is_some(), fit_to) {
        (true, Some(size)) => size,
        _ => (source.width, source.height),
    };

    // One owned buffer for the whole chain. Only a frame that needed no resize has to
    // be copied out of the caller's decode, which this must not write to.
    let samples = fitted.unwrap_or_else(|| source.samples.to_vec());
    Prepared {
        samples,
        width,
        height,
        levels,
    }
}

/// Everything `encode` does up to the point of handing bytes to ffmpeg.
///
/// Split out so a pin can be held against the graded frame without running an encoder,
/// which is what `debug::run`'s luma quantiles reach it for.
pub fn graded(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
) -> (Vec<u16>, usize, usize) {
    graded_as(source, options, matched, crate::gpu::Output::Rolled)
}

/// [`graded`] in whichever coding the caller wants out.
///
/// The transfer is the shader's, in the same dispatch as the grade, so asking for sRGB here
/// is one argument rather than a second implementation of the primaries and the curve.
///
/// `source` is a scene-linear decode. **The fit-to-size happens here, before the coding, so
/// that this agrees with the job.** A rendition's decode arrives already fitted
/// (`decode_frame` bounds it to the largest target), so the only box average production takes
/// in light is that one; coding first and resizing after would put this path's average in PQ
/// and quietly make it a different picture from the one the renditions produce - which
/// matters, because what comes through here is what the pins and the examples measure.
///
/// The coded frame is a buffer of its own, the caller's decode being borrowed. The job does
/// not come through here: it codes in place at `Base::build` and never holds both.
pub fn graded_as(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
    output: crate::gpu::Output,
) -> (Vec<u16>, usize, usize) {
    let levels = tone::levels(source.samples, options.grade.white_quantile).anchored();
    let size = hdr_args::target_size(source.width as u32, source.height as u32, options);
    let fit_to = (size.width as usize, size.height as usize);
    let mut fitted = prepare_with(source, Some(fit_to), *levels);
    tone::encode_base(&mut fitted.samples, levels, options.grade.reference_white_nits);
    let source =
        Source { samples: &fitted.samples, width: fitted.width, height: fitted.height };
    let scene =
        tone::SceneGrade::new(
            matched.map(|m| &m.colour),
            levels,
            options.grade.reference_white_nits,
            1.0,
            // As the camera rendered it: these entry points serve the pins and the debug
            // paths, which measure the grade itself rather than anybody's edit of it. No
            // as-shot illuminant for the same reason - with the pair unset there is nothing
            // to balance away from.
            crate::gpu::Adjust::none(),
            None,
        );
    let size = hdr_args::Size { width: fitted.width as u32, height: fitted.height as u32 };
    graded_with(&source, &scene, matched.map(|m| &m.lens), size, options.grade.peak_nits, output)
}

/// One photo's renditions, carried to the point where only the display still differs.
///
/// Coded, fitted to size, warped and sharpened - **exactly what `edit::open` hands the
/// shader**, and for the same reason: the grade itself is one WGSL implementation now
/// (`gpu::encode`), so whatever reaches it has to be the same thing on both hosts.
///
/// Nothing here knows what display a rendition targets. The colour transform, the roll-off
/// and the transfer are all downstream of this and all run in one dispatch, so a job naming
/// several outputs shares everything up to here and pays only a dispatch each.
///
/// The colour transform is resolution-independent - a per-pixel lookup - so a smaller
/// rendition is a [`Cut::downscale`] of a larger one's frame rather than its own resize, its
/// own warp table and its own sweep. That it is cut before the transform is still what makes
/// the average an honest one: a box mean of the *rendered* picture runs into `mean(f(x))` not
/// being `f(mean(x))` across a whole tone curve and a chroma lattice, where this is one
/// transfer. Not the sensor's own integration either, which linear levels were - see
/// [`Cut::downscale`].
pub struct Cut {
    /// Normalised PQ Rec.2020 `u16`, as `tone::encode_base` coded it and as the shader reads
    /// it back through `nits_of_code`.
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
}

/// What a frame measures once the reader's geometry is applied to it.
///
/// The Rust twin of `displaySize` in `schemas/display_size.ts`, and the same three steps in the
/// same order: straighten to the bounding box, crop as fractions of *that*, then the quarter
/// turn. The two have to agree, because the catalogue lays a grid tile out on one and the
/// encoder writes a file at the other - a disagreement is a tile that is the wrong shape for
/// the picture inside it.
///
/// Floored at one: the fractions are free to describe a rectangle narrower than a pixel at
/// tile size, and a rendition of no pixels is a failed encode rather than a small picture.
pub fn cropped_size(width: usize, height: usize, geometry: image::Geometry) -> (usize, usize) {
    let radians = geometry.angle_degrees.to_radians();
    let (cos, sin) = (radians.cos().abs(), radians.sin().abs());
    let (sw, sh) = (width as f64 * cos + height as f64 * sin, width as f64 * sin + height as f64 * cos);
    let [left, top, right, bottom] = geometry.crop;
    let w = sw * (right - left).max(0.0);
    let h = sh * (bottom - top).max(0.0);
    let turned = matches!(geometry.rotate % 360, 90 | 270);
    let (w, h) = if turned { (h, w) } else { (w, h) };
    ((w.round() as usize).max(1), (h.round() as usize).max(1))
}

impl Cut {
    /// The largest rendition's frame, off the shared base.
    ///
    /// A resize or a warp writes its own output, so the base is only copied when neither
    /// runs - the native-resolution, no-lens case, and 366MB of it on a 61MP frame. Worth
    /// knowing rather than worth avoiding: the caller's decode is borrowed and a `Cut` owns
    /// its samples, so the alternative is a lifetime on every rendition.
    ///
    /// No levels travel with it. They used to, for a sharpen that anchored its own perceptual
    /// domain to diffuse white; the base carries that anchor now, and the grade reads the
    /// levels off `tone::SceneGrade` rather than off the frame.
    pub fn from_base(
        source: &Source<'_>,
        lens: Option<&crate::fit::Lens>,
        size: hdr_args::Size,
        geometry: image::Geometry,
    ) -> Cut {
        let (width, height) = (size.width as usize, size.height as usize);
        let fitted = image::box_resize_u16(source.samples, source.width, source.height, width, height);
        let (width, height) = match fitted.is_some() {
            true => (width, height),
            false => (source.width, source.height),
        };
        // What the reader's crop leaves of that. The gather reads the whole frame and writes
        // only this, so a crop costs a smaller output rather than a second buffer - the frame
        // is never materialised corrected-and-uncropped just to have most of it thrown away.
        let (out_width, out_height) = cropped_size(width, height, geometry);
        let warp = image::PlanarWarp::for_lens_and_geometry(
            width,
            height,
            (width, height),
            (out_width, out_height),
            lens,
            geometry,
            image::Sampling::Bicubic,
        );
        let samples = match warp {
            Some(warp) => warp.apply_u16(fitted.as_deref().unwrap_or(source.samples)),
            // Nothing to warp through and nothing to crop, so a resize that happened is
            // already the frame and one that did not leaves the caller's decode to be copied -
            // the native-resolution case, and the only copy on this path.
            None => fitted.unwrap_or_else(|| source.samples.to_vec()),
        };
        Cut { samples, width: out_width, height: out_height }
    }

    /// The sharpen, once, on the frame every rendition is cut from.
    ///
    /// After the warp, which is the resample whose blur it deconvolves, and *before* the
    /// colour transform - which is where the editor has always had it, because the shader
    /// does the colour per tick and cannot be asked for it at open. Deconvolving before a
    /// per-pixel non-linearity is also the better-posed inversion: the blur was applied in
    /// this domain, not in the graded one.
    pub fn sharpen(&mut self, amount: f64) {
        filter_base(
            &mut self.samples,
            self.width,
            self.height,
            image::Strengths { sharpen: amount, ..Default::default() },
        );
    }

    /// A smaller rendition's frame, averaged out of this one.
    ///
    /// In the frame's own coding rather than in light, which is a genuine approximation: a box
    /// mean of linear levels is what a lower-resolution sensor would have integrated, and a
    /// mean of PQ codes is not. It is taken because the alternative is decoding a whole frame
    /// to average it and coding it back - the two sweeps the coding exists to remove - and
    /// because of what this is for: a grid tile, 99 times in 100, at a size where the
    /// difference is under a count.
    pub fn downscale(&self, size: hdr_args::Size) -> Cut {
        let (width, height) = (size.width as usize, size.height as usize);
        match image::box_resize_u16(&self.samples, self.width, self.height, width, height) {
            Some(samples) => Cut { samples, width, height },
            None => Cut { samples: self.samples.clone(), width: self.width, height: self.height },
        }
    }
}

/// One rendition's display-referred pixels, off a base the caller shares across targets.
///
/// The size and the display peak are the only things a rendition brings: the levels and the
/// whole colour transform belong to the photo and arrive settled.
///
/// `source` is already coded and already at `size` on the only path that reaches this, so the
/// warp is the one thing left before the dispatch.
pub fn graded_with(
    source: &Source<'_>,
    scene: &tone::SceneGrade<'_>,
    lens: Option<&crate::fit::Lens>,
    size: hdr_args::Size,
    peak_nits: f64,
    output: crate::gpu::Output,
) -> (Vec<u16>, usize, usize) {
    let (width, height) = (size.width as usize, size.height as usize);
    let mut samples = match lens
        .and_then(|lens| image::PlanarWarp::for_lens(width, height, width, height, lens, image::Sampling::Bicubic))
    {
        // The gather and the grade were one sweep while the grade was per-pixel Rust. It runs
        // on the GPU now, from the same WGSL the editor runs, so the warp is its own pass
        // again - one gather over the frame against holding two implementations of the colour
        // in agreement, which is the trade DESIGN 21.1 exists to make.
        Some(warp) => warp.apply_u16(source.samples),
        None => source.samples.to_vec(),
    };
    let gpu = crate::gpu::device().expect(
        "no Vulkan adapter answered, not even a software one. The grade runs on the GPU \
         so that the editor and a rendition cannot drift apart, and the CPU copy it \
         used to fall back to is gone. Installing mesa's lavapipe ICD is enough - it is \
         very slow and it works.",
    );
    samples = gpu.encode(&samples, &scene.gpu_grade(width, height, peak_nits, output));
    (samples, width, height)
}

/// `levels` are the frame's own, unexposed; `exposure` is the slider. Keeping them apart
/// is what holds the colour still as it moves - see the `exposure` uniform in `edit.wgsl`.
///
/// The frame must already be through the lens: the editor materialises that once into
/// `Prepared`, and re-grades here on every slider tick.

/// The graded frame as the bytes a child process reads.
///
/// Native byte order, which is what `-pixel_format rgb48le` says on the little-endian
/// targets this ships for.
#[cfg(feature = "renditions")]
fn as_bytes(graded: &[u16]) -> &[u8] {
    // SAFETY: `u16` has no padding and every bit pattern of it is a valid `u8` pair, so
    // this is a reinterpret of the same allocation rather than a copy of it.
    #[expect(unsafe_code)]
    unsafe {
        std::slice::from_raw_parts(graded.as_ptr() as *const u8, std::mem::size_of_val(graded))
    }
}

/// Encodes samples that have already been graded and PQ-encoded, at the size they
/// arrived at.
///
/// `Cow` because the frame used to be shared with a second encoder on another thread and
/// the signature outlived that; an owned frame reaches libavif without a copy and is
/// dropped as soon as the YUV conversion has read it.
/// Reports whether the still went out through `avifenc`, which is what the differential
/// that compares the two routes asserts on. **The branch reports itself**: reading the
/// environment variable a second time would only re-derive the input to the decision, so
/// any further condition added below would leave the test comparing one route with
/// itself and passing.
#[cfg(feature = "renditions")]
pub fn encode_frame(
    frame: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
) -> Result<bool, String> {
    // In this process, for a PQ still. `avifenc` is a wrapper around libavif, and what
    // it was adding over ffmpeg is the nclx `colr` box, which libavif writes just as
    // well when called directly - so the frame stops being written to ffmpeg's stdin,
    // converted, written again as y4m and read back, and becomes a pointer (`avif.rs`).
    //
    // The transfer is already applied and PQ's output gamut is Rec.2020, which the grade
    // already works in, so all that is left between here and a file is the YCbCr matrix,
    // which libavif does.
    if !use_avifenc() {
        let (primaries, transfer, matrix) = hdr_args::cicp();
        crate::avif::save_still(
            frame,
            width,
            height,
            &crate::avif::StillOptions {
                cicp: crate::avif::Cicp {
                    primaries,
                    transfer,
                    matrix,
                },
                format: options.still_chroma.avif_format(),
                quantizer: options.crf,
                speed: options.preset.min(10),
            },
            &options.output_path,
        )?;
        return Ok(false);
    }

    // The child-process route, kept as the reference the in-process one is measured and
    // pinned against. ffmpeg converts, avifenc tags; the y4m between them goes down a
    // pipe rather than a file, since it is the whole frame uncompressed.
    let to_pipe = EncodeOptions {
        output_path: "-".to_string(),
        ..options.clone()
    };
    pipe(
        &hdr_args::ffmpeg_args(width as u32, height as u32, &to_pipe),
        &hdr_args::avifenc_args(options, ""),
        as_bytes(&frame),
    )?;
    Ok(true)
}

/// Encode stills by spawning ffmpeg and avifenc instead of calling libavif here.
///
/// For the test that holds the two against each other, and as a way out if a build
/// turns up where the linked library and the binary disagree.
#[cfg(feature = "renditions")]
pub(crate) fn use_avifenc() -> bool {
    std::env::var("BOWERBIRD_AVIFENC").is_ok_and(|value| value == "1")
}

/// Runs `first`, feeding it `stdin_data`, with its stdout piped into `second`.
///
/// Both are waited on, and both errors are reported: the interesting failure is
/// usually the downstream one, but a first stage that died explains a second stage
/// that saw no frames.
#[cfg(feature = "renditions")]
fn pipe(first: &[String], second: &[String], stdin_data: &[u8]) -> Result<(), String> {
    let (upstream, up_rest) = first.split_first().ok_or("no command to run")?;
    let (downstream, down_rest) = second.split_first().ok_or("no command to pipe into")?;

    let mut up = Command::new(upstream)
        .args(up_rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {upstream}: {e}"))?;

    let feed = up.stdout.take().ok_or("no stdout on the first stage")?;
    // The builder is a temporary on purpose, and it is load-bearing: it owns the read
    // end of the pipe until it is dropped at the end of this statement. Bind it to a
    // `let` and the parent keeps that end open, the downstream never sees EOF, and this
    // function hangs forever with both children alive.
    let down = Command::new(downstream)
        .args(down_rest)
        .stdin(Stdio::from(feed))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn();
    // `Child` has no `Drop`, so returning here without this leaves the first stage
    // running and then unreaped for the life of the process.
    let down = match down {
        Ok(child) => child,
        Err(e) => {
            let _ = up.kill();
            let _ = up.wait();
            return Err(format!("could not start {downstream}: {e}"));
        }
    };

    let mut stdin = up.stdin.take().ok_or("no stdin on the first stage")?;
    let (up_out, down_out) = std::thread::scope(|scope| {
        scope.spawn(move || {
            let _ = stdin.write_all(stdin_data);
        });
        // Both waited on inside the scope, so neither can block on a full pipe while
        // the other is still being read.
        let down_out = scope.spawn(|| down.wait_with_output());
        (up.wait_with_output(), down_out.join())
    });

    let down_out = down_out
        .map_err(|_| format!("{downstream} panicked"))?
        .map_err(|e| format!("{downstream} did not finish: {e}"))?;
    let up_out = up_out.map_err(|e| format!("{upstream} did not finish: {e}"))?;

    // Downstream first, and that order is the whole point. When the second stage
    // rejects its arguments and exits at once, the first is killed by SIGPIPE on its
    // next write - so it fails too, with no exit code and, under `-loglevel error`,
    // nothing on stderr because it never got as far as complaining. Reporting the
    // first stage there hands back `ffmpeg failed (-1): no output` and discards the
    // only message that says what is actually wrong.
    if !down_out.status.success() {
        return Err(failure(downstream, &down_out));
    }
    if !up_out.status.success() {
        return Err(failure(upstream, &up_out));
    }
    Ok(())
}

/// A child's exit code and the tail of whatever it had to say about it.
#[cfg(feature = "renditions")]
fn failure(command: &str, output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr);
    let tail: Vec<&str> = text.trim().lines().rev().take(3).collect();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("; ");
    format!(
        "{command} failed ({}): {}",
        output.status.code().unwrap_or(-1),
        if tail.is_empty() { "no output" } else { &tail },
    )
}

/// The whole of one HDR still, from a scene-linear decode this takes ownership of.
///
/// For a caller with one frame and one rendition to make of it - the debug commands and the
/// pins. `job::run` does not go through here: it shares the decode, the levels, the camera
/// match and the filter across every rendition of a photo, and calls the same three stages
/// below with those already settled.
///
/// This used to write a second file beside it, a one-frame AV1 video for Firefox, and the
/// two shared everything: the same resize, warp and tone map, then libaom at the same
/// settings. So the twin was a re-encode of a bitstream the still already held. It is a
/// rewrap of these very bytes now, done in the browser that needs it.
///
/// Reports whether the still went out through `avifenc` rather than through libavif here,
/// which is the only thing the differential between the two routes can assert on now that
/// they produce the same bytes at 4:4:4.
#[cfg(feature = "renditions")]
pub fn encode_still(
    mut samples: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
) -> Result<bool, String> {
    let levels = tone::levels(&samples, options.grade.white_quantile).anchored();
    tone::encode_base(&mut samples, levels, options.grade.reference_white_nits);
    filter_base(&mut samples, width, height, options.strengths.before_the_fit());
    let gpu = crate::gpu::device().ok_or("no GPU adapter, and the shaders are the grade")?;
    let scene =
        tone::SceneGrade::new(
            matched.map(|m| &m.colour),
            levels,
            options.grade.reference_white_nits,
            1.0,
            // As the camera rendered it: these entry points serve the pins and the debug
            // paths, which measure the grade itself rather than anybody's edit of it. No
            // as-shot illuminant for the same reason - with the pair unset there is nothing
            // to balance away from.
            crate::gpu::Adjust::none(),
            None,
        );
    let size = hdr_args::target_size(width as u32, height as u32, options);

    let mut cut = {
        let source = Source { samples: &samples, width, height };
        // Upright and uncropped: this path serves the pins and the debug renders, which
        // measure the pipeline rather than anybody's edit of it.
        let mut built = Cut::from_base(&source, matched.map(|m| &m.lens), size, image::Geometry::none());
        built.sharpen(options.strengths.sharpen);
        built
    };
    // Handed back before the encode allocates anything, which at 61MP is 361MB of
    // scene-linear samples held across the longest stage of the job.
    drop(samples);

    let frame = gpu.encode(
        &cut.samples,
        &scene.gpu_grade(cut.width, cut.height, options.grade.peak_nits, crate::gpu::Output::Pq),
    );
    cut.samples = Vec::new();
    encode_pq_frame(frame, cut.width, cut.height, options)
}

/// The transfer and the encode: everything a rolled HDR frame has left.
///
/// **Nothing filters here.** The denoise and the defringe ran on the coded base ahead of the
/// warp, and the sharpen ran on the frame every rendition is cut from (`Cut::sharpen`) - which
/// is after the warp and the fit-to-size that apply the blur it deconvolves, and in a coding
/// that does not depend on which display this is for.
#[cfg(feature = "renditions")]
pub fn encode_pq_frame(
    frame: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
) -> Result<bool, String> {
    // Handed over rather than lent, so libavif takes the frame rather than a copy of it.
    encode_frame(std::borrow::Cow::Owned(frame), width, height, options)
}

#[cfg(all(test, feature = "renditions"))]
mod tests {
    use super::*;

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_missing_command_is_an_error_rather_than_a_hang() {
        let error = pipe(&argv(&["definitely-not-a-real-binary-xyz"]), &argv(&["cat"]), &[])
            .expect_err("should not have started");
        assert!(error.contains("could not start"), "{error}");
    }

    #[test]
    fn a_failing_command_reports_the_tail_of_its_stderr() {
        let error = pipe(
            &argv(&["true"]),
            &argv(&["sh", "-c", "echo first >&2; echo LAST_LINE >&2; exit 3"]),
            &[],
        )
        .expect_err("exit 3");
        assert!(error.contains("(3)"), "{error}");
        assert!(error.contains("LAST_LINE"), "{error}");
    }

    #[test]
    fn a_large_stdin_write_does_not_deadlock() {
        // The reason the write is on its own thread: 32MB is far past any pipe buffer,
        // so a stage that reads slowly while writing to stderr would wedge an inline
        // write.
        let data = vec![7u8; 32 * 1024 * 1024];
        pipe(&argv(&["cat"]), &argv(&["sh", "-c", "cat > /dev/null; echo noise >&2"]), &data)
            .expect("should complete");
    }
}
