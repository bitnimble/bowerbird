//! The camera match, small enough to keep.
//!
//! Fitting it costs about half a second - the embedded JPEG is decoded, resampled and a curve
//! fitted per channel against the render - and the answer depends on nothing but the file. So
//! every path that wants one pays for the same answer over and over: a rendition job, an
//! on-demand rebuild after an edit, the editor's open, and worst of all the loupe, which asks
//! for a new tile every time the reader moves. Measured on a 24MP CR3, a 400px tile is 626ms
//! with the fit and 112ms with it already in hand.
//!
//! What the fit *is* turns out to be small: 1,696 numbers. Two thirds of them are the chroma
//! lattice, which the shader reads out of an `rgba16float` texture - so they are stored as
//! `f16`, because anything more is precision the GPU truncates on the way in. The tone curves
//! are read from `r32float` and stay `f32`: a curve feeding an HDR grade is exactly where a
//! thousandth of an error shows up as a band in a smooth sky.
//!
//! **Nothing an edit touches reaches this.** A crop, an exposure, a denoise amount - none of
//! them are inputs to the fit; only the file is. So a stored match cannot go stale except by
//! the photograph itself changing, which is what the caller's own key is for.
//!
//! The format is little-endian and versioned, and a blob this build does not recognise reads
//! as "no match stored" rather than as an error: the fit is then done the slow way, which is
//! what happened before any of this existed.

use crate::fit::Lens;
use crate::hdr_fit::{ChromaMap, HdrColour, HdrMatch};
use half::f16;

/// Bumped when the layout below changes, so an older blob is ignored rather than misread.
const VERSION: u8 = 1;
const MAGIC: [u8; 3] = *b"BBM";

/// The bytes to store for this photograph.
pub fn encode(matched: &HdrMatch) -> Vec<u8> {
    let mut out = Vec::with_capacity(6 * 1024);
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);

    let colour = &matched.colour;
    // The curves, whose length is the fit's own `BINS` and is written rather than assumed.
    put_u32(&mut out, colour.curves[0].len() as u32);
    for channel in &colour.curves {
        put_f32s(&mut out, channel);
    }
    for row in &colour.matrix {
        put_f32s(&mut out, row);
    }
    put_f32(&mut out, colour.saturation);
    // Carried, though nothing downstream reads it: it is what the fit scored, and a stored
    // match that came back without it would report a photograph as unmeasured rather than as
    // measured well.
    put_f32(&mut out, colour.delta_e);

    match &colour.chroma {
        None => out.push(0),
        Some(map) => {
            out.push(1);
            let shape = map.shape();
            put_f32s(&mut out, &shape.chroma_low);
            put_f32s(&mut out, &shape.chroma_scale);
            // The lattice at the precision its texture holds.
            for value in map.nodes_flat() {
                out.extend_from_slice(&f16::from_f64(value).to_le_bytes());
            }
        }
    }

    let lens = &matched.lens;
    put_option_f32s(&mut out, lens.distortion.as_deref());
    put_f32(&mut out, lens.crop);
    match lens.falloff {
        None => out.push(0),
        Some((a, b)) => {
            out.push(1);
            put_f32(&mut out, a);
            put_f32(&mut out, b);
        }
    }
    match &lens.tca {
        None => out.push(0),
        Some([red, blue]) => {
            out.push(1);
            put_option_f32s(&mut out, Some(red));
            put_option_f32s(&mut out, Some(blue));
        }
    }
    out
}

/// The match those bytes described, or None where they described nothing this build reads.
pub fn decode(bytes: &[u8]) -> Option<HdrMatch> {
    let mut at = Reader { bytes, at: 0 };
    if at.take(3)? != MAGIC || at.u8()? != VERSION {
        return None;
    }

    let bins = at.u32()? as usize;
    // A length from a stored blob decides how much is read, so it is bounded before it is
    // trusted: the fit's own is 256, and nothing legitimate is anywhere near this.
    if bins == 0 || bins > 4096 {
        return None;
    }
    let curves = [at.f32s(bins)?, at.f32s(bins)?, at.f32s(bins)?];
    let matrix = [
        [at.f32()?, at.f32()?, at.f32()?],
        [at.f32()?, at.f32()?, at.f32()?],
        [at.f32()?, at.f32()?, at.f32()?],
    ];
    let saturation = at.f32()?;
    let delta_e = at.f32()?;

    let chroma = match at.u8()? {
        0 => None,
        _ => {
            let low = [at.f32()?, at.f32()?];
            let scale = [at.f32()?, at.f32()?];
            let mut nodes = Vec::with_capacity(crate::hdr_fit::map_nodes() * crate::hdr_fit::NODE_VALUES);
            for _ in 0..nodes.capacity() {
                nodes.push(f64::from(f16::from_le_bytes([at.u8()?, at.u8()?])));
            }
            Some(ChromaMap::from_parts(&nodes, low, scale)?)
        }
    };

    let distortion = at.option_f32s()?;
    let crop = at.f32()?;
    let falloff = match at.u8()? {
        0 => None,
        _ => Some((at.f32()?, at.f32()?)),
    };
    let tca = match at.u8()? {
        0 => None,
        _ => {
            let red = at.option_f32s()?.unwrap_or_default();
            let blue = at.option_f32s()?.unwrap_or_default();
            Some([red, blue])
        }
    };

    Some(HdrMatch {
        lens: Lens { distortion, crop, falloff, tca },
        colour: HdrColour { curves, matrix, saturation, delta_e, chroma },
    })
}

#[cfg(test)]
mod tests {
    use super::{VERSION, decode, encode};
    use crate::fit::Lens;
    use crate::hdr_fit::{ChromaMap, HdrColour, HdrMatch, NODE_VALUES, map_nodes};

    fn a_match() -> HdrMatch {
        // Values that are not round, so a field read out of the wrong offset shows up as a
        // mismatch rather than as a coincidence.
        let curve = |base: f64| (0..256).map(|i| base + f64::from(i) * 0.0031).collect::<Vec<_>>();
        let nodes: Vec<f64> =
            (0..map_nodes() * NODE_VALUES).map(|i| 0.5 + f64::from(i as u32) * 0.0007).collect();
        HdrMatch {
            lens: Lens {
                distortion: Some(vec![0.0, 0.011, 0.023, 0.041]),
                crop: 1.0234,
                falloff: Some((0.317, -0.0412)),
                tca: Some([vec![1.0, 1.0004], vec![1.0, 0.9993]]),
            },
            colour: HdrColour {
                curves: [curve(0.01), curve(0.02), curve(0.03)],
                matrix: [[1.02, -0.01, 0.003], [-0.02, 1.03, -0.011], [0.004, -0.02, 1.04]],
                saturation: 0.937,
                delta_e: 1.83,
                chroma: ChromaMap::from_parts(&nodes, [0.11, 0.22], [3.5, 4.5]),
            },
        }
    }

    #[test]
    fn a_match_survives_the_round_trip() {
        let before = a_match();
        let after = decode(&encode(&before)).expect("it reads back");

        // The curves keep `f32`, which is what their texture holds.
        for (channel, was) in after.colour.curves.iter().zip(&before.colour.curves) {
            for (read, wrote) in channel.iter().zip(was) {
                assert!((read - wrote).abs() < 1e-6, "{read} against {wrote}");
            }
        }
        assert!((after.colour.saturation - before.colour.saturation).abs() < 1e-6);
        assert!((after.colour.delta_e - before.colour.delta_e).abs() < 1e-6);
        assert!((after.lens.crop - before.lens.crop).abs() < 1e-6);
        assert_eq!(after.lens.distortion.is_some(), true);
        assert!((after.lens.falloff.unwrap().1 - before.lens.falloff.unwrap().1).abs() < 1e-6);

        // **The lattice keeps only what its texture does.** `rgba16float` is where these end
        // up, so storing more than `f16` would be storing precision the GPU discards - and the
        // tolerance here says exactly that rather than hiding it behind a loose comparison.
        let (read, wrote) = (
            after.colour.chroma.expect("a map").nodes_flat(),
            before.colour.chroma.expect("a map").nodes_flat(),
        );
        for (read, wrote) in read.iter().zip(&wrote) {
            assert!((read - wrote).abs() < 1e-3, "{read} against {wrote}");
        }
    }

    #[test]
    fn a_blob_this_build_does_not_know_reads_as_nothing_stored() {
        assert!(decode(&[]).is_none());
        assert!(decode(b"not a camera match").is_none());

        // A version this build has never seen is ignored rather than misread: the alternative
        // is reading one layout's bytes as another's, which is a photograph with somebody
        // else's colour rather than a photograph that had to be fitted again.
        let mut wrong = encode(&a_match());
        wrong[3] = VERSION + 1;
        assert!(decode(&wrong).is_none());

        // And a blob cut short stops rather than reading past the end.
        let whole = encode(&a_match());
        assert!(decode(&whole[..whole.len() / 2]).is_none());
    }
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_f32(out: &mut Vec<u8>, value: f64) {
    out.extend_from_slice(&(value as f32).to_le_bytes());
}

fn put_f32s(out: &mut Vec<u8>, values: &[f64]) {
    for value in values {
        put_f32(out, *value);
    }
}

fn put_option_f32s(out: &mut Vec<u8>, values: Option<&[f64]>) {
    match values {
        None => out.push(0),
        Some(values) => {
            out.push(1);
            put_u32(out, values.len() as u32);
            put_f32s(out, values);
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Option<&[u8]> {
        let end = self.at.checked_add(count)?;
        let slice = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(slice)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }

    fn f32(&mut self) -> Option<f64> {
        Some(f64::from(f32::from_le_bytes(self.take(4)?.try_into().ok()?)))
    }

    fn f32s(&mut self, count: usize) -> Option<Vec<f64>> {
        (0..count).map(|_| self.f32()).collect()
    }

    fn option_f32s(&mut self) -> Option<Option<Vec<f64>>> {
        match self.u8()? {
            0 => Some(None),
            _ => {
                let count = self.u32()? as usize;
                if count > 4096 {
                    return None;
                }
                Some(Some(self.f32s(count)?))
            }
        }
    }
}
