//! One rectangle of a composite's canvas, gathered source by source.
//!
//! **A window is the unit of work, and that is the whole memory argument.** Ten 61MP frames are
//! 3.6GB of samples and a 400MP canvas is another 2.4GB, none of which anything here holds: a
//! window asks each source for the region it actually reaches, gathers it into the window's own
//! grid, and drops that region before the next source is decoded.

use crate::composition::{Composition, Projection, SourceSpec};
use crate::px::{Drawn, Rect, Size};
use crate::resident::Resident;

/// How a canvas coordinate reaches a source's own pixels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Through {
    /// A finished picture - a JPEG, a PNG - whose geometry *is* the corrected one the recipe is
    /// stated in, so the pinhole coordinate is the pixel.
    Corrected,
    /// A RAW, which the recipe reaches by carrying on through the lens's ratio table, exactly as
    /// `warp.slang` maps a corrected pixel back to the sensor.
    Lens,
}

/// One source of a panorama and as much of it as has been decoded.
pub struct Gathered<'a> {
    pub source: &'a SourceSpec,
    /// The prepared region, which is what the taps read.
    pub prepared: &'a Resident,
    /// The whole frame that region was cut from, at the scale it was decoded at.
    pub full: Size<Drawn>,
    pub region: Rect<Drawn>,
    pub through: Through,
}

/// One source, in a window's own grid, with how much of it to take where.
pub struct Layer {
    pub rgb: Resident,
    /// One float an output pixel: the feather, and zero where this source does not reach.
    pub weight: crate::gpu::Buffer,
}

impl Layer {
    /// Ten bytes an output pixel, given back the moment the blend has read them.
    fn reclaim(self) {
        let Layer { rgb, weight } = self;
        drop(weight);
        rgb.reclaim();
    }
}

fn gather_kernel(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "composite_gather"))
}

fn probe_kernel(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "composite_probe"))
}

fn built(gpu: &'static crate::gpu::Gpu, entry: &str) -> crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_gather.wgsl")),
        &[
            (0, UNIFORM),
            (1, READ),
            (2, WRITE),
            (3, READ),
            (4, READ),
            (5, WRITE),
            (6, WRITE),
            (7, READ),
            (8, READ),
            (9, READ),
        ],
        &[],
    )
}

/// `composite_gather.slang`'s `numthreads`.
const GROUP: usize = 64;

/// What the shader's `projection` field means, and the one place the two orderings are tied.
fn projection_code(projection: Projection) -> u32 {
    match projection {
        Projection::Rectilinear => 0,
        Projection::Cylindrical => 1,
        Projection::Equirectangular => 2,
    }
}

fn through_code(through: Through) -> u32 {
    match through {
        Through::Corrected => 0,
        Through::Lens => 1,
    }
}

/// Where a layer's weight comes from, as `composite_gather.slang`'s `weighting` names it.
#[derive(Clone, Copy)]
pub enum Weighed<'a> {
    /// How deep inside its own frame each pixel sits: a panorama's.
    Feather,
    /// §5.2's field: an assembly's.
    Masked(Masked<'a>),
    /// One wherever the source reaches, which leaves the weighing to the blend: an exposure
    /// bracket's ([`Merit`]).
    Flat,
}

impl Weighed<'_> {
    /// `(weighting, stride, slot)` for the uniform block.
    fn code(&self) -> (u32, u32, u32) {
        match self {
            Weighed::Feather => (0, 0, 0),
            Weighed::Masked(held) => (1, held.stride, held.slot),
            Weighed::Flat => (2, 0, 0),
        }
    }

    fn masked(&self) -> Option<Masked<'_>> {
        match self {
            Weighed::Masked(held) => Some(*held),
            _ => None,
        }
    }
}

/// The uniform block, as `composite_gather.slang` declares it.
///
/// The geometry rather than a [`Gathered`], so `wgsl_layout.rs` can ask what length this writes
/// without a device: a `Gathered` also carries the decoded region the taps read, which is a
/// `Resident` and so a buffer.
#[allow(clippy::too_many_arguments)]
fn params(
    source_at: &SourceSpec,
    full: Size<Drawn>,
    region: Rect<Drawn>,
    through: Through,
    weighed: (u32, u32, u32),
    p: &Composition,
    window: Rect<crate::px::Composite>,
    scale: f64,
) -> Vec<u8> {
    let (left, top, width, height) = window.raw();
    let (region_left, region_top, region_w, region_h) = region.raw();
    let (full_w, full_h) = full.raw();
    let (source_w, source_h) = (source_at.size[0] as f64, source_at.size[1] as f64);
    let shrink = full_w as f64 / source_w;
    let half2 = (source_w / 2.0).powi(2) + (source_h / 2.0).powi(2);

    let mut bytes: Vec<u8> = Vec::with_capacity(96);
    for word in [
        width as u32,
        height as u32,
        region_w as u32,
        region_h as u32,
    ] {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    for value in [
        // Relative to the projection's centre, in `f64`: a wide canvas and an `f32` would lose the
        // fraction of a pixel the whole mapping is being pinned to.
        left as f64 * scale - p.centre[0],
        top as f64 * scale - p.centre[1],
        full_w as f64 / 2.0 - 0.5,
        full_h as f64 / 2.0 - 0.5,
        region_left as f64,
        region_top as f64,
        (region_w - 1) as f64,
        (region_h - 1) as f64,
        source_at.rotation[0],
        source_at.rotation[1],
        source_at.rotation[2],
        source_at.rotation[3],
        scale,
        p.radians_per_pixel,
        source_at.focal,
        shrink,
        1.0 / half2,
    ] {
        bytes.extend_from_slice(&(value as f32).to_le_bytes());
    }
    let (weighting, stride, slot) = weighed;
    for word in [
        projection_code(p.projection),
        through_code(through),
        weighting,
        stride,
        slot,
    ] {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    for value in [source_w / 2.0, source_h / 2.0] {
        bytes.extend_from_slice(&(value as f32).to_le_bytes());
    }
    // §3.7a's warp, carried into the frame the shader's `canvas` is already in - relative to the
    // projection's centre. `warp` is stated in absolute canvas pixels, and `q = p - centre`, so
    // `M*p + b - centre` is `M*q + (M*centre + b - centre)` and the shader needs no centre of its
    // own. The identity gives a translation of exactly zero, which is what every panorama writes.
    let [a, b, c, d, tx, ty] = source_at.warp;
    let (cx, cy) = (p.centre[0], p.centre[1]);
    for value in [
        a,
        b,
        c,
        d,
        a * cx + b * cy + tx - cx,
        c * cx + d * cy + ty - cy,
    ] {
        bytes.extend_from_slice(&(value as f32).to_le_bytes());
    }
    // std140 rounds a block out to a multiple of sixteen, and the binding is sized by the shader's
    // idea of it rather than by what was written.
    bytes.resize(bytes.len().next_multiple_of(16), 0);
    bytes
}

/// The block's size, for `wgsl_layout.rs` to hold against the shader's own. Nothing above branches
/// on a value, so any source's geometry writes the same run of words.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    let spec = Composition::of_one([64, 64], crate::composition::LensSpec::none());
    params(
        &spec.sources[0],
        Size::exact(64, 64),
        Rect::exact(0, 0, 64, 64),
        Through::Corrected,
        Weighed::Feather.code(),
        &spec,
        Rect::exact(0, 0, 64, 64),
        1.0,
    )
    .len()
}

/// The three tables the gather reads for a source, or a stub where it reads none.
fn tables(
    recording: &mut crate::gpu::Recording<'_>,
    from: &Gathered<'_>,
) -> (crate::gpu::Buffer, crate::gpu::Buffer) {
    let lens = match from.through {
        Through::Corrected => crate::fit::Lens::none(),
        Through::Lens => from.source.lens.to_lens(),
    };
    (
        crate::base::float_storage(recording, "pano ratios", &crate::base::ratio_tables(&lens)),
        crate::base::float_storage(
            recording,
            "pano lifts",
            &crate::base::lift_table(lens.falloff),
        ),
    )
}

/// What one source of an assembly reads out of §5.2's fields.
#[derive(Clone, Copy)]
pub struct Masked<'a> {
    /// The signed distance field, and the per-pixel tile index beside it.
    pub signed: &'a crate::gpu::Buffer,
    pub tile_of: &'a crate::gpu::Buffer,
    /// Every tile's §3.7a correction, which the index above picks from.
    pub warps: &'a crate::gpu::Buffer,
    pub stride: u32,
    pub slot: u32,
}

/// One source, read into `window` of the canvas at `scale` canvas pixels an output pixel.
///
/// No exposure gain of the *source's*: that rides its coding white, so a layer arrives already at
/// the brightness its neighbours meet it at. A tile's own correction cannot, being per pixel rather
/// than per source, so §3.7a's gain is applied in the gather beside §3.7a's warp.
///
/// `Masked`, the weight is read from §5.2's field rather than computed as a feather, and the warp is
/// the owning tile's rather than the source's.
pub fn gather_layer(
    gpu: &'static crate::gpu::Gpu,
    from: &Gathered<'_>,
    p: &Composition,
    window: Rect<crate::px::Composite>,
    scale: f64,
    weighed: Weighed<'_>,
) -> Layer {
    let mask = weighed.masked();
    let (_, _, width, height) = window.raw();
    let pixels = width * height;
    let rgb = Resident::empty(gpu, width, height);

    let mut recording = gpu.record();
    recording.holding(from.prepared.buffer());
    recording.holding(rgb.buffer());
    let weight = gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some("pano weight"),
        size: (pixels.max(1) * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    recording.holding(&weight);
    let (ratios, lifts) = tables(&mut recording, from);
    let probe = stub_buffer(&mut recording);
    // Its own stub rather than the probe's: a dispatch may not see one buffer as both a read and a
    // write, and the probe's is bound for writing.
    let no_mask = stub_buffer(&mut recording);
    let no_warps = stub_of(&mut recording, WARP_BYTES);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano gather params"),
        contents: &params(
            from.source,
            from.full,
            from.region,
            from.through,
            weighed.code(),
            p,
            window,
            scale,
        ),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let mask_buffer = mask.map_or(&no_mask, |held| held.signed);
    let tile_of = mask.map_or(&no_mask, |held| held.tile_of);
    let warps = mask.map_or(&no_warps, |held| held.warps);
    recording.holding(mask_buffer);
    recording.holding(tile_of);
    recording.holding(warps);

    let kernel = gather_kernel(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pano gather"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: from.prepared.buffer().as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: rgb.buffer().as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ratios.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: lifts.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: weight.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: probe.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: mask_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 8,
                resource: tile_of.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 9,
                resource: warps.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = crate::base::groups(pixels.div_ceil(2));
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.submit();

    Layer { rgb, weight }
}

fn blend_kernel(gpu: &'static crate::gpu::Gpu, entry: &str) -> crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_blend.wgsl")),
        &[
            (0, UNIFORM),
            (1, READ),
            (2, READ),
            (3, WRITE),
            (4, WRITE),
            (5, WRITE),
            (6, READ),
            (7, WRITE),
        ],
        &[],
    )
}

fn adding(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| blend_kernel(gpu, "composite_add"))
}

fn sharpness(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "composite_sharpness",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_sharpness.wgsl")),
            &[(0, UNIFORM), (1, READ), (2, WRITE), (3, READ)],
            &[],
        )
    })
}

/// A focus bracket's layer weighed by how sharp it is (`Weight::Sharpness`), over the reach its
/// gather wrote.
fn weigh_sharpness(
    gpu: &'static crate::gpu::Gpu,
    base: &'static crate::base::Base,
    layer: &Layer,
    (width, height): (usize, usize),
) {
    let kernel = sharpness(gpu);
    let mut recording = gpu.record();
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano sharpness params"),
        contents: &sharpness_params(width, height),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    recording.holding(layer.rgb.buffer());
    recording.holding(&layer.weight);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pano sharpness"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: layer.rgb.buffer().as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: layer.weight.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: base.light_of_code().as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        let (x, y) = crate::base::groups(width * height);
        pass.dispatch_workgroups(x, y, 1);
    }
    recording.submit();
}

/// `composite_sharpness.slang`'s block, padded to std140's own multiple of sixteen.
fn sharpness_params(width: usize, height: usize) -> Vec<u8> {
    let mut block = (width as u32).to_le_bytes().to_vec();
    block.extend_from_slice(&(height as u32).to_le_bytes());
    block.resize(16, 0);
    block
}

#[cfg(test)]
pub(crate) fn sharpness_block() -> usize {
    sharpness_params(1, 1).len()
}

fn resolving(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| blend_kernel(gpu, "composite_resolve"))
}

/// The layers of a window as one picture, and where anything covered it.
///
/// A layer is a dispatch into an accumulator, so the number of sources is not a number the shader
/// knows: see `composite_blend.slang`.
///
/// **One layer resident at a time, never one per source.** A layer is the window at ten bytes a
/// pixel - six for its coded RGB, four for the weight beside it - so what a window costs does not
/// depend on how many photographs reach it. That is what the strips cost: **every source that
/// reaches a strip is decoded for it**, and a region decode costs what the whole photograph costs -
/// 60ms measured, against the 2ms its pixels then take to gather - so a canvas taken in five times
/// as many strips is decoded five times over. A twenty-six frame pan of a 33804x9376 canvas
/// rendered at 16384 took 180 rows a strip, and so twenty-six strips of 676 decodes; it takes 910
/// rows and five, at 130.
///
/// Order is unchanged and so is the arithmetic: the adds are the same passes over the same
/// accumulator in the same sequence, submitted one at a time rather than recorded together, and
/// submissions to one queue run in the order they were made.
pub struct Blending {
    gpu: &'static crate::gpu::Gpu,
    base: &'static crate::base::Base,
    out: Resident,
    alpha: crate::gpu::Buffer,
    accumulator: crate::gpu::Buffer,
    uniform: crate::gpu::Buffer,
    /// The anchoring layer's luma a pixel, for the ones compared against it (`Merit::ghost`).
    anchor: crate::gpu::Buffer,
    pixels: usize,
    added: usize,
}

/// `composite_blend.slang`'s mark for a pixel no anchoring layer could vouch for.
const UNANCHORED: f32 = -1.0;

impl Blending {
    pub fn over(
        gpu: &'static crate::gpu::Gpu,
        base: &'static crate::base::Base,
        window: Rect<crate::px::Composite>,
    ) -> Blending {
        let (_, _, width, height) = window.raw();
        let pixels = width * height;
        let alpha = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("pano alpha"),
            size: (pixels.max(1) * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let accumulator = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pano accumulator"),
            contents: &vec![0u8; pixels.max(1) * 16],
            usage: wgpu::BufferUsages::STORAGE,
        });
        let uniform = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pano blend params"),
            contents: &blend_params(pixels, Merit::EVEN),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let anchor = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("pano anchor"),
            contents: bytemuck::cast_slice(&vec![UNANCHORED; pixels.max(1)]),
            usage: wgpu::BufferUsages::STORAGE,
        });
        Blending {
            gpu,
            base,
            out: Resident::empty(gpu, width, height),
            alpha,
            accumulator,
            uniform,
            anchor,
            pixels,
            added: 0,
        }
    }

    /// Whether any source has reached this window at all.
    pub fn is_empty(&self) -> bool {
        self.added == 0
    }

    /// Adds one source's layer, and gives its ten bytes a pixel back.
    pub fn add(&mut self, layer: Layer) {
        self.add_merited(layer, Merit::EVEN);
    }

    /// [`Blending::add`], with the layer's own weight scaled by what it is worth (`Merit`).
    pub fn add_merited(&mut self, layer: Layer, merit: Merit) {
        let kernel = adding(self.gpu);
        let mut recording = self.gpu.record();
        let stub = stub_buffer(&mut recording);
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("pano add params"),
            contents: &blend_params(self.pixels, merit),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = self.bind_with(
            kernel,
            &uniform,
            layer.rgb.buffer().as_entire_binding(),
            layer.weight.as_entire_binding(),
            stub.as_entire_binding(),
            stub.as_entire_binding(),
        );
        recording.holding(layer.rgb.buffer());
        recording.holding(&layer.weight);
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(self.pixels);
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
        self.added += 1;
        // Dropped before the next source is decoded, which is the whole memory argument: the
        // submission holds what it reads, so the handle going here is the allocation coming back.
        drop(recording);
        layer.reclaim();
    }

    /// The accumulator as the picture it adds up to, and where anything covered it.
    pub fn resolve(self) -> (Resident, crate::gpu::Buffer) {
        let kernel = resolving(self.gpu);
        let mut recording = self.gpu.record();
        let stub = stub_buffer(&mut recording);
        let group = self.bind(
            kernel,
            stub.as_entire_binding(),
            stub.as_entire_binding(),
            self.out.buffer().as_entire_binding(),
            self.alpha.as_entire_binding(),
        );
        recording.holding(self.out.buffer());
        recording.holding(&self.alpha);
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(self.pixels.div_ceil(2));
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
        drop(recording);
        (self.out, self.alpha)
    }

    fn bind(
        &self,
        kernel: &crate::hdr_fit::Kernel,
        layer: wgpu::BindingResource<'_>,
        weight: wgpu::BindingResource<'_>,
        out: wgpu::BindingResource<'_>,
        alpha: wgpu::BindingResource<'_>,
    ) -> wgpu::BindGroup {
        self.bind_with(kernel, &self.uniform, layer, weight, out, alpha)
    }

    fn bind_with(
        &self,
        kernel: &crate::hdr_fit::Kernel,
        uniform: &crate::gpu::Buffer,
        layer: wgpu::BindingResource<'_>,
        weight: wgpu::BindingResource<'_>,
        out: wgpu::BindingResource<'_>,
        alpha: wgpu::BindingResource<'_>,
    ) -> wgpu::BindGroup {
        self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pano blend"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
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
                    resource: self.accumulator.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: out,
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: alpha,
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: self.base.light_of_code().as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: self.anchor.as_entire_binding(),
                },
            ],
        })
    }
}

/// What one layer of an exposure bracket is worth against the others, beside the weight its gather
/// wrote.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Merit {
    /// A multiplier on the whole layer: the light it gathered, so a longer exposure outweighs a
    /// shorter one wherever both are sound, which is the lower-noise average.
    pub scale: f32,
    /// Where the layer clips, in `Base::light_of_code`'s units; its weight rolls off to nothing on
    /// the way there. Zero for a layer that is never rolled off - the shortest exposure, so a
    /// highlight every frame clipped is still something rather than black.
    pub clip: f32,
    /// How far this layer's light may stray from the anchor's before it counts for nothing, which is
    /// the scene having moved between the frames. Zero compares nothing.
    pub ghost: crate::light::Stops,
    /// Whether this layer is the anchor the later ones are compared against, which has to be added
    /// first.
    pub anchors: bool,
}

impl Merit {
    /// Every layer alike: a panorama's and an assembly's.
    pub const EVEN: Merit = Merit {
        scale: 1.0,
        clip: 0.0,
        ghost: crate::light::Stops::ZERO,
        anchors: false,
    };
}

/// `composite_blend.slang`'s block, padded to std140's own multiple of sixteen.
fn blend_params(pixels: usize, merit: Merit) -> Vec<u8> {
    let mut block = (pixels as u32).to_le_bytes().to_vec();
    block.extend_from_slice(&merit.scale.to_le_bytes());
    block.extend_from_slice(&merit.clip.to_le_bytes());
    block.extend_from_slice(&(merit.ghost.raw() as f32).to_le_bytes());
    block.extend_from_slice(&u32::from(merit.anchors).to_le_bytes());
    block.resize(block.len().next_multiple_of(16), 0);
    block
}

#[cfg(test)]
pub(crate) fn blend_block() -> usize {
    blend_params(1, Merit::EVEN).len()
}

/// Somewhere for a binding this pass does not use to point: the layout names all six either way.
fn stub_buffer(recording: &mut crate::gpu::Recording<'_>) -> crate::gpu::Buffer {
    stub_of(recording, 4)
}

/// A binding nothing reads still has to be at least one element of what the shader declares it as,
/// so the warp table's stub is a whole `TileWarp` where the rest are a word.
fn stub_of(recording: &mut crate::gpu::Recording<'_>, size: u64) -> crate::gpu::Buffer {
    recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano stub"),
        size,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    })
}

/// `TileWarp`'s size in `composite_gather.slang`, which a stub for its binding has to match.
const WARP_BYTES: u64 = std::mem::size_of::<crate::assembly_weight::TileWarp>() as u64;

/// Where a source's file is and what has been measured about it, in the recipe's own order.
#[derive(Clone, Copy)]
pub struct SourceFile<'a> {
    pub path: &'a str,
    pub analysis: Option<&'a crate::photo_analysis::PhotoAnalysis>,
}

/// Which picture of each source a window is composited from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum From {
    /// The source itself, region-decoded to what the window needs. What an export is.
    Original,
    /// The camera's own JPEG, whole, at the smallest scale that covers the window.
    ///
    /// **Seconds rather than a minute, and it needs no second alignment.** The recipe is stated in
    /// the camera's corrected geometry - the previews it was solved from *are* these JPEGs - so
    /// the same rotations and the same canvas reach a JPEG by stopping at the pinhole, where a RAW
    /// carries on through its lens's ratio table. What differs is only how many pixels there are,
    /// which is the gather's `shrink`.
    Camera,
}

/// `composite_gather.slang`'s `NOT_REACHED`, pinned against it by
/// [`tests::the_unreached_sentinel_matches_the_shader`]: what a masked weight reads where the
/// source's own frame does not cover the output pixel.
pub const NOT_REACHED: f32 = -1e30;

/// Where a source's weight is read from rather than computed (§5.2).
#[derive(Clone, Copy)]
pub struct Mask<'a> {
    /// One f32 an output pixel a slot, slot-minor: `assembly_weight::Weights::signed`.
    pub signed: &'a crate::gpu::Buffer,
    /// `assembly_weight::Weights::tile_of` and the table it indexes.
    pub tile_of: &'a crate::gpu::Buffer,
    pub warps: &'a crate::gpu::Buffer,
    /// The same warps the device reads, in canvas pixels about the canvas origin, and which slot
    /// each tile belongs to. Read by [`footprint`], which has to decode whatever any of this
    /// source's tiles will ask it for.
    pub tile_warps: &'a [[f64; 6]],
    pub tile_slot: &'a [u32],
    pub slots: usize,
    /// Which slot each source of the recipe occupies, `None` for one no tile and not the base
    /// uses - which is a source the window skips entirely rather than gathers at weight zero.
    pub slot_of: &'a [Option<u32>],
}

/// One rectangle of a panorama, and everything the grade behind it will want.
#[derive(Clone)]
pub struct CompositeRequest<'a> {
    /// The rectangle to produce, **in this render's own pixels**: the canvas divided by `scale`,
    /// origin and size alike. Whole numbers either way, so a strip of an export is a strip of
    /// rows rather than a fraction of a canvas pixel.
    pub window: Rect<crate::px::Composite>,
    /// The parts of `window` a caller actually asked for, or empty for the whole of it.
    ///
    /// **What a source is decoded for, where `window` is only what the buffer is.** A reader
    /// panning diagonally is short of an L of tiles, and the box bounding an L holds a corner
    /// nobody asked about - which widens every source's footprint to reach it and can pull in a
    /// source that no requested tile touches at all. Listed, so each source is decoded for the box
    /// bounding *its own* requested tiles and a source none of them reach is skipped.
    ///
    /// The gather still writes the whole of `window` from what that bought, since the pixels are
    /// already decoded and a pass over them costs a fiftieth of the decode. What lands in the
    /// corner is whatever the sources reached with the regions the parts paid for, so a caller
    /// keeps the parts it asked for and discards the rest (`wasm::HeldRaw::keep_tiles`).
    pub parts: &'a [Rect<crate::px::Composite>],
    /// Canvas pixels per output pixel: 1 for a loupe tile, more for a rendition.
    pub scale: f64,
    pub white_quantile: f64,
    /// The whole panorama's diffuse white and scene peak, which every source is coded against.
    ///
    /// **Handed in, never measured here.** A window measuring its own is the failure `tile.rs`
    /// names for a loupe and it is worse for a panorama: a render is assembled from strips, so a
    /// strip of sky and a strip of headland would be coded against different whites and the seam
    /// between them is a band across the finished picture. Absent only where the caller has no way
    /// to know, and then the reference's own strip measures for all of them.
    pub levels: Option<crate::tone::Anchored>,
    pub reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    pub strengths: crate::image::Strengths,
    pub detail: crate::galosh::Detail,
    pub sources: &'a [SourceFile<'a>],
    pub from: From,
    pub weight: Weight<'a>,
}

/// How the sources that reach a window are weighed against each other.
#[derive(Clone, Copy)]
pub enum Weight<'a> {
    /// A panorama's: the gather's own feather.
    Feather,
    /// An assembly's: §5.2's field.
    Mask(Mask<'a>),
    /// An exposure bracket's: every source wherever it reaches, by the light it gathered, rolled
    /// off before it clips ([`Merit`]).
    Exposure,
    /// A focus bracket's: every source wherever it reaches, by how sharp it is there
    /// (`composite_sharpness.slang`). Reads its neighbours, so a caller wanting a window that
    /// matches the next one gathers [`SHARPNESS_HALO`] past it.
    Sharpness,
}

/// How far `composite_sharpness.slang` reads past a pixel, rounded up to keep a window even.
pub const SHARPNESS_HALO: usize = 4;

impl<'a> Weight<'a> {
    pub fn mask(&self) -> Option<Mask<'a>> {
        match self {
            Weight::Mask(held) => Some(*held),
            _ => None,
        }
    }
}

/// How far outside its footprint a source is decoded, **in the decoded frame's own pixels**, for
/// the gather's four-tap stencil to have neighbours at the edge of the window.
///
/// Three, where Catmull-Rom reads two either side of the pixel it lands between: one spare for the
/// ratio table's own stretch, which moves where a channel lands by a fraction of a pixel at the
/// corners.
const MARGIN: usize = 3;

/// How finely the window is walked to find what of a source it covers. The map is smooth, so the
/// extremes of the region are found on any grid that is not coarser than the picture's curvature.
const FOOTPRINT_STEP: usize = 8;

/// The whole picture's diffuse white and peak, from what has been measured about every source.
///
/// **A panorama's exposure is the panorama's, not one frame's.** Every source is coded against one
/// white - that is what makes them one picture rather than a strip of separately-graded ones - but
/// taking it from the reference alone means the whole canvas is exposed as though it were that
/// frame. Measured on a twenty-six frame pan whose reference is its dark tree-heavy left end,
/// against a normal render of the same band of the same photograph: 1.5x the light, with the
/// highlights sitting at 0.94 where the render leaves them at 0.69, which is a sky with its
/// modelling flattened out of it.
///
/// Each source's own measurement is of its own light, and `SourceSpec::gain` is what carries that
/// light onto the reference's scale - so a source's estimate of the shared white is its white times
/// its gain, and where the gains are right those estimates agree and this is just their mean. What
/// they disagree about is content: a frame of sky reads a higher white than a frame of trees, and
/// the mean over the set is the average the whole canvas actually has.
///
/// The peak takes the largest rather than the mean, because it is what the roll-off has to reach:
/// a peak set below the brightest frame's clips that frame instead of compressing it.
///
/// **A source whose stored levels this build cannot use drops out of the average rather than
/// being measured.** That is only right because the caller has measured already: `composite_job::base`
/// fills `levels` for the whole canvas before it reaches a tile, so what arrives here has either
/// been through `whole_levels` - which decodes a source rather than skipping it - or is a set of
/// sources with no analysis at all, where the filter discriminates against nobody. Reach this with
/// a partly-analysed set and the anchor is the average of whichever subset happened to be readable,
/// which is a canvas exposed by an accident of what was cached.
fn whole_anchor(
    spec: &Composition,
    request: &CompositeRequest<'_>,
) -> Option<crate::tone::Anchored> {
    let measured: Vec<crate::tone::Levels> = spec
        .sources
        .iter()
        .zip(request.sources)
        .filter_map(|(source, file)| {
            let levels = file
                .analysis
                .and_then(|a| a.from_render.levels)
                .and_then(|m| m.levels_at(request.white_quantile))?;
            Some(crate::tone::Levels {
                white: crate::light::Light::measured(levels.white.raw() * source.gain),
                peak: crate::light::Light::measured(levels.peak.raw() * source.gain),
                floor: levels
                    .floor
                    .map(|f| crate::light::Light::measured(f.raw() * source.gain)),
            })
        })
        .collect();
    combined(&measured)
}

/// Where among the sources' own whites the canvas's own sits.
///
/// **Not their mean, because what is wanted is a quantile of the whole picture and a mean is not
/// one.** Diffuse white is the level a tenth of the picture is brighter than; over a canvas that is
/// largely sky, that level sits inside the sky's own distribution, which is near the *bright*
/// frames' whites rather than halfway between them and the dark ones. Averaging drags it down by
/// however much dark frame the pan happens to include, and every bright frame is then lifted into
/// its own highlights - measured on the twenty-six frame pan, the cloud that started this came out
/// with the sunlit warmth spread across its whole body instead of on its rim, against the same
/// cloud in a render of the frame it came from and in the camera's own JPEG, which agree.
///
/// Measured on that cloud against the render of its own frame, whose chromaticity is r 0.405 /
/// b 0.263: the mean gives r 0.351 / b 0.315, three quarters gives 0.374 / 0.291, this gives
/// 0.383 / 0.279 and the brightest frame outright gives 0.387 / 0.275. High rather than highest,
/// because one frame shot into the sun should not set the exposure for the whole canvas, and the
/// two are within 0.004 of each other here. The dark end does not pay for it - the trees at the
/// left move from 0.0125 to 0.0120 of light between them, which is nothing.
const ANCHOR_AMONG: f64 = 0.9;

/// Where among the sources' own peaks the canvas's own sits.
///
/// **The largest, and measured rather than assumed - lowering it is what flattens a highlight.**
/// The peak is where the roll-off ends, so raising it gives the compression more room and leaves
/// the top of the range less squeezed: measured on the cloud that started this, against a render of
/// the frame it came from at chromaticity r 0.405 / b 0.263, taking the largest gives 0.383 / 0.279
/// where the middle of them gives 0.357 / 0.306. A peak below what a frame holds does not protect
/// that frame, it crushes it.
const PEAK_AMONG: f64 = 1.0;

/// Those quantiles of the sources' whites and peaks, or None where none of them measured anything.
pub(crate) fn combined(measured: &[crate::tone::Levels]) -> Option<crate::tone::Anchored> {
    if measured.is_empty() {
        return None;
    }
    let mut whites: Vec<f64> = measured.iter().map(|l| l.white.raw()).collect();
    whites.sort_by(f64::total_cmp);
    let share = std::env::var("PANO_ANCHOR_Q")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(ANCHOR_AMONG);
    let at = ((whites.len() - 1) as f64 * share.clamp(0.0, 1.0)).round() as usize;
    let white = whites[at];
    let mut peaks: Vec<f64> = measured.iter().map(|l| l.peak.raw()).collect();
    peaks.sort_by(f64::total_cmp);
    let peak_share = std::env::var("PANO_PEAK_Q")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(PEAK_AMONG);
    let peak = peaks[((peaks.len() - 1) as f64 * peak_share.clamp(0.0, 1.0)).round() as usize];
    Some(
        crate::tone::Levels {
            white: crate::light::Light::measured(white),
            // A peak below the white it is anchored on is not a roll-off, it is a clip.
            peak: crate::light::Light::measured(peak.max(white)),
            // The lowest, for the reason the peak takes the largest: the canvas's bottom is the
            // bottom of the darkest thing on it, and a floor above that leaves Blacks unable to
            // reach the frame that has the shadows in it.
            floor: measured
                .iter()
                .filter_map(|l| l.floor)
                .reduce(|lowest, floor| lowest.min(floor)),
        }
        .anchored(),
    )
}

/// One rectangle of the canvas, decoded source by source and composited.
///
/// **One source's region is resident at a time.** Each is decoded, coded, gathered into the
/// window's own grid and then dropped, so a ten-frame panorama costs one region rather than ten -
/// which is what lets a 400MP canvas be exported by a process that never holds one.
pub async fn prepared(
    spec: &Composition,
    request: &CompositeRequest<'_>,
) -> Result<(Resident, crate::tile::Prepared), String> {
    prepared_with(spec, request, &[]).await
}

/// [`prepared`] over one source whose RAW is a sensor-shift burst: `burst` is every frame of it, in
/// its own order, and the source's own path is the first.
pub async fn shifted(
    spec: &Composition,
    request: &CompositeRequest<'_>,
    burst: &[&str],
) -> Result<(Resident, crate::tile::Prepared), String> {
    if spec.sources.len() != 1 {
        return Err("a pixel shift is rendered as its reference frame".into());
    }
    prepared_with(spec, request, burst).await
}

async fn prepared_with(
    spec: &Composition,
    request: &CompositeRequest<'_>,
    burst: &[&str],
) -> Result<(Resident, crate::tile::Prepared), String> {
    let refused = || crate::base::without_a_device("the coding, the lens gather and the composite");
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;
    if spec.sources.len() != request.sources.len() {
        return Err("the recipe and the files it is being rendered from disagree".into());
    }
    let (left, top, width, height) = request.window.raw();

    let mut levels: Option<crate::tone::Anchored> =
        request.levels.or_else(|| whole_anchor(spec, request));
    let mut as_shot = None;
    let mut defocus = (0.0, 0.0);
    let mut wb_gains = None;

    let mut lap = crate::clock::laps("    pano source ");
    let mut blending = Blending::over(gpu, base, request.window);
    // The largest gain is the shortest exposure, which is never rolled off: see `Merit::clip`.
    let shortest = spec.sources.iter().map(|source| source.gain).fold(0.0, f64::max);
    for i in order_of(spec) {
        let Some(taken) = taken(gpu, base, spec, request, i, levels, burst, &mut lap).await? else {
            continue;
        };
        levels = Some(taken.levels);
        if i == spec.reference {
            as_shot = taken.as_shot;
            // The frame a composite is graded as, so the balance it files is this one's.
            wb_gains = Some(taken.wb_gains);
            defocus = taken.defocus;
        }
        let merit = match request.weight {
            Weight::Exposure => merit_of(
                &spec.sources[i],
                shortest,
                taken.neutral_ceiling,
                &taken.levels,
                request.reference_white_nits,
                // First of the layers, by `order_of`.
                i == spec.reference,
            ),
            Weight::Feather | Weight::Mask(_) | Weight::Sharpness => Merit::EVEN,
        };
        if let Weight::Sharpness = request.weight {
            weigh_sharpness(gpu, base, &taken.layer, (width, height));
        }
        blending.add_merited(taken.layer, merit);
    }

    if blending.is_empty() {
        return Err("no source of this composite covers that window".into());
    }
    let anchored = levels.ok_or("the reference does not reach this window")?;
    let (composite, alpha) = blending.resolve();
    drop(alpha);

    let canvas = |value: usize| ((value as f64) / request.scale).round() as usize;
    Ok((
        composite,
        crate::tile::Prepared {
            samples: Vec::new(),
            width,
            height,
            keep: [0, 0, width, height],
            levels: anchored,
            // **Never for the cameras' own pictures.** A match is how a render of a *RAW* is brought to
            // the colour the body would have printed, and these frames are what the body printed - so
            // applying one renders a finished picture as though it were a mosaic, through curves fitted
            // to a photograph that is only one of the sources. Measured on the twenty-six frame pan,
            // whose reference happened to be the one frame of its library with an analysis: over the
            // pixels one source covers, the tile read 0.27 where that source's own JPEG reads 0.55.
            matched: match request.from {
                From::Camera => None,
                From::Original => request.sources[spec.reference]
                    .analysis
                    .and_then(|a| a.from_raw.matched.clone()),
            },
            as_shot,
            wb_gains,
            photograph: (canvas(spec.canvas[0]), canvas(spec.canvas[1])),
            origin: (left, top),
            defocus,
            reference_nits: request.reference_white_nits,
        },
    ))
}

/// The reference first, for the case `whole_anchor` could not answer: nothing has been measured
/// about these sources, so the anchor is taken off the reference's own region as it is decoded and
/// everything after it is coded against that. Every source is coded against one white either way,
/// which is what makes them one picture rather than a strip of separately-graded ones.
fn order_of(spec: &Composition) -> Vec<usize> {
    std::iter::once(spec.reference)
        .chain((0..spec.sources.len()).filter(|i| *i != spec.reference))
        .collect()
}

/// What one source contributed to a window, and what the composite's grade reads off whichever of
/// them was the reference.
struct Taken {
    layer: Layer,
    /// What GALOSH fitted off this source's own mosaic, for a stage measuring what the decode was.
    noise: Option<crate::galosh::NoiseFit>,
    levels: crate::tone::Anchored,
    /// The levels this source was *coded* against, which is [`levels`] divided by its own gain.
    ///
    /// [`levels`]: Taken::levels
    coded: crate::tone::Anchored,
    as_shot: Option<crate::white_balance::AsShot>,
    wb_gains: [f32; 3],
    defocus: (f32, f32),
    neutral_ceiling: f32,
}

/// One source decoded with the request's strengths and detail, coded against `anchor`, and
/// gathered through the recipe's lens onto `request.window`. None where it does not reach it.
async fn taken(
    gpu: &'static crate::gpu::Gpu,
    base: &'static crate::base::Base,
    spec: &Composition,
    request: &CompositeRequest<'_>,
    i: usize,
    anchor: Option<crate::tone::Anchored>,
    burst: &[&str],
    lap: &mut impl FnMut(&str),
) -> Result<Option<Taken>, String> {
    let refused = || crate::base::without_a_device("the coding, the lens gather and the composite");
    let source = &spec.sources[i];
    let file = &request.sources[i];
    // A source the recipe holds no slot for is one no tile and not the base uses, so the window
    // skips it outright rather than decoding a frame to gather it at no weight.
    let weighed = match &request.weight {
        Weight::Feather => Weighed::Feather,
        Weight::Exposure | Weight::Sharpness => Weighed::Flat,
        Weight::Mask(held) => match held.slot_of.get(i).copied().flatten() {
            None => return Ok(None),
            Some(slot) => Weighed::Masked(Masked {
                signed: held.signed,
                tile_of: held.tile_of,
                warps: held.warps,
                stride: held.slots as u32,
                slot,
            }),
        },
    };
    let Some(region) = footprint(spec, source, request, weighed.masked().map(|held| held.slot)) else {
        return Ok(None);
    };

    let photograph = Size::exact(source.size[0], source.size[1]);
    // At least one pixel: a window scaled down far enough rounds this to zero, and a decode of
    // no pixels reaches `Placement::oriented_rect` as an empty frame, where `frame_w - 1`
    // underflows and takes the whole render down with it.
    let wanted =
        ((photograph.raw().0.max(photograph.raw().1) as f64 / request.scale).round()).max(1.0);
    let stored = file.analysis;
    let noise = match request.from {
        // A camera's JPEG has no mosaic and so no noise fit of the photograph's to hand it.
        From::Camera => None,
        From::Original => stored.and_then(|a| a.from_raw.noise),
    };
    let (frame, full, region_at) = match request.from {
        From::Original => {
            let view = crate::view::View {
                photograph,
                window: region,
                scale: crate::view::Scale::for_long_edge(photograph.raw(), wanted as u32),
            };
            let fit = crate::galosh::wanted(noise, request.detail);
            let frame = match burst.is_empty() {
                true => {
                    crate::decode::tile_from(
                        crate::decode::Source::Path(file.path),
                        view,
                        request.detail,
                        fit,
                        crate::RENDITION_TILE_HALO,
                        // A panorama carries no reader's settings yet, and dust removal is one.
                        crate::dust::Known::Off,
                    )
                    .await
                }
                false => {
                    crate::decode::shifted_tile_from(
                        burst,
                        view,
                        request.detail,
                        fit,
                        crate::RENDITION_TILE_HALO,
                    )
                    .await
                }
            }
            .ok_or_else(|| format!("{} could not be decoded", file.path))?;
            // **What came back, not what was asked for.** A region decode answers at the scale
            // it can rather than the one the view names - the halved path wants the region on
            // its own lattice, and a region that is not gets read whole - so a caller that
            // trusted the view describes a 2000px frame while holding a 4000px one, and the
            // gather then reads the top-left quarter of every source it touches. Measured off
            // the frame instead, all three agree whatever the decoder decided.
            let came_back = frame.width as f64 / region.raw().2.max(1) as f64;
            let scaled = |value: usize| ((value as f64 * came_back).round() as usize).max(1);
            let (photo_w, photo_h) = photograph.raw();
            let (at_x, at_y) = (region.raw().0, region.raw().1);
            (
                frame,
                Size::exact(scaled(photo_w), scaled(photo_h)),
                crate::px::At::exact(scaled(at_x), scaled(at_y)),
            )
        }
        // Whole, because a JPEG has no region decode: the saving is the DCT scale it is read
        // at, which `frame_from_bytes` picks from the floor below.
        From::Camera => {
            let frame = camera_picture(file.path, wanted as u32).await?;
            let size = Size::exact(frame.width, frame.height);
            (frame, size, crate::px::At::ORIGIN)
        }
    };

    lap("decode");
    let drawn = (frame.width, frame.height);
    let resident = match frame.pixels {
        crate::frame::Pixels::Resident(resident) => resident,
        crate::frame::Pixels::Sixteen(samples) => {
            crate::resident::Resident::upload(gpu, &samples, drawn.0, drawn.1)
        }
        crate::frame::Pixels::Eight(_) => {
            return Err("a composite needs a 16-bit scene-linear decode".into());
        }
    };
    let mut levels = anchor;
    if i == spec.reference && levels.is_none() {
        levels = Some(
            crate::fit_source::levels(gpu, &resident, request.white_quantile)
                .await
                .ok_or("the reference's levels could not be measured")?
                .anchored(),
        );
    }
    let anchored = levels.ok_or("the reference does not reach this window")?;

    // **The gain lands here, in the coding.** Dividing the white a source is coded against by
    // its gain is a multiplication of its light, which is what an exposure match is - and it
    // costs nothing, where a multiply per sample downstream would be a pass over the window.
    let mine = crate::tone::Levels {
        white: crate::light::Light::measured(anchored.white.raw() / source.gain),
        peak: crate::light::Light::measured(anchored.peak.raw() / source.gain),
        floor: anchored
            .floor
            .map(|f| crate::light::Light::measured(f.raw() / source.gain)),
    }
    .anchored();
    let (coded, took_off) = crate::base::prepare(
        gpu,
        base,
        resident,
        // No lens: the recipe's own gather applies it, at the radius of the whole photograph
        // rather than of this region.
        crate::base::Gather::frame(Size::exact(drawn.0, drawn.1)),
        mine,
        request.reference_white_nits,
        // Everything but the sharpen, which belongs to the composite: sharpening each source
        // and then the picture they were blended into deconvolves the same blur twice. And
        // nothing at all for a camera's JPEG, which the camera already sharpened and
        // defringed - correcting a finished picture again is a second opinion over the first.
        match request.from {
            From::Camera => crate::image::Strengths {
                sharpen: 0.0,
                defringe: 0.0,
            },
            From::Original => request.strengths.before_the_fit(),
        },
        // Nothing to compose: the sharpen this would be the sigma for is the composite's, and
        // the strengths above zero it here on both arms.
        crate::image::SharpenSigma::fixed(crate::image::DECONVOLVE_SIGMA),
        crate::image::SharpenNoise::NONE,
        &crate::fit::Lens::none(),
        stored
            .and_then(|a| a.from_render.defocus)
            .and_then(|d| {
                d.pair_for(
                    request.strengths.defringe,
                    photograph.raw().0.max(photograph.raw().1),
                )
            })
            .map_or(crate::base::Defringe::Measure, crate::base::Defringe::Take),
        noise,
        frame.matrix,
    )
    .await
    .ok_or_else(refused)?;

    let layer = gather_layer(
        gpu,
        &Gathered {
            source,
            prepared: &coded,
            full,
            region: Rect {
                at: region_at,
                size: Size::exact(drawn.0, drawn.1),
            },
            // A camera's JPEG *is* the corrected picture, which is the geometry the recipe is
            // stated in, so there is no lens left to undo - the same reason a rendered source
            // has none.
            through: match request.from == From::Camera
                || crate::decode_rendered::is_rendered(file.path)
            {
                true => Through::Corrected,
                false => Through::Lens,
            },
        },
        spec,
        request.window,
        request.scale,
        weighed,
    );
    // Before the next source is decoded, which is the whole memory argument.
    coded.reclaim();
    lap("code and gather");
    Ok(Some(Taken {
        layer,
        noise: frame.noise,
        levels: anchored,
        coded: mine,
        as_shot: frame.as_shot,
        wb_gains: frame.wb_gains,
        defocus: took_off,
        neutral_ceiling: frame.neutral_ceiling,
    }))
}

/// What one source of an exposure bracket is worth in the blend (`Merit`).
///
/// **The clip in the blend's own units**: the coding writes a sample `s` at `s / white * nits`, the
/// white being the set's divided by this source's gain, and `Base::light_of_code` hands that back
/// over PQ's own ceiling - so a neutral clipping at `neutral_ceiling` lands at this.
fn merit_of(
    source: &SourceSpec,
    shortest: f64,
    neutral_ceiling: f32,
    levels: &crate::tone::Anchored,
    reference_white_nits: crate::light::Light<crate::light::SceneNits>,
    anchors: bool,
) -> Merit {
    let ceiling = crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(1.0));
    let clip = f64::from(neutral_ceiling) * source.gain * reference_white_nits.raw()
        / (levels.white.raw() * ceiling.raw());
    Merit {
        scale: (1.0 / source.gain) as f32,
        clip: match source.gain >= shortest {
            true => 0.0,
            false => clip as f32,
        },
        ghost: match anchors {
            true => crate::light::Stops::ZERO,
            false => BRACKET_GHOST,
        },
        anchors,
    }
}

/// How far a bracket's frame may disagree with the reference before it is taken for a scene that
/// moved. Wide of what the header's exposure arithmetic misses by, a tenth of a stop or so.
const BRACKET_GHOST: crate::light::Stops = crate::light::Stops::exactly(0.5);

/// Every source of the recipe, prepared exactly as [`prepared`] prepares one and handed to `take`
/// in place of the blend, the reference first (see [`order_of`]). A source the window does not
/// reach is never handed over at all.
///
/// **The layer `take` is given is the only one resident**, as in [`prepared`], so whatever is
/// wanted of it has to be taken before `take` returns: at scale 1 a layer is ten bytes a canvas
/// pixel, and holding a set of them is gigabytes for a panorama.
///
/// Answers the levels the whole window was coded against - what a [`crate::tile::Prepared`] built
/// from these layers anchors to - and `None` where no source reached it.
pub async fn layers_of(
    spec: &Composition,
    request: &CompositeRequest<'_>,
    mut take: impl FnMut(usize, Layer, Arrived) -> Result<(), String>,
) -> Result<Option<crate::tone::Anchored>, String> {
    let refused = || crate::base::without_a_device("the coding, the lens gather and the composite");
    let gpu = crate::gpu::device().ok_or_else(refused)?;
    let base = crate::base::device(gpu).ok_or_else(refused)?;
    if spec.sources.len() != request.sources.len() {
        return Err("the recipe and the files it is being rendered from disagree".into());
    }
    let mut levels: Option<crate::tone::Anchored> =
        request.levels.or_else(|| whole_anchor(spec, request));
    let mut lap = crate::clock::laps("    pano source ");
    for i in order_of(spec) {
        let Some(taken) = taken(gpu, base, spec, request, i, levels, &[], &mut lap).await? else {
            continue;
        };
        levels = Some(taken.levels);
        take(
            i,
            taken.layer,
            Arrived {
                noise: taken.noise,
                coded: taken.coded,
                as_shot: taken.as_shot,
                wb_gains: taken.wb_gains,
                defocus: taken.defocus,
            },
        )?;
    }
    Ok(levels)
}

/// What one source's layer arrived with, beside the layer itself.
pub struct Arrived {
    /// What GALOSH fitted off this source's own mosaic.
    pub noise: Option<crate::galosh::NoiseFit>,
    /// The levels this source was *coded* against, which is the composite's own divided by this
    /// source's gain.
    pub coded: crate::tone::Anchored,
    pub as_shot: Option<crate::white_balance::AsShot>,
    pub wb_gains: [f32; 3],
    pub defocus: (f32, f32),
}

/// What the decoded previews of one composite may hold between them.
///
/// Six sources of a column at a 2912px preview is 100MB, which is a fraction of the tile budget
/// they save a decode each for.
const PREVIEW_BUDGET_BYTES: usize = 256 * 1024 * 1024;

thread_local! {
    /// Camera pictures already decoded for the composite in hand, newest last.
    static PREVIEWS: std::cell::RefCell<Vec<(String, u32, crate::rgb::Rgb)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Empties the preview cache, and again when it drops.
///
/// Held by whatever is compositing a canvas, so the pictures of one panorama are never handed to
/// the next and are not left in a worker that has finished: the worker outlives the job, and this
/// is hundreds of megabytes of a photograph nobody is rendering any more. On drop rather than at
/// the end of the loop, so a tile that fails takes them with it.
pub struct CameraPictures;

impl CameraPictures {
    pub fn fresh() -> CameraPictures {
        PREVIEWS.with_borrow_mut(Vec::clear);
        CameraPictures
    }
}

impl Drop for CameraPictures {
    fn drop(&mut self) {
        PREVIEWS.with_borrow_mut(Vec::clear);
    }
}

/// The camera's own picture of one source, decoded at most once per composite.
///
/// **A camera's JPEG has no region decode**: the whole of it is read and turned whatever window is
/// being composited, so a source that reaches four tiles of a canvas was read four times for the
/// same pixels - at 180ms apiece before `upright_preview_rgb`, which is what made the composite off
/// the cameras' pictures slower than the one off the RAWs it exists to beat.
///
/// The preview rather than the frame that comes of it: what costs is the decode and the turn, where
/// putting one on the device is an upload and a pass - so this is the smallest thing that skips the
/// expensive half, and at eight bits a channel it is a third of what the scene-linear frame of the
/// same pixels would cost to hold.
fn preview_of(path: &str, at_least_long_edge: u32) -> Result<crate::rgb::Rgb, String> {
    if let Some(held) = PREVIEWS.with_borrow(|held| {
        held.iter()
            .find(|(of, edge, _)| of == path && *edge == at_least_long_edge)
            .map(|(_, _, preview)| preview.clone())
    }) {
        return Ok(held);
    }
    // **The pixels, not the bytes.** A preview is stored the way the sensor read it, so turning a
    // portrait frame upright through `upright_preview_jpeg` is a full-size decode, a full-size
    // encode and then a second decode here. `upright_preview_rgb` reduces before it turns, and what
    // comes back is a finished picture that never was a file.
    let want = crate::decode_rawler::Preview::SmallestCovering(at_least_long_edge as usize);
    let preview =
        crate::decode_rawler::upright_preview_rgb(path, at_least_long_edge as usize, want)
            .ok_or_else(|| format!("{path} embeds no JPEG to composite"))?;
    PREVIEWS.with_borrow_mut(|held| {
        let mut bytes: usize = held.iter().map(|(_, _, each)| each.data.len()).sum();
        // Oldest first, which for a canvas walked tile by tile is the source furthest behind the
        // one being composited and so the one least likely to be reached again.
        while bytes + preview.data.len() > PREVIEW_BUDGET_BYTES && !held.is_empty() {
            bytes -= held.remove(0).2.data.len();
        }
        held.push((path.to_owned(), at_least_long_edge, preview.clone()));
    });
    Ok(preview)
}

/// The camera's own rendering of one source, as the scene-linear frame the pipeline reads.
///
/// A RAW's is the JPEG it embeds, lifted and decoded here so that one is held at a time. A file
/// that is already a finished picture is its own camera JPEG.
///
/// `at_least_long_edge` bounds it twice over: the smallest preview the body wrote that still
/// covers it, and then the DCT scale that decode reads at. A grid tile of a ten-frame panorama is
/// then ten small JPEGs rather than ten 14MB ones.
pub(crate) async fn camera_picture(
    path: &str,
    at_least_long_edge: u32,
) -> Result<crate::frame::Frame, String> {
    if crate::decode_rendered::is_rendered(path) {
        return crate::decode::frame_from_path(
            path,
            crate::galosh::Detail::at(0.0, 0.0),
            at_least_long_edge,
            false,
            crate::galosh::Fit::Measure,
            crate::dust::Wanted::Off,
        )
        .ok_or_else(|| format!("{path} could not be decoded"));
    }
    let preview = preview_of(path, at_least_long_edge)?;
    let (width, height) = (preview.width, preview.height);
    let held = crate::decode_rendered::holding(crate::decode_rendered::Read {
        codes: crate::decode_rendered::interleaved(&preview.data, width * height, 3),
        width,
        height,
        // What a camera writes its preview in, and what the JPEG path read off the absent profile:
        // eight bits of sRGB.
        coding: crate::transfer::Coding::srgb(8),
        // Already turned, which is the whole of what `upright` means above.
        turn: rawler::decoders::Orientation::Normal,
        gain: None,
        exif: None,
    })?;
    let size = held.size();
    held.window(
        crate::px::Rect {
            at: crate::px::At::ORIGIN,
            size,
        },
        crate::view::Scale::for_long_edge(size.raw(), at_least_long_edge),
    )
    .ok_or_else(|| format!("{path}'s embedded JPEG could not be read onto the device"))
}

/// The level diffuse white sits at in [`camera_picture`]'s frames, which is what a composite of
/// them is coded against.
///
/// **A finished picture is not measured for a white, it is asked.** The camera decided where white
/// went when it wrote the JPEG, and a quantile of that picture is a second opinion about a decision
/// already taken: `composite_job::camera_levels` has what coding one against the other does.
///
/// The frame's own coding, not a constant, because the level depends on whether the container had
/// to make room above white: an sRGB JPEG puts white at full scale, and one carrying a gain map
/// puts it a headroom below.
///
/// With `composite_job`, which is the only caller and is the server's half: the browser opens one
/// photograph and composites a window of a canvas, and never asks what a whole one is coded
/// against.
#[cfg(feature = "renditions")]
pub(crate) fn camera_white(path: &str) -> Result<crate::light::Light<crate::light::Level>, String> {
    if crate::decode_rendered::is_rendered(path) {
        // ponytail: a whole decode for one scalar. Every answer here is a function of the file's
        // headers - the transfer, and whether a gain map rides with it - so a set of finished
        // pictures pays a full-size decode each to learn two flags. The fix if that ever reads as
        // slow is a coding read that stops at the headers, shared with `decode_rendered::read` so
        // there is still one place that decides what a file's transfer is; what is not the fix is
        // assuming sRGB here, which is three stops out on a gain-mapped JPEG.
        let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        return Ok(crate::decode_rendered::hold(&bytes)?.white_level());
    }
    // What `camera_picture` states about a camera's own preview: eight bits of sRGB, and no gain
    // map, since the lift is not read out of a preview.
    Ok(crate::light::Light::measured(
        crate::transfer::Coding::srgb(8).white_level(false),
    ))
}

/// Whether any source of this panorama reaches this window at all.
///
/// Asked before a tile is composited rather than found out by one that composites to nothing: a
/// canvas is framed to what its sources cover between them, and a hand-held pan leaves wedges of
/// nothing at the corners of that - so a tile can genuinely hold no photograph, and that is a tile
/// to leave alone rather than a render to refuse. Cheap enough to ask twice: it is `footprint`'s
/// grid walk per source and nothing is decoded.
pub fn covered(spec: &Composition, request: &CompositeRequest<'_>) -> bool {
    spec.sources
        .iter()
        .enumerate()
        .any(|(i, source)| {
            let slot = request.weight.mask().and_then(|held| held.slot_of.get(i).copied().flatten());
            footprint(spec, source, request, slot).is_some()
        })
}

/// What of one source the parts a caller asked for can reach, in that source's own pixels.
///
/// **The box bounding the parts' own footprints, which is not the footprint of the box.** An L of
/// tiles spans a rectangle holding a corner nobody asked about, and taking the footprint of that
/// rectangle would decode every source for a corner none of them are wanted at - and would give a
/// footprint to a source that only the corner reaches, decoding a whole photograph for pixels the
/// caller is going to throw away.
fn footprint(
    spec: &Composition,
    source: &SourceSpec,
    request: &CompositeRequest<'_>,
    slot: Option<u32>,
) -> Option<Rect<crate::px::Photograph>> {
    let whole = [request.window];
    let parts = match request.parts.is_empty() {
        true => &whole[..],
        false => request.parts,
    };
    let mut warps = vec![source.warp];
    if let (Some(mask), Some(slot)) = (request.weight.mask(), slot) {
        for (tile, owner) in mask.tile_slot.iter().enumerate() {
            if *owner == slot {
                warps.push(mask.tile_warps[tile]);
            }
        }
    }
    parts
        .iter()
        .filter_map(|part| footprint_of(spec, source, request, *part, &warps))
        .reduce(|a, b| {
            let (al, at, aw, ah) = a.raw();
            let (bl, bt, bw, bh) = b.raw();
            let left = al.min(bl);
            let top = at.min(bt);
            Rect::exact(
                left,
                top,
                (al + aw).max(bl + bw) - left,
                (at + ah).max(bt + bh) - top,
            )
        })
}

/// What of one source a single rectangle of the canvas can reach, in that source's own pixels.
///
/// The rectangle walked on a grid rather than only round its border: a source can be behind the
/// camera over part of one and in front over the rest, and a border that never saw it would bound
/// the wrong rectangle.
fn footprint_of(
    spec: &Composition,
    source: &SourceSpec,
    request: &CompositeRequest<'_>,
    over: Rect<crate::px::Composite>,
    warps: &[[f64; 6]],
) -> Option<Rect<crate::px::Photograph>> {
    let (left, top, width, height) = over.raw();
    if width == 0 || height == 0 {
        return None;
    }
    let lens = source.lens.to_lens();
    let (cx, cy) = (source.size[0] as f64 / 2.0, source.size[1] as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt();
    let knots = lens.distortion.clone().unwrap_or_default();

    let mut low = [f64::MAX; 2];
    let mut high = [f64::MIN; 2];
    let mut at = |x: usize, y: usize, warp: [f64; 6]| {
        let canvas = [
            (left + x) as f64 * request.scale + 0.5 * request.scale,
            (top + y) as f64 * request.scale + 0.5 * request.scale,
        ];
        let [a, b, c, d, tx, ty] = warp;
        let asked = [
            a * canvas[0] + b * canvas[1] + tx,
            c * canvas[0] + d * canvas[1] + ty,
        ];
        let ray = crate::composition::canvas_to_ray(spec, asked[0], asked[1]);
        let Some(there) = crate::composition::ray_to_source(source, ray) else {
            return;
        };
        let (ox, oy) = (there[0] - cx, there[1] - cy);
        let radius = (ox * ox + oy * oy).sqrt() / half;
        let ratio = match radius == 0.0 {
            true => lens.crop,
            false => crate::image::sample_radius(&knots, radius, lens.crop) / radius,
        };
        for (axis, value) in [cx + ox * ratio, cy + oy * ratio].iter().enumerate() {
            low[axis] = low[axis].min(*value);
            high[axis] = high[axis].max(*value);
        }
    };
    // **Every warp this source may be read through, not only its own.** §3.7a's correction is a
    // per-pixel lookup inside the gather, so one window can ask this source for canvas points tens
    // of pixels apart from each other; a region bounded by the unwarped walk alone is one the gather
    // reads off the end of, and `tap`'s border rule answers with the edge sample - a tile smeared
    // sideways out of the last row it had pixels for.
    for warp in warps {
        for y in (0..height).step_by(FOOTPRINT_STEP).chain([height - 1]) {
            for x in (0..width).step_by(FOOTPRINT_STEP).chain([width - 1]) {
                at(x, y, *warp);
            }
        }
    }
    if low[0] > high[0] {
        return None;
    }

    // **The margin is the stencil's, so it is in the pixels the stencil reads.** This rectangle is
    // in the source's full-resolution pixels and the decode that answers it is reduced by the
    // render's own scale, so three here is three decoded pixels only at scale 1 - at a coarse level
    // of a ladder it is a fraction of one, the region arrives with no neighbours outside the
    // footprint, and `tap` stands the border sample in for them. Which is a seam: two adjacent
    // windows clamp differently over the boundary they share, so the join is visible in a picture
    // assembled from either.
    let halo = MARGIN as f64 * request.scale.max(1.0);
    let clip = |value: f64, edge: usize| (value.max(0.0) as usize).min(edge);
    let first = [
        clip(low[0] - halo, source.size[0]),
        clip(low[1] - halo, source.size[1]),
    ];
    let last = [
        clip(high[0].ceil() + halo, source.size[0]),
        clip(high[1].ceil() + halo, source.size[1]),
    ];
    (last[0] > first[0] && last[1] > first[1])
        .then(|| Rect::exact(first[0], first[1], last[0] - first[0], last[1] - first[1]))
}

/// Where the gather would tap, for every pixel of a window, without tapping it: `[x, y, inside]`
/// per pixel in the decoded region's own coordinates.
///
/// The pin's half of the mapping, and it reads no picture, so it answers for a window of a source
/// that was never decoded.
pub async fn probe_layer(
    gpu: &'static crate::gpu::Gpu,
    from: &Gathered<'_>,
    p: &Composition,
    window: Rect<crate::px::Composite>,
    scale: f64,
) -> Option<Vec<[f64; 3]>> {
    let (_, _, width, height) = window.raw();
    let pixels = width * height;

    let mut recording = gpu.record();
    let probe = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano probe"),
        size: (pixels * 3 * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pano probe out"),
        size: (pixels * 3 * 4) as u64,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    // One buffer apiece: a dispatch may not see the same buffer as both a read and a write, so the
    // four bindings the probe never touches cannot share a stub.
    let mut stub = || {
        recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pano probe stub"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })
    };
    let (frame, out, weight, mask, tile_of) = (stub(), stub(), stub(), stub(), stub());
    let warps = stub_of(&mut recording, WARP_BYTES);
    let (ratios, lifts) = tables(&mut recording, from);
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pano probe params"),
        contents: &params(
            from.source,
            from.full,
            from.region,
            from.through,
            Weighed::Feather.code(),
            p,
            window,
            scale,
        ),
        usage: wgpu::BufferUsages::UNIFORM,
    });

    let kernel = probe_kernel(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pano probe"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: frame.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: out.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: ratios.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: lifts.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: weight.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 6,
                resource: probe.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 7,
                resource: mask.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 8,
                resource: tile_of.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 9,
                resource: warps.as_entire_binding(),
            },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((pixels as u32).div_ceil(GROUP as u32), 1, 1);
    }
    recording
        .encoder()
        .copy_buffer_to_buffer(&probe, 0, &staging, 0, (pixels * 3 * 4) as u64);
    recording.submit();

    crate::gpu::read_back(gpu, &staging, |mapped| {
        mapped
            .chunks_exact(12)
            .map(|word| {
                let take = |at: usize| {
                    f64::from(f32::from_ne_bytes([
                        word[at],
                        word[at + 1],
                        word[at + 2],
                        word[at + 3],
                    ]))
                };
                [take(0), take(4), take(8)]
            })
            .collect()
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composition::{LensSpec, VERSION, canvas_to_ray, ray_to_source};

    fn drawing() -> &'static crate::gpu::Gpu {
        crate::gpu::device().expect("an adapter for the panorama gather")
    }

    fn levels(white: f64, peak: f64) -> crate::tone::Levels {
        crate::tone::Levels {
            white: crate::light::Light::measured(white),
            peak: crate::light::Light::measured(peak),
            floor: Some(crate::light::Light::measured(white / 32.0)),
        }
    }

    /// The exposure a panorama is coded against is the whole canvas's, not the reference frame's -
    /// and a dark frame in the set does not drag it down.
    ///
    /// A pan whose first frame is dark trees and whose rest is sky was being exposed as though the
    /// whole picture were the trees, which lifts every bright frame into its own highlights. A mean
    /// only softens that; diffuse white is the level a tenth of the picture is brighter than, and
    /// over a canvas that is mostly sky that level sits among the bright frames' own.
    #[test]
    fn a_dark_source_does_not_drag_the_anchor_down() {
        let dark = levels(3000.0, 12000.0);
        let bright = levels(9000.0, 40000.0);
        let anchor = combined(&[dark, bright, bright]).expect("three sources measured");
        // Where the sky is, not halfway to the trees - a mean would have said 7000.
        assert!(
            (anchor.white.raw() - 9000.0).abs() < 1.0,
            "white {}",
            anchor.white.raw()
        );
        // And the roll-off still reaches the brightest of them rather than clipping it.
        assert!(
            (anchor.peak.raw() - 40000.0).abs() < 1e-6,
            "peak {}",
            anchor.peak.raw()
        );
    }

    /// One dim frame among many bright ones does not move it, and one bright frame among many dim
    /// ones does not either: it is a quantile, so neither end gets to decide alone.
    #[test]
    fn neither_end_of_the_set_decides_alone() {
        let dim = levels(1000.0, 4000.0);
        let mid = levels(5000.0, 20000.0);
        let sun = levels(60000.0, 65000.0);
        let mostly_mid = [dim, mid, mid, mid, mid, mid, mid, mid, mid, sun];
        let anchor = combined(&mostly_mid).expect("ten sources measured");
        assert!(
            (anchor.white.raw() - 5000.0).abs() < 1.0,
            "white {}",
            anchor.white.raw()
        );
    }

    /// One frame's own anchor is still its own, so a single-source panorama is graded as the
    /// photograph would be.
    #[test]
    fn one_source_anchors_on_itself() {
        let anchor = combined(&[levels(4200.0, 28000.0)]).expect("one source measured");
        assert!((anchor.white.raw() - 4200.0).abs() < 1e-6);
        assert!((anchor.peak.raw() - 28000.0).abs() < 1e-6);
    }

    /// Nothing measured is not an anchor of zero: the caller falls back to the reference's own
    /// region.
    #[test]
    fn nothing_measured_is_no_anchor() {
        assert!(combined(&[]).is_none());
    }

    /// A peak under the white it is anchored on would clip the frame it came from.
    #[test]
    fn the_peak_never_falls_under_the_white() {
        let anchor = combined(&[levels(6000.0, 2000.0)]).expect("one source measured");
        assert!(
            anchor.peak.raw() >= anchor.white.raw(),
            "peak {}",
            anchor.peak.raw()
        );
    }

    const SOURCE: [usize; 2] = [6000, 4000];
    const WINDOW: (usize, usize) = (256, 128);

    fn lens() -> LensSpec {
        LensSpec {
            distortion: Some(vec![0.0, -0.004, -0.011, -0.021, -0.034]),
            crop: 1.03,
            falloff: None,
            tca: None,
        }
    }

    fn recipe(projection: Projection, through: Through) -> Composition {
        let turns = [[0.0, 0.0, 0.0], [0.0, -0.31, 0.0], [0.06, 0.29, 0.02]];
        // **One of the three carries a warp, and it is a shear.** A recipe of three identities
        // would pin the mapping and say nothing about §3.7a - and a shear in particular is the
        // term no rotation and no focal can stand in for, so it is the one that has to be held
        // against the host rather than assumed. The other two stay unwarped, which is what every
        // panorama writes and what the identity has to keep meaning.
        let warps = [
            crate::composition::no_warp(),
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            [1.004, 0.011, -0.006, 0.997, 23.0, -14.0],
        ];
        Composition {
            version: VERSION,
            sources: turns
                .iter()
                .zip(warps)
                .map(|(axis, warp)| SourceSpec {
                    photo_id: "one".into(),
                    size: SOURCE,
                    rotation: crate::composition::normalise(crate::composition::from_axis_angle(
                        *axis,
                    )),
                    focal: 5200.0,
                    lens: match through {
                        Through::Lens => lens(),
                        Through::Corrected => LensSpec::none(),
                    },
                    gain: 1.0,
                    warp,
                })
                .collect(),
            projection,
            canvas: [9000, 4200],
            centre: [4500.0, 2100.0],
            radians_per_pixel: 1.0 / 5200.0,
            crop: [0.0, 0.0, 1.0, 1.0],
            reference: 0,
            seam_rms_px: None,
        }
    }

    /// Where the host says a canvas pixel reads from, in the decoded region's own coordinates:
    /// the projection, the rotation, and - for a RAW - the lens's own radius mapping, evaluated
    /// exactly rather than through the shader's table.
    fn host_source_of(
        p: &Composition,
        source: &SourceSpec,
        through: Through,
        region: Rect<Drawn>,
        canvas: [f64; 2],
    ) -> Option<[f64; 2]> {
        // §3.7a, before the ray, as `composite_gather.slang` does it.
        let asked = crate::composition::warped_canvas(source, canvas);
        let at = ray_to_source(source, canvas_to_ray(p, asked[0], asked[1]))?;
        let (cx, cy) = (source.size[0] as f64 / 2.0, source.size[1] as f64 / 2.0);
        let (ox, oy) = (at[0] - cx, at[1] - cy);
        let half = (cx * cx + cy * cy).sqrt();
        let ratio = match through {
            Through::Corrected => 1.0,
            Through::Lens => {
                let lens = source.lens.to_lens();
                let knots = lens.distortion.clone().unwrap_or_default();
                let radius = (ox * ox + oy * oy).sqrt() / half;
                match radius == 0.0 {
                    true => lens.crop,
                    false => crate::image::sample_radius(&knots, radius, lens.crop) / radius,
                }
            }
        };
        let (region_left, region_top, _, _) = region.raw();
        Some([
            (cx - 0.5) + ox * ratio - region_left as f64,
            (cy - 0.5) + oy * ratio - region_top as f64,
        ])
    }

    /// Two sources side by side, each a flat field of its own: the composite is each source's own
    /// value where only that source reaches, and crosses between them once, monotonically.
    ///
    /// **A blend that is not monotone is a visible band**, which is what averaging codes instead of
    /// light, or normalising by the wrong sum, produces.
    #[test]
    fn the_blend_feathers_between_two_layers() {
        let gpu = drawing();
        let base = crate::base::device(gpu).expect("the base pipelines");
        let p = recipe(Projection::Rectilinear, Through::Corrected);
        // Two sources overlapping by about a third, which is what a panorama is shot at.
        let apart = 0.55 * SOURCE[0] as f64 / 5200.0;
        let mut left = p.sources[0].clone();
        let mut right = p.sources[0].clone();
        left.rotation = crate::composition::from_axis_angle([0.0, -apart / 2.0, 0.0]);
        right.rotation = crate::composition::from_axis_angle([0.0, apart / 2.0, 0.0]);

        // Wide enough to reach past the overlap at both ends, which is where each source is meant
        // to be alone: two 6000px frames a third apart share the middle 3300.
        let across = 5000;
        let window: Rect<crate::px::Composite> = Rect::exact(4500 - across / 2, 2050, across, 8);
        let region: Rect<Drawn> = Rect::exact(0, 0, SOURCE[0], SOURCE[1]);
        let mut blending = Blending::over(gpu, base, window);
        for (source, nits) in [(&left, 200.0f64), (&right, 800.0)] {
            let flat = flat_frame(gpu, nits);
            let from = Gathered {
                source,
                prepared: &flat,
                full: Size::exact(SOURCE[0], SOURCE[1]),
                region,
                through: Through::Corrected,
            };
            blending.add(gather_layer(gpu, &from, &p, window, 1.0, Weighed::Feather));
        }

        let (blended, alpha) = blending.resolve();
        let row = pollster::block_on(read_row(gpu, &blended, across));
        let covered = pollster::block_on(crate::gpu::read_back(
            gpu,
            &copied(gpu, &alpha, across),
            |m| {
                m.chunks_exact(4)
                    .map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]]))
                    .collect::<Vec<_>>()
            },
        ))
        .expect("the alpha reads back");

        let light = |code: u16| {
            crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(
                f64::from(code) / f64::from(u16::MAX),
            ))
            .raw()
        };
        let ends = (light(row[8]), light(row[across - 9]));
        assert!(
            covered.iter().all(|a| *a == 255),
            "the window is not covered end to end"
        );
        assert!(
            ends.0 < ends.1,
            "the two ends are the same picture: {ends:?}"
        );
        for pair in row.windows(2) {
            assert!(
                pair[1] + 2 >= pair[0],
                "the blend dips: {} then {}",
                pair[0],
                pair[1]
            );
        }
        // Each source still itself at its own end, which is what a feather must not smear away.
        assert!(
            (ends.0 - 200.0).abs() < 4.0 && (ends.1 - 800.0).abs() < 16.0,
            "{ends:?}"
        );
    }

    /// A focus bracket's layers, one textured and one the same scene blurred flat: the merge keeps
    /// the texture rather than averaging it with the blur.
    #[test]
    fn a_focus_bracket_takes_the_sharp_layer_where_it_is_sharp() {
        let gpu = drawing();
        let base = crate::base::device(gpu).expect("the base pipelines");
        let (w, h) = (16usize, 8usize);
        let code = |nits: f64| {
            (crate::tone::pq(crate::light::Light::<crate::light::SceneNits>::measured(nits)).raw()
                * f64::from(u16::MAX))
            .round() as u16
        };
        let light = |code: u16| {
            crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(
                f64::from(code) / f64::from(u16::MAX),
            ))
            .raw()
        };
        let layer = |nits: &dyn Fn(usize) -> f64| {
            let samples: Vec<u16> = (0..w * h).flat_map(|at| [code(nits(at % w)); 3]).collect();
            Layer {
                rgb: Resident::upload(gpu, &samples, w, h),
                weight: gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("reach"),
                    contents: bytemuck::cast_slice(&vec![1.0f32; w * h]),
                    usage: wgpu::BufferUsages::STORAGE,
                }),
            }
        };
        let window: Rect<crate::px::Composite> = Rect::exact(0, 0, w, h);
        let mut blending = Blending::over(gpu, base, window);
        for sharp in [true, false] {
            let taken = match sharp {
                true => layer(&|x| if x % 2 == 0 { 150.0 } else { 300.0 }),
                false => layer(&|_| 212.0),
            };
            weigh_sharpness(gpu, base, &taken, (w, h));
            blending.add(taken);
        }
        let (blended, _) = blending.resolve();
        let row = pollster::block_on(read_row(gpu, &blended, w));
        let (even, odd) = (light(row[8]), light(row[9]));
        assert!((even - 150.0).abs() < 8.0 && (odd - 300.0).abs() < 15.0, "the texture was averaged away: {even}, {odd}");
    }

    /// An exposure bracket's layers, one over the other: each weighed by its merit, and a layer past
    /// its clip counting for nothing.
    #[test]
    fn a_bracket_weighs_by_merit_and_drops_what_clipped() {
        let gpu = drawing();
        let base = crate::base::device(gpu).expect("the base pipelines");
        let p = recipe(Projection::Rectilinear, Through::Corrected);
        let window: Rect<crate::px::Composite> = Rect::exact(4000, 2050, 16, 4);
        let region: Rect<Drawn> = Rect::exact(0, 0, SOURCE[0], SOURCE[1]);
        let light = |code: u16| {
            crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(
                f64::from(code) / f64::from(u16::MAX),
            ))
            .raw()
        };
        let merged = |layers: &[(f64, Merit)]| {
            let mut blending = Blending::over(gpu, base, window);
            for (nits, merit) in layers {
                let flat = flat_frame(gpu, *nits);
                let from = Gathered {
                    source: &p.sources[0],
                    prepared: &flat,
                    full: Size::exact(SOURCE[0], SOURCE[1]),
                    region,
                    through: Through::Corrected,
                };
                blending.add_merited(gather_layer(gpu, &from, &p, window, 1.0, Weighed::Flat), *merit);
            }
            let (blended, _) = blending.resolve();
            light(pollster::block_on(read_row(gpu, &blended, 16))[8])
        };
        let even = Merit::EVEN;
        let heavy = Merit { scale: 3.0, ..Merit::EVEN };

        let alone = merged(&[(200.0, even)]);
        assert!((merged(&[(200.0, even), (200.0, heavy)]) - alone).abs() < 1.0, "a frame merged with itself moved");
        let mixed = merged(&[(200.0, even), (400.0, heavy)]);
        assert!((mixed - 350.0).abs() < 7.0, "merit 1 at 200 and 3 at 400 came to {mixed}");
        let clipped = Merit { clip: 300.0 / 10000.0, ..heavy };
        let dropped = merged(&[(200.0, even), (400.0, clipped)]);
        assert!((dropped - alone).abs() < 1.0, "a layer past its clip still counted: {dropped}");

        // Against an anchor, a layer two stops off it is a scene that moved, and one a tenth of a
        // stop off is the same scene.
        let anchor = Merit { anchors: true, ..Merit::EVEN };
        let wary = Merit { ghost: crate::light::Stops::exactly(0.5), ..heavy };
        let ghosted = merged(&[(200.0, anchor), (800.0, wary)]);
        assert!((ghosted - alone).abs() < 1.0, "a layer two stops off the anchor still counted: {ghosted}");
        let near = merged(&[(200.0, anchor), (215.0, wary)]);
        assert!((near - 211.25).abs() < 3.0, "a layer agreeing with the anchor was dropped: {near}");
    }

    /// A frame every sample of which is the same code, which is what makes a blend's answer
    /// readable: whatever comes back is the mix and not the picture.
    fn flat_frame(gpu: &'static crate::gpu::Gpu, nits: f64) -> Resident {
        let signal = crate::tone::pq(crate::light::Light::<crate::light::SceneNits>::measured(
            nits,
        ));
        let code = (signal.raw() * f64::from(u16::MAX)).round() as u16;
        Resident::upload(
            gpu,
            &vec![code; SOURCE[0] * SOURCE[1] * 3],
            SOURCE[0],
            SOURCE[1],
        )
    }

    fn copied(
        gpu: &'static crate::gpu::Gpu,
        buffer: &crate::gpu::Buffer,
        words: usize,
    ) -> crate::gpu::Buffer {
        let mut recording = gpu.record();
        let staging = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pano readback"),
            size: (words * 4) as u64,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording
            .encoder()
            .copy_buffer_to_buffer(buffer, 0, &staging, 0, (words * 4) as u64);
        recording.submit();
        staging
    }

    /// The green channel along the first row of a composite.
    async fn read_row(gpu: &'static crate::gpu::Gpu, frame: &Resident, across: usize) -> Vec<u16> {
        let staging = copied(gpu, frame.buffer(), (across * 3).div_ceil(2));
        crate::gpu::read_back(gpu, &staging, |mapped| {
            let samples = crate::resident::samples_of(mapped);
            (0..across).map(|x| samples[x * 3 + 1]).collect()
        })
        .await
        .expect("the composite reads back")
    }

    /// A request over a window, for the fields `footprint` and `covered` read.
    fn asking(window: Rect<crate::px::Composite>, scale: f64) -> CompositeRequest<'static> {
        asking_parts(window, scale, &[])
    }

    fn asking_parts<'a>(
        window: Rect<crate::px::Composite>,
        scale: f64,
        parts: &'a [Rect<crate::px::Composite>],
    ) -> CompositeRequest<'a> {
        CompositeRequest {
            window,
            parts,
            scale,
            white_quantile: 0.9,
            levels: None,
            reference_white_nits: crate::light::Light::exactly(203.0),
            strengths: crate::image::Strengths {
                sharpen: 0.0,
                defringe: 0.0,
            },
            detail: crate::galosh::Detail::at(0.0, 0.0),
            sources: &[],
            from: From::Original,
            weight: Weight::Feather,
        }
    }

    /// `NOT_REACHED` in `composite_gather.slang`, which the emitted WGSL folds into its use sites.
    #[test]
    fn the_unreached_sentinel_matches_the_shader() {
        let source = include_str!("../../../slang/composite_gather.slang");
        let line = source
            .lines()
            .find(|l| l.contains("const float NOT_REACHED ="))
            .expect("NOT_REACHED is declared in composite_gather.slang");
        assert!(line.contains("-1e30"), "the shader reads `{line}`");
        assert_eq!(NOT_REACHED, -1e30);
    }

    /// A window of a coarse level is decoded with the stencil's own neighbours outside it.
    ///
    /// **The halo is what the four-tap stencil reads, so it is counted in the pixels the stencil
    /// reads.** The footprint is in the source's full-resolution pixels and the decode answering it
    /// is reduced by the render's scale, so a fixed three there is three decoded pixels at scale 1
    /// and three quarters of one at scale 4 - and a region with no neighbours outside its footprint
    /// is tapped through `tap`'s border clamp instead, which two adjacent windows do differently
    /// over the boundary they share. That is a seam down the join of every picture assembled from
    /// them, and a ladder is nothing but coarse levels.
    #[test]
    fn a_window_of_a_coarse_level_still_decodes_its_neighbourhood() {
        let p = recipe(Projection::Rectilinear, Through::Corrected);
        let source = &p.sources[0];
        const SCALE: f64 = 4.0;
        let window: Rect<crate::px::Composite> = Rect::exact(1093, 509, 64, 32);
        let (left, top, width, height) = window.raw();
        let region =
            footprint(&p, source, &asking(window, SCALE), None).expect("the window reaches it");

        // Where the gather actually taps, over every pixel of that window, in the source's own
        // full-resolution pixels - which is what `host_source_of` answers for a region at the
        // origin.
        let whole: Rect<Drawn> = Rect::exact(0, 0, SOURCE[0], SOURCE[1]);
        let mut low = [f64::MAX; 2];
        let mut high = [f64::MIN; 2];
        for y in 0..height {
            for x in 0..width {
                let canvas = [
                    (left + x) as f64 * SCALE + 0.5 * SCALE,
                    (top + y) as f64 * SCALE + 0.5 * SCALE,
                ];
                let Some(at) = host_source_of(&p, source, Through::Corrected, whole, canvas) else {
                    continue;
                };
                for axis in 0..2 {
                    low[axis] = low[axis].min(at[axis]);
                    high[axis] = high[axis].max(at[axis]);
                }
            }
        }
        assert!(low[0] < high[0], "the window taps nothing");

        // A pixel of slack for the half-pixel centre and the truncation to whole pixels either
        // side, and no more: the claim is the halo's size, not that there is one.
        let wanted = MARGIN as f64 * SCALE - 1.0;
        let (region_left, region_top, region_w, region_h) = region.raw();
        let first = [region_left as f64, region_top as f64];
        let last = [
            (region_left + region_w) as f64,
            (region_top + region_h) as f64,
        ];
        for (axis, name) in [(0, "x"), (1, "y")] {
            assert!(
                low[axis] - first[axis] >= wanted,
                "{name}: the region starts at {} where the gather taps {}, {wanted} short of it",
                first[axis],
                low[axis],
            );
            assert!(
                last[axis] - high[axis] >= wanted,
                "{name}: the region ends at {} where the gather taps {}, {wanted} short of it",
                last[axis],
                high[axis],
            );
        }
    }

    /// A source only the unasked-for part of a window reaches is not decoded for it.
    ///
    /// **The whole of what `parts` buys.** Handed the box alone, a panorama window spanning the
    /// canvas opens every source that touches any of it - so an L of tiles would pay for a whole
    /// photograph that only the L's corner sees, and a pan across a seam would decode both sides
    /// of it to draw one.
    #[test]
    fn a_source_no_part_reaches_is_left_out_of_the_footprint() {
        let p = recipe(Projection::Cylindrical, Through::Corrected);
        const SCALE: f64 = 1.0;
        let whole: Rect<crate::px::Composite> = Rect::exact(0, 0, p.canvas[0], p.canvas[1]);
        let corner: Rect<crate::px::Composite> = Rect::exact(0, 0, 1024, 1024);

        let reached = |request: &CompositeRequest<'_>| -> Vec<bool> {
            p.sources
                .iter()
                .map(|s| footprint(&p, s, request, None).is_some())
                .collect()
        };
        let all = reached(&asking(whole, SCALE));
        let one = reached(&asking_parts(whole, SCALE, &[corner]));
        assert!(
            all.iter().any(|reached| *reached),
            "the canvas reaches none of its own sources"
        );
        assert!(
            one.iter().zip(&all).all(|(part, whole)| !part || *whole),
            "a part of the window reaches a source the whole of it does not: {one:?} of {all:?}",
        );
        assert!(
            one.iter().zip(&all).any(|(part, whole)| !part && *whole),
            "one corner of a {}x{} canvas reached every source the whole canvas does: {all:?}",
            p.canvas[0],
            p.canvas[1],
        );

        // And where a source is reached by two of them, what is decoded is the box bounding those
        // two rather than the box bounding the window: a corner between them is never paid for.
        let far: Rect<crate::px::Composite> = Rect::exact(p.canvas[0] - 1024, 0, 1024, 1024);
        for source in &p.sources {
            let pair = footprint(&p, source, &asking_parts(whole, SCALE, &[corner, far]), None);
            let near = footprint(&p, source, &asking_parts(whole, SCALE, &[corner]), None);
            let there = footprint(&p, source, &asking_parts(whole, SCALE, &[far]), None);
            let bound = match (near, there) {
                (None, other) | (other, None) => other,
                (Some(a), Some(b)) => {
                    let (al, at, aw, ah) = a.raw();
                    let (bl, bt, bw, bh) = b.raw();
                    let (left, top) = (al.min(bl), at.min(bt));
                    Some(Rect::exact(
                        left,
                        top,
                        (al + aw).max(bl + bw) - left,
                        (at + ah).max(bt + bh) - top,
                    ))
                }
            };
            assert_eq!(pair.map(|r| r.raw()), bound.map(|r| r.raw()));
        }
    }

    /// The two enumerations the uniform carries as numbers. A shader numbering them differently
    /// would project every source through the wrong surface and still produce a picture.
    #[test]
    fn the_shader_numbers_what_the_host_numbers() {
        const SLANG: &str = include_str!("../../../slang/composite_gather.slang");
        let says = |line: String| {
            assert!(
                SLANG.contains(&line),
                "composite_gather.slang lacks `{line}`"
            )
        };
        for (projection, name) in [
            (Projection::Rectilinear, "RECTILINEAR"),
            (Projection::Cylindrical, "CYLINDRICAL"),
            (Projection::Equirectangular, "EQUIRECTANGULAR"),
        ] {
            says(format!(
                "static const uint {name} = {};",
                projection_code(projection)
            ));
        }
        says(format!(
            "static const uint THROUGH_LENS = {};",
            through_code(Through::Lens)
        ));
        says(format!(
            "static const uint THROUGH_CORRECTED = {};",
            through_code(Through::Corrected)
        ));
    }

    /// The shader and the recipe are one mapping. Every pixel of a window, for three sources, both
    /// ways of reaching a source's pixels, and all three projections.
    ///
    /// `the_draw_places_a_pixel_where_the_gather_does`'s pattern: a stage whose answer is a
    /// coordinate is pinned against the host's own arithmetic for that coordinate, since a
    /// composite assembled from the wrong pixels is a picture rather than a failure.
    #[test]
    fn the_gather_places_a_pixel_where_the_recipe_does() {
        let gpu = drawing();
        let region: Rect<Drawn> = Rect::exact(0, 0, SOURCE[0], SOURCE[1]);
        let prepared = Resident::empty(gpu, 4, 4);
        let window: Rect<crate::px::Composite> = Rect::exact(3800, 1900, WINDOW.0, WINDOW.1);

        for projection in [
            Projection::Rectilinear,
            Projection::Cylindrical,
            Projection::Equirectangular,
        ] {
            for through in [Through::Corrected, Through::Lens] {
                let p = recipe(projection, through);
                for source in &p.sources {
                    let from = Gathered {
                        source,
                        prepared: &prepared,
                        full: Size::exact(SOURCE[0], SOURCE[1]),
                        region,
                        through,
                    };
                    let probed = pollster::block_on(probe_layer(gpu, &from, &p, window, 1.0))
                        .expect("the device probes");

                    let mut compared = 0;
                    for (pixel, got) in probed.iter().enumerate() {
                        let (x, y) = (pixel % WINDOW.0, pixel / WINDOW.0);
                        let canvas = [3800.0 + x as f64 + 0.5, 1900.0 + y as f64 + 0.5];
                        let Some(want) = host_source_of(&p, source, through, region, canvas) else {
                            assert_eq!(got[2], 0.0, "behind the camera and still reported inside");
                            continue;
                        };
                        let inside = want[0] >= 0.0
                            && want[1] >= 0.0
                            && want[0] <= (SOURCE[0] - 1) as f64
                            && want[1] <= (SOURCE[1] - 1) as f64;
                        assert_eq!(
                            got[2] != 0.0,
                            inside,
                            "{projection:?}/{through:?} disagrees about pixel ({x}, {y})"
                        );
                        if !inside {
                            continue;
                        }
                        compared += 1;
                        assert!(
                            (got[0] - want[0]).abs() < 0.05 && (got[1] - want[1]).abs() < 0.05,
                            "{projection:?}/{through:?} at ({x}, {y}): {got:?} against {want:?}"
                        );
                    }
                    assert!(compared > 0, "{projection:?}/{through:?} covered nothing");
                }
            }
        }
    }
}
