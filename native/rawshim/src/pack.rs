// PQ-coded RGB to I444 planes.
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
/// Chromium takes `I444P10`. Safari 26.4 and Firefox reject every 10-bit format - WebKit
/// validates I420 and NV12 alone - while both accept PQ *tagging* on an 8-bit frame. So
/// 8-bit is not a fallback to SDR, only a coarser ladder, which is what the dither is
/// for; the browsers that need it take the still route instead (§`wasm::Sink`).
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
        width * height * 3 * self.bytes_per_sample()
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

/// Packs a PQ-coded 16-bit RGB frame into I444 planes at `depth`.
///
/// `pq` is what `tone::encode_pq` leaves behind: full range is the display peak.
/// `source_width` is the stride of the frame, which `width` can fall short of.
///
/// **4:4:4 rather than 4:2:0, which the interactive frame is why.** A drag grades at 960px
/// and a subsample would halve that again, so colour would reach the element at 480 where
/// luma reaches it at 960 - and colour then visibly degrades faster than detail does,
/// which is what a drag used to look like. Only Chromium is behind this now, and it takes
/// `I444P10` and `I444` PQ-tagged (measured); the browsers that validate I420 and NV12
/// alone take the still route instead.
pub fn pack(
    pq: &[u16],
    source_width: usize,
    width: usize,
    height: usize,
    depth: Depth,
    planes: &mut [u8],
) {
    let stride = depth.bytes_per_sample();
    let (luma, rest) = planes.split_at_mut(width * height * stride);
    let (cb_plane, cr_plane) = rest.split_at_mut(width * height * stride);

    for y in 0..height {
        for x in 0..width {
            let at = (y * source_width + x) * 3;
            let signal_of = |sample: u16| f32::from(sample) / 65535.0;
            let signal = [
                signal_of(pq[at]),
                signal_of(pq[at + 1]),
                signal_of(pq[at + 2]),
            ];
            let y_signal = LUMA[0] * signal[0] + LUMA[1] * signal[1] + LUMA[2] * signal[2];
            let (floor, span) = depth.luma();
            // `+ 0.5` and truncate rather than `round()`: both are non-negative, where the
            // two agree, and `round()` is a libm call on a target with no rounding
            // instruction - nine million a frame.
            let code =
                (floor + span * y_signal.clamp(0.0, 1.0) + dither(depth, x, y) + 0.5) as u16;
            let at = y * width + x;
            write(luma, depth, at, code);

            let noise = dither(depth, x, y);
            let (mid, span) = depth.chroma();
            let quantise =
                |difference: f32| (mid + span * difference.clamp(-0.5, 0.5) + noise + 0.5) as u16;
            write(cb_plane, depth, at, quantise((signal[2] - y_signal) / 1.8814));
            write(cr_plane, depth, at, quantise((signal[0] - y_signal) / 1.4746));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planes_of(pq: &[u16], w: usize, h: usize, depth: Depth) -> (Vec<u16>, Vec<u16>) {
        let mut planes = vec![0u8; depth.plane_bytes(w, h)];
        pack(pq, w, w, h, depth, &mut planes);
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

    /// The point of 4:4:4: colour that changes every pixel reaches the element, where a
    /// subsample would average each neighbouring pair into one and could not.
    #[test]
    fn colour_survives_at_the_resolution_luma_does() {
        // Alternating red and blue columns, which is the worst case for a 2x1 average.
        let (width, height) = (4usize, 4usize);
        let mut pq = vec![0u16; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let at = (y * width + x) * 3;
                pq[at + if x % 2 == 0 { 0 } else { 2 }] = u16::MAX;
            }
        }

        let (_, chroma) = planes_of(&pq, width, height, Depth::Ten);
        assert_eq!(chroma.len(), width * height * 2, "both planes are full resolution");
        // Per plane, since Cb and Cr differ from each other in any sampling. What a
        // subsample would destroy is the variation *within* one of them.
        for plane in chroma.chunks_exact(width * height) {
            for row in plane.chunks_exact(width) {
                assert_ne!(row[0], row[1], "neighbouring columns were averaged together: {row:?}");
            }
        }
    }
}
