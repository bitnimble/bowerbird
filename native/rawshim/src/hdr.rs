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
    hdr_fit::fit(source.samples, source.width, source.height, anchor, &preview, distortion, crop)
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
    // The levels come from the decode rather than the fitted copy: averaging pulls a
    // specular peak in, so measuring after the resize would give the full-size
    // rendition and the max-resolution one different anchors for the same photo.
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
    let (samples, width, height) = match &fitted {
        Some(resized) => (resized.as_slice(), size.width as usize, size.height as usize),
        None => (source.samples, source.width, source.height),
    };

    // Geometry before the grade and after the resize. Before the grade because the
    // colour was fitted from pairs that only correspond through this warp; after the
    // resize because the model is in normalised radii, so warping 61MP to make a
    // 3840px rendition is the same picture for sixteen times the work.
    let shaped = matched.and_then(|m| hdr_fit::apply_geometry(samples, width, height, m));
    let shaped = shaped.as_deref().unwrap_or(samples);

    let out = tone::grade(
        shaped,
        &GradeOptions {
            reference_white_nits: options.reference_white_nits,
            // The SDR reference has no headroom above white, so its peak is its
            // reference: the roll-off then lands diffuse white on display white, and
            // it renders identically to the HDR one everywhere below that. Differing
            // only above diffuse white is what makes it a control.
            peak_nits: match options.variant {
                hdr_args::Variant::Sdr => options.reference_white_nits,
                hdr_args::Variant::Pq => options.peak_nits,
            },
            match_colour: matched.map(|m| &m.colour),
            levels,
        },
    );
    // A frame with no exposure to read grades to itself.
    (out.unwrap_or_else(|| shaped.to_vec()), width, height)
}

/// Encodes samples that have already been graded, at the size they arrived at.
fn encode_graded(graded: &[u16], width: usize, height: usize, options: &EncodeOptions) -> Result<(), String> {
    // Native byte order, which is what `-pixel_format rgb48le` says on the little-
    // endian targets this ships for.
    let bytes: &[u8] =
        unsafe { std::slice::from_raw_parts(graded.as_ptr() as *const u8, std::mem::size_of_val(graded)) };

    if options.medium == Medium::Video {
        return run(&hdr_args::ffmpeg_args(width as u32, height as u32, options), Some(bytes));
    }

    // A still goes through ffmpeg only to become y4m: ffmpeg's avif muxer writes no
    // colr box, so the primaries and transfer would be lost, and AVIF has no
    // equivalent of the bitstream filter to put them back. avifenc does the tagging.
    let y4m_path = format!("{}.y4m", options.output_path);
    let to_y4m = EncodeOptions { output_path: y4m_path.clone(), ..options.clone() };
    let result = run(&hdr_args::ffmpeg_args(width as u32, height as u32, &to_y4m), Some(bytes))
        .and_then(|()| run(&hdr_args::avifenc_args(options, &y4m_path), None));
    let _ = std::fs::remove_file(&y4m_path);
    result
}

/// Grades and encodes one HDR rendition, and its one-frame video twin where one is
/// asked for.
///
/// The twin shares the grade. Both media run the same resize, warp and tone map and
/// differ only in encoder, so the only thing that can separate them is size - and only
/// SVT-AV1's 8704-row ceiling does that, which nothing but a native-resolution portrait
/// frame reaches. Encoding them as two calls regraded the frame for the second, paying
/// for the most expensive stage of the pipeline twice on every HDR import.
pub fn encode_pair(
    source: &Source<'_>,
    options: &EncodeOptions,
    video_path: Option<&str>,
    matched: Option<&HdrMatch>,
) -> Result<(), String> {
    let levels = tone::levels(source.samples, options.white_quantile);
    let (frame, width, height) = graded_with(source, options, matched, levels);

    let Some(video_path) = video_path else {
        return encode_graded(&frame, width, height, options);
    };
    let video =
        EncodeOptions { medium: Medium::Video, output_path: video_path.to_string(), ..options.clone() };

    let size = hdr_args::target_size(source.width as u32, source.height as u32, &video);
    if size.width as usize != width || size.height as usize != height {
        // The ceiling bit. Same levels, so the two still agree about where diffuse
        // white and the scene peak sit; only the resize below them differs.
        encode_graded(&frame, width, height, options)?;
        let (frame, width, height) = graded_with(source, &video, matched, levels);
        return encode_graded(&frame, width, height, &video);
    }

    // Together rather than one after the other. Both only read the graded frame, and
    // both are mostly waiting on a child process, so the pair finishes in about the
    // time the slower one takes on its own.
    let (still, twin) = std::thread::scope(|scope| {
        let twin = scope.spawn(|| encode_graded(&frame, width, height, &video));
        (encode_graded(&frame, width, height, options), twin.join())
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
