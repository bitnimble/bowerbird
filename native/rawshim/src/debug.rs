// What the tests need to know about pixels, computed here rather than handed over.
//
// The pins have to assert on what this library produced - that two decode routes
// agree byte for byte, that a grade is stable, that a matched render is closer to
// the camera's JPEG than a plain one. That is a real need and it is why the handle
// API outlived every production caller: reading samples back was the only way to
// answer it.
//
// It is not the only way. A digest, a per-channel stat and a strided sample say
// everything those assertions actually check, and computing them here means no
// buffer crosses and no lifetime has to be managed to make it possible. The
// commands below are that: questions in, numbers out.
//
// There turned out to be no exception. The last candidate was a black-border check
// that reads four specific pixels, one per edge - which no aggregate replaces, since
// the frame is mostly picture and a bar barely moves a mean, but which is four
// triples and so a summary like any other (`PixelsAt`). No samples leave this side.

use crate::frame::{Frame, Pixels};
use serde::{Deserialize, Serialize};

/// Per-channel range and average, which is what a "did the grade move" assertion
/// actually reads. A whole-frame mean would hide a shift in one channel, and a
/// shift in one channel is what a wrong matrix row looks like.
#[derive(Serialize)]
pub struct Channel {
    pub min: u32,
    pub max: u32,
    pub mean: f64,
}

pub(crate) fn channels(pixels: &Pixels) -> Vec<Channel> {
    (0..3)
        .map(|c| {
            let (mut min, mut max, mut sum, mut n) = (u32::MAX, 0u32, 0f64, 0u64);
            let mut visit = |value: u32| {
                min = min.min(value);
                max = max.max(value);
                sum += f64::from(value);
                n += 1;
            };
            match pixels {
                Pixels::Eight(data) => data.iter().skip(c).step_by(3).for_each(|v| visit(u32::from(*v))),
                Pixels::Sixteen(data) => data.iter().skip(c).step_by(3).for_each(|v| visit(u32::from(*v))),
            }
            Channel { min: if n == 0 { 0 } else { min }, max, mean: if n == 0 { 0.0 } else { sum / n as f64 } }
        })
        .collect()
}

/// The frame's bytes in native order, for a digest.
///
/// Copied rather than cast. Viewing a `&[u16]` as `&[u8]` needs `align_to` or a
/// crate, and this is a debug path where an allocation costs nothing anybody waits
/// for - so it buys the module out of needing `unsafe` at all, which is the point
/// of the exercise. Native order, so the digest sees exactly the bytes the old
/// byte-buffer did and a pin regenerated against it compares the same thing.
pub(crate) fn to_bytes(pixels: &Pixels) -> Vec<u8> {
    match pixels {
        Pixels::Eight(data) => data.clone(),
        Pixels::Sixteen(data) => data.iter().flat_map(|sample| sample.to_ne_bytes()).collect(),
    }
}

/// Everything a decode assertion reads, without the decode crossing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeSummary {
    pub width: usize,
    pub height: usize,
    pub depth: u32,
    /// Samples, not bytes: a 16-bit frame has half as many as it has bytes, and a
    /// test comparing depths wants the distinction.
    pub samples: usize,
    pub bytes: usize,
    pub halved: bool,
    /// Whether the frame came straight out of `imgdata.image` rather than through
    /// `dcraw_make_mem_image`. The differential pin checks its two arms took
    /// different routes; without it a passing comparison proves nothing (10.4).
    pub direct: bool,
    pub sha1: String,
    pub channels: Vec<Channel>,
}

pub fn summarise(frame: &Frame) -> DecodeSummary {
    let bytes = to_bytes(&frame.pixels);
    DecodeSummary {
        width: frame.width,
        height: frame.height,
        depth: frame.pixels.depth(),
        samples: frame.pixels.len(),
        bytes: bytes.len(),
        halved: frame.halved,
        direct: frame.direct,
        sha1: sha1_hex(&bytes),
        channels: channels(&frame.pixels),
    }
}

/// SHA-1 of a byte slice, hex.
///
/// Hand-rolled because the alternative is a dependency for one digest used by one
/// test, and the algorithm is short and fully specified. Only ever compared against
/// itself - a pin says "the same as last time", not "this specific hash".
fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut message = data.to_vec();
    let bits = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e]) {
            *slot = slot.wrapping_add(value);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

/// SHA-256 of a byte slice, hex.
///
/// Hand-rolled for the same reason as the SHA-1 beside it, and SHA-256 specifically
/// because `hdr_grade.pin.txt` records one per case. Those digests were generated by
/// the TypeScript this subsystem replaced, so computing the same function here keeps
/// the pin valid unregenerated - which makes it say "the grade is unchanged since
/// before the port", where a regenerated pin in a new digest would only say "the
/// grade is unchanged since this commit".
#[cfg(test)]
pub(crate) fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
        0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
        0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
        0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
        0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
        0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
        0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
        0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
        0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
        0xc671_78f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a, 0x510e_527f, 0x9b05_688c, 0x1f83_d9ab,
        0x5be0_cd19,
    ];
    let mut message = data.to_vec();
    let bits = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choose = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(choose)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(majority);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

/// What a debug command asks for.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    /// A decode, described rather than returned.
    DecodeSummary {
        path: String,
        depth: u32,
        #[serde(default)]
        rec2020_linear: bool,
        #[serde(default)]
        at_least_long_edge: u32,
    },
    /// A written image against a decode of the RAW it came from, by PSNR.
    ///
    /// "The rendition is the picture that went in" is a scalar question, so it is
    /// answered here rather than by shipping both images over to be subtracted.
    ComparePsnr {
        image_path: String,
        raw_path: String,
    },
    /// One HDR rendition, encoded to `grade.output_path`.
    EncodeHdr {
        path: String,
        #[serde(default)]
        with_match: bool,
        grade: GradeSpec,
        /// The one-frame AV1 twin, where one is wanted.
        #[serde(default)]
        video_output_path: String,
        /// Decode to this longest edge before grading. 0 takes the whole frame, which
        /// is what the pins want and what the encode tests cannot afford.
        #[serde(default)]
        decode_size: u32,
    },
    /// Written images against the preview of the RAW they were built from.
    ///
    /// For the worker test, whose question is which of two renditions landed closer to
    /// what the camera produced - a pair of scalars, not three images. It stays a
    /// command because that test drives a real worker thread, which is the thing it is
    /// actually about.
    DeltaEToPreview {
        image_paths: Vec<String>,
        raw_path: String,
    },
    /// The camera's embedded preview, described.
    PreviewSummary {
        path: String,
        #[serde(default)]
        size: u32,
    },
}

/// The parts of an HDR encode a pin varies.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeSpec {
    #[serde(default)]
    pub output_path: String,
    pub peak_nits: f64,
    pub reference_white_nits: f64,
    pub white_quantile: f64,
    pub crf: i32,
    pub preset: i32,
    /// Null for the frame's own size. `JSON.stringify` renders an infinite edge as
    /// null, so this is what the other side can actually send.
    pub max_edge: Option<f64>,
    #[serde(default)]
    pub still_full_chroma: bool,
    /// "still" or "video". A still gets avifenc after ffmpeg; a video does not, and
    /// has no say in its chroma.
    #[serde(default)]
    pub medium: Option<String>,
}

impl GradeSpec {
    fn options(&self) -> crate::hdr_args::EncodeOptions {
        crate::hdr_args::EncodeOptions {
            medium: match self.medium.as_deref() {
                Some(name) => crate::hdr_args::Medium::parse(name).unwrap_or(crate::hdr_args::Medium::Still),
                None => crate::hdr_args::Medium::Still,
            },
            still_chroma: match self.still_full_chroma {
                true => crate::hdr_args::Chroma::Yuv444,
                false => crate::hdr_args::Chroma::Yuv420,
            },
            output_path: self.output_path.clone(),
            peak_nits: self.peak_nits,
            reference_white_nits: self.reference_white_nits,
            white_quantile: self.white_quantile,
            crf: self.crf,
            preset: self.preset,
            max_edge: self.max_edge.unwrap_or(f64::INFINITY),
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<DecodeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison: Option<Comparison>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub against_preview: Option<AgainstPreview>,
}

/// How close one or more images sit to the camera's own preview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgainstPreview {
    /// One mean deltaE76 per image, in the order asked for.
    pub mean_delta_e: Vec<f64>,
    pub counted: usize,
    pub sizes: Vec<[usize; 2]>,
    pub preview: [usize; 2],
}

/// The decode and the SDR fit both pins share, kept between calls.
///
/// Not a cache in the performance sense - it is what makes the migration possible at
/// all. Both pin files hold one 16-bit decode and one SDR profile across every case
/// they run, because the fit evaluates tens of candidate geometries and costs more
/// than everything else in the file combined. Asking per command would have run it
/// five times over and turned a pin into a timeout.
///
/// Test-only, like the rest of this module, so an entry lives until the process ends.
struct Shared {
    linear: std::collections::HashMap<String, std::sync::Arc<Frame>>,
    profiles: std::collections::HashMap<String, std::sync::Arc<Option<crate::fit::Profile>>>,
}

fn shared() -> &'static std::sync::Mutex<Shared> {
    static SHARED: std::sync::OnceLock<std::sync::Mutex<Shared>> = std::sync::OnceLock::new();
    SHARED.get_or_init(|| {
        std::sync::Mutex::new(Shared {
            linear: std::collections::HashMap::new(),
            profiles: std::collections::HashMap::new(),
        })
    })
}

fn linear_decode(path: &str) -> Result<std::sync::Arc<Frame>, String> {
    if let Some(frame) = shared().lock().unwrap().linear.get(path) {
        return Ok(frame.clone());
    }
    let frame = std::sync::Arc::new(
        crate::decode_frame(path, 16, true, 0).ok_or("could not decode scene-linear")?,
    );
    shared().lock().unwrap().linear.insert(path.to_string(), frame.clone());
    Ok(frame)
}

/// The SDR fit, which supplies the geometry the HDR colour fit reuses (10.8.1).
fn sdr_profile(path: &str) -> Result<std::sync::Arc<Option<crate::fit::Profile>>, String> {
    if let Some(profile) = shared().lock().unwrap().profiles.get(path) {
        return Ok(profile.clone());
    }
    let render = crate::decode_frame(path, 8, false, 0).ok_or("could not decode")?;
    let profile = std::sync::Arc::new(crate::fit_profile_for(&render, path));
    shared().lock().unwrap().profiles.insert(path.to_string(), profile.clone());
    Ok(profile)
}

/// The HDR colour match, fitted the way a job with an SDR rendition fits it.
fn hdr_match(path: &str, linear: &Frame, spec: &GradeSpec) -> Result<Option<crate::hdr_fit::HdrMatch>, String> {
    let profile = sdr_profile(path)?;
    let Some(profile) = profile.as_ref() else { return Ok(None) };
    Ok(crate::fit_hdr_for(linear, path, spec.white_quantile, Some(profile)))
}

/// Luma quantiles of a graded frame, in nits.
///
/// BT.2020 luma of the PQ-coded samples, which is what the assertion means by "how
/// bright": the anchor is measured on the brightest component, so a luma quantile
/// lands under the reference rather than on it, and it is the drift that is read.
#[cfg(test)]
pub(crate) fn luma_quantiles(samples: &[u16], peak_nits: f64, wanted: &[f64]) -> Vec<f64> {
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut luma: Vec<f64> = samples
        .chunks_exact(3)
        .map(|p| {
            ((0.2627 * f64::from(p[0]) + 0.678 * f64::from(p[1]) + 0.0593 * f64::from(p[2]))
                / 65535.0)
                * peak_nits
        })
        .collect();
    luma.sort_by(f64::total_cmp);
    wanted
        .iter()
        .map(|q| match luma.is_empty() {
            true => 0.0,
            false => luma[((q * (luma.len() - 1) as f64).floor() as usize).min(luma.len() - 1)],
        })
        .collect()
}

pub fn run(command: &Command) -> Result<Reply, String> {
    match command {
        Command::DecodeSummary { path, depth, rec2020_linear, at_least_long_edge } => {
            let frame = crate::decode_frame(path, *depth, *rec2020_linear, *at_least_long_edge)
                .ok_or("could not decode")?;
            Ok(Reply { summary: Some(summarise(&frame)), ..Reply::default() })
        }
        Command::ComparePsnr { image_path, raw_path } => {
            let encoded = std::fs::read(image_path)
                .map_err(|e| format!("could not read {image_path}: {e}"))?;
            let written = crate::vips::Pipeline::decode_upright(&encoded)
                .and_then(crate::vips::Pipeline::finish)
                .map_err(|e| format!("could not decode {image_path}: {e}"))?;
            let expected = crate::decode_frame(raw_path, 8, false, 0).ok_or("could not decode")?;
            let expected = expected.rgb8().ok_or("the comparison needs an 8-bit decode")?;
            Ok(Reply {
                comparison: Some(compare(written.as_ref(), expected)),
                ..Reply::default()
            })
        }
        Command::EncodeHdr { path, with_match, grade, video_output_path, decode_size } => {
            // Only the whole-frame decode is shared: it is the one the pins reuse, and
            // a sized one is cheap enough that caching it would only risk handing back
            // the wrong size.
            let linear = match decode_size {
                0 => linear_decode(path)?,
                size => std::sync::Arc::new(
                    crate::decode_frame(path, 16, true, *size).ok_or("could not decode")?,
                ),
            };
            let matched = match with_match {
                false => None,
                true => hdr_match(path, &linear, grade)?,
            };
            let samples = linear.samples16().ok_or("the encode needs a 16-bit decode")?;
            let source = crate::hdr::Source {
                samples,
                width: linear.width,
                height: linear.height,
            };
            crate::hdr::encode_pair(
                crate::hdr::Decode::Borrowed(source),
                &grade.options(),
                match video_output_path.is_empty() {
                    true => None,
                    false => Some(video_output_path),
                },
                matched.as_ref(),
            )?;
            Ok(Reply::default())
        }
        Command::DeltaEToPreview { image_paths, raw_path } => {
            let images: Vec<crate::vips::Rgb> = image_paths
                .iter()
                .map(|path| {
                    let encoded = std::fs::read(path).map_err(|e| format!("could not read {path}: {e}"))?;
                    crate::vips::Pipeline::decode_upright(&encoded)
                        .and_then(crate::vips::Pipeline::finish)
                        .map_err(|e| format!("could not decode {path}: {e}"))
                })
                .collect::<Result<_, String>>()?;
            let longest = images.iter().map(|image| image.width.max(image.height)).max().unwrap_or(0);
            let preview = crate::decode_embedded_rgb(raw_path, longest).ok_or("no embedded preview")?;

            // Sampled on a normalised grid rather than by index, because the images are
            // not the same shape: the preview is distortion-cropped, so at an 800px long
            // edge it comes out a pixel narrower than the render and a shared index
            // would slide a pixel per row.
            let mut totals = vec![0f64; images.len()];
            let mut counted = 0usize;
            for step in 0..4000u32 {
                let u = f64::from(step % 61) / 61.0;
                let v = (f64::from(step) / 4000.0) % 1.0;
                let target = sample(preview.as_ref(), u, v);
                for (total, image) in totals.iter_mut().zip(&images) {
                    *total += crate::fit::delta_e76(&sample(image.as_ref(), u, v), &target);
                }
                counted += 1;
            }
            Ok(Reply {
                against_preview: Some(AgainstPreview {
                    mean_delta_e: totals.iter().map(|t| t / counted as f64).collect(),
                    counted,
                    sizes: images.iter().map(|i| [i.width, i.height]).collect(),
                    preview: [preview.width, preview.height],
                }),
                ..Reply::default()
            })
        }
        Command::PreviewSummary { path, size } => {
            let preview = crate::decode_embedded_rgb(path, *size as usize).ok_or("no embedded preview")?;
            let pixels = Pixels::Eight(preview.data);
            Ok(Reply {
                summary: Some(DecodeSummary {
                    width: preview.width,
                    height: preview.height,
                    depth: 8,
                    samples: pixels.len(),
                    bytes: pixels.len(),
                    halved: false,
                    direct: false,
                    sha1: sha1_hex(&to_bytes(&pixels)),
                    channels: channels(&pixels),
                }),
                ..Reply::default()
            })
        }
    }
}

/// The pixel at a fractional position, so images of different shapes compare.
fn sample(image: crate::vips::RgbRef<'_>, u: f64, v: f64) -> [f64; 3] {
    let x = ((u * image.width as f64) as usize).min(image.width.saturating_sub(1));
    let y = ((v * image.height as f64) as usize).min(image.height.saturating_sub(1));
    let i = (y * image.width + x) * 3;
    match image.data.get(i + 2) {
        None => [0.0, 0.0, 0.0],
        Some(_) => [
            f64::from(image.data[i]),
            f64::from(image.data[i + 1]),
            f64::from(image.data[i + 2]),
        ],
    }
}

/// How close two images are.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub width: usize,
    pub height: usize,
    /// Mean PSNR in dB. `None` when the two are identical, since the value is not
    /// finite and JSON has no way to say so.
    pub psnr: Option<f64>,
}

fn compare(written: crate::vips::RgbRef<'_>, expected: crate::vips::RgbRef<'_>) -> Comparison {
    let n = written.data.len().min(expected.data.len());
    let mut sum = 0f64;
    for i in 0..n {
        let delta = f64::from(written.data[i]) - f64::from(expected.data[i]);
        sum += delta * delta;
    }
    let mse = sum / n.max(1) as f64;
    Comparison {
        width: written.width,
        height: written.height,
        psnr: (mse > 0.0).then(|| 10.0 * (255.0f64 * 255.0 / mse).log10()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_digest_matches_the_reference_vectors() {
        // Hand-rolled, so it is held to the published vectors rather than to itself.
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(
            sha1_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // Past one block, where the padding and the length suffix are easiest to get
        // wrong: 64 bytes is exactly a block, so this exercises the extra one.
        assert_eq!(sha1_hex(&[b'a'; 64]), "0098ba824b5c16427bd7a1122a5a442a25ec644d");
    }

    #[test]
    fn the_grade_digest_matches_the_reference_vectors() {
        // The one that has to be exactly right rather than merely stable:
        // `hdr_grade.pin.txt` holds SHA-256es produced by the TypeScript this
        // replaced, so a subtly wrong implementation here would fail the pin and read
        // as a changed grade.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            sha256_hex(&[b'a'; 64]),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
    }

    #[test]
    fn channels_are_reported_separately() {
        // A whole-frame mean would hide a shift in one channel, which is what a wrong
        // matrix row looks like.
        let frame = Frame::new(2, 1, Pixels::Eight(vec![0, 10, 20, 2, 12, 22]));
        let stats = channels(&frame.pixels);
        assert_eq!((stats[0].min, stats[0].max), (0, 2));
        assert_eq!((stats[1].min, stats[1].max), (10, 12));
        assert_eq!((stats[2].min, stats[2].max), (20, 22));
        assert!((stats[1].mean - 11.0).abs() < 1e-9);
    }

    #[test]
    fn sixteen_bit_samples_digest_as_their_native_bytes() {
        // The digest has to see the same bytes the old byte-buffer did, or every pin
        // regenerated against it would be comparing a different thing.
        let frame = Frame::new(1, 1, Pixels::Sixteen(vec![0x0102, 0x0304, 0x0506]));
        let expected: Vec<u8> =
            [0x0102u16, 0x0304, 0x0506].iter().flat_map(|v| v.to_ne_bytes()).collect();
        assert_eq!(summarise(&frame).sha1, sha1_hex(&expected));
        assert_eq!(summarise(&frame).bytes, 6);
        assert_eq!(summarise(&frame).samples, 3);
    }
}
