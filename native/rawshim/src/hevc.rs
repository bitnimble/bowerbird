//! The HEVC half of a HEIC: coded tiles into the interleaved code values `linearise` reads.
//!
//! **Everything here is transport, not a codec.** `rust_h265` decodes the bitstream; what this does
//! is get the bitstream into the shape it wants - HEIF stores length-prefixed NAL units and keeps
//! the parameter sets in an `hvcC` property, where a decoder expects Annex B and the parameter sets
//! in front of the slices - and then take the YCbCr planes it hands back to RGB, and the grid's
//! tiles into one raster.

use crate::heif::{Nclx, Picture};

/// A picture's samples as interleaved RGB code values at its own depth.
///
/// `u16` whatever the depth is, because that is what `linearise::Picture::upload` takes and what a
/// 10-bit still needs: the table is indexed by the code, so nothing is scaled on the way.
pub struct Coded {
    pub samples: Vec<u16>,
    pub width: usize,
    pub height: usize,
    pub depth: u32,
}

/// Decodes every tile of a picture and composes them.
///
/// A single-item picture is the one-by-one case of the same walk, so there is one path rather than
/// two that have to agree about cropping.
pub fn decode(picture: &Picture) -> Result<Coded, String> {
    let (columns, _) = picture.grid;
    let (tile_w, tile_h) = picture.tile;
    if tile_w == 0 || tile_h == 0 {
        return Err("this HEIF picture does not say how big a tile is".to_string());
    }
    let parameter_sets = annex_b_parameter_sets(&picture.config)?;
    let length_size = length_size(&picture.config)?;

    let mut samples = vec![0u16; picture.width * picture.height * 3];
    let mut depth = picture.depth;
    for (at, tile) in picture.tiles.iter().enumerate() {
        let (column, row) = (at % columns, at / columns);
        let frame = decode_one(&parameter_sets, tile, length_size)?;
        depth = u32::from(frame.bit_depth);
        // The last column and row are the grid's crop: a tile is a whole tile in the file and the
        // picture's declared size is smaller than the raster they tile out to. Bounded by what
        // the decoder actually produced as well, since a coded frame is padded up to whole coding
        // units and a file whose `ispe` claims more than its bitstream carries is a file, not a
        // panic.
        let across = tile_w
            .min(picture.width.saturating_sub(column * tile_w))
            .min(frame.width as usize);
        let down = tile_h
            .min(picture.height.saturating_sub(row * tile_h))
            .min(frame.height as usize);
        if across == 0 || down == 0 {
            continue;
        }
        to_rgb(&frame, picture.nclx, &mut Placed {
            samples: &mut samples,
            stride: picture.width,
            left: column * tile_w,
            top: row * tile_h,
            width: across,
            height: down,
        })?;
    }
    Ok(Coded { samples, width: picture.width, height: picture.height, depth })
}

fn decode_one(
    parameter_sets: &[u8],
    tile: &[u8],
    length_size: usize,
) -> Result<rust_h265::Frame, String> {
    let mut stream = parameter_sets.to_vec();
    let mut at = 0usize;
    while at + length_size <= tile.len() {
        let length = tile[at..at + length_size]
            .iter()
            .fold(0usize, |value, byte| (value << 8) | usize::from(*byte));
        at += length_size;
        let Some(unit) = tile.get(at..at.saturating_add(length)) else { break };
        at += length;
        stream.extend_from_slice(&[0, 0, 0, 1]);
        stream.extend_from_slice(unit);
    }

    let mut decoder = rust_h265::Decoder::new();
    for nal in rust_h265::parse_annex_b(&stream) {
        match decoder.decode_nal(&nal) {
            Ok(Some(frame)) => return Ok(frame),
            Ok(None) => {}
            Err(why) => return Err(format!("this HEIC's HEVC bitstream would not decode: {why}")),
        }
    }
    decoder.flush().ok_or_else(|| "this HEIC's HEVC bitstream decoded to no picture".to_string())
}

/// The `hvcC` record's parameter set arrays, as one Annex B prelude.
fn annex_b_parameter_sets(config: &[u8]) -> Result<Vec<u8>, String> {
    // The fixed part of the record is 22 bytes; `numOfArrays` is the byte after it.
    let arrays = *config.get(22).ok_or("this HEIC's hvcC record is truncated")?;
    let mut out = Vec::new();
    let mut at = 23usize;
    for _ in 0..arrays {
        let Some(count) = config.get(at + 1..at + 3) else { break };
        let count = u16::from_be_bytes([count[0], count[1]]);
        at += 3;
        for _ in 0..count {
            let Some(length) = config.get(at..at + 2) else { break };
            let length = usize::from(u16::from_be_bytes([length[0], length[1]]));
            at += 2;
            let Some(unit) = config.get(at..at + length) else { break };
            at += length;
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(unit);
        }
    }
    if out.is_empty() {
        return Err("this HEIC's hvcC record carries no parameter sets".to_string());
    }
    Ok(out)
}

/// How many bytes each NAL unit's length prefix takes, which the record states rather than fixes.
fn length_size(config: &[u8]) -> Result<usize, String> {
    let byte = config.get(21).ok_or("this HEIC's hvcC record is truncated")?;
    Ok(usize::from(byte & 3) + 1)
}

/// Where a tile's pixels go in the picture they tile.
struct Placed<'a> {
    samples: &'a mut [u16],
    stride: usize,
    left: usize,
    top: usize,
    width: usize,
    height: usize,
}

/// A decoded 4:2:0 frame's planes as interleaved RGB, written into its place in the picture.
///
/// **The matrix is the file's, not a constant.** A phone writes BT.709 and a camera shooting HDR
/// writes BT.2020, and reading one as the other tilts every colour a little - which is exactly the
/// class of error nothing reports and everything shows.
fn to_rgb(frame: &rust_h265::Frame, nclx: Option<Nclx>, into: &mut Placed<'_>) -> Result<(), String> {
    let depth = u32::from(frame.bit_depth);
    let max = f32::from(u16::MAX >> (16 - depth.clamp(8, 16)));
    let luma = plane(&frame.y);
    let cb = plane(&frame.u);
    let cr = plane(&frame.v);
    let (width, height) = (frame.width as usize, frame.height as usize);
    if luma.len() < width * height {
        return Err("this HEIC's decoded luma plane is short of its own dimensions".to_string());
    }
    let chroma_w = width.div_ceil(2);
    let chroma_h = height.div_ceil(2);
    // **A monochrome stream has no chroma planes, and reading zeroes out of one is not grey.** A
    // gain map is stored as one, and an absent Cb read as code 0 is a colour cast of half the
    // range rather than the neutral it means. `grey` says so, and the loop below takes the
    // midpoint instead.
    let grey = cb.len() < chroma_w * chroma_h || cr.len() < chroma_w * chroma_h;

    let (kr, kb) = coefficients(nclx);
    let kg = 1.0 - kr - kb;
    // Limited where the file said nothing, which is H.273's own default for
    // `video_full_range_flag` and the same rule `coefficients` follows below. Defaulting the
    // other way reads a limited-range picture's black at code 16 as 0.063 and its white at 235
    // as 0.92: milky, with no black point, and nothing reports it.
    let full = nclx.is_some_and(|it| it.full_range);
    // BT.709 §4 and BT.2020 Table 5: a limited-range signal puts black at 16 and white at 235,
    // scaled by the depth, and chroma spans 224 about a midpoint.
    let shift = f32::from(1u16 << (depth.saturating_sub(8)).min(8));
    let (luma_floor, luma_span) = match full {
        true => (0.0, max),
        false => (16.0 * shift, 219.0 * shift),
    };
    let (chroma_mid, chroma_span) = match full {
        true => ((max + 1.0) / 2.0, max),
        false => (128.0 * shift, 224.0 * shift),
    };

    for row in 0..into.height {
        for column in 0..into.width {
            let y = (f32::from(luma[row * width + column]) - luma_floor) / luma_span;
            let (u, v) = match grey {
                true => (chroma_mid, chroma_mid),
                false => chroma(&cb, &cr, chroma_w, chroma_h, column, row),
            };
            let u = (u - chroma_mid) / chroma_span;
            let v = (v - chroma_mid) / chroma_span;
            let r = y + 2.0 * (1.0 - kr) * v;
            let b = y + 2.0 * (1.0 - kb) * u;
            let g = y - (2.0 * (1.0 - kr) * kr / kg) * v - (2.0 * (1.0 - kb) * kb / kg) * u;
            let at = ((into.top + row) * into.stride + into.left + column) * 3;
            for (channel, value) in [r, g, b].into_iter().enumerate() {
                // Rounded, not truncated: the conversion is float and the code is an integer, and
                // a limited-range 8-bit source is 220 levels stretched over 256 - so flooring
                // biases every reconstructed code down by up to a whole one, consistently dark.
                into.samples[at + channel] = (value.clamp(0.0, 1.0) * max + 0.5) as u16;
            }
        }
    }
    Ok(())
}

/// The two chroma samples for a luma position, bilinear against 4:2:0's siting.
///
/// **Not nearest.** A subsampled plane read back by replication puts a two-pixel staircase along
/// every saturated edge, which is invisible in a thumbnail and is the first thing a reader sees at
/// 1:1 in the editor. HEVC's default siting is left-aligned horizontally and between rows
/// vertically, so the luma column falls on a chroma sample and the luma row falls between two.
fn chroma(
    cb: &[u16],
    cr: &[u16],
    width: usize,
    height: usize,
    column: usize,
    row: usize,
) -> (f32, f32) {
    // **Clamped before the floor.** Above the first chroma row there is no pair to interpolate
    // between, and `y` is negative there - so clamping the *index* while taking the weight from
    // the unclamped position gives row 0 three quarters of row 1. On a phone HEIC that is a
    // coloured seam at every 512-pixel tile boundary, which is the artefact the bilinear is here
    // to prevent rather than cause.
    let x = (column as f32 / 2.0).clamp(0.0, (width - 1) as f32);
    let y = ((row as f32 - 0.5) / 2.0).clamp(0.0, (height - 1) as f32);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let fx = x - x.floor();
    let fy = y - y.floor();
    let at = |plane: &[u16], x: usize, y: usize| f32::from(*plane.get(y * width + x).unwrap_or(&0));
    let mix = |plane: &[u16]| {
        let top = at(plane, x0, y0) * (1.0 - fx) + at(plane, x1, y0) * fx;
        let bottom = at(plane, x0, y1) * (1.0 - fx) + at(plane, x1, y1) * fx;
        top * (1.0 - fy) + bottom * fy
    };
    (mix(cb), mix(cr))
}

/// A plane at one sample per entry, whatever width the decoder stored it at.
fn plane(data: &rust_h265::PixelData) -> Vec<u16> {
    match data {
        rust_h265::PixelData::U8(bytes) => bytes.iter().map(|v| u16::from(*v)).collect(),
        rust_h265::PixelData::U16(samples) => samples.clone(),
    }
}

/// The luma coefficients the file's matrix code names.
///
/// BT.709 where nothing was said, which is what every HEIF profile defaults to and what a phone
/// writes.
fn coefficients(nclx: Option<Nclx>) -> (f32, f32) {
    match nclx.map_or(1, |it| it.matrix) {
        // BT.601, both spellings.
        5 | 6 => (0.299, 0.114),
        // BT.2020 non-constant luminance.
        9 => (0.2627, 0.0593),
        _ => (0.2126, 0.0722),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A record's parameter sets come out as Annex B in the order they were stored, which is what
    /// a decoder has to see before the first slice.
    #[test]
    fn the_parameter_sets_come_out_of_the_record_in_order() {
        let mut config = vec![0u8; 22];
        config[21] = 0b11; // four-byte length prefixes
        config.push(2); // two arrays
        for (kind, payload) in [(32u8, [0xAAu8, 0xBB].as_slice()), (33, [0xCC].as_slice())] {
            config.push(kind);
            config.extend_from_slice(&1u16.to_be_bytes());
            config.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            config.extend_from_slice(payload);
        }
        assert_eq!(length_size(&config).unwrap(), 4);
        assert_eq!(
            annex_b_parameter_sets(&config).unwrap(),
            vec![0, 0, 0, 1, 0xAA, 0xBB, 0, 0, 0, 1, 0xCC],
        );
    }

    #[test]
    fn a_record_with_no_parameter_sets_is_refused_rather_than_decoded() {
        let mut config = vec![0u8; 22];
        config.push(0);
        assert!(annex_b_parameter_sets(&config).is_err());
    }

    /// The matrix is the file's, and getting it from nowhere is BT.709.
    #[test]
    fn the_luma_coefficients_come_off_the_files_own_matrix_code() {
        assert_eq!(coefficients(None), (0.2126, 0.0722));
        let bt2020 = Nclx { primaries: 9, transfer: 16, matrix: 9, full_range: false };
        assert_eq!(coefficients(Some(bt2020)), (0.2627, 0.0593));
    }

    /// A frame of flat planes, which is all `to_rgb` reads.
    ///
    /// Built here rather than decoded, because nothing in this repository has an HEVC bitstream
    /// to decode: `rust_h265::Frame` is plain public fields, so the colour conversion - the half
    /// of this module that can be silently wrong - is testable without one.
    fn frame(luma: u16, cb: u16, cr: u16, depth: u8, size: (u32, u32)) -> rust_h265::Frame {
        let (width, height) = (size.0 as usize, size.1 as usize);
        let chroma = width.div_ceil(2) * height.div_ceil(2);
        rust_h265::Frame {
            y: rust_h265::PixelData::U16(vec![luma; width * height]),
            u: rust_h265::PixelData::U16(vec![cb; chroma]),
            v: rust_h265::PixelData::U16(vec![cr; chroma]),
            width: size.0,
            height: size.1,
            pic_order_cnt: 0,
            bit_depth: depth,
        }
    }

    fn converted(frame: &rust_h265::Frame, nclx: Option<Nclx>) -> Vec<u16> {
        let (width, height) = (frame.width as usize, frame.height as usize);
        let mut samples = vec![0u16; width * height * 3];
        to_rgb(frame, nclx, &mut Placed {
            samples: &mut samples,
            stride: width,
            left: 0,
            top: 0,
            width,
            height,
        })
        .expect("the conversion runs");
        samples
    }

    /// **The range is the file's, and getting it wrong is a milky picture nothing reports.** A
    /// limited-range signal puts black at 16 and white at 235; read as full range, black comes
    /// back at 4% and the photograph has no black point at all.
    #[test]
    fn a_limited_range_signal_reaches_black_and_white() {
        let limited = Nclx { primaries: 1, transfer: 13, matrix: 1, full_range: false };
        let black = converted(&frame(16, 128, 128, 8, (2, 2)), Some(limited));
        assert_eq!(&black[..3], &[0, 0, 0], "code 16 is black");
        let white = converted(&frame(235, 128, 128, 8, (2, 2)), Some(limited));
        assert_eq!(&white[..3], &[255, 255, 255], "code 235 is white");

        // And a file that said nothing is read as limited, which is H.273's default - not as
        // full, which would leave that same black at 16 of 255.
        let silent = converted(&frame(16, 128, 128, 8, (2, 2)), None);
        assert_eq!(&silent[..3], &[0, 0, 0]);

        let full = Nclx { full_range: true, ..limited };
        let raised = converted(&frame(16, 128, 128, 8, (2, 2)), Some(full));
        assert_eq!(&raised[..3], &[16, 16, 16], "and a file that said full means full");
    }

    /// Ten-bit, where the same rule is scaled by the depth rather than restated.
    #[test]
    fn a_ten_bit_signal_scales_its_own_range() {
        let limited = Nclx { primaries: 9, transfer: 16, matrix: 9, full_range: false };
        let black = converted(&frame(64, 512, 512, 10, (2, 2)), Some(limited));
        assert_eq!(&black[..3], &[0, 0, 0], "10-bit black is code 64");
        let white = converted(&frame(940, 512, 512, 10, (2, 2)), Some(limited));
        assert_eq!(&white[..3], &[1023, 1023, 1023], "and white is 940 of 1023");
    }

    /// A neutral is neutral: the chroma midpoint must produce equal channels whatever the matrix
    /// says, which is the one identity every YCbCr conversion has to satisfy.
    #[test]
    fn the_chroma_midpoint_is_grey_under_every_matrix() {
        for matrix in [1u16, 5, 9] {
            let nclx = Nclx { primaries: 1, transfer: 13, matrix, full_range: false };
            let grey = converted(&frame(126, 128, 128, 8, (2, 2)), Some(nclx));
            assert_eq!(grey[0], grey[1], "matrix {matrix}");
            assert_eq!(grey[1], grey[2], "matrix {matrix}");
        }
    }

    /// **The top row must not borrow its colour from the row below.** 4:2:0 sites chroma between
    /// rows, so the first luma row sits above the first chroma sample and has no pair to
    /// interpolate with - taking the weight from the unclamped position gives it three quarters of
    /// the next row, which on a tiled HEIC is a coloured seam at every tile boundary.
    #[test]
    fn the_first_row_takes_the_chroma_that_is_actually_above_it() {
        let width = 2usize;
        let mut frame = frame(126, 128, 128, 8, (2, 4));
        // Two chroma rows that differ: the top one neutral, the one below it strongly blue.
        let rust_h265::PixelData::U16(cb) = &mut frame.u else { panic!("u16 planes") };
        for at in width.div_ceil(2)..cb.len() {
            cb[at] = 200;
        }

        let nclx = Nclx { primaries: 1, transfer: 13, matrix: 1, full_range: false };
        let samples = converted(&frame, Some(nclx));
        // Row 0 is above the first chroma sample, so it is that sample exactly - which is
        // neutral, so its blue equals its red.
        assert_eq!(samples[0], samples[2], "row 0 borrowed chroma from the row below");
        // Row 2 sits between the two chroma rows and genuinely is a blend, so it must not be
        // neutral - or the test above would pass on a conversion that ignored chroma entirely.
        let row2 = 2 * width * 3;
        assert!(samples[row2 + 2] > samples[row2], "row 2 blends toward the blue row");
    }
}
