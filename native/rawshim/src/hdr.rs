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
// honours no HDR image tagging at all, so for Firefox the same pixels are also encoded
// as a one-frame video, since its video pipeline does composite HDR by passing through
// to the compositor.

use crate::hdr_args::{self, EncodeOptions, Medium};
use crate::hdr_fit::{self, HdrMatch};
use crate::image;
use crate::tone::{self, GradeOptions};
use std::io::Write;
use std::process::{Command, Stdio};

/// Runs a command, writing `stdin_data` to it where there is any.
///
/// The write runs on its own thread. ~366MB down a pipe will fill it long before the
/// child has read it all, so writing inline and only then waiting deadlocks whenever
/// the child also has something to say on stderr.
///
/// Scoped rather than spawned, so the thread borrows the graded frame instead of
/// taking a copy of it: that copy was a second ~366MB allocation on every encode, for
/// bytes this frame already owns and outlives the write.
fn run(args: &[String], stdin_data: Option<&[u8]>) -> Result<(), String> {
    let (command, rest) = args.split_first().ok_or("no command to run")?;
    let mut child = Command::new(command)
        .args(rest)
        .stdin(if stdin_data.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {command}: {e}"))?;

    let waited = match stdin_data {
        None => child.wait_with_output(),
        Some(data) => {
            let mut stdin = child.stdin.take().ok_or("no stdin on the child")?;
            std::thread::scope(|scope| {
                // A broken pipe here means the child died early; its stderr says why,
                // so the write error is the less useful of the two and is dropped.
                scope.spawn(move || {
                    let _ = stdin.write_all(data);
                });
                child.wait_with_output()
            })
        }
    };

    let output = waited.map_err(|e| format!("{command} did not finish: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&output.stderr);
    let tail: Vec<&str> = text.trim().lines().rev().take(3).collect();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("; ");
    Err(format!(
        "{command} failed ({}): {}",
        output.status.code().unwrap_or(-1),
        if tail.is_empty() { "no output" } else { &tail },
    ))
}

/// The scene-linear decode, its dimensions, and where its levels sit.
pub struct Source<'a> {
    pub samples: &'a [u16],
    pub width: usize,
    pub height: usize,
}

/// Fits the camera's colour for the HDR grade, reusing geometry the SDR fit resolved.
///
/// For a job that renders SDR too, where that geometry has already been paid for off an
/// 8-bit render. Where nothing renders SDR, `fit_all` does both halves in one pass.
///
/// The preview is decoded here rather than passed in, so the JPEG never leaves this
/// side. None when the file embeds no preview, or when there are too few usable pairs.
pub fn fit_match(
    raw_path: &str,
    source: &Source<'_>,
    quantile: f64,
    distortion: Option<Vec<f64>>,
    crop: f64,
) -> Option<HdrMatch> {
    let anchor = tone::levels(source.samples, quantile).white;
    let preview = crate::decode_embedded_rgb(raw_path, hdr_fit::fit_long_edge())?;
    let plane = hdr_fit::fit_plane(source.samples, source.width, source.height, preview.width * 2);
    hdr_fit::fit(&plane, anchor, &preview, distortion, crop)
}

/// The whole camera match for an HDR rendition - the geometry and the colour - off one
/// pass over the decode.
///
/// Both halves want the same three things: the frame's levels, the camera's preview,
/// and the decode box-averaged to twice that preview's width. Asked for as two calls
/// they each measured the levels, each pulled the 5-14MB preview back out of the file,
/// and each walked the whole frame to build the same average. They differ only in what
/// they normalise that average by - the scene peak for the geometry search, since it
/// stands in for LibRaw's auto-brightening, and diffuse white for the colour fit, since
/// that is the domain the grade works in.
///
/// Geometry first and colour second, which is not negotiable: the colour is fitted from
/// pixel pairs that only correspond through the warp (10.8).
///
/// None when the file embeds no preview, when the fit found nothing worth applying, or
/// when there were too few usable pairs - in each case the caller grades neutrally.
pub fn fit_all(
    raw_path: &str,
    source: &Source<'_>,
    quantile: f64,
    geometry: crate::fit::Geometry,
) -> Option<(crate::fit::Profile, HdrMatch)> {
    crate::vips::init();
    let levels = tone::levels(source.samples, quantile);
    // Diffuse white, not the peak: it is what both halves normalise by, and a frame
    // with none has no exposure to fit against either.
    if !(levels.white > 0.0) {
        return None;
    }
    let path = std::ffi::CString::new(raw_path).ok()?;

    // SAFETY: the CString outlives the call.
    #[expect(unsafe_code)]
    let fitted = unsafe {
        crate::with_embedded_jpeg(path.as_ptr(), |jpeg| {
            let preview = crate::vips::Pipeline::thumbnail(jpeg, hdr_fit::fit_long_edge())
                .and_then(crate::vips::Pipeline::finish)
                .ok()?;
            let plane =
                hdr_fit::fit_plane(source.samples, source.width, source.height, preview.width * 2);

            // Both halves off the same plane and the same anchor: the geometry search
            // wants a render that looks like an ordinary picture, the colour fit wants
            // the grade's own domain, and diffuse white is what puts them there.
            let render = hdr_fit::render_srgb8(&plane, levels.white);
            let profile = crate::fit::fit(render.as_ref(), jpeg, geometry).ok().flatten()?;
            let matched =
                hdr_fit::fit(&plane, levels.white, &preview, profile.knots.clone(), profile.crop)?;
            Some((profile, matched))
        })
    };
    fitted.flatten()
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
    // Measured wherever the decode happens to be, which is safe now that both ends are
    // quantiles over a fixed sample count: the anchor no longer moves with the frame's
    // resolution, so the decode is free to arrive already fitted (`copy_processed`).
    graded_with(source, options, matched, tone::levels(source.samples, options.white_quantile))
}

/// `graded`, against levels the caller already measured.
///
/// Split out for `encode_pair`, which writes two files off one decode and must anchor
/// both on the same reading whether or not it regrades between them.
fn graded_with(
    source: &Source<'_>,
    options: &EncodeOptions,
    matched: Option<&HdrMatch>,
    levels: tone::Levels,
) -> (Vec<u16>, usize, usize) {
    // Fit before grading, not after. zscale would have done the same resize in the
    // same linear light, but only once the whole frame had been graded - so a 61MP
    // decode was tone-mapped in full to produce a 3840px rendition and 15/16 of that
    // work was thrown away.
    let size = hdr_args::target_size(source.width as u32, source.height as u32, options);

    let fitted = image::box_resize_u16(
        source.samples,
        source.width,
        source.height,
        size.width as usize,
        size.height as usize,
    );
    let (width, height) = match fitted.is_some() {
        true => (size.width as usize, size.height as usize),
        false => (source.width, source.height),
    };

    // Geometry before the grade and after the resize. Before the grade because the
    // colour was fitted from pairs that only correspond through this warp; after the
    // resize because the model is in normalised radii, so warping 61MP to make a
    // 3840px rendition is the same picture for sixteen times the work.
    //
    // Scoped so the borrow of `fitted` ends before it is moved from below.
    let warped = {
        let samples = fitted.as_deref().unwrap_or(source.samples);
        matched.and_then(|m| hdr_fit::apply_geometry(samples, width, height, m))
    };

    // One owned buffer for the whole chain, and the grade runs inside it. Whichever
    // stage last allocated *is* that buffer - the warp's output, or the resize's - so
    // only a frame that needed neither has to be copied out of the caller's decode,
    // which this must not write to. The grade used to allocate its own on top of these,
    // a third full frame at 61MP.
    let mut frame = match warped {
        Some(warped) => warped,
        None => fitted.unwrap_or_else(|| source.samples.to_vec()),
    };

    // A frame with no exposure to read grades to itself, and is left as it arrived.
    tone::grade(
        &mut frame,
        &GradeOptions {
            reference_white_nits: options.reference_white_nits,
            peak_nits: options.peak_nits,
            match_colour: matched.map(|m| &m.colour),
            levels,
        },
    );
    (frame, width, height)
}

/// The graded frame as the bytes a child process reads.
///
/// Native byte order, which is what `-pixel_format rgb48le` says on the little-endian
/// targets this ships for.
fn as_bytes(graded: &[u16]) -> &[u8] {
    // SAFETY: `u16` has no padding and every bit pattern of it is a valid `u8` pair, so
    // this is a reinterpret of the same allocation rather than a copy of it.
    #[expect(unsafe_code)]
    unsafe { std::slice::from_raw_parts(graded.as_ptr() as *const u8, std::mem::size_of_val(graded)) }
}

/// Encodes samples that have already been graded, at the size they arrived at.
///
/// `Cow` so the still can PQ-encode in place where it owns the frame. Only the
/// still-plus-video pair passes `Borrowed`, because there the twin is reading the same
/// samples on another thread (`avif::encode_still`).
fn encode_graded(
    graded: std::borrow::Cow<'_, [u16]>,
    width: usize,
    height: usize,
    options: &EncodeOptions,
) -> Result<(), String> {
    if options.medium == Medium::Video {
        return run(&hdr_args::ffmpeg_args(width as u32, height as u32, options), Some(as_bytes(&graded)));
    }

    // In this process, for a PQ still. `avifenc` is a wrapper around libavif, and what
    // it was adding over ffmpeg is the nclx `colr` box, which libavif writes just as
    // well when called directly - so the frame stops being written to ffmpeg's stdin,
    // converted, written again as y4m and read back, and becomes a pointer (`avif.rs`).
    //
    // The grade hands over Rec.2020 linear and PQ's output gamut is Rec.2020, so all
    // that is left between here and a file is the transfer - which this crate owns -
    // and the YCbCr matrix, which libavif does.
    if !use_avifenc() {
        let (primaries, transfer, matrix) = hdr_args::cicp();
        return crate::avif::encode_still(
            graded,
            width,
            height,
            &crate::avif::StillOptions {
                cicp: crate::avif::Cicp { primaries, transfer, matrix },
                format: options.still_chroma.avif_format(),
                quantizer: options.crf,
                speed: options.preset.min(10),
                // What the grade normalised full range to, which is what the transfer
                // has to be told to undo.
                peak_nits: options.peak_nits,
            },
            &options.output_path,
        );
    }

    // The child-process route, kept as the reference the in-process one is measured and
    // pinned against. ffmpeg converts, avifenc tags; the y4m between them goes down a
    // pipe rather than a file, since it is the whole frame uncompressed.
    let to_pipe = EncodeOptions { output_path: "-".to_string(), ..options.clone() };
    pipe(
        &hdr_args::ffmpeg_args(width as u32, height as u32, &to_pipe),
        &hdr_args::avifenc_args(options, ""),
        as_bytes(&graded),
    )
}

/// Encode stills by spawning ffmpeg and avifenc instead of calling libavif here.
///
/// For the test that holds the two against each other, and as a way out if a build
/// turns up where the linked library and the binary disagree.
fn use_avifenc() -> bool {
    std::env::var("BOWERBIRD_AVIFENC").is_ok_and(|value| value == "1")
}

/// Runs `first`, feeding it `stdin_data`, with its stdout piped into `second`.
///
/// Both are waited on, and both errors are reported: the interesting failure is
/// usually the downstream one, but a first stage that died explains a second stage
/// that saw no frames.
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

/// Grades and encodes one HDR rendition, and its one-frame video twin where one is
/// asked for.
///
/// The twin shares the grade outright. Both media run the same resize, warp and tone
/// map, and now that the video is libaom rather than SVT-AV1 there is no encoder
/// ceiling to make them different sizes either - so one graded frame serves both,
/// always. It used to be regraded for the second encode, paying for the most expensive
/// stage of the pipeline twice on every HDR import.
pub fn encode_pair(
    source: Source<'_>,
    options: &EncodeOptions,
    video_path: Option<&str>,
    matched: Option<&HdrMatch>,
    done_with_source: impl FnOnce(),
) -> Result<(), String> {
    let levels = tone::levels(source.samples, options.white_quantile);
    let (frame, width, height) = graded_with(&source, options, matched, levels);

    // Taken by value and dropped here so that "the decode is finished with" is a fact
    // the compiler holds rather than a comment: everything below reads `frame`, and the
    // caller is free to reclaim 366MB of scene-linear samples before the encode - the
    // most expensive stage - even starts.
    drop(source);
    done_with_source();

    let Some(video_path) = video_path else {
        // Handed over rather than lent: with no twin reading it, the still's transfer
        // runs in this buffer instead of a second one the size of the frame.
        return encode_graded(std::borrow::Cow::Owned(frame), width, height, options);
    };
    let video =
        EncodeOptions { medium: Medium::Video, output_path: video_path.to_string(), ..options.clone() };

    // Together rather than one after the other. Both only read the graded frame, and
    // both are mostly waiting on a child process, so the pair finishes in about the
    // time the slower one takes on its own.
    let (still, twin) = std::thread::scope(|scope| {
        let twin = scope.spawn(|| encode_graded(std::borrow::Cow::Borrowed(&frame), width, height, &video));
        (encode_graded(std::borrow::Cow::Borrowed(&frame), width, height, options), twin.join())
    });
    still?;
    twin.map_err(|_| "the video encode panicked".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_command_is_an_error_rather_than_a_hang() {
        let args = vec!["definitely-not-a-real-binary-xyz".to_string()];
        let error = run(&args, None).expect_err("should not have started");
        assert!(error.contains("could not start"), "{error}");
    }

    #[test]
    fn a_failing_command_reports_the_tail_of_its_stderr() {
        let args = ["sh", "-c", "echo first >&2; echo LAST_LINE >&2; exit 3"]
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<_>>();
        let error = run(&args, None).expect_err("exit 3");
        assert!(error.contains("(3)"), "{error}");
        assert!(error.contains("LAST_LINE"), "{error}");
    }

    #[test]
    fn a_large_stdin_write_does_not_deadlock() {
        // The reason the write is on its own thread: 32MB is far past any pipe buffer,
        // so a child that reads slowly while writing to stderr would wedge an inline
        // write. `cat` to /dev/null reads it all.
        let data = vec![7u8; 32 * 1024 * 1024];
        let args = ["sh", "-c", "cat > /dev/null; echo noise >&2"]
            .iter()
            .map(|s| (*s).to_string())
            .collect::<Vec<_>>();
        run(&args, Some(&data)).expect("should complete");
    }
}
