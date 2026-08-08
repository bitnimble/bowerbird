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

/// The scene-linear decode, its dimensions, and where its levels sit.
pub struct Source<'a> {
    pub samples: &'a [u16],
    pub width: usize,
    pub height: usize,
}

/// Denoises and defringes scene-linear samples in place, in the perceptual domain.
///
/// **In PQ against the scene's own diffuse white, not in linear and not in the grade's
/// output.** Linear is the wrong domain and `image.rs` says why: a difference taken there is
/// proportional to absolute luminance, so a filter calibrated on the bright end of a frame
/// reads the whole shadow region as flat. Measured, it flattens shadow texture by a factor of
/// forty. But the filter never needed the *grade's* output either - it needed a perceptual
/// domain, and PQ against a fixed anchor is one that has nothing to do with the exposure.
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
/// the sharpen ahead of the warp, and the sharpen after it. A rendition takes the second half
/// on the coded frame its renditions share (`Cut::sharpen`), where nothing has to convert;
/// the editor comes back here for it, because what it hands the shader is scene-linear.
///
/// **The transfer rides on the filter's own reads and writes** rather than converting the
/// frame and converting it back. Done as its own pass this cost a whole second frame in f32 -
/// 722MB at 61MP, on top of the 361MB decode - which is what `processing_concurrency`
/// multiplies. `image::Coding` puts it inside `deinterleave` and `recombine`, so the buffer
/// never exists and the per-sample count is unchanged.
pub fn filter_scene_linear(
    samples: &mut [u16],
    width: usize,
    height: usize,
    white: f64,
    reference_white_nits: f64,
    strengths: image::Strengths,
) {
    if !strengths.does_anything() {
        return;
    }
    let (forward, scale) = tone::ScenePq::table(white, reference_white_nits);
    image::finish_coded(
        samples,
        width,
        height,
        strengths,
        tone::ScenePq::new(&forward, scale),
    );
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
    let path = std::ffi::CString::new(raw_path).ok()?;

    // SAFETY: the CString outlives the call.
    #[expect(unsafe_code)]
    let fitted = unsafe {
        crate::with_embedded_jpeg(path.as_ptr(), |jpeg| {
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
    /// of being folded into them (`tone::GradeOptions::exposure`).
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
    let levels = tone::levels(source.samples, options.grade.white_quantile);
    let scene = tone::SceneGrade::new(
        source.samples,
        matched.map(|m| &m.colour),
        levels,
        options.grade.reference_white_nits,
        1.0,
    );
    let size = hdr_args::target_size(source.width as u32, source.height as u32, options);
    graded_with(source, levels, scene.as_ref(), matched.map(|m| &m.lens), size, options.grade.peak_nits)
}

/// One photo's renditions, carried to the point where only the display still differs.
///
/// Nits per channel: the fit-to-size, the warp, the camera's colour transform and the
/// sharpen have all run, and none of them knows or cares what peak a rendition targets. What
/// is left is the roll-off, the transfer and the encode.
///
/// This is the whole reason a job can name several outputs cheaply. The colour transform is
/// resolution-independent - it is a per-pixel lookup - so a smaller rendition is a
/// [`Cut::downscale`] of a larger one's frame rather than its own resize, its own warp table
/// and its own sweep. That is not free: the transform is non-linear, so `mean(f(x))` is not
/// `f(mean(x))` and grading then downscaling is not the same picture as downscaling then
/// grading. It is close - `fixture_tests` pins the two within mean deltaE76 1.0 - and the
/// smaller cut is a grid tile, where the difference is not what anyone is looking at.
pub struct Cut {
    /// PQ of the scene-referred nits, as `u16` codes. Coded rather than linear so the sharpen
    /// reads it in the domain it filters in, and `u16` rather than `f16` because PQ is
    /// already 0..1 and a float's exponent earns nothing there (`tone::pq_of_f16`). Nothing
    /// on this path evaluates a transfer per sample.
    pub signal: Vec<u16>,
    pub width: usize,
    pub height: usize,
}

impl Cut {
    /// The largest rendition's frame, off the shared base.
    ///
    /// Where the base is already at `size` nothing is copied: the resize is skipped and the
    /// colour sweep reads the base where it lies. That matters at native resolution, where a
    /// copy is 361MB on a 61MP frame.
    pub fn from_base(
        source: &Source<'_>,
        scene: &tone::SceneGrade<'_>,
        lens: Option<&crate::fit::Lens>,
        size: hdr_args::Size,
    ) -> Cut {
        let (width, height) = (size.width as usize, size.height as usize);
        let fitted = image::box_resize_u16(source.samples, source.width, source.height, width, height);
        let (frame, width, height) = match fitted.as_deref() {
            Some(fitted) => (fitted, width, height),
            None => (source.samples, source.width, source.height),
        };
        let warp = lens.and_then(|lens| {
            image::PlanarWarp::for_lens(width, height, width, height, lens, image::Sampling::Bicubic)
        });
        Cut { signal: scene.to_signal(frame, warp.as_ref()), width, height }
    }

    /// The sharpen, once, on the frame every rendition is cut from.
    ///
    /// The frame is already PQ, so nothing converts - and PQ being *absolute*, that coding
    /// says nothing about which display the frame is bound for, which is what lets one
    /// sharpen serve every rendition.
    pub fn sharpen(&mut self, amount: f64) {
        image::finish(
            &mut self.signal,
            self.width,
            self.height,
            image::Strengths { sharpen: amount, ..Default::default() },
        );
    }

    /// A smaller rendition's frame, averaged out of this one.
    ///
    /// In PQ rather than in linear light, that being what the frame is stored in. The
    /// physical argument for a linear average - it is what a larger sensor pixel would have
    /// integrated - belongs to the resize ahead of the grade (`hdr::prepare`), which is
    /// still linear. This one averages an already-rendered picture, where a perceptual
    /// domain is the ordinary choice.
    ///
    /// Measured against averaging the same frame in linear nits, on the 800px tile of a
    /// grid+full job: mean 0.39 counts of 255, worst 13, and 4.7% of samples differing by
    /// more than one - concentrated on high-contrast edges, which is where the two domains
    /// disagree at all. Indistinguishable side by side at tile size.
    pub fn downscale(&self, size: hdr_args::Size) -> Cut {
        let (width, height) = (size.width as usize, size.height as usize);
        match image::box_resize_u16(&self.signal, self.width, self.height, width, height) {
            Some(signal) => Cut { signal, width, height },
            None => Cut { signal: self.signal.clone(), width: self.width, height: self.height },
        }
    }
}

/// One rendition's display-referred pixels, off a base the caller shares across targets.
///
/// The size and the display peak are the only things a rendition brings: the levels and the
/// whole colour transform belong to the photo and arrive settled. `scene` at None is a frame
/// with no exposure to read, which grades to itself and ships as it arrived.
///
/// Lens owned by the grade: the scene peak was taken off the unwarped base, then the gather
/// and the colour share one sweep.
pub fn graded_with(
    source: &Source<'_>,
    levels: tone::Levels,
    scene: Option<&tone::SceneGrade<'_>>,
    lens: Option<&crate::fit::Lens>,
    size: hdr_args::Size,
    peak_nits: f64,
) -> (Vec<u16>, usize, usize) {
    let mut prepared =
        prepare_with(source, Some((size.width as usize, size.height as usize)), levels);
    let warp = lens.and_then(|lens| {
        image::PlanarWarp::for_lens(
            prepared.width,
            prepared.height,
            prepared.width,
            prepared.height,
            lens,
            image::Sampling::Bicubic,
        )
    });
    if let Some(scene) = scene {
        // The gather and the grade were one sweep while the grade was per-pixel Rust. It
        // runs on the GPU now, from the same WGSL the editor runs, so the warp is its own
        // pass again - one gather over the frame against holding two implementations of
        // the colour in agreement, which is the trade DESIGN 21.1 exists to make.
        if let Some(lens) = warp.as_ref() {
            let src = std::mem::take(&mut prepared.samples);
            prepared.samples = lens.map_u16(&src, |r, g, b| [r, g, b]);
        }
        let gpu = crate::gpu::device().expect(
            "no Vulkan adapter answered, not even a software one. The grade runs on the GPU \
             so that the editor and a rendition cannot drift apart, and the CPU copy it \
             used to fall back to is gone. Installing mesa's lavapipe ICD is enough - it is \
             very slow and it works.",
        );
        prepared.samples = gpu.encode(
            &prepared.samples,
            &scene.gpu_grade(
                prepared.width,
                prepared.height,
                peak_nits,
                crate::gpu::Output::Rolled,
            ),
        );
    }
    (prepared.samples, prepared.width, prepared.height)
}

/// `levels` are the frame's own, unexposed; `exposure` is the slider. Keeping them apart
/// is what holds the colour still as it moves - see the `exposure` uniform in `tick.wgsl`.
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
    let levels = tone::levels(&samples, options.grade.white_quantile);
    filter_scene_linear(
        &mut samples,
        width,
        height,
        levels.white,
        options.grade.reference_white_nits,
        options.strengths.before_the_fit(),
    );
    let scene = tone::SceneGrade::new(
        &samples,
        matched.map(|m| &m.colour),
        levels,
        options.grade.reference_white_nits,
        1.0,
    );
    let size = hdr_args::target_size(width as u32, height as u32, options);
    let Some(scene) = scene else {
        // No exposure to read, so the grade declines and the frame ships as it arrived.
        let source = Source { samples: &samples, width, height };
        let (frame, width, height) =
            graded_with(&source, levels, None, None, size, options.grade.peak_nits);
        return encode_pq_frame(frame, width, height, options);
    };

    let mut cut = {
        let source = Source { samples: &samples, width, height };
        let mut built = Cut::from_base(&source, &scene, matched.map(|m| &m.lens), size);
        built.sharpen(options.strengths.sharpen);
        built
    };
    // Handed back before the encode allocates anything, which at 61MP is 361MB of
    // scene-linear samples held across the longest stage of the job.
    drop(samples);

    let frame = scene.roll(&cut.signal, options.grade.peak_nits);
    cut.signal = Vec::new();
    encode_pq_frame(frame, cut.width, cut.height, options)
}

/// The transfer and the encode: everything a rolled HDR frame has left.
///
/// **Nothing filters here.** The denoise and the defringe ran on the scene-linear frame ahead
/// of the warp, and the sharpen ran on the frame of nits every rendition is cut from
/// (`Cut::sharpen`) - which is after the warp and the fit-to-size that apply the blur it
/// deconvolves, and in a perceptual coding that does not depend on which display this is for.
#[cfg(feature = "renditions")]
pub fn encode_pq_frame(
    mut frame: Vec<u16>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
) -> Result<bool, String> {
    tone::encode_pq(&mut frame, options.grade.peak_nits);
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
