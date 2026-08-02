// PQ-coded RGB to I420 planes.
//
// The one stage of the browser pipeline with no counterpart in a rendition: there the
// graded frame goes to libavif, which does its own RGB-to-YUV against the CICP it writes.
// So nothing else in this crate checks this arithmetic, and a wrong range or matrix here
// reads as a grading fault rather than a packing one - which is why it lives in its own
// module with its own test rather than inside the wasm-only surface, where `cargo test`
// would never reach it.

/// Rec.2020 luma, non-constant luminance - the matrix the frames are tagged with.
const LUMA: [f32; 3] = [0.2627, 0.678, 0.0593];

/// Ordered dither, 4x4 Bayer, scaled to one LSB.
///
/// **Only at 8 bits, and load-bearing there.** PQ's toe is near-vertical, so 219 luma
/// codes quantise a smooth sky into visible steps - the reason the renditions are 10-bit.
/// Trading that for half an LSB of noise is the right way round for a photograph, which
/// arrives carrying sensor grain anyway. Ordered rather than random so a still frame does
/// not shimmer while the slider is held.
const BAYER: [[f32; 4]; 4] = [
    [0.0, 8.0, 2.0, 10.0],
    [12.0, 4.0, 14.0, 6.0],
    [3.0, 11.0, 1.0, 9.0],
    [15.0, 7.0, 13.0, 5.0],
];

/// How many bits a sample gets, which is a browser capability rather than a preference.
///
/// Chromium takes `I420P10`. Safari 26.4 and Firefox reject every 10-bit format - WebKit
/// validates I420 and NV12 alone - while both accept PQ *tagging* on an 8-bit frame, and
/// Safari composites that to a real HDR panel (measured on an XDR display: a 1000-nit
/// patch reads clearly brighter than a 203-nit one). So 8-bit is not a fallback to SDR,
/// only a coarser ladder, which is what the dither is for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Depth {
    Eight,
    Ten,
}

impl Depth {
    /// Limited-range luma footroom and span, per BT.2020: 16-235 at 8 bits, 64-940 at 10.
    fn luma(self) -> (f32, f32) {
        match self {
            Depth::Eight => (16.0, 219.0),
            Depth::Ten => (64.0, 876.0),
        }
    }

    /// Chroma about its midpoint, spanning 16-240 at 8 bits and 64-960 at 10.
    fn chroma(self) -> (f32, f32) {
        match self {
            Depth::Eight => (128.0, 224.0),
            Depth::Ten => (512.0, 896.0),
        }
    }

    pub fn bytes_per_sample(self) -> usize {
        match self {
            Depth::Eight => 1,
            Depth::Ten => 2,
        }
    }

    pub fn plane_bytes(self, width: usize, height: usize) -> usize {
        width * height * 3 / 2 * self.bytes_per_sample()
    }
}

fn dither(depth: Depth, x: usize, y: usize) -> f32 {
    match depth {
        Depth::Ten => 0.0,
        Depth::Eight => (BAYER[y & 3][x & 3] + 0.5) / 16.0 - 0.5,
    }
}

fn write(plane: &mut [u8], depth: Depth, index: usize, value: u16) {
    match depth {
        Depth::Eight => plane[index] = value as u8,
        Depth::Ten => {
            plane[index * 2] = value as u8;
            plane[index * 2 + 1] = (value >> 8) as u8;
        }
    }
}

/// Packs a PQ-coded 16-bit RGB frame into I420 planes at `depth`.
///
/// `pq` is what `tone::encode_pq` leaves behind: full range is the display peak.
/// `source_width` is the stride of the frame, which can exceed `width` when it was
/// rounded down to even for 4:2:0.
pub fn pack_i420(
    pq: &[u16],
    source_width: usize,
    width: usize,
    height: usize,
    depth: Depth,
    planes: &mut [u8],
) {
    pack_i420_with(pq, source_width, width, height, depth, planes);
}

fn pack_i420_with(
    pq: &[u16],
    source_width: usize,
    width: usize,
    height: usize,
    depth: Depth,
    planes: &mut [u8],
) {
    let stride = depth.bytes_per_sample();
    let (luma, chroma) = planes.split_at_mut(width * height * stride);
    let (cb_plane, cr_plane) = chroma.split_at_mut((width / 2) * (height / 2) * stride);

    for by in 0..height / 2 {
        for bx in 0..width / 2 {
            let (mut cb_sum, mut cr_sum) = (0.0f32, 0.0f32);
            for dy in 0..2 {
                for dx in 0..2 {
                    let (x, y) = (bx * 2 + dx, by * 2 + dy);
                    let at = (y * source_width + x) * 3;
                    let signal_of = |sample: u16| f32::from(sample) / 65535.0;
                    let signal = [
                        signal_of(pq[at]),
                        signal_of(pq[at + 1]),
                        signal_of(pq[at + 2]),
                    ];
                    let y_signal = LUMA[0] * signal[0] + LUMA[1] * signal[1] + LUMA[2] * signal[2];
                    let (floor, span) = depth.luma();
                    // `+ 0.5` and truncate rather than `round()`: both are non-negative,
                    // where the two agree, and `round()` is a libm call on a target with
                    // no rounding instruction - nine million a frame.
                    let code = (floor + span * y_signal.clamp(0.0, 1.0) + dither(depth, x, y) + 0.5)
                        as u16;
                    write(luma, depth, y * width + x, code);
                    cb_sum += (signal[2] - y_signal) / 1.8814;
                    cr_sum += (signal[0] - y_signal) / 1.4746;
                }
            }
            // Half-resolution planes carry their own dither phase rather than borrowing a
            // luma pixel's.
            let noise = dither(depth, bx, by);
            let (mid, span) = depth.chroma();
            let quantise =
                |sum: f32| (mid + span * (sum / 4.0).clamp(-0.5, 0.5) + noise + 0.5) as u16;
            let at = by * (width / 2) + bx;
            write(cb_plane, depth, at, quantise(cb_sum));
            write(cr_plane, depth, at, quantise(cr_sum));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planes_of(pq: &[u16], w: usize, h: usize, depth: Depth) -> (Vec<u16>, Vec<u16>) {
        let mut planes = vec![0u8; depth.plane_bytes(w, h)];
        pack_i420(pq, w, w, h, depth, &mut planes);
        let read = |bytes: &[u8]| -> Vec<u16> {
            match depth {
                Depth::Ten => bytes
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect(),
                Depth::Eight => bytes.iter().map(|v| u16::from(*v)).collect(),
            }
        };
        let split = w * h * depth.bytes_per_sample();
        (read(&planes[..split]), read(&planes[split..]))
    }

    /// A neutral grey at a known brightness must land on the code the standard names.
    ///
    /// 203 nits is BT.2408 diffuse white, which the grade anchors on, so this is the value
    /// most of a correctly graded frame sits near - and the one whose misplacement would
    /// read as "the whole picture is too dark".
    #[test]
    fn a_known_grey_packs_to_the_code_the_standard_names() {
        let signal = crate::tone::pq(203.0) as f32;
        let sample = (signal * 65535.0).round() as u16;
        let pq = vec![sample; 4 * 4 * 3];

        for (depth, floor, span, mid) in [
            (Depth::Ten, 64.0f32, 876.0f32, 512u16),
            (Depth::Eight, 16.0, 219.0, 128),
        ] {
            let want = (floor + span * signal).round() as u16;
            let (luma, chroma) = planes_of(&pq, 4, 4, depth);
            assert!(
                luma.iter().all(|y| y.abs_diff(want) <= 1),
                "{depth:?} luma {luma:?} should sit on {want}",
            );
            assert!(
                chroma.iter().all(|c| c.abs_diff(mid) <= 1),
                "{depth:?} grey picked up chroma: {chroma:?}",
            );
        }
    }

    /// Black and the display peak must reach the ends of the legal range, not past them.
    #[test]
    fn the_ends_of_the_range_land_where_they_should() {
        for (depth, black, white) in [(Depth::Ten, 64u16, 940u16), (Depth::Eight, 16, 235)] {
            let (luma, _) = planes_of(&vec![0u16; 4 * 4 * 3], 4, 4, depth);
            assert!(
                luma.iter().all(|y| *y == black),
                "{depth:?} black is {luma:?}, want {black}"
            );

            let (luma, _) = planes_of(&vec![u16::MAX; 4 * 4 * 3], 4, 4, depth);
            assert!(
                luma.iter().all(|y| *y == white),
                "{depth:?} white is {luma:?}, want {white}"
            );
        }
    }
}
