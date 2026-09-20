//! The perceptual descriptor photo stacks are grouped by, and the grouping.
//!
//! Both live here rather than in TypeScript because a comparison is descriptor
//! arithmetic over a couple of thousand cells: fifteen microseconds of it, run
//! once per candidate pair. Handing that across the FFI boundary one call at a
//! time would cost more than the work.
//!
//! The one part of it that walks a frame is `stacks.slang`, which hands back each
//! cell's channel sums as the exact integers a sum of bytes is. Everything below
//! that - the normalisation, the quantise, the ranking, the comparison and the
//! grouping - is arithmetic over a few hundred bytes and stays here.
//!
//! What the descriptor has to survive, for two frames of one scene: a different
//! exposure, a shift or small rotation, people walking through, a different white
//! balance or colour profile, and a step closer or further back. A 64-bit
//! perceptual hash survives none of it well enough to be worth a threshold; see
//! the design document for the measurements that settled this shape.

use crate::image::LUMA;
use crate::rgb::RgbRef;

/// Cells along one edge of the luma and chroma grids.
const GRID: usize = 20;
/// The window actually compared, leaving a two-cell margin for the offset search.
const WINDOW: usize = 16;
/// Cells along one edge of the grid the alignment is searched on.
const COARSE: usize = 10;
/// The coarse grid's own comparison window, so its offsets are +/-1 coarse cell.
const COARSE_WINDOW: usize = 8;

/// The fraction of the frame the second view keeps.
///
/// Stepping closer to a subject is a crop plus a resample, which nothing else in
/// the descriptor sees: a dolly scales every cell at once, and the trimmed mean
/// reads that as most cells disagreeing. Comparing one frame's whole grid against
/// another's cropped grid asks "is this the same scene from further back".
///
/// Centred, and measurably so: anchoring the window off centre barely moves the
/// same-scene pairs and lifts the different-scene ones hard, because more freedom
/// to slide is more chance of a coincidental match.
const CROP: f32 = 0.78;

/// The share of cells a distance is averaged over, best-agreeing first.
///
/// The occlusion tolerance. Somebody walking through the frame changes a handful
/// of cells completely, and a plain mean lets those few outvote the scene they
/// are standing in.
const KEEP: f32 = 0.75;

/// Chroma's share of the score. Luma carries the structure; chroma separates a
/// sunset from the white plaza beside it.
const CHROMA_WEIGHT: f32 = 0.3;

const COARSE_CELLS: usize = COARSE * COARSE;
const GRID_CELLS: usize = GRID * GRID;
const VIEW_BYTES: usize = COARSE_CELLS + GRID_CELLS * 3;

/// The coarse grid is the fine one folded two by two, which is only the same cells because of
/// this: `(x * COARSE) / w` is `(x * GRID) / w` halved for every x exactly when GRID is twice
/// COARSE. Break it and the fold silently reads a different picture than the kernel wrote.
const _: () = assert!(GRID == COARSE * 2);

/// Bytes one photo's descriptor occupies: the header, then two views, each a coarse luma grid, a
/// luma grid, and two chroma grids.
pub const DESCRIPTOR_BYTES: usize = HEADER + VIEW_BYTES * 2;

/// Bumped when the *numbers* change, not only the layout.
///
/// A descriptor is stored and compared against ones written months earlier, and the only thing on
/// the reading side that keeps two formats apart is `descriptorsOf`'s length check - so a change
/// that kept the size and moved the bytes would quietly rank a library's older photographs against
/// a rule they were not measured under. The grids are accumulated in integers now, which is exact
/// where the f32 sums they replaced were not, so the last bits move and `rank_normalize` spreads a
/// moved tie run across a whole stretch of cells.
///
/// **The header is this many bytes, so that a bump is a length change by construction.** A version
/// that only wrote its number into a fixed-width header would read as the right length forever: the
/// blob would stay in the catalogue, `similarity` would score it zero against everything, and the
/// photograph would drop out of stacking silently and permanently instead of being described again.
pub const FORMAT: u8 = 1;
const HEADER: usize = FORMAT as usize;

/// A rectangle of the frame, as a fraction kept about the centre.
#[derive(Clone, Copy)]
struct View {
    crop: f32,
}

impl View {
    fn bounds(&self, width: usize, height: usize) -> (usize, usize, usize, usize) {
        let (w, h) = ((width as f32 * self.crop) as usize, (height as f32 * self.crop) as usize);
        (((width - w) / 2), ((height - h) / 2), w.max(1), h.max(1))
    }
}

/// The two views a descriptor holds, in the order it holds them.
const VIEWS: [View; 2] = [View { crop: 1.0 }, View { crop: CROP }];

/// Rounds cells to the precision the descriptor actually stores, on a 0-255
/// scale, so that cells which are only accidentally unequal tie exactly.
///
/// Load-bearing ahead of `rank_normalize`, which spreads whatever ordering it is
/// given across the whole byte range: a region of genuinely uniform colour - a
/// grey sky, a white wall, a neutral shadow - differs cell to cell only in the
/// last bits of the chromaticity division, and ranking that raw turns pure
/// floating-point noise into a full-scale signal. Two frames of one flat scene
/// then describe it completely differently.
fn quantize(values: &mut [f32], scale: f32) {
    for value in values.iter_mut() {
        *value = (*value * scale).round();
    }
}

/// Replaces each cell by its rank, quantized to a byte.
///
/// This is the exposure and white-balance invariance: any monotonic tone curve -
/// a stop of exposure, a warmer white balance, a different colour profile -
/// leaves the ordering of the cells alone, so it leaves the descriptor alone.
fn rank_normalize(values: &[f32], out: &mut Vec<u8>) {
    let mut order: Vec<u32> = (0..values.len() as u32).collect();
    order.sort_unstable_by(|a, b| values[*a as usize].total_cmp(&values[*b as usize]));
    let mut ranked = vec![0u8; values.len()];
    let last = (values.len() - 1).max(1) as f32;
    // Cells that tie share the mean of the ranks they span, rather than taking
    // consecutive ranks in whatever order the sort left them. Without this the
    // descriptor depends on how a tie was broken, and ties are not an edge case:
    // a flat sky, a blown highlight and a black shadow are all large runs of
    // cells with the same value, so two frames of one scene would describe it
    // differently for no reason a photograph would recognise.
    let mut start = 0;
    while start < order.len() {
        let mut end = start + 1;
        while end < order.len() && values[order[end] as usize] == values[order[start] as usize] {
            end += 1;
        }
        let mean_rank = (start + end - 1) as f32 / 2.0;
        let value = ((mean_rank / last) * 255.0).round() as u8;
        for slot in &order[start..end] {
            ranked[*slot as usize] = value;
        }
        start = end;
    }
    out.extend_from_slice(&ranked);
}

/// One view's cells: each one's channel sums, and how many pixels landed in it.
///
/// The sums are integers because a sample is a byte, which is what lets `stacks.slang` accumulate
/// them in whatever order the invocations arrive and still hand back one answer.
struct Cells {
    side: usize,
    /// `side * side` triples, red, green and blue.
    channels: Vec<u32>,
    counts: Vec<u32>,
}

impl Cells {
    /// The coarse grid, which is this one folded two by two.
    fn folded(&self) -> Cells {
        let side = self.side / 2;
        let mut into =
            Cells { side, channels: vec![0; side * side * 3], counts: vec![0; side * side] };
        for y in 0..self.side {
            for x in 0..self.side {
                let (from, to) = (y * self.side + x, (y / 2) * side + x / 2);
                into.counts[to] += self.counts[from];
                for channel in 0..3 {
                    into.channels[to * 3 + channel] += self.channels[from * 3 + channel];
                }
            }
        }
        into
    }

    fn mean(&self, cell: usize, channel: usize) -> f32 {
        self.channels[cell * 3 + channel] as f32 / self.counts[cell].max(1) as f32
    }
}

/// How many pixels each cell holds, which is counted here rather than read back.
///
/// The cell a pixel falls in is `(x - x0) * cells / w` by `(y - y0) * cells / h`, and the two
/// axes decide independently, so a cell holds its column's width times its row's height.
fn cell_counts(w: usize, h: usize, cells: usize) -> Vec<u32> {
    let spans = |extent: usize| {
        let mut spans = vec![0u32; cells];
        for i in 0..extent {
            spans[i * cells / extent] += 1;
        }
        spans
    };
    let (across, down) = (spans(w), spans(h));
    (0..cells * cells).map(|cell| across[cell % cells] * down[cell / cells]).collect()
}

/// Box-averaged luma on an exact grid, squashing aspect.
///
/// Squashing rather than fitting is deliberate: a crop or a second camera body
/// gives one scene two aspect ratios, and that must not read as a difference.
fn luma_grid(cells: &Cells) -> Vec<f32> {
    (0..cells.side * cells.side)
        // The shared constant in its own width rather than through `luma_of`: the descriptor is
        // persisted, so going via f64 and back would shift stored values for no gain.
        .map(|cell| {
            LUMA[0] * cells.mean(cell, 0)
                + LUMA[1] * cells.mean(cell, 1)
                + LUMA[2] * cells.mean(cell, 2)
        })
        .collect()
}

/// Where the colour sits in the frame, with the frame's own cast divided out.
///
/// Grey-world first, so a warmer white balance scales every cell by the same
/// factor and therefore moves the descriptor not at all; then chromaticity, which
/// drops brightness; then rank-normalize, which drops what is left of a global
/// shift. What survives is "the warm part is along the top".
fn chroma_grids(cells: &Cells) -> (Vec<f32>, Vec<f32>) {
    let count = cells.side * cells.side;
    let mut channels: [Vec<f32>; 3] =
        std::array::from_fn(|channel| (0..count).map(|cell| cells.mean(cell, channel)).collect());
    for channel in channels.iter_mut() {
        let mean = channel.iter().sum::<f32>() / count as f32;
        for cell in channel.iter_mut() {
            *cell /= mean.max(1e-6);
        }
    }
    let total = |i: usize| (channels[0][i] + channels[1][i] + channels[2][i]).max(1e-6);
    let red = (0..count).map(|i| channels[0][i] / total(i)).collect();
    let green = (0..count).map(|i| channels[1][i] / total(i)).collect();
    (red, green)
}

struct Kernels {
    layout: wgpu::BindGroupLayout,
    cells: wgpu::ComputePipeline,
}

fn kernels(gpu: &'static crate::gpu::Gpu) -> &'static Kernels {
    static BUILT: std::sync::OnceLock<Kernels> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("stacks"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/stacks.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("stacks"),
            entries: &[
                entry(0, wgpu::BufferBindingType::Storage { read_only: true }),
                entry(1, wgpu::BufferBindingType::Storage { read_only: false }),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("stacks"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let cells = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("stacks_cells"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("stacks_cells"),
            compilation_options: Default::default(),
            cache: None,
        });
        Kernels { cells, layout }
    })
}

/// `stacks.slang`'s `Params`, as the bytes the host writes.
fn params_block(
    width: usize,
    pixels: usize,
    bounds: &[(usize, usize, usize, usize); 2],
) -> Vec<u8> {
    let mut fields = vec![width as i32, pixels as i32, GRID as i32, 0];
    for (x0, y0, w, h) in bounds {
        fields.extend([*x0 as i32, *y0 as i32, *w as i32, *h as i32]);
    }
    fields.iter().flat_map(|field| field.to_ne_bytes()).collect()
}

/// Both views' grids, in one pass over the frame.
///
/// The frame goes up as its own bytes, four samples to a word: it is 8-bit interleaved RGB, and
/// as floats it would be four times the transfer for a sum of small integers.
async fn accumulate(gpu: &'static crate::gpu::Gpu, image: RgbRef<'_>) -> Option<[Cells; 2]> {
    let pixels = image.width * image.height;
    if pixels == 0 || image.data.len() < pixels * 3 {
        return None;
    }
    let bounds = VIEWS.map(|view| view.bounds(image.width, image.height));
    let words = GRID_CELLS * 3;
    let sums_bytes = (words * VIEWS.len() * 4) as u64;

    let mut recording = gpu.record();
    let frame = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("stacks frame"),
        contents: &image.data[..pixels * 3],
        usage: wgpu::BufferUsages::STORAGE,
    });
    let sums = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("stacks sums"),
        size: sums_bytes,
        // Zeroed by the driver, which the accumulation relies on: every cell is added into rather
        // than written.
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("stacks sums out"),
        size: sums_bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let block = params_block(image.width, pixels, &bounds);
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("stacks push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let built = kernels(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("stacks"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: frame.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: sums.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });

    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_bind_group(0, &group, &[]);
        pass.set_pipeline(&built.cells);
        let (x, y) = crate::base::groups(pixels);
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.encoder().copy_buffer_to_buffer(&sums, 0, &out, 0, sums_bytes);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &out, |mapped| {
        mapped
            .chunks_exact(4)
            .map(|word| u32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
            .collect::<Vec<u32>>()
    })
    .await;
    // The named locals as well as the recording, or its copies are not the last ones and the
    // frame stays up until the caller returns.
    drop((frame, sums, out, push, recording));

    let Some(read) = read else {
        // Said out loud, because the two ways to have no descriptor are not the same: a frame too
        // small to grid is one this photograph will never be a stacking candidate on, and a device
        // that declined is one it would have been.
        eprintln!("rawshim: the stacking grids were not read back, so this photograph gets none");
        return None;
    };
    let mut grids = read.chunks_exact(words);
    let mut view = |(_, _, w, h): (usize, usize, usize, usize)| {
        grids.next().map(|channels| Cells {
            side: GRID,
            channels: channels.to_vec(),
            counts: cell_counts(w, h, GRID),
        })
    };
    let whole = view(bounds[0])?;
    let cropped = view(bounds[1])?;
    Some([whole, cropped])
}

/// The descriptor for one frame: `DESCRIPTOR_BYTES` of rank-normalized grids.
///
/// None where the device declined to hand the grids back, which leaves the photograph out of the
/// stacking rather than out of the library.
pub fn describe(gpu: &'static crate::gpu::Gpu, image: RgbRef<'_>) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(DESCRIPTOR_BYTES);
    out.resize(HEADER, FORMAT);
    for cells in pollster::block_on(accumulate(gpu, image))? {
        let coarse = cells.folded();
        // Luma arrives on a 0-255 scale already, chromaticity on a 0-1 one.
        for grid in [&coarse, &cells] {
            let mut luma = luma_grid(grid);
            quantize(&mut luma, 1.0);
            rank_normalize(&luma, &mut out);
        }
        let (mut red, mut green) = chroma_grids(&cells);
        quantize(&mut red, 255.0);
        quantize(&mut green, 255.0);
        rank_normalize(&red, &mut out);
        rank_normalize(&green, &mut out);
    }
    Some(out)
}

/// One view's four grids, borrowed out of a stored descriptor.
struct Grids<'a> {
    coarse: &'a [u8],
    luma: &'a [u8],
    red: &'a [u8],
    green: &'a [u8],
}

fn grids_of(descriptor: &[u8], view: usize) -> Grids<'_> {
    let base = HEADER + view * VIEW_BYTES;
    let luma = base + COARSE_CELLS;
    Grids {
        coarse: &descriptor[base..luma],
        luma: &descriptor[luma..luma + GRID_CELLS],
        red: &descriptor[luma + GRID_CELLS..luma + GRID_CELLS * 2],
        green: &descriptor[luma + GRID_CELLS * 2..luma + GRID_CELLS * 3],
    }
}

/// Mean absolute difference between `a`'s centred window and `b`'s at an offset.
fn window_distance(a: &[u8], b: &[u8], side: usize, window: usize, offset: (usize, usize)) -> f32 {
    let pad = (side - window) / 2;
    let mut total = 0u32;
    for y in 0..window {
        let (row_a, row_b) = ((pad + y) * side + pad, (offset.1 + y) * side + offset.0);
        for x in 0..window {
            total += (a[row_a + x] as i32 - b[row_b + x] as i32).unsigned_abs();
        }
    }
    total as f32 / (window * window) as f32 / 255.0
}

/// As `window_distance`, averaged over only the best-agreeing `KEEP` of cells.
fn trimmed_distance(a: &[u8], b: &[u8], side: usize, window: usize, offset: (usize, usize)) -> f32 {
    let pad = (side - window) / 2;
    let cells = window * window;
    let mut differences = [0u8; WINDOW * WINDOW];
    for y in 0..window {
        let (row_a, row_b) = ((pad + y) * side + pad, (offset.1 + y) * side + offset.0);
        for x in 0..window {
            differences[y * window + x] = a[row_a + x].abs_diff(b[row_b + x]);
        }
    }
    let kept = ((cells as f32 * KEEP) as usize).max(1);
    let slice = &mut differences[..cells];
    slice.select_nth_unstable(kept - 1);
    let total: u32 = slice[..kept].iter().map(|d| *d as u32).sum();
    total as f32 / kept as f32 / 255.0
}

/// The offset that best lines two coarse grids up, in coarse cells.
///
/// Searching the alignment coarsely and evaluating the real distance once at the
/// winner costs a fraction of evaluating all twenty-five offsets at full size,
/// which is the difference between a detection pass measured in seconds and one
/// measured in minutes.
/// Seeded with the centre's own distance, so an offset only wins by being
/// strictly better than not moving at all.
///
/// Seeding with infinity instead hands every tie to whichever offset is scanned
/// first, which is the top-left corner. That is not a rare case: any subject
/// with a repeating pattern - a fence, roof tiles, a striped shirt - can score
/// the same at several alignments, and picking the corner then compares one
/// frame's centre against another's corner. A frame can fail to match *itself*
/// that way, which is how this was found.
fn coarse_offset(a: &[u8], b: &[u8]) -> (usize, usize) {
    let pad = (COARSE - COARSE_WINDOW) / 2;
    let mut best = (window_distance(a, b, COARSE, COARSE_WINDOW, (pad, pad)), pad, pad);
    for oy in 0..=2 * pad {
        for ox in 0..=2 * pad {
            let distance = window_distance(a, b, COARSE, COARSE_WINDOW, (ox, oy));
            if distance < best.0 {
                best = (distance, ox, oy);
            }
        }
    }
    (best.1, best.2)
}

fn directed(a: &Grids<'_>, b: &Grids<'_>) -> f32 {
    let (ox, oy) = coarse_offset(a.coarse, b.coarse);
    let offset = (ox * 2, oy * 2);
    let luma = trimmed_distance(a.luma, b.luma, GRID, WINDOW, offset);
    let red = trimmed_distance(a.red, b.red, GRID, WINDOW, offset);
    let green = trimmed_distance(a.green, b.green, GRID, WINDOW, offset);
    let structure = 1.0 - luma * 3.0;
    let colour = 1.0 - (red + green) * 1.5;
    (1.0 - CHROMA_WEIGHT) * structure + CHROMA_WEIGHT * colour
}

/// Both directions, because one of them alone is not symmetric.
///
/// A directed comparison pins the first frame's window at the centre and slides
/// the second, so the two orders weigh different regions and can differ by
/// enough to straddle the threshold - measured at 0.081 on a panned pair. The
/// grouping calls this a clique, and a clique of a relation that depends on
/// which member came first is not one.
fn similarity_at(a: &Grids<'_>, b: &Grids<'_>) -> f32 {
    directed(a, b).max(directed(b, a))
}

/// How alike two frames are, in `[0, 1]`.
///
/// The best of three pairings: both whole, and each one's whole frame against the
/// other's crop. Cropping both sides is the same view as cropping neither, so
/// that pairing is skipped. Trying both directions is what makes the score
/// symmetric, which the grouping rule needs.
pub fn similarity(a: &[u8], b: &[u8]) -> f32 {
    // Length alone would let a descriptor from another format through if it ever happened to be
    // this long; the byte says which rule the numbers were measured under.
    if a.len() < DESCRIPTOR_BYTES || b.len() < DESCRIPTOR_BYTES || a[0] != FORMAT || b[0] != FORMAT
    {
        return 0.0;
    }
    let best = similarity_at(&grids_of(a, 0), &grids_of(b, 0))
        .max(similarity_at(&grids_of(a, 0), &grids_of(b, 1)))
        .max(similarity_at(&grids_of(a, 1), &grids_of(b, 0)));
    best.clamp(0.0, 1.0)
}

/// Groups frames into stacks, given their descriptors in ascending time order.
///
/// The window gates *adjacency* only: a stack may chain arbitrarily far in time,
/// and what bounds it is that every member clears `threshold` against every other
/// member. A scene that drifts frame by frame therefore reaches a point where the
/// newest photo no longer matches the one the stack started from, and the stack
/// ends there on its own. That is why chaining needs no separate guard.
///
/// Returns a group index per frame, or -1 for one that ended up alone.
pub fn group(descriptors: &[u8], timestamps: &[i64], threshold: f32, window_seconds: i64) -> Vec<i32> {
    let count = timestamps.len();
    let mut groups = vec![-1i32; count];
    if count == 0 {
        return groups;
    }
    let descriptor = |i: usize| &descriptors[i * DESCRIPTOR_BYTES..(i + 1) * DESCRIPTOR_BYTES];

    let mut next_group = 0i32;
    let mut current: Vec<usize> = vec![0];
    let close = |current: &Vec<usize>, groups: &mut Vec<i32>, next: &mut i32| {
        if current.len() > 1 {
            for index in current {
                groups[*index] = *next;
            }
            *next += 1;
        }
    };

    for index in 1..count {
        // Saturating, because a corrupt timestamp either side of the subtraction
        // would otherwise wrap: in a release build that reports two frames a
        // century apart as adjacent, and in a debug build it panics, which
        // across an extern "C" boundary aborts the process.
        let adjacent = timestamps[index].saturating_sub(timestamps[index - 1]) <= window_seconds;
        let clique = adjacent
            && current
                .iter()
                .all(|member| similarity(descriptor(*member), descriptor(index)) >= threshold);
        if clique {
            current.push(index);
        } else {
            close(&current, &mut groups, &mut next_group);
            current = vec![index];
        }
    }
    close(&current, &mut groups, &mut next_group);
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame built from a closure over normalized coordinates, so a test can
    /// state the picture rather than a buffer.
    fn frame(width: usize, height: usize, paint: impl Fn(f32, f32) -> [u8; 3]) -> Vec<u8> {
        let mut data = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&paint(x as f32 / width as f32, y as f32 / height as f32));
            }
        }
        data
    }

    fn describe_frame(
        gpu: &'static crate::gpu::Gpu,
        width: usize,
        height: usize,
        data: &[u8],
    ) -> Vec<u8> {
        describe(gpu, RgbRef { width, height, data }).expect("the device hands the grids back")
    }

    /// A gradient sky over a darker ground, which is the shape of most of the
    /// frames this was tuned against.
    ///
    /// The horizontal term matters: a perfectly smooth vertical ramp has whole
    /// rows of identical cells, and darkening it collapses neighbouring levels
    /// into each other, so the fixture would be testing 8-bit quantization rather
    /// than the descriptor. A photograph has texture; this is the least amount of
    /// it that stops the fixture being degenerate.
    fn scene(brightness: f32, shift: f32) -> Vec<u8> {
        frame(160, 120, |x, y| {
            let horizon = 0.55 + shift;
            let base = if y < horizon { 200.0 - 120.0 * y } else { 60.0 - 30.0 * (y - horizon) };
            let lit = ((base + 40.0 * x) * brightness).clamp(0.0, 255.0) as u8;
            [lit, (lit as f32 * 0.95) as u8, (lit as f32 * 0.8) as u8]
        })
    }

    #[test]
    fn descriptor_is_the_declared_size() {
        let Some(gpu) = crate::gpu::device() else { return };
        let data = scene(1.0, 0.0);
        assert_eq!(describe_frame(gpu, 160, 120, &data).len(), DESCRIPTOR_BYTES);
    }

    #[test]
    fn a_frame_matches_itself_exactly() {
        let Some(gpu) = crate::gpu::device() else { return };
        let data = scene(1.0, 0.0);
        let descriptor = describe_frame(gpu, 160, 120, &data);
        assert_eq!(similarity(&descriptor, &descriptor), 1.0);
    }

    /// The grids are integer sums, so the same frame twice is the same bytes twice - which is
    /// what lets a descriptor written months ago be compared against one taken now.
    #[test]
    fn describing_one_frame_twice_gives_the_same_bytes() {
        let Some(gpu) = crate::gpu::device() else { return };
        let data = scene(1.0, 0.0);
        assert_eq!(describe_frame(gpu, 160, 120, &data), describe_frame(gpu, 160, 120, &data));
    }

    #[test]
    fn similarity_is_symmetric() {
        let Some(gpu) = crate::gpu::device() else { return };
        let (a, b) = (scene(1.0, 0.0), scene(0.7, 0.04));
        let (da, db) = (describe_frame(gpu, 160, 120, &a), describe_frame(gpu, 160, 120, &b));
        assert_eq!(similarity(&da, &db), similarity(&db, &da));
    }

    /// Rank normalization is the whole reason a different exposure of one scene
    /// still reads as that scene: a monotonic curve cannot reorder the cells.
    #[test]
    fn exposure_change_leaves_the_descriptor_alone() {
        let Some(gpu) = crate::gpu::device() else { return };
        let (bright, dark) = (scene(1.0, 0.0), scene(0.55, 0.0));
        let (a, b) = (describe_frame(gpu, 160, 120, &bright), describe_frame(gpu, 160, 120, &dark));
        assert!(similarity(&a, &b) > 0.95, "exposure change scored {}", similarity(&a, &b));
    }

    /// Aspect is squashed, so a crop or a second body must not read as a change.
    #[test]
    fn aspect_ratio_alone_is_not_a_difference() {
        let Some(gpu) = crate::gpu::device() else { return };
        let wide = frame(200, 100, |_, y| [(220.0 - 160.0 * y) as u8; 3]);
        let tall = frame(100, 200, |_, y| [(220.0 - 160.0 * y) as u8; 3]);
        let (a, b) = (describe_frame(gpu, 200, 100, &wide), describe_frame(gpu, 100, 200, &tall));
        assert!(similarity(&a, &b) > 0.95, "aspect change scored {}", similarity(&a, &b));
    }

    /// A frame of sky over ground against a frame of vertical stripes: different
    /// pictures, and the score has to say so well below any usable threshold.
    #[test]
    fn a_different_scene_scores_far_lower() {
        let Some(gpu) = crate::gpu::device() else { return };
        let sky = scene(1.0, 0.0);
        let stripes = frame(160, 120, |x, _| [if (x * 8.0) as u32 % 2 == 0 { 230 } else { 40 }; 3]);
        let (a, b) = (describe_frame(gpu, 160, 120, &sky), describe_frame(gpu, 160, 120, &stripes));
        assert!(similarity(&a, &b) < 0.7, "unrelated frames scored {}", similarity(&a, &b));
    }

    #[test]
    fn grouping_needs_two_to_make_a_stack() {
        let Some(gpu) = crate::gpu::device() else { return };
        let data = scene(1.0, 0.0);
        let descriptor = describe_frame(gpu, 160, 120, &data);
        assert_eq!(group(&descriptor, &[0], 0.78, 60), vec![-1]);
    }

    #[test]
    fn alike_and_adjacent_frames_stack() {
        let Some(gpu) = crate::gpu::device() else { return };
        let frames = [scene(1.0, 0.0), scene(0.9, 0.01), scene(0.95, 0.0)];
        let descriptors: Vec<u8> =
            frames.iter().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        assert_eq!(group(&descriptors, &[0, 5, 9], 0.78, 60), vec![0, 0, 0]);
    }

    /// The window gates adjacency, so a gap between two frames ends the stack even
    /// when they are otherwise identical.
    #[test]
    fn a_gap_wider_than_the_window_ends_a_stack() {
        let Some(gpu) = crate::gpu::device() else { return };
        let frames = [scene(1.0, 0.0), scene(1.0, 0.0), scene(1.0, 0.0)];
        let descriptors: Vec<u8> =
            frames.iter().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        assert_eq!(group(&descriptors, &[0, 5, 400], 0.78, 60), vec![0, 0, -1]);
    }

    /// The clique rule: the third frame is close to the second and far from the
    /// first, so the stack has to end rather than chain onto it.
    #[test]
    fn a_frame_unlike_the_first_member_starts_a_new_stack() {
        let Some(gpu) = crate::gpu::device() else { return };
        let frames = [scene(1.0, 0.0), scene(1.0, 0.0)];
        let stripes = frame(160, 120, |x, _| [if (x * 8.0) as u32 % 2 == 0 { 230 } else { 40 }; 3]);
        let mut descriptors: Vec<u8> =
            frames.iter().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        descriptors.extend(describe_frame(gpu, 160, 120, &stripes));
        assert_eq!(group(&descriptors, &[0, 5, 9], 0.78, 60), vec![0, 0, -1]);
    }

    /// Horizontal bands one grid row high, which make every coarse alignment score identically.
    /// A tie handed to the top-left offset compares the frame against itself two rows out of
    /// phase, so this is what says the search breaks one on the centre.
    fn striped() -> Vec<u8> {
        frame(160, 120, |_, y| {
            let band = (y * 20.0) as u32 % 4;
            let value = if band == 1 || band == 2 { 230 } else { 40 };
            [value, value, value]
        })
    }

    #[test]
    fn a_repeating_pattern_still_matches_itself() {
        let Some(gpu) = crate::gpu::device() else { return };
        let data = striped();
        let descriptor = describe_frame(gpu, 160, 120, &data);
        assert_eq!(similarity(&descriptor, &descriptor), 1.0);
    }

    /// A pan, which the two directions weigh differently unless both are taken.
    #[test]
    fn similarity_is_symmetric_under_a_pan() {
        let Some(gpu) = crate::gpu::device() else { return };
        let base = scene(1.0, 0.0);
        let panned = frame(160, 120, |x, y| {
            let (sx, sy) = ((x + 0.18).min(0.999), (y + 0.09).min(0.999));
            let horizon = 0.55;
            let value = if sy < horizon { 200.0 - 120.0 * sy } else { 60.0 - 30.0 * (sy - horizon) };
            let lit = (value + 40.0 * sx).clamp(0.0, 255.0) as u8;
            [lit, (lit as f32 * 0.95) as u8, (lit as f32 * 0.8) as u8]
        });
        let (a, b) = (describe_frame(gpu, 160, 120, &base), describe_frame(gpu, 160, 120, &panned));
        assert_eq!(similarity(&a, &b), similarity(&b, &a));
    }

    /// The grouping is a clique of `similarity`, so the answer must not depend on
    /// which frame the walk reached first.
    #[test]
    fn grouping_does_not_depend_on_order() {
        let Some(gpu) = crate::gpu::device() else { return };
        let frames = [scene(1.0, 0.0), scene(0.85, 0.03)];
        let forward: Vec<u8> =
            frames.iter().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        let backward: Vec<u8> =
            frames.iter().rev().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        let a = group(&forward, &[0, 5], 0.78, 60);
        let b = group(&backward, &[0, 5], 0.78, 60);
        assert_eq!(a.iter().filter(|g| **g >= 0).count(), b.iter().filter(|g| **g >= 0).count());
    }

    /// A corrupt timestamp must not wrap the gap into "adjacent", nor panic
    /// across the FFI boundary.
    #[test]
    fn an_extreme_timestamp_gap_is_not_adjacent() {
        let Some(gpu) = crate::gpu::device() else { return };
        let frames = [scene(1.0, 0.0), scene(1.0, 0.0)];
        let descriptors: Vec<u8> =
            frames.iter().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        assert_eq!(group(&descriptors, &[i64::MIN, i64::MAX], 0.78, 60), vec![-1, -1]);
    }

    #[test]
    fn a_lower_threshold_admits_more() {
        let Some(gpu) = crate::gpu::device() else { return };
        let frames = [scene(1.0, 0.0), scene(0.4, 0.08)];
        let descriptors: Vec<u8> =
            frames.iter().flat_map(|f| describe_frame(gpu, 160, 120, f)).collect();
        let strict = group(&descriptors, &[0, 5], 0.999, 60);
        let loose = group(&descriptors, &[0, 5], 0.5, 60);
        assert_eq!(strict, vec![-1, -1]);
        assert_eq!(loose, vec![0, 0]);
    }
}

