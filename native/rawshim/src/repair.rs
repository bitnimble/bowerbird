//! A spot or a thing the reader removed, filled from elsewhere in the same photograph.
//!
//! **After the chain, over whichever frame of the lens-corrected photograph a host has.** A repair
//! is stored on the [`Stored`] grid, which is the photograph as the lens left it and before the
//! reader's crop, and every frame the chain writes is a picture of that photograph: the editor's,
//! a rendition at its own size, a loupe's window. So the pass is one implementation at every size,
//! and a rendition agrees with the tab that ordered it because a position crosses only through
//! [`Point::onto`].
//!
//! After the sharpen rather than before it, which is the one place both hosts reach: a window
//! leaves `base::prepare` sharpened (`tile::prepared_on_device`), and a whole rendition is
//! sharpened per target (`hdr::Cut::from_base`).

use crate::gpu::{self, Gpu};
use crate::light::Gain;
use crate::px::{
    At, Coordinate, Drawn, Extent, Point, Rect, STORED_LONG, Share, Size, Span, Stored,
};
use crate::resident::Resident;

/// The schema's `MOST_REPAIRS` and `MOST_REPAIR_VERTICES`.
pub const MOST_REPAIRS: usize = 64;
pub const MOST_VERTICES: usize = 64;

/// How many cells the solve lays across the loop the reader drew, whatever its size.
///
/// The grain the seam is found at, and so the width of the feather that hides it: a seam is a
/// staircase of cells, and a feather a cell wide is what stops the staircase showing.
pub const CELLS_ACROSS: f64 = 24.0;

/// The widest feather a repair is offered or falls back to: the most the Blend slider reaches, and
/// the merge's own (`MOST_FEATHER` in `assembly.ts`).
pub const MOST_OFFERED_FEATHER: Share = Share::of(3, 200);

/// The most a fill's light is scaled by, either way: four stops. Past that the ground it was read
/// from is not the ground around the hole.
pub const MOST_GAIN: f64 = 16.0;

/// One repair, as the edit document holds it.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(try_from = "Written", into = "Written")]
pub struct Repair {
    /// The loop the reader drew, kept so the tool can be reopened on it.
    pub drawn: Vec<Point<Stored>>,
    /// Where the fill lands, which the solve grew past `drawn` to wherever the cut was cheapest.
    pub seam: Vec<Point<Stored>>,
    /// Where the fill is read, from where it lands.
    pub donor: [Extent<Stored>; 2],
    /// What the fill's light is multiplied by to meet the light around it.
    pub gain: Gain,
    /// How far either side of the seam the fill fades across, on the same grid, as the merge's
    /// feather does; none is [`offered_feather`].
    pub feather: Option<Extent<Stored>>,
}

/// The document's own shape: whole steps of the grid, which is what the schema bounds.
#[derive(serde::Deserialize, serde::Serialize)]
struct Written {
    drawn: Vec<[u16; 2]>,
    seam: Vec<[u16; 2]>,
    donor: [i32; 2],
    gain: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    feather: Option<u16>,
}

impl TryFrom<Written> for Repair {
    type Error = String;

    fn try_from(written: Written) -> Result<Repair, String> {
        if written
            .donor
            .iter()
            .any(|step| step.unsigned_abs() as usize > STORED_LONG)
        {
            return Err(format!(
                "a repair's fill is read from {:?}, off the photograph",
                written.donor
            ));
        }
        if !(1.0 / MOST_GAIN..=MOST_GAIN).contains(&written.gain) {
            return Err(format!("a repair's gain of {} is no gain", written.gain));
        }
        Ok(Repair {
            drawn: loop_of(written.drawn)?,
            seam: loop_of(written.seam)?,
            donor: written.donor.map(|step| Extent::exactly(f64::from(step))),
            gain: Gain::of_ratio(written.gain),
            feather: written
                .feather
                .map(|steps| Extent::exactly(f64::from(steps))),
        })
    }
}

impl From<Repair> for Written {
    fn from(repair: Repair) -> Written {
        let steps = |points: Vec<Point<Stored>>| {
            points
                .into_iter()
                .map(|p| [p.x, p.y].map(|c| c.raw().round().clamp(0.0, STORED_LONG as f64) as u16))
                .collect()
        };
        let most = STORED_LONG as f64;
        Written {
            drawn: steps(repair.drawn),
            seam: steps(repair.seam),
            donor: repair
                .donor
                .map(|step| step.raw().round().clamp(-most, most) as i32),
            gain: repair.gain.raw(),
            feather: repair
                .feather
                .map(|steps| steps.raw().round().clamp(0.0, most) as u16),
        }
    }
}

impl Repair {
    /// This repair as the document will hold it, every position on a whole step of the grid: what a
    /// reader previews has to be what is saved.
    pub fn on_grid(self) -> Result<Repair, String> {
        Repair::try_from(Written::from(self))
    }
}

/// A loop as the document writes one, on the grid.
pub fn loop_of(written: Vec<[u16; 2]>) -> Result<Vec<Point<Stored>>, String> {
    if !(3..=MOST_VERTICES).contains(&written.len()) {
        return Err(format!(
            "a repair's loop has {} vertices, and takes 3 to {MOST_VERTICES}",
            written.len()
        ));
    }
    Ok(written
        .into_iter()
        .map(|[x, y]| Point {
            x: Coordinate::exactly(f64::from(x)),
            y: Coordinate::exactly(f64::from(y)),
        })
        .collect())
}

/// One repair on one frame, in the pixels of the buffer it is drawn into.
pub struct Placed {
    seam: Vec<Point<Drawn>>,
    /// Whole pixels: a fill read between pixels would be resampled, and softer than what it lands
    /// beside.
    donor: [isize; 2],
    gain: Gain,
    feather: Extent<Drawn>,
}

impl Repair {
    /// This repair on a frame of `frame`'s size, the whole of it.
    pub fn on(&self, frame: Size<Drawn>) -> Placed {
        let stored = frame.stored();
        let drawn: Vec<Point<Drawn>> = self.drawn.iter().map(|p| p.onto(stored, frame)).collect();
        Placed {
            seam: self.seam.iter().map(|p| p.onto(stored, frame)).collect(),
            donor: [
                self.donor[0].onto(stored.width, frame.width),
                self.donor[1].onto(stored.height, frame.height),
            ]
            .map(|step| step.raw().round() as isize),
            gain: self.gain,
            feather: match self.feather {
                Some(steps) => steps.onto(stored.width, frame.width),
                None => offered_feather(&drawn, frame),
            },
        }
    }
}

/// How many [`cell`]s wide the feather a repair starts at is.
pub const FEATHER_CELLS: usize = 2;

/// The feather a repair drawn around `drawn` on a frame of `frame`'s size starts at:
/// [`FEATHER_CELLS`] of its [`cell`]s, never wider than [`MOST_OFFERED_FEATHER`].
pub fn offered_feather(drawn: &[Point<Drawn>], frame: Size<Drawn>) -> Extent<Drawn> {
    let most = MOST_OFFERED_FEATHER.across(frame.long());
    Extent::exactly((cell(drawn).raw() * FEATHER_CELLS as f64).min(most.raw()))
}

/// The side of the cell the solve lays over `drawn`: a [`CELLS_ACROSS`]th of its longer extent,
/// and never under a pixel.
pub fn cell(drawn: &[Point<Drawn>]) -> Extent<Drawn> {
    let [low, high] = bounds(drawn);
    let longer = (high[0] - low[0]).max(high[1] - low[1]);
    Extent::exactly((longer / CELLS_ACROSS).max(1.0))
}

/// The least and the greatest of `points` on each axis.
pub fn bounds(points: &[Point<Drawn>]) -> [[f64; 2]; 2] {
    points
        .iter()
        .fold([[f64::MAX; 2], [f64::MIN; 2]], |[low, high], p| {
            let (x, y) = (p.x.raw(), p.y.raw());
            [
                [low[0].min(x), low[1].min(y)],
                [high[0].max(x), high[1].max(y)],
            ]
        })
}

impl Placed {
    /// The same repair in a buffer that starts at `origin` in the frame it was placed on.
    pub fn within(mut self, origin: At<Drawn>) -> Placed {
        let back = [origin.x, origin.y].map(|at| Extent::<Drawn>::exactly(-(at.raw() as f64)));
        for p in &mut self.seam {
            p.x = p.x + back[0];
            p.y = p.y + back[1];
        }
        self
    }

    /// The pixels the fill can land on, `[left, top, right, bottom)`: the seam and the feather
    /// outside it, reaching past the buffer wherever those do.
    pub(crate) fn lands(&self) -> [isize; 4] {
        let [low, high] = bounds(&self.seam);
        let feather = self.feather.raw();
        [
            (low[0] - feather).floor() as isize,
            (low[1] - feather).floor() as isize,
            (high[0] + feather).ceil() as isize,
            (high[1] + feather).ceil() as isize,
        ]
    }

    /// The pixels it is read from.
    pub(crate) fn reads(&self) -> [isize; 4] {
        let [left, top, right, bottom] = self.lands();
        let [dx, dy] = self.donor;
        [left + dx, top + dy, right + dx, bottom + dy]
    }
}

/// `need`, grown to hold the fill of every repair whose seam comes within `reach` of it.
///
/// **A window has to hold where its fills are read from, not only where they land.** The pass reads
/// its own buffer, so a window holding a seam and not the place across the photograph its fill
/// comes from would fill it from nothing - and a loupe over a repair would show the thing it
/// removed. `reach` is the chain's own margin, which the fill needs around it for the same reason
/// the picture does: the sharpen reads past what it writes.
pub fn reaching(
    repairs: &[Repair],
    frame: Size<Drawn>,
    need: Rect<Drawn>,
    reach: Span<Drawn>,
) -> Rect<Drawn> {
    let (width, height) = frame.raw();
    let (left, top, wide, deep) = need.raw();
    let margin = reach.raw() as isize;
    let near = [
        left as isize - margin,
        top as isize - margin,
        (left + wide) as isize + margin,
        (top + deep) as isize + margin,
    ];
    let mut out = [
        left as isize,
        top as isize,
        (left + wide) as isize,
        (top + deep) as isize,
    ];
    for placed in repairs.iter().map(|repair| repair.on(frame)) {
        if !overlaps(placed.lands(), near) {
            continue;
        }
        let reads = placed.reads();
        out = [
            out[0].min(reads[0] - margin),
            out[1].min(reads[1] - margin),
            out[2].max(reads[2] + margin),
            out[3].max(reads[3] + margin),
        ];
    }
    let [left, top, right, bottom] = [
        out[0].clamp(0, width as isize),
        out[1].clamp(0, height as isize),
        out[2].clamp(0, width as isize),
        out[3].clamp(0, height as isize),
    ]
    .map(|edge| edge as usize);
    Rect::exact(left, top, right - left, bottom - top)
}

fn overlaps(a: [isize; 4], b: [isize; 4]) -> bool {
    a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/// `Params` in `repair.slang`.
#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
pub(crate) struct Params {
    pub(crate) size: [u32; 2],
    pub(crate) first: u32,
    pub(crate) pixels: u32,
    pub(crate) donor: [i32; 2],
    pub(crate) vertices: u32,
    pub(crate) band_first: u32,
    pub(crate) band_samples: u32,
    pub(crate) gain: f32,
    pub(crate) feather: f32,
    pub(crate) cell: u32,
    pub(crate) cells: [u32; 2],
    pub(crate) origin: [u32; 2],
    pub(crate) picture: [f32; 4],
}

/// The block's size, for `wgsl_layout.rs` to hold against the shader's own.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

fn built(gpu: &'static Gpu, entry: &str) -> crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    let bindings: &[(u32, wgpu::BufferBindingType)] = match entry {
        "repair" => &[(0, UNIFORM), (1, WRITE), (2, READ), (3, READ), (4, READ)],
        _ => &[(0, UNIFORM), (1, WRITE), (3, READ), (5, WRITE)],
    };
    crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/repair.wgsl")),
        bindings,
        &[],
    )
}

fn repairing(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "repair"))
}

pub(crate) fn averaging(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "repair_cells"))
}

/// Every repair that reaches `frame`, in the order they were made.
///
/// `frame` is a window at `origin` of a photograph of `whole`'s size, which is the whole of it where
/// `origin` is zero. Refuses only where there is no device, which the chain that wrote `frame` has
/// already needed.
///
/// Answers what each repair was drawn over, cut out before any was ([`crate::retouched_frame`]),
/// which is the only way to know it once they have been.
pub(crate) fn apply(
    frame: &Resident,
    whole: Size<Drawn>,
    origin: At<Drawn>,
    repairs: &[Repair],
) -> Result<Vec<Cut>, String> {
    let (width, height) = frame.size();
    let (ox, oy) = origin.raw();
    let (whole_width, whole_height) = whole.raw();
    let buffer = [0, 0, width as isize, height as isize];
    let placed: Vec<(usize, Placed, Rect<Drawn>)> = repairs
        .iter()
        .map(|repair| repair.on(whole).within(origin))
        .enumerate()
        .filter(|(_, placed)| overlaps(placed.lands(), buffer))
        .map(|(repair, placed)| {
            let [left, top, right, bottom] = placed.lands();
            let [left, right] = [left, right].map(|x| x.clamp(0, width as isize) as usize);
            let [top, bottom] = [top, bottom].map(|y| y.clamp(0, height as isize) as usize);
            let rect = Rect::exact(left, top, right - left, bottom - top);
            (repair, placed, rect)
        })
        .collect();
    if placed.is_empty() {
        return Ok(Vec::new());
    }
    let gpu = frame.gpu();
    let mut recording = gpu.record();
    recording.holding(frame.buffer());
    // Recorded ahead of every repair's pass, so what is cut is the picture before any of them - and
    // wherever a repair lands, whether or not this frame holds what it is filled from.
    let cuts = placed
        .iter()
        .map(|(repair, _, rect)| {
            let (left, top, wide, deep) = rect.raw();
            let rgb = Resident::empty(gpu, wide, deep);
            crate::retouched_frame::copy(
                &mut recording,
                (frame, At::exact(left, top)),
                (&rgb, At::ORIGIN),
                Size::exact(wide, deep),
            );
            Cut {
                repair: *repair,
                rect: *rect,
                rgb,
            }
        })
        .collect();
    let Some([top, bottom]) = placed
        .iter()
        .map(|(_, placed, _)| {
            let reads = placed.reads();
            [reads[1].max(0), reads[3].min(height as isize)]
        })
        .filter(|[top, bottom]| top < bottom)
        .reduce(|a, b| [a[0].min(b[0]), a[1].max(b[1])])
    else {
        recording.submit();
        return Ok(cuts);
    };
    let base =
        crate::base::device(gpu).ok_or_else(|| crate::base::without_a_device("the repairs"))?;

    // **One copy of the rows every fill is read from, taken before any repair runs**, so a repair
    // reads the picture and never another repair's work. Whole words, which is what a copy moves.
    let first_word = top as usize * width * 3 / 2;
    let end_word = (bottom as usize * width * 3).div_ceil(2).min(frame.words());
    let band = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("repair band"),
        size: ((end_word - first_word) * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(
        frame.buffer(),
        (first_word * 4) as u64,
        &band,
        0,
        ((end_word - first_word) * 4) as u64,
    );

    let kernel = repairing(gpu);
    let mut dispatches: Vec<(wgpu::BindGroup, (u32, u32))> = Vec::new();
    for (_, placed, rect) in &placed {
        let (left, top, wide, deep) = rect.raw();
        let (right, bottom) = (left + wide, top + deep);
        // A run of whole rows from the seam's first pixel to its last, started on an even pixel so
        // every pair an invocation takes begins on a word.
        let first = (top * width + left) & !1;
        let pixels = (bottom - 1) * width + right - first;
        let block = Params {
            size: [width as u32, height as u32],
            first: first as u32,
            pixels: pixels as u32,
            donor: placed.donor.map(|step| step as i32),
            vertices: placed.seam.len() as u32,
            band_first: (first_word * 2) as u32,
            band_samples: ((end_word - first_word) * 2) as u32,
            gain: placed.gain.raw() as f32,
            feather: placed.feather.raw() as f32,
            picture: [
                -(ox as f32),
                -(oy as f32),
                (whole_width - ox) as f32,
                (whole_height - oy) as f32,
            ],
            ..Default::default()
        };
        let vertices: Vec<f32> = placed
            .seam
            .iter()
            .flat_map(|p| [p.x.raw() as f32, p.y.raw() as f32])
            .collect();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("repair params"),
            contents: bytemuck::bytes_of(&block),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let seam = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("repair seam"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("repair"),
            layout: &kernel.layout,
            entries: &[
                entry(0, &uniform),
                entry(1, frame.buffer()),
                entry(2, &band),
                entry(3, base.light_of_code()),
                entry(4, &seam),
            ],
        });
        dispatches.push((group, crate::base::groups(pixels.div_ceil(2))));
    }
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        for (group, (x, y)) in &dispatches {
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(*x, *y, 1);
        }
    }
    recording.submit();
    Ok(cuts)
}

/// The pixels under one repair's footprint on the frame [`apply`] drew it on, before it did.
pub(crate) struct Cut {
    /// Which of the repairs [`apply`] was handed.
    pub(crate) repair: usize,
    /// Where on that frame, in its own pixels.
    pub(crate) rect: Rect<Drawn>,
    pub(crate) rgb: Resident,
}

pub(crate) fn entry(binding: u32, buffer: &gpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn written(json: &str) -> Result<Repair, serde_json::Error> {
        serde_json::from_str(json)
    }

    const SQUARE: &str = r#"{"drawn":[[100,100],[200,100],[200,200]],"seam":[[90,90],[210,90],[210,210],[90,210]],"donor":[-300,40],"gain":1.25}"#;

    /// What the schema writes comes back as it was written, and a loop the schema would refuse is
    /// refused here too rather than drawn.
    #[test]
    fn a_repair_crosses_the_document_as_it_was_written() {
        let repair = written(SQUARE).expect("a repair");
        assert_eq!(repair.seam.len(), 4);
        assert_eq!(repair.donor[0].raw(), -300.0);
        assert_eq!(repair.gain.raw(), 1.25);
        let again: serde_json::Value = serde_json::to_value(&repair).expect("written");
        let before: serde_json::Value = serde_json::from_str(SQUARE).expect("json");
        assert_eq!(again, before);
        assert_eq!(repair.feather, None);

        let feathered = format!("{}, \"feather\": 120}}", SQUARE.trim_end_matches('}'));
        let repair = written(&feathered).expect("a feathered repair");
        assert_eq!(repair.feather.map(|steps| steps.raw()), Some(120.0));
        assert_eq!(
            serde_json::to_value(&repair).expect("written"),
            serde_json::from_str::<serde_json::Value>(&feathered).expect("json")
        );

        assert!(
            written(r#"{"drawn":[[1,1],[2,2]],"seam":[[1,1],[2,2],[3,3]],"donor":[0,0],"gain":1}"#)
                .is_err()
        );
        assert!(
            written(
                r#"{"drawn":[[1,1],[2,2],[3,3]],"seam":[[1,1],[2,2],[3,3]],"donor":[0,0],"gain":0}"#
            )
            .is_err()
        );
        assert!(written(r#"{"drawn":[[1,1],[2,2],[3,3]],"seam":[[1,1],[2,2],[65536,3]],"donor":[0,0],"gain":1}"#).is_err());
        assert!(written(r#"{"drawn":[[1,1],[2,2],[3,3]],"seam":[[1,1],[2,2],[3,3]],"donor":[70000,0],"gain":1}"#).is_err());
    }

    /// The schema and the host bound a repair alike, and put a position on the same grid.
    #[test]
    fn the_schema_writes_on_the_grid_the_host_reads() {
        let grid = include_str!("../../../src/schemas/stored_grid.ts");
        for line in [
            format!("export const STORED_LONG = {STORED_LONG};"),
            format!("export const MOST_REPAIRS = {MOST_REPAIRS};"),
            format!("export const MOST_REPAIR_VERTICES = {MOST_VERTICES};"),
        ] {
            assert!(grid.contains(&line), "the grid does not say `{line}`");
        }
        let gain = format!("gain: z.number().min(1 / {MOST_GAIN}).max({MOST_GAIN}),");
        assert!(
            include_str!("../../../src/schemas/photo_edits.ts").contains(&gain),
            "the schema does not say `{gain}`"
        );
    }

    /// One repair lands on the same share of the photograph at every size a host draws it at, and
    /// its fill is read from the same share away.
    #[test]
    fn a_repair_is_the_same_place_on_every_frame() {
        let repair = written(SQUARE).expect("a repair");
        let full = repair.on(Size::exact(6000, 4000));
        let half = repair.on(Size::exact(3000, 2000));
        for (a, b) in full.seam.iter().zip(&half.seam) {
            assert!((a.x.raw() - 2.0 * b.x.raw()).abs() < 1e-9);
            assert!((a.y.raw() - 2.0 * b.y.raw()).abs() < 1e-9);
        }
        // -300 steps of 65535 across 6000 pixels.
        assert_eq!(full.donor, [-27, 4]);
        assert_eq!(half.donor, [-14, 2]);

        // Two cells of the loop, so twice the pixels on a frame twice the size - and a cell never
        // under a pixel.
        let large = square((6000, 4000), 1000, 1480, [0, 0]);
        let [full, half] =
            [(6000, 4000), (3000, 2000)].map(|(w, h)| large.on(Size::exact(w, h)).feather.raw());
        assert!(
            (full - 40.0).abs() < 0.1 && (half - 20.0).abs() < 0.1,
            "{full} and {half}"
        );
        assert_eq!(repair.on(Size::exact(600, 400)).feather.raw(), 2.0);
        // A loop half the frame across would take a cell of 125 pixels, and is held to 1.5%.
        let huge = square((6000, 4000), 1000, 4000, [0, 0]);
        let held = huge.on(Size::exact(6000, 4000)).feather.raw();
        assert!((held - 90.0).abs() < 1e-9, "{held}");

        // A feather the reader set is a share of the long edge, and may be none at all.
        let set = |steps: f64| Repair {
            feather: Some(Extent::exactly(steps)),
            ..repair.clone()
        };
        let [full, half] =
            [6000, 3000].map(|w| set(655.35).on(Size::exact(w, w * 2 / 3)).feather.raw());
        assert!(
            (full - 60.0).abs() < 1e-9 && (half - 30.0).abs() < 1e-9,
            "{full} and {half}"
        );
        assert_eq!(set(0.0).on(Size::exact(6000, 4000)).feather.raw(), 0.0);
    }

    /// A window that reaches a seam is grown to hold where that seam's fill is read, and one that
    /// reaches none is left as it was.
    #[test]
    fn a_window_reaching_a_seam_holds_its_fill() {
        let frame = Size::<Drawn>::exact(6000, 4000);
        // A seam at pixels 1000..1100 across, its fill read 2000 pixels to the right.
        let step = |px: f64| (px * STORED_LONG as f64 / 6000.0).round() as u16;
        let repair = Repair::try_from(Written {
            drawn: vec![
                [step(1010.0), step(1010.0)],
                [step(1090.0), step(1010.0)],
                [step(1050.0), step(1090.0)],
            ],
            seam: vec![
                [step(1000.0), step(1000.0)],
                [step(1100.0), step(1000.0)],
                [step(1100.0), step(1100.0)],
                [step(1000.0), step(1100.0)],
            ],
            donor: [step(2000.0) as i32, 0],
            gain: 1.0,
            feather: None,
        })
        .expect("a repair");
        let reach = Span::exact(16);

        let over = Rect::exact(1040, 1040, 64, 64);
        let (left, top, wide, deep) =
            reaching(std::slice::from_ref(&repair), frame, over, reach).raw();
        assert!(left <= 1040 && top <= 1000 - 16, "{left},{top}");
        assert!(
            left + wide >= 3100 + 16,
            "the window stops at {}",
            left + wide
        );
        assert!(top + deep >= 1100 + 16);

        let away = Rect::exact(4000, 3000, 64, 64);
        assert_eq!(
            reaching(std::slice::from_ref(&repair), frame, away, reach),
            away
        );
    }

    /// A repair of the square `[from, to)` of a `size` frame, its fill read `donor` pixels away.
    fn square(size: (usize, usize), from: usize, to: usize, donor: [i32; 2]) -> Repair {
        let stored = Size::<Drawn>::exact(size.0, size.1).stored();
        let step =
            |px: usize| (px as f64 * stored.width.raw() as f64 / size.0 as f64).round() as u16;
        let corners = vec![
            [step(from), step(from)],
            [step(to), step(from)],
            [step(to), step(to)],
            [step(from), step(to)],
        ];
        Repair::try_from(Written {
            drawn: corners.clone(),
            seam: corners,
            donor: donor.map(|px| {
                (f64::from(px) * stored.width.raw() as f64 / size.0 as f64).round() as i32
            }),
            gain: 1.0,
            feather: None,
        })
        .expect("a repair")
    }

    fn textured(size: (usize, usize)) -> Vec<u16> {
        (0..size.0 * size.1 * 3)
            .map(|sample| 20000 + ((sample * 7919) % 4000) as u16)
            .collect()
    }

    fn repaired(
        samples: &[u16],
        size: (usize, usize),
        whole: (usize, usize),
        origin: (usize, usize),
        repairs: &[Repair],
    ) -> Vec<u16> {
        let gpu = crate::gpu::device().expect("a device");
        let frame = Resident::upload(gpu, samples, size.0, size.1);
        apply(
            &frame,
            Size::exact(whole.0, whole.1),
            At::exact(origin.0, origin.1),
            repairs,
        )
        .expect("applied");
        pollster::block_on(frame.host()).expect("read back")
    }

    /// Inside the seam the picture is the fill, code for code; past its feather, and where the fill
    /// was read from, nothing moves.
    #[test]
    fn a_seam_takes_its_fill_and_nothing_else_moves() {
        let size = (64, 48);
        let mut before = textured(size);
        for y in 10..20 {
            for x in 10..20 {
                for channel in 0..3 {
                    before[(y * size.0 + x) * 3 + channel] = 50000;
                }
            }
        }
        let after = repaired(&before, size, size, (0, 0), &[square(size, 8, 22, [30, 0])]);
        for y in 0..size.1 {
            for x in 0..size.0 {
                for channel in 0..3 {
                    let at = (y * size.0 + x) * 3 + channel;
                    if (10..20).contains(&x) && (10..20).contains(&y) {
                        let fill = before[(y * size.0 + x + 30) * 3 + channel];
                        assert!(
                            after[at].abs_diff(fill) <= 1,
                            "{x},{y}: {} for a fill of {fill}",
                            after[at]
                        );
                    // Past the pixel either side of the seam the feather reaches into.
                    } else if !(7..23).contains(&x) || !(7..23).contains(&y) {
                        assert_eq!(after[at], before[at], "{x},{y} moved");
                    }
                }
            }
        }
    }

    /// The fill fades across the seam as the merge's feather does: half at the seam, all of it a
    /// feather inside, none a feather outside.
    #[test]
    fn the_feather_is_centred_on_the_seam() {
        let size = (96, 56);
        let (dark, bright) = (20000u16, 45000u16);
        let before: Vec<u16> = (0..size.0 * size.1 * 3)
            .map(|sample| {
                if (sample / 3) % size.0 >= 42 {
                    bright
                } else {
                    dark
                }
            })
            .collect();
        let stored = Size::<Drawn>::exact(size.0, size.1).stored();
        let feather = 4.0 * stored.width.raw() as f64 / size.0 as f64;
        let repair = Repair {
            feather: Some(Extent::exactly(feather)),
            ..square(size, 16, 40, [30, 0])
        };
        let after = repaired(&before, size, size, (0, 0), &[repair]);
        let at = |x: usize| after[(28 * size.0 + x) * 3];
        for x in [8, 11] {
            assert_eq!(at(x), dark, "{x} is past the feather outside");
        }
        for x in [20, 28, 35] {
            assert!(
                at(x).abs_diff(bright) <= 1,
                "{x} is {}, past the feather inside",
                at(x)
            );
        }
        // Pixel centres half a pixel either side of the seam at 16, and a feather's worth of ramp.
        let (outside, inside) = (at(15), at(16));
        assert!(
            dark < outside && outside < inside && inside < bright,
            "{outside}, {inside}"
        );
        assert!(at(13) < outside && at(13) > dark, "{}", at(13));
    }

    /// A window of the photograph holding a repair and its fill comes out as that part of the whole
    /// frame does, which is what lets a loupe and a band stand in for the frame.
    #[test]
    fn a_window_is_repaired_as_the_whole_frame_is() {
        let whole = (96, 64);
        let before = textured(whole);
        let repairs = [square(whole, 20, 36, [40, 8])];
        let everywhere = repaired(&before, whole, whole, (0, 0), &repairs);

        let (origin, size) = ((12, 16), (80, 44));
        let window: Vec<u16> = (0..size.1)
            .flat_map(|y| {
                let row = ((origin.1 + y) * whole.0 + origin.0) * 3;
                before[row..row + size.0 * 3].to_vec()
            })
            .collect();
        let part = repaired(&window, size, whole, origin, &repairs);
        for y in 0..size.1 {
            for x in 0..size.0 * 3 {
                let there = everywhere[((origin.1 + y) * whole.0 + origin.0) * 3 + x];
                let here = part[y * size.0 * 3 + x];
                assert!(
                    here.abs_diff(there) <= 1,
                    "{},{}: {here} against {there}",
                    x / 3,
                    y
                );
            }
        }
    }

    /// Stripes ten pixels apart across a frame of `size`, and a bright, coloured disc on them.
    pub(crate) fn striped_with_a_disc(size: (usize, usize), centre: (f64, f64)) -> Vec<u16> {
        let mut samples = Vec::with_capacity(size.0 * size.1 * 3);
        for y in 0..size.1 {
            for x in 0..size.0 {
                let (dx, dy) = (x as f64 + 0.5 - centre.0, y as f64 + 0.5 - centre.1);
                match dx * dx + dy * dy < 64.0 {
                    true => samples.extend([55000, 40000, 30000]),
                    false => samples.extend([stripe(x); 3]),
                }
            }
        }
        samples
    }

    fn stripe(x: usize) -> u16 {
        (30000.0 + 3000.0 * (x as f64 * std::f64::consts::TAU / 10.0).sin()) as u16
    }

    /// A loop of radius 12 around `centre`, on the grid.
    pub(crate) fn loop_around(whole: Size<Drawn>, centre: (f64, f64)) -> Vec<Point<Stored>> {
        (0..16)
            .map(|at| {
                let angle = at as f64 * std::f64::consts::TAU / 16.0;
                Point {
                    x: Coordinate::<Drawn>::exactly(centre.0 + 12.0 * angle.cos()),
                    y: Coordinate::exactly(centre.1 + 12.0 * angle.sin()),
                }
                .onto(whole, whole.stored())
            })
            .collect()
    }

    /// The whole of it: a loop drawn around a disc on striped ground, solved and drawn, leaves the
    /// stripes and no disc - with the seam grown, and with the loop kept exactly as drawn.
    #[test]
    fn a_thing_drawn_around_is_removed() {
        let gpu = crate::gpu::device().expect("a device");
        let size = (200usize, 160usize);
        let centre = (100.0, 80.0);
        let samples = striped_with_a_disc(size, centre);
        let whole = Size::<Drawn>::exact(size.0, size.1);
        let drawn = loop_around(whole, centre);
        for grow in [true, false] {
            let frame = Resident::upload(gpu, &samples, size.0, size.1);
            let offered = pollster::block_on(async {
                crate::repair_solve::measure(&frame, whole, At::ORIGIN, drawn.clone(), None)?
                    .solved(&[], grow)
                    .await
            })
            .expect("solved");
            assert!(!offered.is_empty(), "nothing was offered, grown {grow}");
            for repair in &offered {
                let unset = Repair {
                    feather: None,
                    ..repair.clone()
                };
                let (set, unset) = (
                    repair.on(whole).feather.raw(),
                    unset.on(whole).feather.raw(),
                );
                assert!(
                    (set - unset).abs() < 0.05,
                    "offered a feather of {set}, not {unset}"
                );
            }
            if !grow {
                assert!(
                    offered.iter().all(|repair| repair.seam == repair.drawn),
                    "a loop not grown was changed"
                );
            }

            apply(&frame, whole, At::ORIGIN, &offered[..1]).expect("applied");
            let after = pollster::block_on(frame.host()).expect("read back");
            for y in 70..90 {
                for x in 90..110 {
                    let at = (y * size.0 + x) * 3;
                    let wanted = stripe(x);
                    for channel in 0..3 {
                        assert!(
                            after[at + channel].abs_diff(wanted) <= 600,
                            "{x},{y} is {} where the stripes are {wanted}, grown {grow}: {:?}",
                            after[at + channel],
                            offered[0],
                        );
                    }
                }
            }
        }
    }

    /// A fill the reader put somewhere is read from exactly there, grown or not, and removes what the
    /// loop holds when there is ground there that matches.
    #[test]
    fn a_fill_is_read_from_where_the_reader_put_it() {
        let gpu = crate::gpu::device().expect("a device");
        let size = (200usize, 160usize);
        let centre = (100.0, 80.0);
        let samples = striped_with_a_disc(size, centre);
        let whole = Size::<Drawn>::exact(size.0, size.1);
        let drawn = loop_around(whole, centre);
        // Four stripes to the left, which is the same ground as around the disc.
        let donor = [Extent::<Drawn>::exactly(-40.0), Extent::exactly(0.0)]
            .map(|px| px.onto(whole.width, whole.stored().width));
        for grow in [true, false] {
            let frame = Resident::upload(gpu, &samples, size.0, size.1);
            let offered = pollster::block_on(async {
                crate::repair_solve::measure(&frame, whole, At::ORIGIN, drawn.clone(), Some(donor))?
                    .solved(&[], grow)
                    .await
            })
            .expect("solved");
            assert_eq!(offered.len(), 1, "grown {grow}");
            let [dx, dy] = offered[0].donor.map(|step| step.raw());
            assert!(
                (dx - donor[0].raw()).abs() <= 1.0 && (dy - donor[1].raw()).abs() <= 1.0,
                "read from {dx},{dy}, not {:?}, grown {grow}",
                donor
            );
            apply(&frame, whole, At::ORIGIN, &offered).expect("applied");
            let after = pollster::block_on(frame.host()).expect("read back");
            for y in 74..86 {
                for x in 94..106 {
                    let at = (y * size.0 + x) * 3;
                    assert!(
                        after[at].abs_diff(stripe(x)) <= 600,
                        "{x},{y} is {} where the stripes are {}, grown {grow}",
                        after[at],
                        stripe(x)
                    );
                }
            }
        }
    }

    /// A loop drawn off the top of the picture, as the page clamps it, removes what it holds right
    /// up to the edge, grown or not.
    #[test]
    fn a_loop_past_the_edge_removes_up_to_it() {
        let gpu = crate::gpu::device().expect("a device");
        let size = (200usize, 120usize);
        let centre = (100.0, 3.0);
        let samples = striped_with_a_disc(size, centre);
        let whole = Size::<Drawn>::exact(size.0, size.1);
        let drawn: Vec<Point<Stored>> = (0..16)
            .map(|at| {
                let angle = at as f64 * std::f64::consts::TAU / 16.0;
                Point {
                    x: Coordinate::<Drawn>::exactly(centre.0 + 14.0 * angle.cos()),
                    y: Coordinate::exactly((centre.1 + 14.0 * angle.sin()).max(0.0)),
                }
                .onto(whole, whole.stored())
            })
            .collect();
        for grow in [true, false] {
            let frame = Resident::upload(gpu, &samples, size.0, size.1);
            let offered = pollster::block_on(async {
                crate::repair_solve::measure(&frame, whole, At::ORIGIN, drawn.clone(), None)?
                    .solved(&[], grow)
                    .await
            })
            .expect("solved");
            assert!(!offered.is_empty(), "nothing was offered, grown {grow}");
            apply(&frame, whole, At::ORIGIN, &offered[..1]).expect("applied");
            let after = pollster::block_on(frame.host()).expect("read back");
            for y in 0..10 {
                for x in 95..105 {
                    let at = (y * size.0 + x) * 3;
                    let wanted = stripe(x);
                    for channel in 0..3 {
                        assert!(
                            after[at + channel].abs_diff(wanted) <= 600,
                            "{x},{y} is {} where the stripes are {wanted}, grown {grow}: {:?}",
                            after[at + channel],
                            offered[0],
                        );
                    }
                }
            }
        }
    }

    /// A window holding what the search reads - a composite's tiles, as the editor holds them - is
    /// offered exactly what the whole frame is.
    #[test]
    fn a_window_holding_the_search_is_offered_what_the_frame_is() {
        let gpu = crate::gpu::device().expect("a device");
        let size = (420usize, 300usize);
        let centre = (120.0, 90.0);
        let samples = striped_with_a_disc(size, centre);
        let whole = Size::<Drawn>::exact(size.0, size.1);
        let drawn = loop_around(whole, centre);
        let offered = |frame: &Resident, origin: At<Drawn>| {
            pollster::block_on(async {
                crate::repair_solve::measure(frame, whole, origin, drawn.clone(), None)?
                    .solved(&[], true)
                    .await
            })
            .expect("solved")
        };

        let searched = crate::repair_solve::searched(whole, &drawn, None);
        let (left, top, wide, deep) = searched.raw();
        assert!(
            wide < size.0 || deep < size.1,
            "the search reads the whole frame, so no window is smaller"
        );
        let window: Vec<u16> = (0..deep)
            .flat_map(|y| {
                let row = ((top + y) * size.0 + left) * 3;
                samples[row..row + wide * 3].to_vec()
            })
            .collect();
        let everywhere = offered(&Resident::upload(gpu, &samples, size.0, size.1), At::ORIGIN);
        let within = offered(
            &Resident::upload(gpu, &window, wide, deep),
            At::exact(left, top),
        );
        assert!(!everywhere.is_empty(), "nothing was offered");
        assert_eq!(within, everywhere);
    }
}
