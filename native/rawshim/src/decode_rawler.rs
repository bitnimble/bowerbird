//! The decode without LibRaw: rawler reads the sensor, and everything after that is ours.
//!
//! LibRaw's `dcraw_process` did four things in one call - black subtraction, white balance, the
//! demosaic and the camera-to-output matrix. Only the demosaic was ever difficult, and it now
//! lives in `demosaic.rs`; the other three are arithmetic over coefficients rawler already carries
//! on its `RawImage`, so this module is mostly a matter of getting them in the right order and
//! the right space.
//!
//! Selected by `BOWERBIRD_DECODER=rawler`. The LibRaw path is still there and still the default,
//! so the two can be rendered side by side on the same file.

use crate::frame::{Frame, Pixels};
use rayon::prelude::*;

/// Whether the caller asked for this path rather than LibRaw's.
pub fn wanted() -> bool {
    std::env::var("BOWERBIRD_DECODER").is_ok_and(|value| value.eq_ignore_ascii_case("rawler"))
}

/// XYZ (D65) to linear Rec.2020, which is the space the rest of the pipeline works in.
///
/// The grade downstream reads normalised PQ Rec.2020, and `tone::encode_base` is what puts it
/// there; what arrives here has to be linear Rec.2020 with the same primaries LibRaw's
/// `OUTPUT_REC2020` produced, or every camera match ever fitted describes a different starting
/// point.
const XYZ_TO_REC2020: [[f32; 3]; 3] = [
    [1.716651, -0.355671, -0.253366],
    [-0.666684, 1.616481, 0.015769],
    [0.017640, -0.042771, 0.942103],
];

/// Decodes a RAW to a linear Rec.2020 frame, denoising the mosaic and demosaicing on the GPU.
///
/// `amounts` is the mosaic denoise, which runs before the demosaic for the reason it always has:
/// GALOSH is fitted to the sensor's own noise on the CFA, and a demosaic in front of it would
/// correlate the samples it measures.
pub fn decode(path: &str, amounts: crate::galosh::Amounts) -> Option<Frame> {
    // Stage timings, for the benchmark that compares this against LibRaw. Off unless asked, and
    // the clock reads are per decode rather than per pixel, so leaving it in costs nothing.
    let profile = std::env::var_os("BOWERBIRD_DECODE_PROFILE").is_some();
    let mut mark = std::time::Instant::now();
    let mut lap = |name: &str| {
        if profile {
            eprintln!("  decode {name}: {}ms", mark.elapsed().as_millis());
        }
        mark = std::time::Instant::now();
    };

    let source = rawler::rawsource::RawSource::new(std::path::Path::new(path)).ok()?;
    let decoder = rawler::get_decoder(&source).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();

    // **From the metadata, not from `RawImage::orientation`.** That field exists but the decoders
    // here leave it `Normal` even for a frame shot in portrait; the EXIF tag is where the answer
    // actually is. Reading the wrong one leaves every upright photograph on its side.
    let upright = decoder
        .raw_metadata(&source, &params)
        .ok()
        .and_then(|meta| meta.exif.orientation)
        .map_or(rawler::decoders::Orientation::Normal, rawler::decoders::Orientation::from_u16);

    lap("open");
    let image = decoder.raw_image(&source, &params, false).ok()?;
    lap("read");
    let (width, height) = (image.width, image.height);

    let cfa = [
        image.camera.cfa.color_at(0, 0) as u32,
        image.camera.cfa.color_at(0, 1) as u32,
        image.camera.cfa.color_at(1, 0) as u32,
        image.camera.cfa.color_at(1, 1) as u32,
    ];

    let rawler::RawImageData::Integer(samples) = &image.data else {
        return None;
    };
    if samples.len() < width * height {
        return None;
    }

    // **Black first, then white balance, then the demosaic.** The order is not free. The
    // directional statistic in RCD is built to be blind to a per-channel gain, so it does not care
    // either way, but the colour-difference stages assume the difference between a chroma channel
    // and green is locally smooth - and before white balance green sits about twice as high as red
    // and blue, so that difference carries the imbalance rather than the scene.
    let black = per_channel_black(&image, cfa);
    let white = f32::from(image.whitelevel.0.iter().copied().max().unwrap_or(65535) as u16);
    let gains = white_balance_gains(&image);

    let mut mosaic = vec![0f32; width * height];
    mosaic.par_chunks_mut(width).enumerate().for_each(|(row, out)| {
        let from = &samples[row * width..(row + 1) * width];
        for (col, (sample, slot)) in from.iter().zip(out).enumerate() {
            let colour = cfa[(row & 1) * 2 + (col & 1)].min(3) as usize;
            let floor = black[colour];
            let range = (white - floor).max(1.0);
            // Clamped at zero because §2.2 of the specification requires it: a negative sample in
            // the shadows can drive the low-pass sum the green stage divides by through zero, and
            // the epsilon there does not save it.
            *slot = (f32::from(*sample) - floor).max(0.0) / range * gains[colour];
        }
    });

    lap("condition");
    let gpu = crate::gpu::device()?;
    let noise = crate::galosh::device(gpu).and_then(|kernels| {
        if amounts.does_anything() {
            Some(crate::galosh::denoise(gpu, kernels, &mut mosaic, width, height, amounts))
        } else {
            None
        }
    });

    lap("denoise");
    let matrix = camera_to_rec2020(&image)?;

    // The sensor's readable area is larger than the picture: there are masked columns for the
    // black level and a few rows the manufacturer does not consider valid. LibRaw hands back the
    // cropped frame, so this must too, or every photograph shifts and every fitted camera match
    // describes a different framing.
    let crop = image
        .crop_area
        .map(|area| (area.p.x, area.p.y, area.d.w, area.d.h))
        .unwrap_or((0, 0, width, height));

    let rcd = crate::demosaic::device(gpu)?;
    let pixels = crate::demosaic::demosaic_with(gpu, rcd, &mosaic, width, height, cfa, |rgb| {
        to_rec2020(rgb, width, crop, matrix)
    })?;
    drop(mosaic);

    lap("demosaic, colour, crop");

    // **The sensor reads in its own orientation; the photograph has another one.** LibRaw applies
    // this from `sizes.flip` and hands back an upright frame, so this must too - and not only
    // because the picture would be sideways. The camera match is fitted by comparing this frame
    // against the camera's own embedded JPEG, which is always upright, so a frame left in sensor
    // orientation produces a fit against unrelated content and a grade built on it.
    let (pixels, out_w, out_h) = orient(pixels, crop.2, crop.3, upright);

    lap("colour, crop, orient");

    Some(Frame {
        width: out_w,
        height: out_h,
        pixels: Pixels::Sixteen(pixels),
        halved: false,
        direct: true,
        as_shot: as_shot_of(&image),
        noise,
    })
}

/// The per-channel black level, in sensor counts.
///
/// A Bayer sensor reports four, one per position of the 2x2, and they are not equal: the two
/// greens in particular can differ by enough to leave a visible checkerboard if a single scalar is
/// used for both.
fn per_channel_black(image: &rawler::RawImage, cfa: [u32; 4]) -> [f32; 4] {
    let levels = &image.blacklevel.levels;
    let mut out = [0f32; 4];
    for (position, slot) in out.iter_mut().enumerate() {
        // `blacklevel` is indexed by position in the 2x2, not by colour, when it carries four.
        let value = if levels.len() >= 4 {
            levels[position].as_f32()
        } else if let Some(first) = levels.first() {
            first.as_f32()
        } else {
            0.0
        };
        *slot = value;
    }
    // Reordered to be indexed by colour, which is how the mosaic loop reads it.
    let mut by_colour = [0f32; 4];
    for position in 0..4 {
        by_colour[cfa[position].min(3) as usize] = out[position];
    }
    by_colour
}

/// Per-channel gains normalised so green is unity, which keeps the frame's overall level where the
/// rest of the pipeline expects it rather than brightening every photograph by the green multiplier.
fn white_balance_gains(image: &rawler::RawImage) -> [f32; 4] {
    let wb = image.wb_coeffs;
    let green = if wb[1].is_finite() && wb[1] > 0.0 { wb[1] } else { 1.0 };
    let mut out = [1f32; 4];
    for (channel, slot) in out.iter_mut().enumerate() {
        let coefficient = wb[channel.min(3)];
        *slot = if coefficient.is_finite() && coefficient > 0.0 { coefficient / green } else { 1.0 };
    }
    out
}

/// The camera's XYZ matrix, as three rows of three.
///
/// **Not `xyz_to_cam`, which is dead.** That field is marked deprecated in rawler and comes back
/// all zeros for at least the Canon bodies here, which makes `cam_to_xyz_normalized` return NaN
/// and every pixel black. The live data is `color_matrix`, a flat row-major matrix per illuminant.
fn xyz_to_cam_of(image: &rawler::RawImage) -> Option<[[f32; 3]; 4]> {
    // D65 to agree with LibRaw, which references its `cam_xyz` to daylight, and by the enum's
    // ordering rather than the map's when there is no D65: `color_matrix` is a `HashMap` and its
    // iteration order is seeded per process, so taking whatever came first made the decode differ
    // between runs of the same binary on the same file.
    let illuminant = image
        .color_matrix
        .keys()
        .copied()
        .find(|i| *i == rawler::imgop::xyz::Illuminant::D65)
        .or_else(|| image.color_matrix.keys().copied().min_by_key(|i| *i as u16))?;
    let flat = image.color_matrix.get(&illuminant)?;
    if flat.len() < 9 || flat.len() % 3 != 0 {
        return None;
    }
    let mut out = [[0f32; 3]; 4];
    for row in 0..(flat.len() / 3).min(4) {
        for col in 0..3 {
            out[row][col] = flat[row * 3 + col];
        }
    }
    Some(out)
}

/// Camera native primaries to linear Rec.2020.
fn camera_to_rec2020(image: &rawler::RawImage) -> Option<[[f32; 3]; 3]> {
    let xyz_to_cam = xyz_to_cam_of(image)?;
    let cam_to_xyz = pseudoinverse(xyz_to_cam);
    let mut out = [[0f32; 3]; 3];
    for (row, slot) in out.iter_mut().enumerate() {
        for (col, cell) in slot.iter_mut().enumerate() {
            let mut total = 0f32;
            for k in 0..3 {
                total += XYZ_TO_REC2020[row][k] * cam_to_xyz[k][col];
            }
            *cell = total;
        }
    }
    Some(out)
}

/// Moore-Penrose inverse of the camera's XYZ matrix, normalised so that a neutral in camera space
/// lands on a neutral in XYZ.
///
/// Written here rather than taken from rawler's own because that one reads `xyz_to_cam`, which is
/// the field that comes back empty.
fn pseudoinverse(matrix: [[f32; 3]; 4]) -> [[f32; 3]; 3] {
    // Rows normalised so each sums to one: a camera matrix scaled per row renders the same colours
    // at a different exposure, and the rest of the pipeline sets exposure itself.
    let mut normalised = [[0f64; 3]; 3];
    for row in 0..3 {
        let sum: f64 = (0..3).map(|c| f64::from(matrix[row][c])).sum();
        let scale = if sum.abs() > 1e-9 { 1.0 / sum } else { 1.0 };
        for col in 0..3 {
            normalised[row][col] = f64::from(matrix[row][col]) * scale;
        }
    }

    let m = &normalised;
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        // Singular, which means the file described something impossible. Identity at least renders
        // a picture with the wrong colours rather than no picture at all.
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let inv = 1.0 / det;
    let mut out = [[0f32; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            // Cofactor transposed, i.e. the adjugate, divided by the determinant.
            let (r1, r2) = ((col + 1) % 3, (col + 2) % 3);
            let (c1, c2) = ((row + 1) % 3, (row + 2) % 3);
            let cofactor = m[r1][c1] * m[r2][c2] - m[r1][c2] * m[r2][c1];
            out[row][col] = (cofactor * inv) as f32;
        }
    }
    out
}

/// Applies the colour transform over the cropped region, quantising to the 16-bit scene-linear the
/// rest of the pipeline reads. `crop` is (left, top, width, height) in the full frame's pixels.
///
/// `rgb` is the demosaic's own output buffer: interleaved triples of native-endian `f32`, `stride`
/// pixels to the row.
fn to_rec2020(rgb: &[u8], stride: usize, crop: (usize, usize, usize, usize), matrix: [[f32; 3]; 3]) -> Vec<u16> {
    let (left, top, width, height) = crop;
    let sample = |at: usize| f32::from_ne_bytes([rgb[at], rgb[at + 1], rgb[at + 2], rgb[at + 3]]);
    let mut out = vec![0u16; width * height * 3];
    out.par_chunks_mut(width * 3).enumerate().for_each(|(row, line)| {
        for (col, pixel) in line.chunks_exact_mut(3).enumerate() {
            let from = ((top + row) * stride + left + col) * 12;
            let (r, g, b) = (sample(from), sample(from + 4), sample(from + 8));
            for (channel, slot) in pixel.iter_mut().enumerate() {
                let value = matrix[channel][0] * r + matrix[channel][1] * g + matrix[channel][2] * b;
                *slot = (value * 65535.0).clamp(0.0, 65535.0) as u16;
            }
        }
    });
    out
}

/// Rewrites the frame upright, returning it with whatever dimensions that left.
///
/// The four transposing orientations swap width and height; the rest are in-place permutations.
fn orient(
    pixels: Vec<u16>,
    width: usize,
    height: usize,
    orientation: rawler::decoders::Orientation,
) -> (Vec<u16>, usize, usize) {
    use rawler::decoders::Orientation as O;
    // `Unknown` is left alone deliberately: a file that did not say is more likely to be upright
    // already than to want a guess, and guessing wrong rotates a whole shoot.
    if matches!(orientation, O::Normal | O::Unknown) {
        return (pixels, width, height);
    }

    let transposes = matches!(orientation, O::Transpose | O::Rotate90 | O::Transverse | O::Rotate270);
    let (out_w, out_h) = if transposes { (height, width) } else { (width, height) };
    let mut out = vec![0u16; pixels.len()];
    for row in 0..height {
        for col in 0..width {
            let (to_col, to_row) = match orientation {
                O::HorizontalFlip => (width - 1 - col, row),
                O::Rotate180 => (width - 1 - col, height - 1 - row),
                O::VerticalFlip => (col, height - 1 - row),
                O::Transpose => (row, col),
                O::Rotate90 => (height - 1 - row, col),
                O::Transverse => (height - 1 - row, width - 1 - col),
                O::Rotate270 => (row, width - 1 - col),
                O::Normal | O::Unknown => (col, row),
            };
            let from = (row * width + col) * 3;
            let to = (to_row * out_w + to_col) * 3;
            out[to..to + 3].copy_from_slice(&pixels[from..from + 3]);
        }
    }
    (out, out_w, out_h)
}

/// The illuminant the decode balanced against.
///
/// `white_balance::as_shot` already takes the camera's multipliers and its XYZ matrix, which is
/// exactly what rawler carries, so this is a shape conversion and not a second implementation -
/// the temperature and tint a photograph reports must not depend on which decoder read it.
fn as_shot_of(image: &rawler::RawImage) -> Option<crate::white_balance::AsShot> {
    let wb = image.wb_coeffs;
    let cam_mul = [wb[0], wb[1], wb[2], wb[3]];
    crate::white_balance::as_shot(&cam_mul, &xyz_to_cam_of(image)?)
}
