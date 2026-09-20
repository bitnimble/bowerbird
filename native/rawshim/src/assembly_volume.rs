//! What the analysis leaves on disk for a seam solve: its seam field, and the plane it was measured
//! on.

use crate::assembly_seam::{NOT_REACHED, SeamField};

/// What the analysis leaves for [`crate::assembly_seams::solve`]: its seam field in source order,
/// over the plane it was measured on.
pub struct Volume {
    /// The analysis plane the shrunk grid was cut from, which is what carries a cell to the canvas.
    pub plane: (usize, usize),
    pub shrunk: (usize, usize),
    pub field: SeamField,
}

const MAGIC: u32 = u32::from_le_bytes(*b"BBSV");
const VERSION: u32 = 4;
const HEADER_WORDS: usize = 7;

impl Volume {
    pub fn to_bytes(&self) -> Vec<u8> {
        let header: [u32; HEADER_WORDS] = [
            MAGIC,
            VERSION,
            self.plane.0 as u32,
            self.plane.1 as u32,
            self.shrunk.0 as u32,
            self.shrunk.1 as u32,
            self.field.sources as u32,
        ];
        let mut out = Vec::new();
        out.extend_from_slice(bytemuck::cast_slice(&header));
        out.extend_from_slice(bytemuck::cast_slice(&self.field.level));
        out.extend_from_slice(bytemuck::cast_slice(&self.field.tint));
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Volume, String> {
        let refused = || "that is not a seam volume this build can read".to_string();
        let words = |from: usize, count: usize| -> Result<&[u8], String> {
            bytes.get(from * 4..(from + count) * 4).ok_or_else(refused)
        };
        let header: Vec<u32> = bytemuck::pod_collect_to_vec(words(0, HEADER_WORDS)?);
        if header[0] != MAGIC || header[1] != VERSION {
            return Err(refused());
        }
        let [plane_w, plane_h, w, h, sources] = [2, 3, 4, 5, 6].map(|at| header[at] as usize);
        let cells = w * h;
        let levels = cells * (sources + 1);
        let tints = cells * sources * 2;
        if bytes.len() != (HEADER_WORDS + levels + tints) * 4 {
            return Err(refused());
        }
        let mut at = HEADER_WORDS;
        let mut take = |count: usize| {
            let held = words(at, count);
            at += count;
            held
        };
        Ok(Volume {
            plane: (plane_w, plane_h),
            shrunk: (w, h),
            field: SeamField {
                level: bytemuck::pod_collect_to_vec(take(levels)?),
                tint: bytemuck::pod_collect_to_vec(take(tints)?),
                sources,
            },
        })
    }
}

/// `field` reordered from the planes' order into the sources', the consensus staying first.
pub fn by_source(field: SeamField, plane_sources: &[usize]) -> SeamField {
    let per = field.sources + 1;
    let mut level = vec![NOT_REACHED; field.level.len()];
    for (cell, row) in field.level.chunks_exact(per).enumerate() {
        level[cell * per] = row[0];
        for (i, &source) in plane_sources.iter().enumerate() {
            level[cell * per + 1 + source] = row[1 + i];
        }
    }
    let per = field.sources * 2;
    let mut tint = vec![0.0; field.tint.len()];
    for (cell, row) in field.tint.chunks_exact(per).enumerate() {
        for (i, &source) in plane_sources.iter().enumerate() {
            tint[cell * per + source * 2..][..2].copy_from_slice(&row[i * 2..][..2]);
        }
    }
    SeamField {
        level,
        tint,
        ..field
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assembly_seams::tests::{MOVED, burst};

    #[test]
    fn a_volume_reads_back_what_was_written() {
        let volume = burst(MOVED);
        let read = Volume::from_bytes(&volume.to_bytes()).expect("a volume");

        assert_eq!((read.plane, read.shrunk), (volume.plane, volume.shrunk));
        assert_eq!(read.field.level, volume.field.level);
        assert_eq!(read.field.tint, volume.field.tint);
        assert!(Volume::from_bytes(&volume.to_bytes()[..40]).is_err());
        assert!(Volume::from_bytes(b"not a volume at all").is_err());
    }
}
