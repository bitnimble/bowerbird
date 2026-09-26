//! Pictures pinned as pictures: a test's answer committed as a PNG a reader can open, rather than as
//! bytes only the test can read.
//!
//! A snapshot is one of two codings, and both are what the pipeline already writes: PQ Rec.2020 at
//! sixteen bits with the `cICP` chunk that makes a browser show it as HDR, or sRGB at eight. A frame
//! the coding has not reached, and a mosaic, are coded by the pipeline's own coding on the way in,
//! so every snapshot opens as a photograph - in a PR's image diff as much as anywhere.
//!
//! Compared in the stored codes, which for both codings are perceptual, so a tolerance means the
//! same amount of visible change in the shadows as in the highlights.
//!
//! Regenerate deliberately, after looking at why they moved (`bun run snapshots` draws each one
//! beside the committed copy):
//!
//!   BOWERBIRD_WRITE_FIXTURES=1 bun run test:native <name>

use crate::condition::Mosaic;
use crate::light::{DisplayNits, Light, Pq, SceneNits};
use crate::px::{Pinned, Rect, Size, Span};
use crate::resident::Resident;
use crate::tone::Anchored;

/// The nits an SDR view of a PQ snapshot puts at its white, BT.2408's reference.
const DISPLAY_WHITE: Light<DisplayNits> = Light::exactly(203.0);

/// The nits the side-by-side's second exposure puts at SDR white: the library's HDR peak.
const VIEW_PEAK: Light<DisplayNits> = Light::exactly(1000.0);

/// Between crops in a snapshot, and between panels side by side.
const GAP: usize = 8;

/// Between a side-by-side's exposures, wider than [`GAP`] so a block does not read as one more crop.
const BAND_GAP: usize = 32;

/// The side-by-side's background, and the before of a snapshot that has none.
const BLANK: u8 = 48;

/// The difference in codes a side-by-side draws at full red.
const DIFF_FULL_SCALE: f64 = 1024.0;

/// How long a side-by-side's panels are drawn, at least, by nearest neighbour.
const VIEW_LONG: usize = 512;
const VIEW_MAX_ZOOM: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Coding {
    Pq,
    Srgb,
}

/// A frame on the device, and what its samples are.
pub enum Frame<'a> {
    /// PQ codes, as the grade and `base::prepare` write them.
    Coded(&'a Resident),
    /// Scene-linear levels the coding has not reached yet.
    Scene(&'a Resident, Anchoring),
}

/// Where a scene-linear frame's diffuse white lands when it is coded to be looked at.
#[derive(Clone, Copy)]
pub struct Anchoring {
    pub levels: Anchored,
    pub reference_white_nits: Light<SceneNits>,
}

/// How far a snapshot may drift from its committed copy, in sixteen-bit codes of its coding.
#[derive(Clone, Copy, Debug)]
pub struct Tolerance {
    pub worst: u16,
    pub mean: f64,
}

impl Tolerance {
    pub const EXACT: Tolerance = Tolerance {
        worst: 0,
        mean: 0.0,
    };
}

#[derive(Clone, Copy, Debug)]
pub struct Drift {
    pub mean: f64,
    pub worst: u16,
    /// The pixel the worst sample is in.
    pub at: (usize, usize),
}

#[derive(Clone, PartialEq, Debug)]
pub struct Snapshot {
    pub coding: Coding,
    pub width: usize,
    pub height: usize,
    /// Interleaved RGB at sixteen bits, an sRGB byte widened by 257 so both codings share a scale.
    pub samples: Vec<u16>,
}

impl Snapshot {
    /// The whole frame, downscaled on the device by the resize a rendition is cut with, so the mean
    /// is of light. A frame already no longer than `long` is taken as it is.
    pub fn whole(frame: Frame<'_>, long: Span<Pinned>) -> Snapshot {
        let resident = frame.resident();
        let gpu = resident.gpu();
        let base = crate::base::device(gpu).expect("the base kernels");
        let (width, height) = resident.size();
        let scale = long.raw() as f64 / width.max(height) as f64;
        let out = (
            ((width as f64 * scale).round() as usize).max(1),
            ((height as f64 * scale).round() as usize).max(1),
        );
        let resized = match frame {
            Frame::Coded(_) => crate::base::resize(gpu, base, resident, out),
            Frame::Scene(..) => crate::base::resize_scene(gpu, base, resident, out),
        };
        let taken = resized.as_ref().unwrap_or(resident);
        let (width, height) = taken.size();
        let samples = pollster::block_on(taken.host()).expect("the frame reads back");
        Snapshot::coded(frame.code(samples), width, height)
    }

    /// Rectangles of the frame at 1:1, one under the next.
    pub fn crops<S>(frame: Frame<'_>, crops: &[Rect<S>]) -> Snapshot {
        let resident = frame.resident();
        let (width, height) = resident.size();
        let samples = pollster::block_on(resident.host()).expect("the frame reads back");
        let (cut, cut_width, cut_height) = stacked(crops, (width, height), |x, y| {
            let at = (y * width + x) * 3;
            [samples[at], samples[at + 1], samples[at + 2]]
        });
        Snapshot::coded(frame.code(cut), cut_width, cut_height)
    }

    /// Rectangles of a mosaic at 1:1, each photosite drawn in its own filter's colour.
    pub fn mosaic<S>(
        gpu: &'static crate::gpu::Gpu,
        mosaic: &Mosaic,
        cfa: &crate::cfa::Cfa,
        anchoring: Anchoring,
        crops: &[Rect<S>],
    ) -> Snapshot {
        let values = pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back");
        let width = mosaic.width;
        let (cut, cut_width, cut_height) = stacked(crops, (mosaic.width, mosaic.height), |x, y| {
            // A full-scale photosite is the full-scale level `encode_base` codes from.
            let level = (values[y * width + x] * f32::from(u16::MAX))
                .round()
                .clamp(0.0, f32::from(u16::MAX)) as u16;
            let mut pixel = [0u16; 3];
            pixel[usize::from(cfa.colour_at(y, x))] = level;
            pixel
        });
        let coded = code_scene(gpu, cut, anchoring);
        Snapshot::coded(coded, cut_width, cut_height)
    }

    /// PQ codes already on the host, as they are.
    pub fn pq<S>(samples: &[u16], size: Size<S>) -> Snapshot {
        let (width, height) = size.raw();
        assert_eq!(
            samples.len(),
            width * height * 3,
            "a PQ frame of {width}x{height}"
        );
        Snapshot::coded(samples.to_vec(), width, height)
    }

    /// The grade's rolled arm - display light as a share of `peak` - coded to PQ to be looked at.
    pub fn signal<S>(samples: &[u16], size: Size<S>, peak: Light<DisplayNits>) -> Snapshot {
        let coded: Vec<u16> = (0..=u16::MAX)
            .map(|level| {
                let share = f64::from(level) / f64::from(u16::MAX);
                let nits = Light::<DisplayNits>::measured(peak.raw() * share);
                (crate::tone::pq(nits).raw() * f64::from(u16::MAX)).round() as u16
            })
            .collect();
        let samples: Vec<u16> = samples.iter().map(|&v| coded[usize::from(v)]).collect();
        Snapshot::pq(&samples, size)
    }

    /// An SDR picture as it was written, at the size it was rendered at.
    pub fn srgb<S>(samples: &[u8], size: Size<S>) -> Snapshot {
        let (width, height) = size.raw();
        assert_eq!(
            samples.len(),
            width * height * 3,
            "an sRGB frame of {width}x{height}"
        );
        Snapshot {
            coding: Coding::Srgb,
            width,
            height,
            samples: samples.iter().map(|&v| u16::from(v) * 257).collect(),
        }
    }

    fn coded(samples: Vec<u16>, width: usize, height: usize) -> Snapshot {
        Snapshot {
            coding: Coding::Pq,
            width,
            height,
            samples,
        }
    }

    /// Holds this against `test/fixtures/snapshots/<name>.png`, or writes it there under
    /// `BOWERBIRD_WRITE_FIXTURES=1`. A mismatch writes this and a side-by-side under [`scratch`].
    pub fn check(&self, name: &str, tolerance: Tolerance) {
        let path = dir().join(format!("{name}.png"));
        if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
            std::fs::create_dir_all(path.parent().expect("a snapshot directory"))
                .expect("the snapshot directory");
            std::fs::write(&path, self.encode()).expect("writing the snapshot");
            eprintln!("wrote {}", path.display());
            return;
        }
        let bytes = std::fs::read(&path).unwrap_or_else(|e| {
            panic!(
                "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
                path.display()
            )
        });
        let want = Snapshot::decode(&bytes).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let Some(why) = self.differs_from(&want, tolerance) else {
            return;
        };

        let actual = scratch().join(format!("{name}.png"));
        let side_by_side = scratch().join(format!("{name}.diff.png"));
        std::fs::create_dir_all(actual.parent().expect("a scratch directory"))
            .expect("the scratch directory");
        std::fs::write(&actual, self.encode()).expect("writing the actual snapshot");
        std::fs::write(&side_by_side, side_by_side_png(Some(&want), self))
            .expect("writing the side-by-side");
        panic!(
            "snapshot {name} moved: {why}\n  actual       {}\n  side by side {} (before | after | difference)\n\
             BOWERBIRD_WRITE_FIXTURES=1 rewrites it, if it was meant to move",
            actual.display(),
            side_by_side.display(),
        );
    }

    fn differs_from(&self, want: &Snapshot, tolerance: Tolerance) -> Option<String> {
        if self.coding != want.coding {
            return Some(format!(
                "coded {:?}, committed {:?}",
                self.coding, want.coding
            ));
        }
        if (self.width, self.height) != (want.width, want.height) {
            return Some(format!(
                "{}x{}, committed {}x{}",
                self.width, self.height, want.width, want.height
            ));
        }
        let drift = drift(want, self)?;
        (drift.worst > tolerance.worst || drift.mean > tolerance.mean).then(|| {
            format!(
                "worst {} codes at {:?} (allowed {}), mean {:.3} (allowed {})",
                drift.worst, drift.at, tolerance.worst, drift.mean, tolerance.mean
            )
        })
    }

    pub fn encode(&self) -> Vec<u8> {
        match self.coding {
            Coding::Pq => crate::png_write::encode_hdr(&self.samples, self.width, self.height, None),
            Coding::Srgb => {
                let bytes: Vec<u8> = self.samples.iter().map(|&v| (v / 257) as u8).collect();
                crate::png_write::encode_sdr(&bytes, self.width, self.height, None)
            }
        }
        .expect("the snapshot encodes")
    }

    pub fn decode(bytes: &[u8]) -> Result<Snapshot, String> {
        if bytes.starts_with(b"version https://git-lfs") {
            return Err("an LFS pointer rather than the picture: `git lfs pull`".into());
        }
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .map_err(|e| format!("not a PNG: {e}"))?;
        let info = reader.info();
        let (width, height) = (info.width as usize, info.height as usize);
        let points = info.coding_independent_code_points.ok_or("no cICP chunk")?;
        let coding = match (
            (points.color_primaries, points.transfer_function),
            info.bit_depth,
        ) {
            (crate::png_write::HDR, png::BitDepth::Sixteen) => Coding::Pq,
            (crate::png_write::SDR, png::BitDepth::Eight) => Coding::Srgb,
            other => return Err(format!("not a snapshot's coding: {other:?}")),
        };
        let mut buffer = vec![0u8; reader.output_buffer_size().ok_or("an oversized PNG")?];
        reader
            .next_frame(&mut buffer)
            .map_err(|e| format!("could not decode: {e}"))?;
        let count = width * height * 3;
        let samples = match coding {
            Coding::Pq => buffer
                .chunks_exact(2)
                .take(count)
                .map(|b| u16::from_be_bytes([b[0], b[1]]))
                .collect(),
            Coding::Srgb => buffer
                .iter()
                .take(count)
                .map(|&v| u16::from(v) * 257)
                .collect(),
        };
        Ok(Snapshot {
            coding,
            width,
            height,
            samples,
        })
    }
}

impl Frame<'_> {
    fn resident(&self) -> &Resident {
        match self {
            Frame::Coded(frame) | Frame::Scene(frame, _) => frame,
        }
    }

    fn code(&self, samples: Vec<u16>) -> Vec<u16> {
        match self {
            Frame::Coded(_) => samples,
            Frame::Scene(frame, anchoring) => code_scene(frame.gpu(), samples, *anchoring),
        }
    }
}

fn code_scene(
    gpu: &'static crate::gpu::Gpu,
    mut samples: Vec<u16>,
    anchoring: Anchoring,
) -> Vec<u16> {
    let base = crate::base::device(gpu).expect("the base kernels");
    pollster::block_on(crate::base::encode_base(
        gpu,
        base,
        &mut samples,
        anchoring.levels,
        anchoring.reference_white_nits,
    ))
    .expect("the coding");
    samples
}

/// The rectangles top to bottom, left-aligned, over zero.
fn stacked<S>(
    crops: &[Rect<S>],
    frame: (usize, usize),
    pixel: impl Fn(usize, usize) -> [u16; 3],
) -> (Vec<u16>, usize, usize) {
    assert!(!crops.is_empty(), "no crops");
    let rects: Vec<(usize, usize, usize, usize)> = crops.iter().map(|r| r.raw()).collect();
    for &(x, y, w, h) in &rects {
        assert!(
            w > 0 && h > 0 && x + w <= frame.0 && y + h <= frame.1,
            "crop {w}x{h} at {x},{y} is not inside the {}x{} frame",
            frame.0,
            frame.1,
        );
    }
    let width = rects.iter().map(|r| r.2).max().unwrap_or(0);
    let height = rects.iter().map(|r| r.3).sum::<usize>() + GAP * (rects.len() - 1);
    let mut out = vec![0u16; width * height * 3];
    let mut top = 0;
    for (x, y, w, h) in rects {
        for row in 0..h {
            for col in 0..w {
                let at = ((top + row) * width + col) * 3;
                out[at..at + 3].copy_from_slice(&pixel(x + col, y + row));
            }
        }
        top += h + GAP;
    }
    (out, width, height)
}

/// None where the two are not the same shape and coding, which is a difference no number states.
pub fn drift(before: &Snapshot, after: &Snapshot) -> Option<Drift> {
    if before.coding != after.coding || (before.width, before.height) != (after.width, after.height)
    {
        return None;
    }
    let (mut total, mut worst, mut at) = (0u64, 0u16, 0usize);
    for (index, (a, b)) in before.samples.iter().zip(&after.samples).enumerate() {
        let error = a.abs_diff(*b);
        total += u64::from(error);
        if error > worst {
            (worst, at) = (error, index);
        }
    }
    let pixel = at / 3;
    Some(Drift {
        mean: total as f64 / before.samples.len().max(1) as f64,
        worst,
        at: (pixel % before.width, pixel / before.width),
    })
}

/// Where a failed check leaves what it saw, and `snapshot_diff` its side-by-sides.
pub fn scratch() -> std::path::PathBuf {
    std::env::temp_dir().join("bowerbird-snapshots")
}

pub fn dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/snapshots")
}

/// An SDR PNG of before, after and where they differ, as columns, enlarged to be read: what an
/// agent or a terminal can look at where a PR's HDR image diff is not to hand. A snapshot's crops
/// are its rows.
///
/// PQ is drawn twice, one block under the other, by exposure alone and never a tone map: once with
/// diffuse white at SDR white, clipping above it, and once with [`VIEW_PEAK`] there, which is where
/// the highlights are read.
pub fn side_by_side_png(before: Option<&Snapshot>, after: &Snapshot) -> Vec<u8> {
    let (width, height) = (after.width, after.height);
    let whites: &[Light<DisplayNits>] = match after.coding {
        Coding::Pq => &[DISPLAY_WHITE, VIEW_PEAK],
        Coding::Srgb => &[DISPLAY_WHITE],
    };
    let rows: Vec<Vec<Vec<u8>>> = whites
        .iter()
        .map(|&white| {
            let shown = view(after, white);
            // A new snapshot: the whole of it is what changed.
            let Some(before) = before else {
                return vec![vec![BLANK; shown.len()], shown.clone(), shown];
            };
            if (before.width, before.height) != (width, height) {
                let fitted = fit(
                    &view(before, white),
                    (before.width, before.height),
                    (width, height),
                );
                return vec![fitted, shown];
            }
            let moved = difference(before, after, &shown);
            vec![view(before, white), shown, moved]
        })
        .collect();

    let zoom = (VIEW_LONG / width.max(height).max(1)).clamp(1, VIEW_MAX_ZOOM);
    let (panel_w, panel_h) = (width * zoom, height * zoom);
    let (columns, bands) = (rows[0].len(), rows.len());
    let out_w = panel_w * columns + GAP * (columns - 1);
    let out_h = panel_h * bands + BAND_GAP * (bands - 1);
    let mut out = vec![BLANK; out_w * out_h * 3];
    let placed = rows.iter().enumerate().flat_map(|(band, row)| {
        row.iter()
            .enumerate()
            .map(move |(column, panel)| (band, column, panel))
    });
    for (band, column, panel) in placed {
        let (left, top) = (column * (panel_w + GAP), band * (panel_h + BAND_GAP));
        for y in 0..panel_h {
            for x in 0..panel_w {
                let from = ((y / zoom) * width + x / zoom) * 3;
                let into = ((top + y) * out_w + left + x) * 3;
                out[into..into + 3].copy_from_slice(&panel[from..from + 3]);
            }
        }
    }
    crate::png_write::encode_sdr(&out, out_w, out_h, None).expect("the side-by-side encodes")
}

/// Eight-bit sRGB to show a snapshot as, with `white` at SDR white.
fn view(snapshot: &Snapshot, white: Light<DisplayNits>) -> Vec<u8> {
    if snapshot.coding == Coding::Srgb {
        return snapshot.samples.iter().map(|&v| (v / 257) as u8).collect();
    }
    let share: Vec<f64> = (0..=u16::MAX)
        .map(|code| {
            let signal = Light::<Pq>::measured(f64::from(code) / f64::from(u16::MAX));
            crate::tone::pq_inv::<DisplayNits>(signal) / white
        })
        .map(|gain| gain.raw())
        .collect();
    let matrix = crate::hdr_fit::rec2020_to_srgb();
    let mut out = Vec::with_capacity(snapshot.samples.len());
    for pixel in snapshot.samples.chunks_exact(3) {
        let rgb = [0, 1, 2].map(|c| share[usize::from(pixel[c])]);
        for row in matrix {
            let linear = (row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]).clamp(0.0, 1.0);
            out.push((crate::hdr_fit::srgb_oetf(linear) * 255.0).round() as u8);
        }
    }
    out
}

/// The after picture darkened, with every pixel that moved in red by how far it moved.
fn difference(before: &Snapshot, after: &Snapshot, after_view: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(after_view.len());
    for ((a, b), shown) in before
        .samples
        .chunks_exact(3)
        .zip(after.samples.chunks_exact(3))
        .zip(after_view.chunks_exact(3))
    {
        let moved = (0..3).map(|c| a[c].abs_diff(b[c])).max().unwrap_or(0);
        let heat = (f64::from(moved) / DIFF_FULL_SCALE).sqrt().min(1.0);
        let ground = (f64::from(shown[0]) + f64::from(shown[1]) + f64::from(shown[2])) / 12.0;
        out.extend_from_slice(&[
            (ground + heat * (255.0 - ground)) as u8,
            (ground * (1.0 - heat)) as u8,
            (ground * (1.0 - heat)) as u8,
        ]);
    }
    out
}

/// A view placed top-left on a canvas of another size, cropped where it overhangs.
fn fit(view: &[u8], from: (usize, usize), to: (usize, usize)) -> Vec<u8> {
    let mut out = vec![BLANK; to.0 * to.1 * 3];
    for y in 0..from.1.min(to.1) {
        let span = from.0.min(to.0) * 3;
        out[y * to.0 * 3..][..span].copy_from_slice(&view[y * from.0 * 3..][..span]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(coding: Coding, width: usize, height: usize) -> Snapshot {
        let samples = (0..width * height * 3)
            .map(|i| match coding {
                Coding::Pq => (i * 997 % 65536) as u16,
                Coding::Srgb => (i * 31 % 256) as u16 * 257,
            })
            .collect();
        Snapshot {
            coding,
            width,
            height,
            samples,
        }
    }

    #[test]
    fn a_snapshot_survives_its_png_in_either_coding() {
        for coding in [Coding::Pq, Coding::Srgb] {
            let snapshot = gradient(coding, 12, 7);
            assert_eq!(
                Snapshot::decode(&snapshot.encode()).expect("decodes"),
                snapshot
            );
        }
    }

    #[test]
    fn an_lfs_pointer_is_named_as_one() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n";
        let error = Snapshot::decode(pointer).expect_err("not a picture");
        assert!(error.contains("git lfs pull"), "{error}");
    }

    #[test]
    fn drift_names_the_worst_pixel_and_the_tolerance_holds_it() {
        let before = gradient(Coding::Pq, 10, 6);
        let mut after = before.clone();
        after.samples[(4 * 10 + 7) * 3 + 1] ^= 40;

        let drift = drift(&before, &after).expect("same shape");
        assert_eq!((drift.worst, drift.at), (40, (7, 4)));
        assert!((drift.mean - 40.0 / 180.0).abs() < 1e-12);

        let loose = Tolerance {
            worst: 40,
            mean: 1.0,
        };
        assert_eq!(after.differs_from(&before, loose), None);
        assert!(after.differs_from(&before, Tolerance::EXACT).is_some());
    }

    #[test]
    fn a_different_shape_or_coding_is_a_difference_whatever_the_tolerance() {
        let wide = Tolerance {
            worst: u16::MAX,
            mean: f64::MAX,
        };
        let before = gradient(Coding::Pq, 10, 6);
        assert!(
            gradient(Coding::Pq, 6, 10)
                .differs_from(&before, wide)
                .is_some()
        );
        assert!(
            gradient(Coding::Srgb, 10, 6)
                .differs_from(&before, wide)
                .is_some()
        );
    }

    #[test]
    fn crops_are_laid_top_to_bottom_with_a_gap() {
        let rects = [Rect::<Pinned>::exact(1, 2, 3, 2), Rect::exact(0, 0, 2, 4)];
        let (cut, width, height) = stacked(&rects, (8, 8), |x, y| [x as u16, y as u16, 7]);
        assert_eq!((width, height), (3, 2 + GAP + 4));
        let at = |x: usize, y: usize| &cut[(y * width + x) * 3..][..3];
        assert_eq!(at(0, 0), [1, 2, 7]);
        assert_eq!(at(2, 1), [3, 3, 7]);
        assert_eq!(at(0, 2), [0, 0, 0], "the gap is empty");
        assert_eq!(at(1, 2 + GAP + 3), [1, 3, 7]);
        assert_eq!(at(2, 2 + GAP), [0, 0, 0], "beside a narrower crop is empty");
    }

    fn flat(width: usize, height: usize, code: u16) -> Snapshot {
        Snapshot::coded(vec![code; width * height * 3], width, height)
    }

    /// The side-by-side's pixels, and a reader of one at a panel's centre.
    fn drawn(png: &[u8]) -> (usize, usize, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .expect("a PNG");
        let mut pixels = vec![0u8; reader.output_buffer_size().expect("a size")];
        reader.next_frame(&mut pixels).expect("decodes");
        let info = reader.info();
        (info.width as usize, info.height as usize, pixels)
    }

    /// Wide on purpose: the columns are before, after and difference whatever the shape. The
    /// after is 500 nits, which the upper exposure clips to white and the lower does not.
    #[test]
    fn the_side_by_side_is_before_after_difference_over_two_exposures() {
        let nits = Light::<crate::light::SceneNits>::exactly(500.0);
        let code = (crate::tone::pq(nits).raw() * f64::from(u16::MAX)).round() as u16;
        let (width, height, pixels) = drawn(&side_by_side_png(
            Some(&flat(32, 16, 0)),
            &flat(32, 16, code),
        ));

        let zoom = (VIEW_LONG / 32).min(VIEW_MAX_ZOOM);
        let (panel_w, panel_h) = (32 * zoom, 16 * zoom);
        assert_eq!(
            (width, height),
            (3 * panel_w + 2 * GAP, 2 * panel_h + BAND_GAP)
        );
        let centre = |column: usize, band: usize| {
            let x = column * (panel_w + GAP) + panel_w / 2;
            let y = band * (panel_h + BAND_GAP) + panel_h / 2;
            <[u8; 3]>::try_from(&pixels[(y * width + x) * 3..][..3]).expect("a pixel")
        };
        for band in 0..2 {
            assert_eq!(centre(0, band), [0, 0, 0], "before, in band {band}");
            assert_eq!(
                centre(2, band),
                [255, 0, 0],
                "the difference, in band {band}"
            );
        }
        assert_eq!(
            centre(1, 0),
            [255, 255, 255],
            "after, clipped at diffuse white"
        );
        let [r, g, b] = centre(1, 1);
        let neutral = r.abs_diff(g) <= 1 && g.abs_diff(b) <= 1;
        assert!(
            neutral && (100..255).contains(&r),
            "after, under the peak: {:?}",
            [r, g, b]
        );
    }

    #[test]
    fn a_new_snapshot_is_blank_after_after() {
        let after = flat(32, 16, u16::MAX);
        let zoom = (VIEW_LONG / 32).min(VIEW_MAX_ZOOM);
        let (panel_w, panel_h) = (32 * zoom, 16 * zoom);
        let (width, height, pixels) = drawn(&side_by_side_png(None, &after));
        assert_eq!((width, height), (3 * panel_w + 2 * GAP, 2 * panel_h + BAND_GAP));
        let centre = |column: usize| {
            let (x, y) = (column * (panel_w + GAP) + panel_w / 2, panel_h / 2);
            <[u8; 3]>::try_from(&pixels[(y * width + x) * 3..][..3]).expect("a pixel")
        };
        assert_eq!(centre(0), [BLANK; 3]);
        assert_eq!(centre(2), centre(1), "the difference is the after");
    }

    #[test]
    fn a_before_of_another_shape_is_drawn_beside_the_after_with_no_difference() {
        let (width, height, _) = drawn(&side_by_side_png(Some(&flat(16, 16, 0)), &flat(32, 16, 0)));
        let zoom = (VIEW_LONG / 32).min(VIEW_MAX_ZOOM);
        assert_eq!(
            (width, height),
            (2 * 32 * zoom + GAP, 2 * 16 * zoom + BAND_GAP)
        );
    }

    #[test]
    fn an_srgb_render_is_widened_to_sixteen_bits() {
        let snapshot = Snapshot::srgb(&[0, 1, 255, 128, 64, 32], Size::<Pinned>::exact(2, 1));
        assert_eq!(snapshot.coding, Coding::Srgb);
        assert_eq!(snapshot.samples, [0, 257, 65535, 32896, 16448, 8224]);
    }

    #[test]
    fn the_rolled_signal_is_coded_where_its_nits_would_be() {
        let peak = Light::<DisplayNits>::exactly(1000.0);
        let snapshot = Snapshot::signal(&[0, u16::MAX, 13107], Size::<Pinned>::exact(1, 1), peak);
        let code = |nits: f64| {
            let pq = crate::tone::pq(Light::<DisplayNits>::measured(nits)).raw();
            (pq * f64::from(u16::MAX)).round() as u16
        };
        assert_eq!(snapshot.coding, Coding::Pq);
        assert_eq!(snapshot.samples, [code(0.0), code(1000.0), code(200.0)]);
    }

    #[test]
    #[should_panic(expected = "an sRGB frame of 2x2")]
    fn an_srgb_render_of_the_wrong_length_is_refused() {
        Snapshot::srgb(&[0; 6], Size::<Pinned>::exact(2, 2));
    }

    #[test]
    fn frames_on_the_device_become_snapshots_of_the_asked_shape() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered");
            return;
        };
        let (width, height) = (64usize, 32usize);
        let codes: Vec<u16> = (0..width * height * 3)
            .map(|i| (i * 211 % 60000) as u16)
            .collect();
        let frame = Resident::upload(gpu, &codes, width, height);

        let whole = Snapshot::whole(Frame::Coded(&frame), Span::exact(16));
        assert_eq!(
            (whole.coding, whole.width, whole.height),
            (Coding::Pq, 16, 8)
        );

        let crops = Snapshot::crops(Frame::Coded(&frame), &[Rect::<Pinned>::exact(5, 3, 4, 2)]);
        assert_eq!((crops.width, crops.height), (4, 2));
        assert_eq!(
            crops.samples[..3],
            codes[(3 * width + 5) * 3..][..3],
            "a crop is 1:1"
        );

        let levels = crate::tone::Levels {
            white: Light::measured(20000.0),
            peak: Light::measured(60000.0),
            floor: Some(Light::measured(0.0)),
        };
        let anchoring = Anchoring {
            levels: levels.anchored(),
            reference_white_nits: Light::exactly(203.0),
        };
        let values: Vec<f32> = (0..width * height).map(|i| (i % 7) as f32 / 7.0).collect();
        let mosaic = Mosaic::upload(gpu, &values, width, height);
        let rggb = crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB");
        let painted = Snapshot::mosaic(
            gpu,
            &mosaic,
            &rggb,
            anchoring,
            &[Rect::<Pinned>::exact(2, 2, 2, 2)],
        );
        let red = &painted.samples[..3];
        assert!(
            red[0] > 0 && red[1] == 0 && red[2] == 0,
            "a red photosite is red: {red:?}"
        );
        let green = &painted.samples[3..6];
        assert!(
            green[0] == 0 && green[1] > 0 && green[2] == 0,
            "a green one is green: {green:?}"
        );
    }
}
