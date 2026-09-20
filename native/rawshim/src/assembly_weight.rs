//! §5.2's weight field: one signed distance a source, one `W(x)` for all of them.
//!
//! The host for `assembly_weight.slang`'s four entries - the owner map, a seed pass a slot, a jump
//! flood, and the resolve - driven once for a window of a render. The flood is per source because
//! `composite_add` takes one layer and one weight buffer a dispatch; `W(x)` is one field for every
//! source because both sides of a seam have to read the same width or `smoothstep` is not symmetric.

use crate::assembly::Drawing;
use crate::gpu::{self, Gpu};
use crate::px::{Composite, Rect};

/// `Assembly::feather` where a recipe names none.
pub const FEATHER: crate::px::Share = crate::px::Share::of(1, 400);
/// §5.2's high band, in **render pixels** - the one spatial constant here that is not a share,
/// because anti-aliasing a staircase is a pixel-scale job.
pub const W_HIGH_PX: f32 = 2.0;

/// `EVERY_SLOT` in `assembly_weight.slang`, pinned by `the_every_slot_sentinel_matches_the_shader`:
/// the slot for the pass that measures every owner change at once, which `W(x)` is built from.
const EVERY_SLOT: u32 = 0xffff_ffff;

/// The fields one window of a render reads, over `Drawing::sources_used()`'s own slots.
pub struct Weights {
    /// One f32 an output pixel a slot, slot-minor: the signed distance in render pixels to the
    /// boundary of the union of tiles that slot's source picked, positive inside. Read by
    /// `composite_gather` through `CompositeRequest::mask`.
    pub signed: gpu::Buffer,
    /// One f32 an output pixel: §5.2's `W(x)`, the half-width the low band feathers over, the
    /// same for every source at a pixel and so the same on both sides of every seam.
    pub width: gpu::Buffer,
    /// One uint an output pixel a slot, slot-minor beside `signed`: which tile of that slot the
    /// gather reads it through, or `NO_TILE`. This is what makes §3.7a per tile without a gather
    /// per tile - the correction varies inside one pass rather than across several.
    pub tile_of: gpu::Buffer,
    /// One [`TileWarp`] a tile, in `Drawing::tiles`' own order.
    pub warps: gpu::Buffer,
    pub slots: usize,
    pub pixels: usize,
}

/// `TileWarp` in `composite_gather.slang`: what a tile does to the canvas, and to the light.
///
/// **Per tile rather than per gather, which is the whole point of it.** A source is read once for a
/// window; the correction a tile's seam needs is a lookup inside that pass, so a carve with eighty
/// tiles costs eighty affines rather than eighty passes over the window and eighty slots of the
/// weight field.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct TileWarp {
    /// `(a, b, c, d)` of `[a b; c d]`, carried into the centre-relative frame the shader's canvas
    /// coordinate is already in, as `composite_tile::params` carries a source's own.
    pub m: [f32; 4],
    pub t: [f32; 2],
    /// What to multiply this tile's light by, past whatever its source's own gain already did, as
    /// the `tone::gain_in_y` the gather's `lift_in_pq` multiplies by.
    pub gain: f32,
    pub pad: f32,
}

/// `NO_TILE` in `assembly_weight.slang`, pinned by `the_no_tile_sentinel_matches_the_shader`.
pub const NO_TILE: u32 = 0xffff_ffff;

/// Every tile's §3.7a correction, in the frame the gather asks for it in.
///
/// Canvas pixels either side, so nothing here divides by the render's scale: the shader applies this
/// to a canvas coordinate it has already scaled up.
fn warps_of(recipe: &Drawing) -> Vec<TileWarp> {
    let (cx, cy) = (recipe.spec.centre[0], recipe.spec.centre[1]);
    (0..recipe.tiles.len())
        .map(|tile| {
            // The warp is stated in canvas pixels about the canvas origin and the shader's
            // coordinate is relative to the projection's centre, so `M*p + b - centre` becomes
            // `M*q + (M*centre + b - centre)` - `composite_tile::params` does the same for a source.
            let [a, b, c, d, tx, ty] = recipe.warp_of(tile);
            TileWarp {
                m: [a as f32, b as f32, c as f32, d as f32],
                t: [
                    (a * cx + b * cy + tx - cx) as f32,
                    (c * cx + d * cy + ty - cy) as f32,
                ],
                gain: crate::tone::gain_in_y(recipe.gain[tile]) as f32,
                pad: 0.0,
            }
        })
        .collect()
}

/// Which slot each source of the recipe occupies, `None` where no tile and not the base uses it.
pub fn slots_of(recipe: &Drawing) -> Vec<Option<u32>> {
    let used = recipe.sources_used();
    (0..recipe.spec.sources.len())
        .map(|i| used.iter().position(|&s| s == i).map(|at| at as u32))
        .collect()
}

/// `Params` in `assembly_weight.slang`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    size: [u32; 2],
    origin: [i32; 2],
    tiles: u32,
    slots: u32,
    slot: u32,
    step: u32,
    out_size: [u32; 2],
    pad_at: [u32; 2],
    w_max: f32,
    pad: [f32; 3],
}

/// `Tile` in `assembly_weight.slang`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct TileSpan {
    box_: [f32; 4],
    start: u32,
    count: u32,
    slot: u32,
    width: f32,
}

/// The block's size, for `wgsl_layout.rs` to hold against the shader's own.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

/// One entry of `assembly_weight.slang`, and the bindings past the uniform it reads.
///
/// **Only those**, because the four together bind eleven storage buffers and a stage is allowed ten
/// (`gpu::MOST_STORAGE_BUFFERS`).
struct Entry {
    kernel: crate::hdr_fit::Kernel,
    uses: &'static [u32],
}

fn built(gpu: &'static Gpu, entry: &str, uses: &'static [u32]) -> Entry {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    // The polygons are uploaded and only read; everything past them is a field some entry writes.
    let bindings: Vec<_> = std::iter::once((0, UNIFORM))
        .chain(
            uses.iter()
                .map(|&at| (at, if at <= 3 { READ } else { WRITE })),
        )
        .collect();
    let kernel = crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/assembly_weight.wgsl")),
        &bindings,
        &[],
    );
    Entry { kernel, uses }
}

fn owning(gpu: &'static Gpu) -> &'static Entry {
    static BUILT: std::sync::OnceLock<Entry> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_owner", &[1, 2, 3, 4, 5, 10]))
}

fn seeding(gpu: &'static Gpu) -> &'static Entry {
    static BUILT: std::sync::OnceLock<Entry> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_seed", &[4, 5, 6]))
}

fn flooding(gpu: &'static Gpu) -> &'static Entry {
    static BUILT: std::sync::OnceLock<Entry> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_flood", &[6, 7]))
}

fn settling(gpu: &'static Gpu) -> &'static Entry {
    static BUILT: std::sync::OnceLock<Entry> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_settle", &[4, 6, 8, 9, 10, 11]))
}

// `zeroed`, `uploaded` and `dispatch` are `assembly_analysis.rs`'s, copied rather than shared -
// they are eight lines each and sharing them would make one module's binding count another's
// problem.

fn zeroed(gpu: &'static Gpu, words: usize, label: &str) -> gpu::Buffer {
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::cast_slice(&vec![0u32; words.max(1)]),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    })
}

fn uploaded<T: bytemuck::Pod>(gpu: &'static Gpu, values: &[T], label: &str) -> gpu::Buffer {
    let spare = [T::zeroed()];
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents: bytemuck::cast_slice(match values.is_empty() {
            true => &spare,
            false => values,
        }),
        usage: wgpu::BufferUsages::STORAGE,
    })
}

/// `entry` over `bound`, every field in binding order from 1, of which it binds those it reads.
fn dispatch(
    gpu: &'static Gpu,
    entry: &Entry,
    params: Params,
    bound: &[&gpu::Buffer],
    groups: (u32, u32),
) {
    let kernel = &entry.kernel;
    let bound: Vec<(u32, &gpu::Buffer)> = entry
        .uses
        .iter()
        .map(|&at| (at, bound[at as usize - 1]))
        .collect();
    let mut recording = gpu.record();
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("assembly weight params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    for (_, held) in &bound {
        recording.holding(held);
    }
    let mut entries = vec![wgpu::BindGroupEntry {
        binding: 0,
        resource: uniform.as_entire_binding(),
    }];
    for (binding, buffer) in &bound {
        entries.push(wgpu::BindGroupEntry {
            binding: *binding,
            resource: buffer.as_entire_binding(),
        });
    }
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("assembly weight"),
        layout: &kernel.layout,
        entries: &entries,
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups.0, groups.1, 1);
    }
    recording.submit();
}

/// The fields for one window of one render, at `scale` canvas pixels an output pixel.
///
/// **`window` is `CompositeRequest::window`'s: this render's own pixels**, which is the canvas
/// divided by `scale`. The polygons are divided by it too, so the whole pass works in one
/// coordinate system.
///
/// The owner map and the flood run on the window grown by `w_max` on every side, and only the
/// resolve writes the window: a seam outside the window still feathers the pixels inside it, so a
/// grid stopping at the window's own edge makes a strip that ends on a seam take one frame whole
/// where the canvas taken in one piece has half of each.
pub async fn weights(
    gpu: &'static Gpu,
    recipe: &Drawing,
    window: Rect<Composite>,
    scale: f64,
) -> Weights {
    let (left, top, w, h) = window.raw();
    let pixels = w * h;
    let slots = recipe.sources_used().len();
    // The render's own long edge, which is the canvas's divided by `scale` - a render plane's
    // pixels are as large as the render is small, so it is not one of `px.rs`'s spaces and the
    // share is resolved against a measured extent rather than an exact one.
    let long = (recipe.spec.canvas[0].max(recipe.spec.canvas[1]) as f64 / scale).max(1.0);
    let w_max = (recipe.feather().raw() * long) as f32;
    let of = slots_of(recipe);

    let margin = w_max.ceil().max(1.0) as usize;
    let grid = (w + 2 * margin, h + 2 * margin);
    let grid_pixels = grid.0 * grid.1;

    // The vertices are the recipe's canvas pixels (§3.8); a render works in its own, which is the
    // canvas divided by `scale`.
    let vertices: Vec<[f32; 2]> = recipe
        .vertices
        .iter()
        .map(|v| [v[0] / scale as f32, v[1] / scale as f32])
        .collect();
    let mut flat: Vec<u32> = Vec::new();
    let spans: Vec<TileSpan> = recipe
        .tiles
        .iter()
        .enumerate()
        .map(|(t, tile)| {
            let start = flat.len() as u32;
            flat.extend_from_slice(tile);
            let fold = |axis: usize, f: fn(f32, f32) -> f32, from: f32| {
                tile.iter()
                    .map(|&v| vertices[v as usize][axis])
                    .fold(from, f)
            };
            TileSpan {
                box_: [
                    fold(0, f32::min, f32::INFINITY),
                    fold(1, f32::min, f32::INFINITY),
                    fold(0, f32::max, f32::NEG_INFINITY),
                    fold(1, f32::max, f32::NEG_INFINITY),
                ],
                start,
                count: tile.len() as u32,
                slot: of[recipe.pick[t]].expect("a picked source has a slot"),
                // Half the corridor, in render pixels, between §5.2's two bounds. Floored at the
                // high band: where `W` falls under it the tile takes the high band alone, which is
                // the same thing said as a clamp.
                //
                // The ceiling first and the floor second, rather than one `clamp`: the feather of a
                // small enough render is under the high band, and `clamp` panics on a reversed
                // pair rather than answering. The high band wins there, being the pixel-scale job
                // that still has to be done.
                width: ((f64::from(recipe.corridor[t]) * long / 2.0) as f32)
                    .min(w_max)
                    .max(W_HIGH_PX),
            }
        })
        .collect();

    let vertices_buf = uploaded(gpu, &vertices, "assembly weight vertices");
    let loops_buf = uploaded(gpu, &flat, "assembly weight loops");
    let tiles_buf = uploaded(gpu, &spans, "assembly weight tiles");

    let owner = zeroed(gpu, grid_pixels, "assembly owner");
    let owner_width = zeroed(gpu, grid_pixels, "assembly owner width");
    let ping = zeroed(gpu, grid_pixels * 4, "assembly flood a");
    let pong = zeroed(gpu, grid_pixels * 4, "assembly flood b");
    let signed = zeroed(gpu, pixels * slots, "assembly signed distance");
    let width = zeroed(gpu, pixels, "assembly feather width");
    let owner_tile = zeroed(gpu, grid_pixels, "assembly owner tile");
    let tile_of = zeroed(gpu, pixels * slots, "assembly tile of");
    let warps = uploaded(gpu, &warps_of(recipe), "assembly tile warps");

    let tile_count = spans.len();
    let block = |slot: u32, step: u32| Params {
        size: [grid.0 as u32, grid.1 as u32],
        origin: [left as i32 - margin as i32, top as i32 - margin as i32],
        tiles: tile_count as u32,
        slots: slots as u32,
        slot,
        step,
        out_size: [w as u32, h as u32],
        pad_at: [margin as u32, margin as u32],
        w_max,
        pad: [0.0; 3],
    };
    // `from_` is `ping` while the flood is reading it, which is every pass that reads a site:
    // the seed writes `ping`, each flood step swaps, and the settle reads whichever the last step
    // wrote.
    let entries = |from_is_ping: bool| -> Vec<&gpu::Buffer> {
        let (from, to) = match from_is_ping {
            true => (&ping, &pong),
            false => (&pong, &ping),
        };
        vec![
            &vertices_buf,
            &loops_buf,
            &tiles_buf,
            &owner,
            &owner_width,
            from,
            to,
            &signed,
            &width,
            &owner_tile,
            &tile_of,
        ]
    };

    dispatch(
        gpu,
        owning(gpu),
        block(0, 0),
        &entries(true),
        crate::base::groups(grid_pixels),
    );

    // `EVERY_SLOT` first - the width field every source reads - then a field a slot.
    for slot in std::iter::once(EVERY_SLOT).chain(0..slots as u32) {
        dispatch(
            gpu,
            seeding(gpu),
            block(slot, 0),
            &entries(true),
            crate::base::groups(grid_pixels),
        );
        let mut step = (grid.0.max(grid.1) as u32).next_power_of_two() / 2;
        let mut from_is_ping = true;
        while step >= 1 {
            dispatch(
                gpu,
                flooding(gpu),
                block(slot, step),
                &entries(from_is_ping),
                crate::base::groups(grid_pixels),
            );
            from_is_ping = !from_is_ping;
            step /= 2;
        }
        dispatch(
            gpu,
            settling(gpu),
            block(slot, 0),
            &entries(from_is_ping),
            crate::base::groups(pixels),
        );
    }

    Weights {
        signed,
        width,
        tile_of,
        warps,
        slots,
        pixels,
    }
}

#[cfg(test)]
mod tests {
    /// The sentinel a `static const` in the shader is folded into its use sites, so the source is
    /// what a test reads (`CLAUDE.md`).
    #[test]
    fn the_unseeded_sentinel_matches_the_shader() {
        let source = include_str!("../../../slang/assembly_weight.slang");
        let line = source
            .lines()
            .find(|l| l.contains("const float UNSEEDED ="))
            .expect("UNSEEDED is declared in assembly_weight.slang");
        assert!(line.contains("1e30"), "the shader reads `{line}`");
    }

    /// `EVERY_SLOT` in `assembly_weight.slang`, which the host loop also reads to drive the width
    /// field's pass before any per-source one.
    #[test]
    fn the_every_slot_sentinel_matches_the_shader() {
        let source = include_str!("../../../slang/assembly_weight.slang");
        let line = source
            .lines()
            .find(|l| l.contains("const uint EVERY_SLOT ="))
            .expect("EVERY_SLOT is declared in assembly_weight.slang");
        assert!(line.contains("0xffffffffu"), "the shader reads `{line}`");
        assert_eq!(super::EVERY_SLOT, 0xffff_ffff);
    }
}
