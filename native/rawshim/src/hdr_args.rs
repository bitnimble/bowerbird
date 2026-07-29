// The command lines the HDR renditions are built with (DESIGN 10.7).
//
// Ported from TypeScript with the rest of the HDR encode, so the samples never
// cross the FFI boundary. The reasoning behind each flag came with it, because
// that reasoning is the reason the flags are what they are: every one of them was
// arrived at by watching a browser refuse to treat a file as HDR.

use std::fmt::Write as _;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    /// PQ, the only HDR transfer anything renders. HLG was carried for a while and
    /// never earned it: PQ is absolute where HLG is relative to the display's own
    /// range, which makes it the wrong curve for judging whether a panel reaches a
    /// given nits value.
    Pq,
    /// The SDR reference the HDR one is compared against.
    Sdr,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Medium {
    /// AVIF, 4:4:4. Chrome renders it as HDR on Android 14+ and desktop, Safari on
    /// macOS.
    Still,
    /// The same AVIF at 4:2:0, a control. 4:4:4 is AVIF's Advanced profile, which a
    /// decoder may refuse while still claiming AVIF support - only Baseline is
    /// mandatory - so without this beside it, a still failing on an Apple device
    /// cannot be told from a failure to handle HDR at all.
    StillBaseline,
    /// One-frame AV1 in MP4, for Firefox, which honours no HDR image tagging but
    /// does composite HDR video.
    Video,
}

impl Variant {
    pub fn parse(name: &str) -> Option<Variant> {
        match name {
            "pq" => Some(Variant::Pq),
            "sdr" => Some(Variant::Sdr),
            _ => None,
        }
    }
}

impl Medium {
    pub fn parse(name: &str) -> Option<Medium> {
        match name {
            "still" => Some(Medium::Still),
            "still-baseline" => Some(Medium::StillBaseline),
            "video" => Some(Medium::Video),
            _ => None,
        }
    }

    fn is_still(self) -> bool {
        !matches!(self, Medium::Video)
    }

    /// 4:2:0 only for the control; everything else keeps full chroma.
    fn chroma(self) -> &'static str {
        match self {
            Medium::StillBaseline => "420",
            _ => "444",
        }
    }
}

#[derive(Clone)]
pub struct EncodeOptions {
    pub variant: Variant,
    pub medium: Medium,
    pub output_path: String,
    /// Display peak the grade rolls highlights into, and the declared mastering peak.
    pub peak_nits: f64,
    /// Nits diffuse white maps to (BT.2408 HDR Reference White).
    pub reference_white_nits: f64,
    /// Quantile of the frame taken as diffuse white.
    pub white_quantile: f64,
    /// Constant-quality level; lower is better and slower.
    pub crf: i32,
    /// Encoder speed, 0 slowest. Clamped per encoder: libaom 0-8, avifenc 0-10.
    pub preset: i32,
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
const BT709: Coding = Coding { name: "bt709", cicp: 1 };

/// A still's SDR reference is tagged sRGB rather than BT.709. They share primaries,
/// but BT.709's transfer is a camera OETF, and a browser renders an untagged still
/// against sRGB - so sRGB is what makes the control look like an ordinary picture.
/// Video keeps BT.709, which is what a video decoder expects.
const STILL_SDR_TRANSFER: Coding = Coding { name: "iec61966-2-1", cicp: 13 };

fn target_for(variant: Variant, medium: Medium) -> Target {
    match variant {
        Variant::Pq => Target {
            primaries: BT2020,
            transfer: Coding { name: "smpte2084", cicp: 16 },
            matrix: BT2020_NCL,
        },
        Variant::Sdr => Target {
            primaries: BT709,
            transfer: if medium.is_still() { STILL_SDR_TRANSFER } else { BT709 },
            matrix: BT709,
        },
    }
}

/// zscale names the identity matrix `gbr` and rejects `rgb` outright.
const RGB_MATRIX: &str = "gbr";

/// SVT-AV1's constraint, stated in its own words: "Source Height must be less than
/// or equal to 8704". There is no matching width limit - 12288 wide encodes fine -
/// so it is portrait frames that hit it, and a 60MP one does.
///
/// The asymmetry means a tall frame could be encoded rotated and turned back in the
/// client, keeping the last 9% of its height. Not done: it is 9% of linear
/// resolution on a view already past any display's row count, and the obvious way to
/// signal the rotation - the MP4 display matrix - is exactly what Firefox 153 lists
/// as "not shown as HDR", so it would have to be CSS in the one browser this file
/// exists for.
const MAX_VIDEO_HEIGHT: f64 = 8704.0;

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

pub fn fitted_for_video(width: u32, height: u32, max_edge: f64) -> Size {
    let first = fitted(width, height, max_edge);
    if f64::from(first.height) <= MAX_VIDEO_HEIGHT {
        return first;
    }
    Size {
        width: even(f64::from(first.width) * (MAX_VIDEO_HEIGHT / f64::from(first.height))),
        height: MAX_VIDEO_HEIGHT as u32,
    }
}

/// What this rendition ends up as. Video has an encoder ceiling on top of the
/// requested edge; a still does not.
pub fn target_size(width: u32, height: u32, options: &EncodeOptions) -> Size {
    match options.medium {
        Medium::Video => fitted_for_video(width, height, options.max_edge),
        _ => fitted(width, height, options.max_edge),
    }
}

/// A number as JavaScript's `String()` would render it, since these strings are
/// compared against a pin captured from the TypeScript this replaces. An integral
/// f64 prints without a decimal point there; Rust's `{}` would print `1000` too,
/// but `2.5` must stay `2.5` rather than becoming `2`.
fn num(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        return format!("{}", value as i64);
    }
    format!("{value}")
}

/// Rec.2020 primaries and the D65 white point, as SMPTE ST 2086 expects them.
fn mastering_display(peak_nits: f64) -> String {
    format!(
        "mastering-display=G(0.265,0.690)B(0.150,0.060)R(0.680,0.320)WP(0.3127,0.3290)L({},0.0001):content-light={},{}",
        num(peak_nits),
        num(peak_nits),
        num((peak_nits / 2.0).round()),
    )
}

/// The still is 4:4:4. It is a photograph, and 4:2:0 keeps luma at full resolution
/// while dropping chroma to a quarter of the samples, smearing precisely the
/// saturated edges a photo is judged on. Not identity/RGB: avifenc relabels y4m
/// planes as GBR without converting them (SSIM 0.55 against the correct decode),
/// and RGB compresses worse than decorrelated YCbCr anyway.
///
/// The video is 4:2:0, which is AV1 Profile 0. 4:4:4 was tried and reverted: it is
/// Profile 1, Chromium refuses it outright, Safari cannot hardware-decode it, and on
/// Firefox/Windows it played but rendered washed out - PQ code values shown with no
/// transfer applied, which is what a decode that never reaches the HDR compositor
/// looks like.
///
/// A still is 10-bit whatever the variant, so its SDR reference differs from the HDR
/// ones only in transfer and tagging. Video keeps 8-bit SDR, which is what an SDR
/// video actually is.
fn pixel_format(variant: Variant, medium: Medium) -> String {
    if medium.is_still() {
        return format!("yuv{}p10le", medium.chroma());
    }
    match variant {
        Variant::Sdr => "yuv420p".to_string(),
        Variant::Pq => "yuv420p10le".to_string(),
    }
}

/// The grade hands back display-referred Rec.2020 linear at full range, so the input
/// side of the conversion has to say so: zscale reads the frame's tags, and rawvideo
/// carries none. npl ties linear 1.0 to absolute brightness, and the grade has
/// already put the display's peak there.
fn filter_chain(options: &EncodeOptions, resize: Option<Size>) -> String {
    let target = target_for(options.variant, options.medium);
    let npl = match options.variant {
        Variant::Sdr => String::new(),
        Variant::Pq => format!(":npl={}", num(options.peak_nits)),
    };
    // Resizing inside zscale keeps it in the linear light the decode handed over,
    // which is where downscaling is correct; a resize after the transfer would
    // average PQ code values and darken the result.
    let resize = match resize {
        None => String::new(),
        Some(size) => format!(":w={}:h={}", size.width, size.height),
    };
    let mut chain = format!("zscale=tin=linear:min={RGB_MATRIX}:pin=bt2020:rin=full");
    let _ = write!(
        chain,
        ":t={}:m={}:p={}:r=tv{npl}{resize},format={}",
        target.transfer.name,
        target.matrix.name,
        target.primaries.name,
        pixel_format(options.variant, options.medium),
    );
    chain
}

pub fn ffmpeg_args(width: u32, height: u32, options: &EncodeOptions) -> Vec<String> {
    let target = target_for(options.variant, options.medium);
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

    // The still is only converted here, then handed to avifenc: ffmpeg's avif muxer
    // writes no colr box, so the primaries and transfer are lost exactly as they are
    // below, and AVIF has no equivalent of the bitstream filter to put them back.
    // y4m carries the pixels and nothing else; avifenc does the tagging.
    if options.medium.is_still() {
        for arg in ["-strict", "-1", "-f", "yuv4mpegpipe"] {
            args.push(arg.to_string());
        }
        args.push(options.output_path.clone());
        return args;
    }

    // The encoder drops the primaries and transfer on its own, leaving a file that
    // says "unknown" where it matters most, so av1_metadata writes them back into
    // the sequence header. Verified with ffprobe: without the filter the stream
    // reports color_primaries=unknown, with it bt2020/smpte2084.
    let metadata = format!(
        "av1_metadata=color_primaries={}:transfer_characteristics={}:matrix_coefficients={}:color_range=tv",
        target.primaries.cicp, target.transfer.cicp, target.matrix.cicp,
    );

    // SVT-AV1, which does Profile 0 only - exactly what is wanted here, and it is
    // 2.4x faster than libaom and the only one of the two that can carry the
    // mastering-display and content-light metadata through ffmpeg.
    for arg in ["-c:v", "libsvtav1", "-preset"] {
        args.push(arg.to_string());
    }
    args.push(options.preset.to_string());
    args.push("-crf".to_string());
    args.push(options.crf.to_string());
    for (flag, value) in [
        ("-color_primaries", target.primaries.name),
        ("-color_trc", target.transfer.name),
        ("-colorspace", target.matrix.name),
        ("-color_range", "tv"),
    ] {
        args.push(flag.to_string());
        args.push(value.to_string());
    }
    // SMPTE ST 2086 and MaxCLL/MaxFALL. Declared rather than measured: they are a
    // hint for a display's tone mapping, and a histogram pass would not change what
    // a panel does with one still. The SDR reference gets none, so there is nothing
    // for it to be tone-mapped against.
    if options.variant != Variant::Sdr {
        args.push("-svtav1-params".to_string());
        args.push(mastering_display(options.peak_nits));
    }
    args.push("-bsf:v".to_string());
    args.push(metadata);
    // Seekable and decodable from the first byte, since it is displayed rather than
    // streamed.
    args.push("-movflags".to_string());
    args.push("+faststart".to_string());
    args.push(options.output_path.clone());
    args
}

pub fn avifenc_args(options: &EncodeOptions, y4m_path: &str) -> Vec<String> {
    let target = target_for(options.variant, options.medium);
    let mut args: Vec<String> = Vec::new();
    args.push("avifenc".to_string());
    // The whole point of routing through avifenc: an explicit nclx colr box, which
    // is what Chrome reads to decide a still is HDR.
    args.push("--cicp".to_string());
    args.push(format!("{}/{}/{}", target.primaries.cicp, target.transfer.cicp, target.matrix.cicp));
    for arg in ["--range", "limited", "--depth", "10", "--yuv"] {
        args.push(arg.to_string());
    }
    // avifenc takes the chroma from the y4m and this flag only has to agree with it:
    // passing 444 while feeding a 4:2:0 y4m silently encoded 4:2:0 anyway, which is
    // how the subsampling went unnoticed.
    args.push(options.medium.chroma().to_string());
    args.push("--speed".to_string());
    args.push(options.preset.min(10).to_string());
    args.push("--min".to_string());
    args.push("0".to_string());
    args.push("--max".to_string());
    args.push(options.crf.to_string());
    // Single-threaded by default, and it is most of the encode time: 9.6s against
    // 0.5s on a 24MP frame.
    args.push("--jobs".to_string());
    args.push("all".to_string());
    args.push(y4m_path.to_string());
    args.push(options.output_path.clone());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(variant: Variant, medium: Medium, max_edge: f64) -> EncodeOptions {
        EncodeOptions {
            variant,
            medium,
            output_path: "/out/rendition.avif".to_string(),
            peak_nits: 1000.0,
            reference_white_nits: 203.0,
            white_quantile: 0.9,
            crf: 8,
            preset: 8,
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
    fn a_tall_video_meets_the_encoder_ceiling_and_a_still_does_not() {
        // SVT-AV1 refuses a source taller than 8704, so only the video is capped.
        let video = fitted_for_video(6336, 9504, f64::INFINITY);
        assert_eq!(video.height, 8704);
        assert_eq!(fitted(6336, 9504, f64::INFINITY), Size { width: 6336, height: 9504 });
    }

    #[test]
    fn the_still_is_converted_by_ffmpeg_but_tagged_by_avifenc() {
        let args = ffmpeg_args(800, 533, &options(Variant::Pq, Medium::Still, 3840.0));
        assert!(args.contains(&"yuv4mpegpipe".to_string()), "a still leaves ffmpeg as y4m");
        assert!(!args.iter().any(|a| a.contains("av1_metadata")), "and is not encoded here");

        let avif = avifenc_args(&options(Variant::Pq, Medium::Still, 3840.0), "/tmp/x.y4m");
        let cicp = avif.iter().position(|a| a == "--cicp").expect("--cicp");
        assert_eq!(avif[cicp + 1], "9/16/9", "bt2020 / smpte2084 / bt2020nc");
    }

    #[test]
    fn the_video_restates_the_signalling_the_encoder_drops() {
        let args = ffmpeg_args(800, 533, &options(Variant::Pq, Medium::Video, 3840.0));
        let bsf = args.iter().find(|a| a.contains("av1_metadata")).expect("the bitstream filter");
        assert!(bsf.contains("color_primaries=9"));
        assert!(bsf.contains("transfer_characteristics=16"));
        assert!(bsf.contains("matrix_coefficients=9"));
    }

    #[test]
    fn the_sdr_reference_gets_no_pq_transfer_and_no_mastering_metadata() {
        let args = ffmpeg_args(800, 533, &options(Variant::Sdr, Medium::Video, 3840.0));
        assert!(!args.iter().any(|a| a.contains("npl=")), "npl is meaningless without PQ");
        assert!(!args.iter().any(|a| a == "-svtav1-params"), "nothing to tone-map against");
    }

    #[test]
    fn a_still_sdr_reference_is_tagged_srgb_where_the_video_one_is_bt709() {
        let still = avifenc_args(&options(Variant::Sdr, Medium::Still, 3840.0), "/tmp/x.y4m");
        let cicp = still.iter().position(|a| a == "--cicp").expect("--cicp");
        assert_eq!(still[cicp + 1], "1/13/1", "sRGB transfer, not BT.709's camera OETF");

        let video = ffmpeg_args(800, 533, &options(Variant::Sdr, Medium::Video, 3840.0));
        let trc = video.iter().position(|a| a == "-color_trc").expect("-color_trc");
        assert_eq!(video[trc + 1], "bt709");
    }

    #[test]
    fn the_baseline_control_differs_in_chroma_and_nothing_else() {
        let full = ffmpeg_args(800, 533, &options(Variant::Pq, Medium::Still, 3840.0));
        let base = ffmpeg_args(800, 533, &options(Variant::Pq, Medium::StillBaseline, 3840.0));
        let differing: Vec<_> = full.iter().zip(&base).filter(|(a, b)| a != b).collect();
        assert_eq!(differing.len(), 1, "one argument apart: {differing:?}");
        assert!(differing[0].0.contains("yuv444p10le") && differing[0].1.contains("yuv420p10le"));
    }

    #[test]
    fn the_resize_happens_in_linear_light_before_the_transfer() {
        let args = ffmpeg_args(4024, 6024, &options(Variant::Pq, Medium::Still, 3840.0));
        let chain = args.iter().find(|a| a.starts_with("zscale")).expect("the filter chain");
        let resize = chain.find("w=2566").expect("the resize");
        let format = chain.find(",format=").expect("the pixel format");
        assert!(resize < format, "zscale resizes before it converts");
        assert!(chain.contains("tin=linear"), "and is told the input is linear");
    }

    #[test]
    fn numbers_render_the_way_javascript_printed_them() {
        // These strings are compared against a pin captured from the TypeScript.
        assert_eq!(num(1000.0), "1000");
        assert_eq!(num(203.0), "203");
        assert_eq!(num(2.5), "2.5");
    }
}
