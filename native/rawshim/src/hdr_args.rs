// The command lines the HDR renditions are built with (DESIGN 10.7).
//
// Ported from TypeScript with the rest of the HDR encode, so the samples never
// cross the FFI boundary. The reasoning behind each flag came with it, because
// that reasoning is the reason the flags are what they are: every one of them was
// arrived at by watching a browser refuse to treat a file as HDR.

use std::fmt::Write as _;

// There is one transfer, and no enum for it. PQ is absolute where HLG is relative
// to the display's own range, which makes HLG the wrong curve for judging whether a
// panel reaches a given nits value - it was carried for a while and dropped. The SDR
// reference that used to sit beside every HDR file went with the check page it was
// built to be compared against; what the app serves has never been anything else.

// There is one medium, and no enum for it. An HDR rendition used to be two encodes -
// an AVIF still and a one-frame AV1 in MP4 for Firefox, which honours no HDR image
// tagging - built from the same graded frame by the same encoder at the same settings.
// The video is a container away from the still, so Firefox rewraps the file it is
// already served (§10.7) and nothing here encodes or stores one.

#[derive(Clone)]
pub struct EncodeOptions {
    pub still_chroma: Chroma,
    pub output_path: String,
    pub grade: crate::hdr::Grade,
    /// Constant-quality level; lower is better and slower.
    pub crf: i32,
    /// Encoder speed, 0 slowest. Clamped per encoder: libaom 0-8, avifenc 0-10.
    pub preset: i32,
    /// The defringe, the two denoises and the fraction of the deconvolution to blend in,
    /// all applied to the graded frame after the transfer and before either encoder sees it
    /// (§10.9). None is scaled here: how much noise the frame has is measured off its own
    /// pixels where the filters run.
    pub strengths: crate::image::Strengths,
    /// Longest edge of the output. Infinite means "whatever the frame is".
    pub max_edge: f64,
}

/// Transfer, matrix and primaries as CICP numbers (AV1 spec 6.4.2, and the same
/// values AVIF's colr box carries), alongside ffmpeg's names for them. zscale takes
/// ffmpeg's spelling as an alias for zimg's own, so one table serves the filter and
/// the tagging both.
struct Coding {
    name: &'static str,
    cicp: u32,
}

struct Target {
    primaries: Coding,
    transfer: Coding,
    matrix: Coding,
}

const BT2020: Coding = Coding { name: "bt2020", cicp: 9 };
const BT2020_NCL: Coding = Coding { name: "bt2020nc", cicp: 9 };

/// The CICP triple every HDR rendition is tagged with, for the encoder that sets it
/// directly rather than through a command line.
///
/// The same three whichever medium asks, now that there is one transfer: BT.2020
/// primaries, PQ, and the non-constant-luminance BT.2020 matrix. It is a function
/// rather than a constant because it is the answer to "what does this file claim to
/// be", and that is worth asking in one place.
pub fn cicp() -> (u16, u16, u16) {
    let target = target_for();
    (target.primaries.cicp as u16, target.transfer.cicp as u16, target.matrix.cicp as u16)
}

fn target_for() -> Target {
    Target {
        primaries: BT2020,
        transfer: Coding { name: "smpte2084", cicp: 16 },
        matrix: BT2020_NCL,
    }
}

/// zscale names the identity matrix `gbr` and rejects `rgb` outright.
const RGB_MATRIX: &str = "gbr";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Size {
    pub width: u32,
    pub height: u32,
}

/// yuv420 has no odd dimensions.
fn even(n: f64) -> u32 {
    ((n / 2.0).round() * 2.0).max(2.0) as u32
}

pub fn fitted(width: u32, height: u32, max_edge: f64) -> Size {
    let longest = f64::from(width.max(height));
    let scale = (max_edge / longest).min(1.0);
    if scale == 1.0 {
        return Size { width, height };
    }
    Size { width: even(f64::from(width) * scale), height: even(f64::from(height) * scale) }
}

/// What this rendition ends up as: the requested edge, rounded to what the chroma can
/// carry.
///
/// `fitted` hands back the frame untouched when nothing needs shrinking, and a decode
/// can arrive odd - the masked-border crop takes asymmetric insets off it - so a
/// native-resolution 4:2:0 encode could be asked for an odd width and refuse outright.
/// Which makes the rounding a native-resolution concern alone: nothing else here can
/// produce an odd number.
pub fn target_size(width: u32, height: u32, options: &EncodeOptions) -> Size {
    let size = fitted(width, height, options.max_edge);
    if !options.still_chroma.subsampled() {
        return size;
    }
    // Down to even, never up. `even` rounds to nearest, which is right inside `fitted`
    // where the number is already below the source, and wrong here: a 533-row frame
    // would be asked for 534 and the encoder would be upscaling to invent a row. Losing
    // one is the only direction available.
    Size { width: size.width & !1, height: size.height & !1 }
}

/// The still's chroma, which is the `hdr_still_full_chroma` setting.
///
/// 4:2:0 by default, and that is a memory decision rather than a quality one. It keeps
/// luma whole and drops chroma to a quarter of the samples, which is measurably worse
/// per byte on a photograph - held to equal SSIM it needs 51% more of them - but it
/// roughly halves what libaom carries, and the encoder is the peak (DESIGN 10.7).
/// 4:4:4 is there for a library that would rather spend the memory.
///
/// Not identity/RGB either way: avifenc relabels y4m planes as GBR without converting
/// them (SSIM 0.55 against the correct decode), and RGB compresses worse than
/// decorrelated YCbCr anyway.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chroma {
    Yuv420,
    Yuv444,
}

impl Chroma {
    /// libavif's `avifPixelFormat`.
    pub fn avif_format(self) -> u32 {
        match self {
            Chroma::Yuv420 => 3,
            Chroma::Yuv444 => 1,
        }
    }

    fn subsampled(self) -> bool {
        self == Chroma::Yuv420
    }

    fn y4m(self) -> &'static str {
        match self {
            Chroma::Yuv420 => "420",
            Chroma::Yuv444 => "444",
        }
    }
}

/// 10-bit either way, which is what a PQ curve's shadows need: 8 bits band visibly where
/// it stretches them.
///
/// 4:4:4 is AV1 Profile 1, which is where Firefox is lost: its video path is the only
/// one there that composites HDR, and it plays Profile 1 washed out - PQ code values
/// shown with no transfer applied, which is what a decode that never reaches the HDR
/// compositor looks like. Chromium refuses Profile 1 video outright and Safari cannot
/// hardware-decode it, but neither needs the video. So a 4:4:4 still is one Firefox
/// cannot rewrap into anything it will composite, and `hdr_still_full_chroma` says so.
fn pixel_format(options: &EncodeOptions) -> &'static str {
    match options.still_chroma {
        Chroma::Yuv444 => "yuv444p10le",
        Chroma::Yuv420 => "yuv420p10le",
    }
}

/// The frame arrives already in its output transfer, so the input side of the
/// conversion has to say so: zscale reads the frame's tags, and rawvideo carries none.
///
/// It used to arrive linear and `zscale` applied the transfer, which is what `npl` was
/// there for. That put the still and the video in different domains between the grade
/// and the encode - the still's transfer being libavif's, in this process - so anything
/// belonging in between had to be written twice or not at all. `tone::encode_pq` does
/// it once for both now, and with `tin` matching `t` zimg does no transfer work at all:
/// what is left here is the matrix, the range and the depth.
fn filter_chain(options: &EncodeOptions, resize: Option<Size>) -> String {
    let target = target_for();
    // Resizing here would average PQ code values, so nothing does: `graded_with` fits
    // the frame in linear light before the transfer, and this only ever fires on the
    // reference path, where the argv is built for a frame that is already at size.
    let resize = match resize {
        None => String::new(),
        Some(size) => format!(":w={}:h={}", size.width, size.height),
    };
    let mut chain =
        format!("zscale=tin={}:min={RGB_MATRIX}:pin=bt2020:rin=full", target.transfer.name);
    let _ = write!(
        chain,
        ":t={}:m={}:p={}:r=tv{resize},format={}",
        target.transfer.name,
        target.matrix.name,
        target.primaries.name,
        pixel_format(options),
    );
    chain
}

/// The still's conversion, on the reference route: ffmpeg turns the graded frame into a
/// y4m and avifenc encodes and tags it.
///
/// ffmpeg's own avif muxer writes no colr box, so the primaries and transfer are lost -
/// and AVIF has no equivalent of the bitstream filter that used to put them back on the
/// video side. y4m carries the pixels and nothing else; avifenc does the tagging.
pub fn ffmpeg_args(width: u32, height: u32, options: &EncodeOptions) -> Vec<String> {
    let size = target_size(width, height, options);
    let resize = if size.width == width && size.height == height { None } else { Some(size) };

    let mut args: Vec<String> = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        // LibRaw's samples are in native order, so no byte swap is needed here.
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgb48le",
        "-video_size",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    args.push(format!("{width}x{height}"));
    for arg in ["-framerate", "1", "-i", "-", "-frames:v", "1", "-vf"] {
        args.push(arg.to_string());
    }
    args.push(filter_chain(options, resize));
    for arg in ["-strict", "-1", "-f", "yuv4mpegpipe"] {
        args.push(arg.to_string());
    }
    args.push(options.output_path.clone());
    args
}

/// The still's encode. `y4m_path` empty reads the frame from stdin instead of a file.
///
/// avifenc is here for its **container**, not its encoder: both media go through libaom
/// now, and what avifenc adds is an explicit nclx `colr` box, which is what Chrome reads
/// to decide a still is HDR. ffmpeg's avif muxer writes none, and AVIF has no equivalent
/// of the bitstream filter that repairs it on the video side.
pub fn avifenc_args(options: &EncodeOptions, y4m_path: &str) -> Vec<String> {
    let target = target_for();
    let mut args: Vec<String> = Vec::new();
    args.push("avifenc".to_string());
    args.push("--cicp".to_string());
    args.push(format!("{}/{}/{}", target.primaries.cicp, target.transfer.cicp, target.matrix.cicp));
    for arg in ["--range", "limited", "--depth", "10", "--yuv"] {
        args.push(arg.to_string());
    }
    // avifenc takes the chroma from the y4m and this flag only has to agree with it:
    // passing 444 while feeding a 4:2:0 y4m silently encoded 4:2:0 anyway, which is
    // how the subsampling went unnoticed once. `filter_chain` decides what the y4m
    // actually is, so both read the same setting.
    args.push(options.still_chroma.y4m().to_string());
    args.push("--speed".to_string());
    args.push(options.preset.min(10).to_string());
    // Both ends, since libavif quantises on the midpoint of the pair: `--min 0` would
    // ask for half the number the setting names, which is what it used to do.
    args.push("--min".to_string());
    args.push(options.crf.to_string());
    args.push("--max".to_string());
    args.push(options.crf.to_string());
    // Single-threaded by default, and it is most of the encode time: 9.6s against
    // 0.5s on a 24MP frame. The threads only go to work once there is something to
    // divide, though - libaom parallelises across tiles, and with one tile `--jobs
    // all` buys much less than it looks: 378ms to 265ms on a 3840px frame once the
    // frame is tiled, for a file the same size to within 2kB.
    args.push("--jobs".to_string());
    args.push("all".to_string());
    args.push("--autotiling".to_string());
    if y4m_path.is_empty() {
        // Must come before the output path, and forbids an input one.
        args.push("--stdin".to_string());
    } else {
        args.push(y4m_path.to_string());
    }
    args.push(options.output_path.clone());
    args
}

#[cfg(test)]
mod tests {
    /// Every argv the encoder builds, across the chroma and size matrix.
    ///
    /// Chroma is a dimension because it reaches three separate arguments that have to
    /// agree - zscale's output format, avifenc's `--yuv`, and whether the target size
    /// is forced even - and 4:2:0 with an odd dimension is refused outright rather
    /// than rounded.
    ///
    /// The argv carries colour signalling whose loss is invisible until a browser
    /// refuses to treat a file as HDR, which is why this is pinned rather than
    /// asserted piecewise.
    #[test]
    fn every_argv_the_encoder_builds() {
        // Unit separator, so a row survives arguments that contain spaces.
        const SEP: &str = " \x1f ";
        const SIZES: [(u32, u32); 4] = [
            (4024, 6024), // 24MP portrait
            (9504, 6336), // 61MP landscape
            (6336, 9504), // 61MP portrait
            (800, 533),   // already inside any edge
        ];

        let mut rows: Vec<String> = Vec::new();
        for still_full_chroma in [false, true] {
            for (width, height) in SIZES {
                for max_edge in [3840.0, 800.0, f64::INFINITY] {
                    let options = EncodeOptions {
                        still_chroma: match still_full_chroma {
                            true => Chroma::Yuv444,
                            false => Chroma::Yuv420,
                        },
                        output_path: "/out/rendition.avif".to_string(),
                        grade: SHIPPING_GRADE,
                        crf: 8,
                        preset: 8,
                        // Not in the argv: the frame is denoised and sharpened on this
                        // side, before either encoder is handed anything.
                        strengths: crate::image::Strengths::default(),
                        max_edge,
                    };
                    let chroma = match still_full_chroma {
                        true => "444",
                        false => "420",
                    };
                    // `Infinity`, not Rust's `inf`: the recorded rows came from
                    // JavaScript and the label is part of what is pinned.
                    let edge = match max_edge.is_finite() {
                        true => format!("{max_edge}"),
                        false => "Infinity".to_string(),
                    };
                    let key = format!("still|{chroma}|{width}x{height}|edge={edge}");

                    let size = target_size(width, height, &options);
                    rows.push(format!("{key}\tsize\t{}x{}", size.width, size.height));
                    rows.push(format!(
                        "{key}\tffmpeg\t{}",
                        ffmpeg_args(width, height, &options).join(SEP)
                    ));
                    let argv = avifenc_args(&options, "/out/rendition.avif.y4m");
                    rows.push(format!("{key}\tavifenc\t{}", argv.join(SEP)));
                }
            }
        }
        crate::pin::check("hdr_argv.pin.txt", &format!("{}\n", rows.join("\n")));
    }

    use super::*;

    /// The library's own defaults, which is what the recorded rows were captured with.
    const SHIPPING_GRADE: crate::hdr::Grade = crate::hdr::Grade {
        peak_nits: 1000.0,
        reference_white_nits: 203.0,
        white_quantile: 0.9,
    };

    fn options(max_edge: f64) -> EncodeOptions {
        options_with(max_edge, Chroma::Yuv420)
    }

    fn options_with(max_edge: f64, still_chroma: Chroma) -> EncodeOptions {
        EncodeOptions {
            still_chroma,
            output_path: "/out/rendition.avif".to_string(),
            grade: SHIPPING_GRADE,
            crf: 8,
            preset: 8,
            strengths: crate::image::Strengths::default(),
            max_edge,
        }
    }

    #[test]
    fn an_oversized_frame_is_fitted_on_both_axes_evenly() {
        let size = fitted(4024, 6024, 3840.0);
        assert_eq!(size, Size { width: 2566, height: 3840 });
        assert_eq!(size.width % 2, 0);
        assert_eq!(size.height % 2, 0);
    }

    #[test]
    fn a_frame_already_inside_the_edge_is_left_alone() {
        assert_eq!(fitted(800, 533, 3840.0), Size { width: 800, height: 533 });
        assert_eq!(fitted(800, 533, f64::INFINITY), Size { width: 800, height: 533 });
    }

    #[test]
    fn an_odd_frame_loses_a_row_to_subsampled_chroma_rather_than_gaining_one() {
        // 4:2:0 has no odd dimensions, and at native size nothing else is rounding
        // them - the masked-border crop can leave a frame odd. It has to come down:
        // asking a 533-row source for 534 makes the encoder invent a row.
        let subsampled = options_with(f64::INFINITY, Chroma::Yuv420);
        assert_eq!(target_size(801, 533, &subsampled), Size { width: 800, height: 532 });

        // 4:4:4 keeps every pixel it was given.
        let full = options_with(f64::INFINITY, Chroma::Yuv444);
        assert_eq!(target_size(801, 533, &full), Size { width: 801, height: 533 });
    }

    #[test]
    fn the_still_is_converted_by_ffmpeg_but_tagged_by_avifenc() {
        let args = ffmpeg_args(800, 533, &options(3840.0));
        assert!(args.contains(&"yuv4mpegpipe".to_string()), "a still leaves ffmpeg as y4m");
        assert!(!args.iter().any(|a| a.contains("av1_metadata")), "and is not encoded here");

        let avif = avifenc_args(&options(3840.0), "/tmp/x.y4m");
        let cicp = avif.iter().position(|a| a == "--cicp").expect("--cicp");
        assert_eq!(avif[cicp + 1], "9/16/9", "bt2020 / smpte2084 / bt2020nc");
    }

    #[test]
    fn a_still_reads_the_frame_from_stdin_when_no_y4m_is_named() {
        // The y4m is the whole frame uncompressed - ~366MB at native resolution - so
        // it goes down a pipe rather than through a file. avifenc requires `--stdin`
        // before the output path and forbids an input one alongside it.
        let args = avifenc_args(&options(3840.0), "");
        let stdin = args.iter().position(|a| a == "--stdin").expect("--stdin");
        assert_eq!(stdin, args.len() - 2, "must be the last flag before the output path");
        assert!(args.iter().any(|a| a == "--autotiling"), "libaom needs tiles to use its threads");
    }

    #[test]
    fn the_frame_reaches_zscale_already_in_its_output_transfer() {
        // The frame is PQ-encoded on this side now (`tone::encode_pq`), so the one
        // thing zscale must not be told is that its input is linear: it would apply the
        // curve a second time and hand the encoder a frame several stops dark.
        let args = ffmpeg_args(4024, 6024, &options(3840.0));
        let chain = args.iter().find(|a| a.starts_with("zscale")).expect("the filter chain");
        assert!(chain.contains("tin=smpte2084"), "{chain}");
        assert!(!chain.contains("npl="), "there is no transfer left for npl to scale");
    }
}
