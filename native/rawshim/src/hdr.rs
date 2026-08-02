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
use crate::tone::{self, GradeOptions};
use serde::Deserialize;
#[cfg(not(target_arch = "wasm32"))]
use std::io::Write;
#[cfg(not(target_arch = "wasm32"))]
use std::process::{Command, Stdio};

/// How a scene-linear decode is anchored to a display (DESIGN 10.7).
///
/// One value rather than three loose numbers because the three are only meaningful
/// together: the quantile picks the sample diffuse white is read from, and the two nits
/// figures say where that sample and the highlights above it land. A rendition and a
/// slider tick that disagreed on any one of them would be grading different pictures.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
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

/// The decode an encode reads, either borrowed or handed over outright.
///
/// This is what replaced a `release_source` flag on the old boundary. The problem it
/// existed for is real - the decode is 366MB at 61MP and holding it across the
/// encode, the longest stage of the job, is the peak - but the flag solved it by
/// freeing a buffer the caller still held a pointer to, and could only be made safe
/// by nulling that pointer and re-checking it at every accessor.
///
/// Owning it says the same thing to the compiler. `Owned` is dropped the moment the
/// grade has copied out, and anything that tried to read it afterwards would not
/// build. `Borrowed` is for a caller with another rendition still to write off the
/// same frame; it keeps its decode and pays for it.
#[cfg(not(target_arch = "wasm32"))]
pub enum Decode<'a> {
    /// For a caller with another rendition still to write off the same frame. It
    /// keeps its decode and pays for it.
    Borrowed(Source<'a>),
    /// For the last reader. Dropped once the grade has copied out, which is what
    /// hands 366MB back before the encode allocates anything.
    Owned(crate::frame::Frame),
}

#[cfg(not(target_arch = "wasm32"))]
impl Decode<'_> {
    fn source(&self) -> Result<Source<'_>, String> {
        match self {
            Decode::Borrowed(source) => Ok(Source {
                samples: source.samples,
                width: source.width,
                height: source.height,
            }),
            Decode::Owned(frame) => {
                let samples = frame
                    .samples16()
                    .ok_or("the HDR encode needs a 16-bit decode")?;
                Ok(Source {
                    samples,
                    width: frame.width,
                    height: frame.height,
                })
            }
        }
    }
}

/// Fits the camera's colour for the HDR grade, reusing geometry the SDR fit resolved.
///
/// For a job that renders SDR too, where that geometry has already been paid for off an
/// 8-bit render. Where nothing renders SDR, `fit_all` does both halves in one pass.
///
/// The preview is decoded here rather than passed in, so the JPEG never leaves this
/// side. None when the file embeds no preview, or when there are too few usable pairs.
#[cfg(not(target_arch = "wasm32"))]
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
#[cfg(not(target_arch = "wasm32"))]
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
/// Fit to size, warped through the lens the colour was fitted against, and measured. A
/// rendition runs those three once and grades once; an editor runs them once and grades
/// on every slider tick, which is the whole reason they are a value rather than a phase
/// of `graded`.
pub struct Prepared {
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    /// The frame's own, read before the grade so exposure can move against them instead
    /// of being folded into them (`tone::GradeOptions::exposure`).
    pub levels: tone::Levels,
}

impl Prepared {
    /// A smaller copy carrying the same levels, for the frames a drag throws away.
    ///
    /// Resolution is the disposable part while the slider moves; tone and colour are
    /// not, so this grades through the identical curve at fewer pixels rather than
    /// approximating it at more.
    pub fn shrunk_to(&self, long_edge: usize) -> Prepared {
        let longest = self.width.max(self.height);
        if longest <= long_edge {
            return Prepared {
                samples: self.samples.clone(),
                width: self.width,
                height: self.height,
                levels: self.levels,
            };
        }
        let scaled = |dimension: usize| {
            let value = dimension as u64 * long_edge as u64 / longest as u64;
            usize::try_from(value)
                .expect("a preview dimension must fit the address space")
                .max(1)
        };
        let (width, height) = (scaled(self.width), scaled(self.height));
        let samples =
            image::box_resize_u16(&self.samples, self.width, self.height, width, height)
                .expect("an interactive frame only shrinks");
        Prepared {
            samples,
            width,
            height,
            levels: self.levels,
        }
    }
}

/// Everything a grade needs that the exposure does not change.
///
/// `fit_to` is the size to resample to, or `None` for a decode that already arrived at
/// one - LibRaw bounds the browser's decode on the way out, so there is nothing left to
/// resize there.
pub fn prepare(
    source: &Source<'_>,
    fit_to: Option<(usize, usize)>,
    grade: &Grade,
    matched: Option<&HdrMatch>,
) -> Prepared {
    // Measured wherever the decode happens to be, which is safe now that both ends are
    // quantiles over a fixed sample count: the anchor no longer moves with the frame's
    // resolution, so the decode is free to arrive already fitted (`copy_processed`).
    let levels = tone::levels(source.samples, grade.white_quantile);

    // Fit before grading, not after. zscale would have done the same resize in the
    // same linear light, but only once the whole frame had been graded - so a 61MP
    // decode was tone-mapped in full to produce a 3840px rendition and 15/16 of that
    // work was thrown away.
    let fitted = fit_to.and_then(|(width, height)| {
        image::box_resize_u16(source.samples, source.width, source.height, width, height)
    });
    let (width, height) = match (fitted.is_some(), fit_to) {
        (true, Some(size)) => size,
        _ => (source.width, source.height),
    };

    // Geometry before the grade and after the resize. Before the grade because the
    // colour was fitted from pairs that only correspond through this warp; after the
    // resize because the model is in normalised radii, so warping 61MP to make a
    // 3840px rendition is the same picture for sixteen times the work.
    //
    // Scoped so the borrow of `fitted` ends before it is moved from below.
    let warped = {
        let samples = fitted.as_deref().unwrap_or(source.samples);
        matched.and_then(|m| hdr_fit::apply_lens(samples, width, height, m))
    };

    // One owned buffer for the whole chain, and the grade runs inside it. Whichever
    // stage last allocated *is* that buffer - the warp's output, or the resize's - so
    // only a frame that needed neither has to be copied out of the caller's decode,
    // which this must not write to. The grade used to allocate its own on top of these,
    // a third full frame at 61MP.
    let samples = match warped {
        Some(warped) => warped,
        None => fitted.unwrap_or_else(|| source.samples.to_vec()),
    };
    Prepared {
        samples,
        width,
        height,
        levels,
    }
}

/// Everything `encode` does up to the point of handing bytes to ffmpeg.
///
/// Split out so the pin that captured the TypeScript's graded output can be held
/// against this without running an encoder (`hdr_pin.integration.test.ts`).
pub fn graded(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
) -> (Vec<u16>, usize, usize) {
    let size = hdr_args::target_size(source.width as u32, source.height as u32, options);
    let mut prepared = prepare(
        source,
        Some((size.width as usize, size.height as usize)),
        &options.grade,
        matched,
    );
    // A frame with no exposure to read grades to itself, and is left as it arrived.
    grade_prepared(
        &mut prepared.samples,
        &options.grade,
        matched,
        prepared.levels,
        1.0,
    );
    (prepared.samples, prepared.width, prepared.height)
}

/// `levels` are the frame's own, unexposed; `exposure` is the slider. Keeping them apart
/// is what holds the colour still as it moves - see `tone::GradeOptions::exposure`.
pub fn grade_prepared(
    frame: &mut [u16],
    grade: &Grade,
    matched: Option<&HdrMatch>,
    levels: tone::Levels,
    exposure: f64,
) {
    tone::grade(
        frame,
        &GradeOptions {
            reference_white_nits: grade.reference_white_nits,
            peak_nits: grade.peak_nits,
            match_colour: matched.map(|m| &m.colour),
            levels,
            exposure,
        },
    );
}

/// The graded frame as the bytes a child process reads.
///
/// Native byte order, which is what `-pixel_format rgb48le` says on the little-endian
/// targets this ships for.
#[cfg(not(target_arch = "wasm32"))]
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
#[cfg(not(target_arch = "wasm32"))]
fn encode_frame(
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
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn use_avifenc() -> bool {
    std::env::var("BOWERBIRD_AVIFENC").is_ok_and(|value| value == "1")
}

/// Runs `first`, feeding it `stdin_data`, with its stdout piped into `second`.
///
/// Both are waited on, and both errors are reported: the interesting failure is
/// usually the downstream one, but a first stage that died explains a second stage
/// that saw no frames.
#[cfg(not(target_arch = "wasm32"))]
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
#[cfg(not(target_arch = "wasm32"))]
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

/// Grades and encodes one HDR rendition.
///
/// This used to write a second file beside it, a one-frame AV1 video for Firefox, and
/// the two shared everything: the same resize, warp and tone map, then libaom at the
/// same settings. So the twin was a re-encode of a bitstream the still already held. It
/// is a rewrap of these very bytes now, done in the browser that needs it - no second
/// encode, no second file, and nothing to leave stale when a setting changes.
///
/// Reports whether the still went out through `avifenc` rather than through libavif
/// here, which is the only thing the differential between the two routes can assert on
/// now that they produce the same bytes at 4:4:4.
#[cfg(not(target_arch = "wasm32"))]
pub fn encode_still(
    decode: Decode<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
) -> Result<bool, String> {
    let (mut frame, width, height) = {
        let source = decode.source()?;
        graded(&source, options, matched)
    };

    // Dropped here, before the encode allocates anything: everything below reads the
    // graded frame, and where the caller handed its decode over outright this is where
    // 366MB of scene-linear samples go back. The compiler holds that rather than a
    // comment - `decode` cannot be named again after this line.
    drop(decode);

    // The transfer used to be applied twice, in two domains: libavif's for the still, in
    // this process, and a `zscale` in ffmpeg for the video. That left nowhere for
    // anything belonging between the grade and the encode to run once. The denoise and
    // the sharpen are exactly that: both read a difference against a blur, and a
    // difference taken in linear light follows absolute luminance rather than what the
    // eye reads.
    tone::encode_pq(&mut frame, options.grade.peak_nits);
    crate::image::finish(&mut frame, width, height, options.strengths);

    // Handed over rather than lent, so libavif takes the frame rather than a copy of it.
    encode_frame(std::borrow::Cow::Owned(frame), width, height, options)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
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
