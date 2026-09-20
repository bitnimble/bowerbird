//! §5.2's two bands, accumulated one layer at a time.
//!
//! `composite_tile::Blending`'s shape, with two accumulators instead of one and log2 light instead
//! of light: the lowpass at `W(x)`, the detail at `W_HIGH_PX`. A source's layer arrives with
//! §5.2's signed distance in its weight buffer rather than a feather, which is what
//! `CompositeRequest::mask` asks the gather for.

use crate::composite_tile::Layer;
use crate::gpu::{self, Gpu};
use crate::px::{Composite, Rect};
use crate::resident::Resident;

/// `composite_gather.slang`'s own sentinel, pinned against it by
/// `composite_tile::tests::the_unreached_sentinel_matches_the_shader`.
pub const NOT_REACHED: f32 = crate::composite_tile::NOT_REACHED;

/// `Params` in `assembly_blend.slang`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    size: [u32; 2],
    pixels: u32,
    w_high: f32,
    lowpass_size: [u32; 2],
    lowpass_at: [f32; 2],
    lowpass_per_pixel: [f32; 2],
    pad: [f32; 2],
}

/// The block's size, for `wgsl_layout.rs` to hold against the shader's own.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

fn built(gpu: &'static Gpu, entry: &str) -> crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/assembly_blend.wgsl")),
        &[
            (0, UNIFORM),
            (1, READ),
            (2, READ),
            (3, READ),
            (4, READ),
            (5, WRITE),
            (6, WRITE),
            (7, READ),
        ],
        &[],
    )
}

fn adding(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_add"))
}

fn resolving(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_resolve"))
}

/// The two bands of one window, over the crop-wide lowpass every source was reduced to.
pub struct Banding {
    gpu: &'static Gpu,
    base: &'static crate::base::Base,
    lowpass: Vec<gpu::Buffer>,
    width: gpu::Buffer,
    out: Resident,
    accumulator: gpu::Buffer,
    uniform: gpu::Buffer,
    pixels: usize,
    added: usize,
}

impl Banding {
    /// `window` is `CompositeRequest::window`'s: this render's own pixels, at `scale` canvas pixels
    /// each.
    pub fn over(
        gpu: &'static Gpu,
        base: &'static crate::base::Base,
        window: Rect<Composite>,
        width: &gpu::Buffer,
        lowpass: &crate::assembly_render::Lowpass,
        scale: f64,
    ) -> Banding {
        let (left, top, w, h) = window.raw();
        let pixels = w * h;
        let (crop_left, crop_top, crop_w, crop_h) = lowpass.crop.raw();
        // Canvas pixels a cell of the lowpass's grid, per axis: the grid is the crop's own shape
        // rounded to whole cells, so the two ratios are not the same number.
        let cell = [
            crop_w as f64 / lowpass.size.0 as f64,
            crop_h as f64 / lowpass.size.1 as f64,
        ];
        // The shader samples with cell *centres* at whole `u`, so the half cell comes off here.
        let at = |axis: usize, window_at: usize, crop_at: usize| {
            ((window_at as f64 + 0.5) * scale - crop_at as f64) / cell[axis] - 0.5
        };
        let block = Params {
            size: [w as u32, h as u32],
            pixels: pixels as u32,
            w_high: crate::assembly_weight::W_HIGH_PX,
            lowpass_size: [lowpass.size.0 as u32, lowpass.size.1 as u32],
            lowpass_at: [at(0, left, crop_left) as f32, at(1, top, crop_top) as f32],
            lowpass_per_pixel: [(scale / cell[0]) as f32, (scale / cell[1]) as f32],
            pad: [0.0; 2],
        };
        Banding {
            gpu,
            base,
            lowpass: lowpass
                .bands
                .iter()
                .map(|band| band.buffer().clone())
                .collect(),
            width: width.clone(),
            out: Resident::empty(gpu, w, h),
            accumulator: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("assembly accumulator"),
                contents: &vec![0u8; pixels.max(1) * 32],
                usage: wgpu::BufferUsages::STORAGE,
            }),
            uniform: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("assembly blend params"),
                contents: bytemuck::bytes_of(&block),
                usage: wgpu::BufferUsages::UNIFORM,
            }),
            pixels,
            added: 0,
        }
    }

    /// Whether any source has reached this window at all.
    pub fn is_empty(&self) -> bool {
        self.added == 0
    }

    /// One source's layer, its weight buffer holding §5.2's signed distance, and its slot.
    pub fn add(&mut self, layer: Layer, slot: usize) {
        let kernel = adding(self.gpu);
        let mut recording = self.gpu.record();
        let stub = stub_buffer(&mut recording);
        let group = self.bind(
            kernel,
            layer.rgb.buffer().as_entire_binding(),
            layer.weight.as_entire_binding(),
            self.lowpass[slot].as_entire_binding(),
            stub.as_entire_binding(),
        );
        recording.holding(layer.rgb.buffer());
        recording.holding(&layer.weight);
        recording.holding(&self.lowpass[slot]);
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(self.pixels);
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
        self.added += 1;
        // Dropped before the next source is decoded, as `Blending::add` does: the submission holds
        // what it reads, so the handle going here is the allocation coming back.
        drop(recording);
        let Layer { rgb, weight } = layer;
        drop(weight);
        rgb.reclaim();
    }

    /// The two accumulators as the picture they add up to.
    pub fn resolve(self) -> Resident {
        let kernel = resolving(self.gpu);
        let mut recording = self.gpu.record();
        let stub = stub_buffer(&mut recording);
        let group = self.bind(
            kernel,
            stub.as_entire_binding(),
            stub.as_entire_binding(),
            stub.as_entire_binding(),
            self.out.buffer().as_entire_binding(),
        );
        recording.holding(self.out.buffer());
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(self.pixels.div_ceil(2));
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
        drop(recording);
        self.out
    }

    fn bind(
        &self,
        kernel: &crate::hdr_fit::Kernel,
        layer: wgpu::BindingResource<'_>,
        weight: wgpu::BindingResource<'_>,
        lowpass: wgpu::BindingResource<'_>,
        out: wgpu::BindingResource<'_>,
    ) -> wgpu::BindGroup {
        self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("assembly blend"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: layer,
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: weight,
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: self.width.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: lowpass,
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: self.accumulator.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: out,
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: self.base.light_of_code().as_entire_binding(),
                },
            ],
        })
    }
}

/// Somewhere for a binding this pass does not use to point: the layout names all eight either way.
fn stub_buffer(recording: &mut gpu::Recording<'_>) -> gpu::Buffer {
    recording.buffer(&wgpu::BufferDescriptor {
        label: Some("assembly blend stub"),
        size: 4,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    })
}

#[cfg(test)]
mod tests {
    /// The sentinel a `static const` in the shader is folded into its use sites, so the source is
    /// what a test reads (`CLAUDE.md`). Two shaders agree on it, each held to the `.slang` rather
    /// than to the other.
    #[test]
    fn the_unreached_sentinel_matches_the_shader() {
        let source = include_str!("../../../slang/assembly_blend.slang");
        let line = source
            .lines()
            .find(|l| l.contains("const float NOT_REACHED ="))
            .expect("NOT_REACHED is declared in assembly_blend.slang");
        assert!(line.contains("-1e30"), "the shader reads `{line}`");
        assert_eq!(super::NOT_REACHED, -1e30);
    }
}
