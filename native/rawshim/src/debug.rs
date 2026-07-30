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
// Where a test genuinely needs the bytes - and after this there is one, the fit's
// injected-distortion case, which has to get an image *in* - they go through a file
// on disk rather than through memory. `dump_samples` is the only door and it
// announces itself in the log, so a production call is visible rather than silent.

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

fn channels(pixels: &Pixels) -> Vec<Channel> {
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
fn to_bytes(pixels: &Pixels) -> Vec<u8> {
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

/// Writes a frame's samples to a file, in native order.
///
/// **The only door that hands pixels over, and it goes through the filesystem.**
/// One test genuinely needs bytes rather than a summary, and rather than open a
/// buffer path for it - which is the thing every other part of this refactor
/// exists to close - it writes them somewhere and the caller reads them back.
///
/// It says so in the log every time. Nothing in the product calls this, and if a
/// line ever appears in a production log then something does and the log is where
/// that shows up rather than in a review that did not happen.
pub fn dump_samples(frame: &Frame, out_path: &str) -> Result<usize, String> {
    let bytes = to_bytes(&frame.pixels);
    eprintln!(
        "rawshim: WARNING bb_debug wrote {} bytes of pixel data to {out_path}. This is a \
         test and debug path; nothing in the product should reach it.",
        bytes.len(),
    );
    std::fs::write(out_path, &bytes).map_err(|e| format!("could not write {out_path}: {e}"))?;
    Ok(bytes.len())
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
    /// A decode's samples, written to a file. The guarded door.
    DumpDecode {
        path: String,
        depth: u32,
        #[serde(default)]
        rec2020_linear: bool,
        #[serde(default)]
        at_least_long_edge: u32,
        out_path: String,
    },
    /// A written image against a decode of the RAW it came from, by PSNR.
    ///
    /// "The rendition is the picture that went in" is a scalar question, so it is
    /// answered here rather than by shipping both images over to be subtracted.
    ComparePsnr {
        image_path: String,
        raw_path: String,
    },
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<DecodeSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub written: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comparison: Option<Comparison>,
}

pub fn run(command: &Command) -> Result<Reply, String> {
    match command {
        Command::DecodeSummary { path, depth, rec2020_linear, at_least_long_edge } => {
            let frame = crate::decode_frame(path, *depth, *rec2020_linear, *at_least_long_edge)
                .ok_or("could not decode")?;
            Ok(Reply { summary: Some(summarise(&frame)), ..Reply::default() })
        }
        Command::DumpDecode { path, depth, rec2020_linear, at_least_long_edge, out_path } => {
            let frame = crate::decode_frame(path, *depth, *rec2020_linear, *at_least_long_edge)
                .ok_or("could not decode")?;
            Ok(Reply {
                summary: Some(summarise(&frame)),
                written: Some(dump_samples(&frame, out_path)?),
                ..Reply::default()
            })
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
