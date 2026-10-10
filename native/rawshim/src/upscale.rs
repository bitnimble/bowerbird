//! The 2x mosaic upscaler of `models/upscaler` on the device: the Detail panel's third denoiser.
//!
//! A conditioned Bayer mosaic in, still noisy, and the mosaic of a sensor with twice the photosites
//! each way out, denoised. `slang/upscale.slang` runs the network's every step, and its 3x3 layers
//! run on the matrix units through `slang/passthrough/upscale_coop.slang` where the device reaches
//! them. A browser has no passthrough shader, so a page runs [`Arm::Half`] or [`Arm::Float`].
//!
//! The net is `MultiScale`: a body at full, half and quarter resolution, joined back up through 1x1
//! rises, bilinear doublings and skips. A rectangle is cut into tiles, each grown by the network's
//! reach and placed on the frame's own grid of its coarsest level, so a tile computes what the whole
//! frame would: every level's region sits where the frame's own pooling put it.
//!
//! `examples/upscale_bench.rs` times every arm, and `models/upscaler`'s `upscaler.device_check`
//! holds each against torch.

use std::sync::Mutex;

/// What the forward pass computes on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arm {
    /// The 3x3 layers on the matrix units, accumulated in `half`, over `half` tensors.
    Matrix,
    /// All of it in WGSL over `half` tensors and in `half` arithmetic, which needs `shader-f16`.
    Half,
    /// All of it in WGSL in `float`.
    Float,
}

impl Arm {
    pub const ALL: [Arm; 3] = [Arm::Matrix, Arm::Half, Arm::Float];

    fn on_matrix_units(self) -> bool {
        self == Arm::Matrix
    }

    /// The pixels a 3x3 layer's workgroup covers, across and down.
    fn tile(self) -> (usize, usize) {
        match self {
            Arm::Matrix => (COOP_WIDE, COOP_TALL),
            Arm::Half | Arm::Float => (CONV_WIDE, CONV_TALL),
        }
    }
}

/// The widths the kernels are compiled for: the full level's, doubling at each halving.
const CHANNELS: usize = 48;
const LEVELS: usize = 3;
/// The input's planes, and what the last layer's channels shuffle into.
const PLANES: usize = 4;
const SHUFFLED: usize = PLANES * 4;
/// The input's planes as the matrix units read them, padded to a whole fragment.
const MATRIX_PLANES: usize = 16;
/// The output channels one workgroup of a 3x3 layer carries; wider layers go a slice at a time.
const OUT_MOST: usize = 48;

/// `pack`'s, `leave`'s and the channel steps' workgroup in `slang/upscale.slang`.
const STEP_WIDE: usize = 16;
const STEP_TALL: usize = 8;
/// A WGSL 3x3 layer's tile there, and the matrix units' in `upscale_coop.slang`.
const CONV_WIDE: usize = 32;
const CONV_TALL: usize = 8;
const COOP_WIDE: usize = 64;
const COOP_TALL: usize = 4;
/// Planes a side the coarsest level's pixel covers, which every region's corner sits on.
const COARSEST: usize = 1 << (LEVELS - 1);

/// `FRAGMENT` there, by backend, as `pmrid`'s kernel has it.
const SPIRV_FRAGMENT: usize = 16;
const METAL_FRAGMENT: usize = 8;

/// The most cells a tensor of a tile may hold.
const TENSOR_CELLS_MOST: usize = 1 << 28;

/// The 3x3 layers the kernels hold, as (in, out, linear), named `conv_{in}_{out}` and
/// `coop_{in}_{out}`, the first reading the planes padded to [`MATRIX_PLANES`] on the matrix units.
const CONVS: [(usize, usize, bool); 7] = [
    (PLANES, CHANNELS, false),
    (CHANNELS, CHANNELS, false),
    (CHANNELS, CHANNELS * 2, false),
    (CHANNELS * 2, CHANNELS * 2, false),
    (CHANNELS * 2, CHANNELS * 4, false),
    (CHANNELS * 4, CHANNELS * 4, false),
    (CHANNELS, SHUFFLED, true),
];

/// `Step` in `slang/upscale.slang`, whose first nine words `slang/passthrough/upscale_coop.slang`
/// reads too.
#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Step {
    width: u32,
    height: u32,
    left: i32,
    top: i32,
    frame_width: u32,
    frame_height: u32,
    weights_at: u32,
    bias_at: u32,
    slope_at: u32,
    planes_channels: u32,
    inner_left: u32,
    inner_top: u32,
    inner_width: u32,
    inner_height: u32,
    other_width: u32,
    other_height: u32,
    other_left: i32,
    other_top: i32,
    real_width: u32,
    real_height: u32,
    window_left: u32,
    window_top: u32,
    window_width: u32,
    window_height: u32,
    out_left: u32,
    out_top: u32,
    out_width: u32,
    out_height: u32,
    channels: u32,
    out_channels: u32,
    _pad: [u32; 2],
}

/// What a photo's planes go through on their way in and out: `Photo` in `slang/upscale.slang`, from
/// [`Upscaler::photo`].
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Photo {
    floors: [f32; 4],
    roots: [f32; 4],
    scales: [f32; 4],
    gains: [f32; 4],
    positions: [u32; 4],
    alpha: f32,
    sigma_sq: f32,
    grain: f32,
    luma: f32,
    colour: f32,
    _pad: [u32; 3],
}

/// The Luminance an unset slider takes: the network's light, with a quarter of the photo's grain.
pub const LUMINANCE: f64 = 75.0;

/// A Luminance position as how much of the network's light to keep and the share of the photo's
/// noise variance to add as grain, together leaving `1 - luminance / 100` of its noise.
fn light_of(luminance: f64) -> (f64, f64) {
    let share = 1.0 - luminance / 100.0;
    let towards_input = ((LUMINANCE - luminance) / LUMINANCE).clamp(0.0, 1.0);
    // The input's noise arrives as the blend's square, not the blend.
    let grain = (share - towards_input * towards_input).max(0.0);
    (1.0 - towards_input, grain)
}

/// `models/training`'s `fit_stabiliser`, as the weights' `weights.json` states it.
struct Stabilising {
    reference_alpha: f32,
    max_scale: f32,
    min_floor: f32,
    max_floor: f32,
}

impl Stabilising {
    fn read(manifest: &serde_json::Value) -> Result<Stabilising, String> {
        let fit = &manifest["stabiliser"];
        let number = |name: &str| {
            fit[name]
                .as_f64()
                .map(|n| n as f32)
                .ok_or(format!("the manifest's stabiliser has no {name}"))
        };
        Ok(Stabilising {
            reference_alpha: number("reference_alpha")?,
            max_scale: number("max_scale")?,
            min_floor: number("min_floor")?,
            max_floor: number("max_floor")?,
        })
    }
}

/// Where a step's tensors live among a tile's: the packed planes, or a level's two working tensors
/// and the skip it keeps for the way back up.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Slot {
    Planes,
    A(usize),
    B(usize),
    Skip(usize),
}

impl Slot {
    /// The working tensor of `level` that is not `self`.
    fn other(self, level: usize) -> Slot {
        match self {
            Slot::A(_) => Slot::B(level),
            _ => Slot::A(level),
        }
    }
}

#[derive(Clone, Copy)]
struct Layer {
    /// Which of [`CONVS`] it is.
    kind: usize,
    /// Where its taps, `[tap][in][out]`, its biases and its slopes are in the `float` weights, and
    /// its fragments in [`Coop::blocks`].
    weights_at: usize,
    bias_at: usize,
    slope_at: usize,
    blocks_at: usize,
}

/// One step of the forward pass, in the order they run.
#[derive(Clone, Copy)]
enum Op {
    Pack,
    Conv {
        level: usize,
        layer: Layer,
        from: Slot,
        to: Slot,
    },
    /// Into `level` from the one above it.
    Pool {
        level: usize,
        channels: usize,
        from: Slot,
        to: Slot,
    },
    /// At the coarse `level`, `input` channels to `output`.
    Rise {
        level: usize,
        input: usize,
        output: usize,
        weights_at: usize,
        bias_at: usize,
        from: Slot,
        to: Slot,
    },
    /// The rise below `level`, doubled, onto that level's skip.
    Double {
        level: usize,
        channels: usize,
        rise: Slot,
        skip: Slot,
        to: Slot,
    },
    Leave {
        from: Slot,
    },
}

impl Op {
    fn level(self) -> usize {
        match self {
            Op::Pack | Op::Leave { .. } => 0,
            Op::Conv { level, .. }
            | Op::Pool { level, .. }
            | Op::Rise { level, .. }
            | Op::Double { level, .. } => level,
        }
    }
}

pub struct Upscaler {
    arm: Arm,
    ops: Vec<Op>,
    /// How far the network reads past a tile, in packed pixels, on the coarsest level's grid.
    reach: usize,
    stabilising: Stabilising,
    /// The grain, as a share of the photo's noise variance, that looks like all of its noise.
    calibration: f32,
    weights: crate::gpu::Buffer,
    layout: wgpu::BindGroupLayout,
    pack: wgpu::ComputePipeline,
    convs: Vec<wgpu::ComputePipeline>,
    pool: wgpu::ComputePipeline,
    rise: wgpu::ComputePipeline,
    double: wgpu::ComputePipeline,
    leave: wgpu::ComputePipeline,
    coop: Option<Coop>,
    held: Mutex<Option<Tensors>>,
    halving: Halving,
}

/// `slang/supersample.slang`, which takes RCD's plane of an upscale back to the photo's size.
pub struct Halving {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

struct Coop {
    layout: wgpu::BindGroupLayout,
    convs: Vec<wgpu::ComputePipeline>,
    blocks: crate::gpu::Buffer,
}

/// A tile's tensors, kept for the next rectangle whose region fits them.
struct Tensors {
    /// The largest region they hold, and the one last laid out in them.
    region: (usize, usize),
    laid: (usize, usize),
    planes: crate::gpu::Buffer,
    /// Each level's A, B and skip.
    levels: Vec<[crate::gpu::Buffer; 3]>,
}

impl Tensors {
    fn of(&self, slot: Slot) -> &crate::gpu::Buffer {
        match slot {
            Slot::Planes => &self.planes,
            Slot::A(level) => &self.levels[level][0],
            Slot::B(level) => &self.levels[level][1],
            Slot::Skip(level) => &self.levels[level][2],
        }
    }
}

/// Where a call's mosaic lies and what it asks for, all in the photo's mosaic: `window` is the
/// buffer handed in as `(left, top, width, height)`, `frame` the whole mosaic's size, and `rect` the
/// part to upscale, on whole 2x2 sites. The window has to reach [`Upscaler::margin`] past the
/// rectangle wherever the frame does.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub window: (usize, usize, usize, usize),
    pub frame: (usize, usize),
    pub rect: (usize, usize, usize, usize),
}

impl Upscaler {
    /// The network `export` wrote, as `manifest` (`weights.json`) and `weights` (`weights.bin`), on
    /// `arm`; `None` where the device cannot run that arm.
    pub fn new(
        gpu: &'static crate::gpu::Gpu,
        manifest: &str,
        weights: &[u8],
        arm: Arm,
    ) -> Result<Option<Upscaler>, String> {
        let manifest: serde_json::Value =
            serde_json::from_str(manifest).map_err(|e| format!("the manifest: {e}"))?;
        let stabilising = Stabilising::read(&manifest)?;
        let calibration = manifest["grain_calibration"]
            .as_f64()
            .ok_or("the manifest has no grain_calibration")?;
        let floats: Vec<f32> = weights
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes(word.try_into().expect("four")))
            .collect();
        let tensors = tensors(&manifest, &floats)?;
        let device = gpu.describing();
        if arm != Arm::Float && !device.features().contains(wgpu::Features::SHADER_F16) {
            return Ok(None);
        }
        let fragment = match arm.on_matrix_units() {
            true => match coop_fragment(gpu) {
                Some(fragment) => fragment,
                None => return Ok(None),
            },
            false => SPIRV_FRAGMENT,
        };
        let (ops, packed, blocks) = lay_out(&manifest, &tensors, fragment)?;

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("upscale"),
            source: wgpu::ShaderSource::Wgsl(forward_pass(arm != Arm::Float).into()),
        });
        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("upscale"),
                entries: &[
                    storage(0, true),
                    storage(1, true),
                    storage(2, false),
                    storage(3, true),
                    storage(4, true),
                    storage(5, false),
                    wgpu::BindGroupLayoutEntry {
                        binding: 6,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: true,
                            min_binding_size: wgpu::BufferSize::new(
                                std::mem::size_of::<Step>() as u64
                            ),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 7,
                        visibility: wgpu::ShaderStages::COMPUTE,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: wgpu::BufferSize::new(
                                std::mem::size_of::<Photo>() as u64
                            ),
                        },
                        count: None,
                    },
                ],
            });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("upscale"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = |name: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let coop = match arm.on_matrix_units() {
            true => match coop_kernels(gpu, fragment, &blocks) {
                Some(coop) => Some(coop),
                None => return Ok(None),
            },
            false => None,
        };

        let mut recording = gpu.record();
        let held = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("upscale weights"),
            contents: bytemuck::cast_slice(&packed),
            usage: wgpu::BufferUsages::STORAGE,
        });
        recording.submit();

        let reach = reach(&ops);
        Ok(Some(Upscaler {
            arm,
            ops,
            reach,
            stabilising,
            calibration: calibration as f32,
            weights: held,
            pack: pipeline("pack"),
            convs: CONVS
                .iter()
                .map(|(input, output, _)| pipeline(&format!("conv_{input}_{output}")))
                .collect(),
            pool: pipeline("pool"),
            rise: pipeline("rise"),
            double: pipeline("double_add"),
            leave: pipeline("leave"),
            layout,
            coop,
            held: Mutex::new(None),
            halving: Halving::new(gpu),
        }))
    }

    /// The network on the fastest arm this device runs: the matrix units, then `half` WGSL, then
    /// `float`.
    pub fn fastest(
        gpu: &'static crate::gpu::Gpu,
        manifest: &str,
        weights: &[u8],
    ) -> Result<Upscaler, String> {
        for arm in Arm::ALL {
            if let Some(built) = Upscaler::new(gpu, manifest, weights, arm)? {
                return Ok(built);
            }
        }
        Err("no arm of the upscaler runs on this device".into())
    }

    pub fn arm(&self) -> Arm {
        self.arm
    }

    /// How far past a rectangle, in mosaic pixels, the window handed to [`Upscaler::upscale`]
    /// has to reach for the rectangle to come out as the whole frame's would.
    pub fn margin(&self) -> usize {
        self.reach * 2
    }

    /// What a photo's planes go through, from its R, G, B conditioning `gains`, its Bayer `cfa`, its
    /// fitted `noise`, and the Detail sliders as `(luminance, colour)`, 0 to 100. Luminance is the
    /// share of the photo's noise left in its light, none at 100 and all of the input's own at 0;
    /// colour is how much of the colour the network moved to keep.
    pub fn photo(
        &self,
        gains: [f32; 3],
        cfa: &crate::cfa::Cfa,
        noise: crate::galosh::NoiseModel,
        (luminance, colour): (f64, f64),
    ) -> Result<Photo, String> {
        let positions = positions(cfa).ok_or("the upscaler takes a Bayer mosaic")?;
        let [red, green, blue] = gains;
        let plane_gains = [red, green, green, blue];
        let &Stabilising {
            reference_alpha,
            max_scale,
            min_floor,
            max_floor,
        } = &self.stabilising;
        let mut floors = [0.0; 4];
        let mut scales = [0.0; 4];
        for (c, gain) in plane_gains.into_iter().enumerate() {
            let a = (noise.alpha * gain / green).max(reference_alpha / (max_scale * max_scale));
            let b = noise.sigma_sq * gain * gain / (green * green);
            // Floored below by 3 standard deviations of read noise, so black's noise isn't clamped away.
            floors[c] = (b / a).max(3.0 * b.sqrt()).clamp(min_floor, max_floor);
            scales[c] = (reference_alpha / a).sqrt();
        }
        let (luma, grain) = light_of(luminance);
        Ok(Photo {
            floors,
            roots: floors.map(f32::sqrt),
            scales,
            gains: plane_gains,
            positions,
            alpha: noise.alpha / green,
            sigma_sq: noise.sigma_sq / (green * green),
            grain: self.calibration * grain as f32,
            luma: luma as f32,
            colour: (colour / 100.0) as f32,
            _pad: [0; 3],
        })
    }

    /// `at.rect` of `mosaic`, a window of the photo's conditioned mosaic as `at` places it, upscaled
    /// into `into`, the mosaic at twice the size over twice the rectangle
    /// ([`answer_bytes`]), in tiles of at most `tile` packed pixels a side or as large as fit.
    /// Recorded and submitted, not waited for.
    pub fn upscale(
        &self,
        gpu: &'static crate::gpu::Gpu,
        mosaic: &crate::gpu::Buffer,
        at: Placement,
        into: &crate::gpu::Buffer,
        photo: &Photo,
        tile: Option<usize>,
    ) -> Result<(), String> {
        let (rect_left, rect_top, rect_width, rect_height) = at.rect;
        let (window_left, window_top, window_width, window_height) = at.window;
        if [rect_left, rect_top, rect_width, rect_height]
            .iter()
            .any(|n| n % 2 != 0)
            || rect_width == 0
            || rect_height == 0
        {
            return Err(format!("{:?} is not whole 2x2 sites", at.rect));
        }
        if into.size() < answer_bytes(rect_width, rect_height) {
            return Err(format!("{} bytes cannot hold the answer", into.size()));
        }
        let margin = self.margin();
        let short = window_left > rect_left.saturating_sub(margin)
            || window_top > rect_top.saturating_sub(margin)
            || window_left + window_width < (rect_left + rect_width + margin).min(at.frame.0 & !1)
            || window_top + window_height < (rect_top + rect_height + margin).min(at.frame.1 & !1);
        if short {
            return Err(format!(
                "{:?} does not reach the margin past {:?}",
                at.window, at.rect
            ));
        }
        let real = (at.frame.0 / 2, at.frame.1 / 2);
        let padded = (
            real.0.next_multiple_of(COARSEST),
            real.1.next_multiple_of(COARSEST),
        );
        let wanted = (
            rect_left / 2,
            rect_top / 2,
            (rect_left + rect_width) / 2,
            (rect_top + rect_height) / 2,
        );
        let origin = (
            wanted.0 / COARSEST * COARSEST,
            wanted.1 / COARSEST * COARSEST,
        );
        let reach = self.reach;
        let region_of = |(tw, th): (usize, usize)| {
            (
                (tw + 2 * reach).next_multiple_of(self.arm.tile().0.max(CONV_WIDE) * COARSEST),
                (th + 2 * reach).next_multiple_of(CONV_TALL.max(COOP_TALL) * COARSEST),
            )
        };
        let cell = match self.arm {
            Arm::Float => 4,
            _ => 2,
        };
        let binding = gpu.limits().max_storage_buffer_binding_size as usize;
        let fits = |side: usize| {
            let (rw, rh) = region_of((side, side));
            let cells = (rw + 2) * (rh + 2) * CHANNELS;
            cells <= TENSOR_CELLS_MOST && cells * cell <= binding
        };
        let most = match tile {
            Some(asked) => asked.next_multiple_of(COARSEST),
            None => (1..=64)
                .rev()
                .map(|n| n * 64)
                .find(|&side| fits(side))
                .ok_or("not even a 64 pixel tile fits a binding")?,
        };
        if !fits(most) {
            return Err(format!("a tile of {most} does not fit a binding"));
        }
        let cut = |extent: usize| {
            let count = extent.div_ceil(most).max(1);
            (count, extent.div_ceil(count).next_multiple_of(COARSEST))
        };
        let ((across, tw), (down, th)) = (cut(wanted.2 - origin.0), cut(wanted.3 - origin.1));
        let region = region_of((tw, th));

        let mut kept = self.held.lock().expect("the tensors' lock");
        let held = kept.as_ref().map_or((0, 0), |t| t.region);
        if held.0 < region.0 || held.1 < region.1 {
            *kept = Some(self.tensors(gpu, (held.0.max(region.0), held.1.max(region.1)), cell));
        }
        let tensors = kept.as_mut().expect("just made");
        let relaid = tensors.laid != region;
        tensors.laid = region;
        let tensors = &*tensors;

        let mut recording = gpu.record();
        recording.holding(mosaic);
        recording.holding(into);
        recording.holding(&self.weights);
        let buffers = std::iter::once(&tensors.planes).chain(tensors.levels.iter().flatten());
        for buffer in buffers {
            recording.holding(buffer);
            // Another layout's interior lies where this one's ring of zeros is.
            if relaid {
                recording.encoder().clear_buffer(buffer, 0, None);
            }
        }

        let planes_channels = match self.arm.on_matrix_units() {
            true => MATRIX_PLANES,
            false => PLANES,
        };
        let mut steps: Vec<Step> = Vec::new();
        for ty in 0..down {
            for tx in 0..across {
                let tile_left = origin.0 + tx * tw;
                let tile_top = origin.1 + ty * th;
                let left = tile_left as i32 - reach as i32;
                let top = tile_top as i32 - reach as i32;
                let inner_left = tile_left.max(wanted.0);
                let inner_top = tile_top.max(wanted.1);
                let inner_right = (tile_left + tw).min(wanted.2);
                let inner_bottom = (tile_top + th).min(wanted.3);
                let base = Step {
                    real_width: real.0 as u32,
                    real_height: real.1 as u32,
                    planes_channels: planes_channels as u32,
                    inner_left: (inner_left as i32 - left) as u32,
                    inner_top: (inner_top as i32 - top) as u32,
                    inner_width: inner_right.saturating_sub(inner_left) as u32,
                    inner_height: inner_bottom.saturating_sub(inner_top) as u32,
                    window_left: window_left as u32,
                    window_top: window_top as u32,
                    window_width: window_width as u32,
                    window_height: window_height as u32,
                    out_left: (rect_left * 2) as u32,
                    out_top: (rect_top * 2) as u32,
                    out_width: (rect_width * 2) as u32,
                    out_height: (rect_height * 2) as u32,
                    ..Default::default()
                };
                let at_level = |step: Step, level: usize| Step {
                    width: (region.0 >> level) as u32,
                    height: (region.1 >> level) as u32,
                    left: left / (1 << level),
                    top: top / (1 << level),
                    frame_width: (padded.0 >> level) as u32,
                    frame_height: (padded.1 >> level) as u32,
                    ..step
                };
                let with_other = |step: Step, level: usize| Step {
                    other_width: (region.0 >> level) as u32,
                    other_height: (region.1 >> level) as u32,
                    other_left: left / (1 << level),
                    other_top: top / (1 << level),
                    ..step
                };
                for op in &self.ops {
                    let step = at_level(base, op.level());
                    steps.push(match *op {
                        Op::Pack | Op::Leave { .. } => step,
                        Op::Conv { layer, .. } => Step {
                            weights_at: match self.arm {
                                Arm::Matrix => layer.blocks_at,
                                _ => layer.weights_at,
                            } as u32,
                            bias_at: layer.bias_at as u32,
                            slope_at: layer.slope_at as u32,
                            ..step
                        },
                        Op::Pool {
                            level, channels, ..
                        } => Step {
                            channels: channels as u32,
                            ..with_other(step, level - 1)
                        },
                        Op::Rise {
                            input,
                            output,
                            weights_at,
                            bias_at,
                            ..
                        } => Step {
                            channels: input as u32,
                            out_channels: output as u32,
                            weights_at: weights_at as u32,
                            bias_at: bias_at as u32,
                            ..step
                        },
                        Op::Double {
                            level, channels, ..
                        } => Step {
                            channels: channels as u32,
                            ..with_other(step, level + 1)
                        },
                    });
                }
            }
        }
        let stride = (std::mem::size_of::<Step>() as u64)
            .next_multiple_of(u64::from(gpu.limits().min_uniform_buffer_offset_alignment));
        let mut bytes = vec![0u8; steps.len() * stride as usize];
        for (i, step) in steps.iter().enumerate() {
            bytes[i * stride as usize..][..std::mem::size_of::<Step>()]
                .copy_from_slice(bytemuck::bytes_of(step));
        }
        let uniforms = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("upscale steps"),
            contents: &bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let photo = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("upscale photo"),
            contents: bytemuck::bytes_of(photo),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let group = |given: Slot, made: Slot, aside: Slot| {
            gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("upscale"),
                layout: &self.layout,
                entries: &[
                    entry(0, &self.weights),
                    entry(1, tensors.of(given)),
                    entry(2, tensors.of(made)),
                    entry(3, tensors.of(aside)),
                    entry(4, mosaic),
                    entry(5, into),
                    wgpu::BindGroupEntry {
                        binding: 6,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: &uniforms,
                            offset: 0,
                            size: wgpu::BufferSize::new(std::mem::size_of::<Step>() as u64),
                        }),
                    },
                    entry(7, &photo),
                ],
            })
        };
        // A binding may not be read and written at once, so a step that has nothing to set aside
        // or to read names a tensor it does not write.
        let groups: Vec<Option<wgpu::BindGroup>> = self
            .ops
            .iter()
            .map(|op| match *op {
                Op::Pack => Some(group(Slot::A(0), Slot::Planes, Slot::A(0))),
                Op::Conv { from, to, .. } if self.coop.is_none() => Some(group(from, to, from)),
                Op::Conv { .. } => None,
                Op::Pool { from, to, .. } | Op::Rise { from, to, .. } => {
                    Some(group(from, to, from))
                }
                Op::Double { rise, skip, to, .. } => Some(group(rise, to, skip)),
                Op::Leave { from } => Some(group(from, from.other(0), Slot::Planes)),
            })
            .collect();
        let coop_groups: Vec<Option<wgpu::BindGroup>> = self
            .ops
            .iter()
            .map(|op| match (op, &self.coop) {
                (Op::Conv { from, to, .. }, Some(coop)) => {
                    Some(gpu.bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("upscale coop"),
                        layout: &coop.layout,
                        entries: &[
                            entry(0, &coop.blocks),
                            entry(1, tensors.of(*from)),
                            entry(2, tensors.of(*to)),
                            entry(3, &self.weights),
                        ],
                    }))
                }
                _ => None,
            })
            .collect();

        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            for (n, step) in steps.iter().enumerate() {
                let index = n % self.ops.len();
                let op = self.ops[index];
                let offset = (n as u64 * stride) as u32;
                let level = op.level();
                let (width, height) = (region.0 >> level, region.1 >> level);
                let lanes = |quads: usize| {
                    (
                        (width * quads).div_ceil(STEP_WIDE) as u32,
                        height.div_ceil(STEP_TALL) as u32,
                    )
                };
                let (x, y, z, pipeline) = match op {
                    Op::Pack => (
                        width.div_ceil(STEP_WIDE) as u32,
                        height.div_ceil(STEP_TALL) as u32,
                        1,
                        &self.pack,
                    ),
                    Op::Conv { layer, .. } => {
                        let (_, output, _) = CONVS[layer.kind];
                        let slices = output.div_ceil(OUT_MOST) as u32;
                        let (wide, tall) = self.arm.tile();
                        if let (Some(coop), Some(group)) = (&self.coop, &coop_groups[index]) {
                            pass.set_pipeline(&coop.convs[layer.kind]);
                            pass.set_bind_group(0, group, &[]);
                            pass.set_immediates(0, bytemuck::bytes_of(step));
                            pass.dispatch_workgroups(
                                (width / wide) as u32,
                                (height / tall) as u32,
                                slices,
                            );
                            continue;
                        }
                        (
                            (width / wide) as u32,
                            (height / tall) as u32,
                            slices,
                            &self.convs[layer.kind],
                        )
                    }
                    Op::Pool { channels, .. } => {
                        let (x, y) = lanes(channels / 4);
                        (x, y, 1, &self.pool)
                    }
                    Op::Rise { output, .. } => {
                        let (x, y) = lanes(output / 4);
                        (x, y, 1, &self.rise)
                    }
                    Op::Double { channels, .. } => {
                        let (x, y) = lanes(channels / 4);
                        (x, y, 1, &self.double)
                    }
                    Op::Leave { .. } => {
                        if step.inner_width == 0 || step.inner_height == 0 {
                            continue;
                        }
                        (
                            step.inner_width.div_ceil(STEP_WIDE as u32),
                            step.inner_height.div_ceil(STEP_TALL as u32),
                            1,
                            &self.leave,
                        )
                    }
                };
                pass.set_pipeline(pipeline);
                pass.set_bind_group(
                    0,
                    groups[index].as_ref().expect("a WGSL step's group"),
                    &[offset],
                );
                pass.dispatch_workgroups(x, y, z);
            }
        }
        recording.submit();
        Ok(())
    }

    /// Frees the tensors [`Upscaler::upscale`] keeps between calls, for a caller done upscaling.
    pub fn release(&self) {
        *self.held.lock().expect("the tensors' lock") = None;
    }

    /// [`Halving::halve`].
    pub fn halve(
        &self,
        gpu: &crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'static>,
        plane: &crate::gpu::Buffer,
        source: (usize, usize),
    ) -> crate::gpu::Buffer {
        self.halving.halve(gpu, recording, plane, source)
    }

    fn tensors(&self, gpu: &crate::gpu::Gpu, region: (usize, usize), cell: usize) -> Tensors {
        let mut recording = gpu.record();
        let mut tensor = |label: &str, level: usize, channels: usize| {
            let pixels = ((region.0 >> level) + 2) * ((region.1 >> level) + 2);
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (pixels * channels * cell) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let planes = tensor("upscale planes", 0, MATRIX_PLANES);
        let levels = (0..LEVELS)
            .map(|level| {
                let channels = CHANNELS << level;
                [
                    tensor("upscale a", level, channels),
                    tensor("upscale b", level, channels),
                    tensor(
                        "upscale skip",
                        level,
                        if level + 1 < LEVELS { channels } else { 1 },
                    ),
                ]
            })
            .collect();
        Tensors {
            region,
            laid: region,
            planes,
            levels,
        }
    }
}

impl Halving {
    /// `plane`, RCD's three `f32` a site over a `source` of the upscale, halved into a plane of its
    /// own through Lanczos-3, recorded into `recording`.
    pub fn halve(
        &self,
        gpu: &crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'static>,
        plane: &crate::gpu::Buffer,
        source: (usize, usize),
    ) -> crate::gpu::Buffer {
        let out = (source.0 / 2, source.1 / 2);
        let smaller = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("halved plane"),
            size: ((out.0 * out.1).max(1) * 3 * std::mem::size_of::<f32>()) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let sizes = [source.0, source.1, out.0, out.1].map(|n| n as u32);
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("halving"),
            contents: bytemuck::cast_slice(&sizes),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("halving"),
            layout: &self.layout,
            entries: &[entry(0, &uniform), entry(1, plane), entry(2, &smaller)],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(out.0 * out.1);
            pass.dispatch_workgroups(x, y, 1);
        }
        smaller
    }

    pub fn new(gpu: &crate::gpu::Gpu) -> Halving {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("supersample"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/supersample.wgsl")).into(),
            ),
        });
        let buffer = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("halving"),
            entries: &[
                buffer(0, wgpu::BufferBindingType::Uniform),
                buffer(1, wgpu::BufferBindingType::Storage { read_only: true }),
                buffer(2, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("halving"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("halve_lanczos"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("halve_lanczos"),
            compilation_options: Default::default(),
            cache: None,
        });
        Halving { layout, pipeline }
    }
}

/// The model this build carries: the plan for walking the weights, embedded on both hosts, and the
/// weights, embedded in a rendition's binary and fetched by a page, as `pmrid::weights` says why.
/// An app that has downloaded a newer one hands it over with [`hold_model`].
const MANIFEST: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/.upscaler/weights.json"
));

#[cfg(not(target_arch = "wasm32"))]
const BUNDLED: Option<&[u8]> = Some(include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/.upscaler/weights.bin"
)));

#[cfg(target_arch = "wasm32")]
const BUNDLED: Option<&[u8]> = None;

struct Model {
    manifest: &'static str,
    weights: Option<&'static [u8]>,
    built: Option<Option<&'static Upscaler>>,
}

const UNBUILT: Model = Model {
    manifest: MANIFEST,
    weights: BUNDLED,
    built: None,
};

#[cfg(not(target_arch = "wasm32"))]
fn with_model<R>(f: impl FnOnce(&mut Model) -> R) -> R {
    static MODEL: std::sync::Mutex<Model> = std::sync::Mutex::new(UNBUILT);
    f(&mut MODEL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner))
}

// A page's network holds WebGPU handles, which are neither `Send` nor `Sync`.
#[cfg(target_arch = "wasm32")]
fn with_model<R>(f: impl FnOnce(&mut Model) -> R) -> R {
    thread_local! {
        static MODEL: std::cell::RefCell<Model> = const { std::cell::RefCell::new(UNBUILT) };
    }
    MODEL.with(|held| f(&mut held.borrow_mut()))
}

/// What the page fetched of the model this build carries, kept for the rest of the tab.
#[cfg(target_arch = "wasm32")]
pub fn hold_weights(bytes: Vec<u8>) {
    with_model(|held| {
        held.manifest = MANIFEST;
        held.weights = Some(Box::leak(bytes.into_boxed_slice()));
        held.built = None;
    });
}

/// A model the app downloaded, in place of the one this build carries, from the next frame on.
///
/// ponytail: leaks the model it replaces, network and all, since a frame mid-render may still hold
/// it; one leak per model update for the life of the process.
pub fn hold_model(manifest: String, weights: Vec<u8>) {
    with_model(|held| {
        held.manifest = Box::leak(manifest.into_boxed_str());
        held.weights = Some(Box::leak(weights.into_boxed_slice()));
        held.built = None;
    });
}

/// The network on its fastest arm, built on the first frame that asks for it and kept until a model
/// replaces it. `None` in a page until it has handed over what it fetched.
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Upscaler> {
    with_model(|held| {
        if let Some(tried) = held.built {
            return tried;
        }
        let made = Upscaler::fastest(gpu, held.manifest, held.weights?)
            .map_err(|why| crate::warn(&format!("rawshim: the upscaler did not build: {why}")))
            .ok()
            .map(|made| &*Box::leak(Box::new(made)));
        held.built = Some(made);
        made
    })
}

/// The bytes [`Upscaler::upscale`]'s answer for a `width` by `height` rectangle takes.
pub fn answer_bytes(width: usize, height: usize) -> u64 {
    (width * 2 * height * 2 * std::mem::size_of::<f32>()) as u64
}

/// Which of a 2x2's positions holds each of the network's planes: red, the green on red's row, the
/// green on blue's, blue. `None` for a pattern that is not Bayer.
fn positions(cfa: &crate::cfa::Cfa) -> Option<[u32; 4]> {
    if !cfa.is_bayer() {
        return None;
    }
    let red = (0..4).find(|&p| cfa.colour_at(p / 2, p % 2) == 0)?;
    let (row, column) = (red / 2, red % 2);
    Some([
        red as u32,
        (row * 2 + (1 - column)) as u32,
        ((1 - row) * 2 + column) as u32,
        ((1 - row) * 2 + (1 - column)) as u32,
    ])
}

/// How far a pixel of the answer reads the planes, in packed pixels, rounded out to the coarsest
/// level's grid: a 3x3 reaches one pixel of its level and a pool or a doubling one more, each
/// level's pixels twice as wide as the level above.
fn reach(ops: &[Op]) -> usize {
    let mut levels = [0usize; LEVELS];
    for op in ops {
        match *op {
            Op::Conv { level, .. } | Op::Pool { level, .. } | Op::Double { level, .. } => {
                levels[level] += 1
            }
            _ => {}
        }
    }
    let reach: usize = levels
        .iter()
        .enumerate()
        .map(|(level, steps)| steps << level)
        .sum();
    reach.next_multiple_of(COARSEST)
}

fn entry<'a>(binding: u32, buffer: &'a crate::gpu::Buffer) -> wgpu::BindGroupEntry<'a> {
    wgpu::BindGroupEntry {
        binding,
        resource: buffer.as_entire_binding(),
    }
}

/// Each tensor of the manifest by name, as its shape and its floats.
fn tensors<'a>(
    manifest: &serde_json::Value,
    floats: &'a [f32],
) -> Result<Vec<(String, Vec<usize>, &'a [f32])>, String> {
    let listed = manifest["tensors"]
        .as_array()
        .ok_or("the manifest has no tensors")?;
    listed
        .iter()
        .map(|t| {
            let name = t["name"]
                .as_str()
                .ok_or("a tensor without a name")?
                .to_string();
            let shape: Vec<usize> = t["shape"]
                .as_array()
                .ok_or("a tensor without a shape")?
                .iter()
                .map(|n| {
                    n.as_u64()
                        .map(|n| n as usize)
                        .ok_or("a shape that is not counts")
                })
                .collect::<Result<_, _>>()?;
            let at = t["offset"].as_u64().ok_or("a tensor without an offset")? as usize;
            let count: usize = shape.iter().product();
            let values = floats
                .get(at..at + count)
                .ok_or_else(|| format!("{name} runs past the weights"))?;
            Ok((name, shape, values))
        })
        .collect()
}

/// The forward pass as steps, the `float` weights the WGSL reads and the fragments the matrix units
/// read.
///
/// The network is `models/upscaler/src/upscaler/model.py`'s `MultiScale`: `encoders.L.N`,
/// `decoders.L.N`, `rises.L` and `out`, each 3x3 followed by its PReLU's slopes at `N+1` but `out`.
fn lay_out(
    manifest: &serde_json::Value,
    tensors: &[(String, Vec<usize>, &[f32])],
    fragment: usize,
) -> Result<(Vec<Op>, Vec<f32>, Vec<u16>), String> {
    let counts = |name: &str| -> Result<Vec<usize>, String> {
        manifest[name]
            .as_array()
            .ok_or(format!("the manifest has no {name}"))?
            .iter()
            .map(|n| {
                n.as_u64()
                    .map(|n| n as usize)
                    .ok_or(format!("{name} is not counts"))
            })
            .collect()
    };
    let encoders = counts("encoder_blocks")?;
    let decoders = counts("decoder_blocks")?;
    if manifest["channels"].as_u64() != Some(CHANNELS as u64)
        || encoders.len() != LEVELS
        || decoders.len() != LEVELS - 1
    {
        return Err(format!(
            "the kernels hold {LEVELS} levels from {CHANNELS} channels, which this network is not"
        ));
    }
    let named = |name: &str| {
        tensors
            .iter()
            .find(|(n, _, _)| n == name)
            .map(|(_, shape, values)| (shape.as_slice(), *values))
            .ok_or(format!("the manifest has no {name}"))
    };
    let mut packed: Vec<f32> = Vec::new();
    let mut blocks: Vec<u16> = Vec::new();
    let mut ops = vec![Op::Pack];

    let conv =
        |packed: &mut Vec<f32>, blocks: &mut Vec<u16>, prefix: &str, slopes: Option<&str>| {
            let (shape, values) = named(&format!("{prefix}.weight"))?;
            let &[output, input, 3, 3] = shape else {
                return Err(format!("{prefix} is {shape:?}, not a 3x3 convolution"));
            };
            let linear = slopes.is_none();
            let kind = CONVS
                .iter()
                .position(|&c| c == (input, output, linear))
                .ok_or_else(|| format!("no kernel holds {prefix}, {input} to {output}"))?;
            let (_, bias) = named(&format!("{prefix}.bias"))?;
            let weights_at = packed.len();
            for tap in 0..9 {
                for i in 0..input {
                    for o in 0..output {
                        packed.push(values[(o * input + i) * 9 + tap]);
                    }
                }
            }
            let bias_at = packed.len();
            packed.extend_from_slice(bias);
            let slope_at = packed.len();
            if let Some(slopes) = slopes {
                packed.extend_from_slice(named(slopes)?.1);
            }
            // `float4` reads of a layer's taps want each start on a fourth float.
            packed.resize(packed.len().next_multiple_of(4), 0.0);

            // The first layer reads the planes as the matrix units are handed them, padded to 16.
            let deep = input.next_multiple_of(MATRIX_PLANES);
            let slice = output.min(OUT_MOST);
            let (depth, across) = (deep / fragment, slice / fragment);
            let blocks_at = blocks.len();
            blocks.resize(blocks_at + 9 * deep * output, 0);
            for tap in 0..9 {
                for i in 0..input {
                    for o in 0..output {
                        let (s, n) = (o / slice, o % slice);
                        let block = ((s * 9 + tap) * depth + i / fragment) * across + n / fragment;
                        let at = blocks_at
                            + block * fragment * fragment
                            + (i % fragment) * fragment
                            + n % fragment;
                        blocks[at] =
                            half::f16::from_f32(values[(o * input + i) * 9 + tap]).to_bits();
                    }
                }
            }
            Ok(Layer {
                kind,
                weights_at,
                bias_at,
                slope_at,
                blocks_at,
            })
        };

    let mut from = Slot::Planes;
    for (level, &blocks_of) in encoders.iter().enumerate() {
        if level > 0 {
            let to = Slot::A(level);
            ops.push(Op::Pool {
                level,
                channels: CHANNELS << (level - 1),
                from,
                to,
            });
            from = to;
        }
        let layers = blocks_of + 1;
        for n in 0..layers {
            let layer = conv(
                &mut packed,
                &mut blocks,
                &format!("encoders.{level}.{}", 2 * n),
                Some(&format!("encoders.{level}.{}.weight", 2 * n + 1)),
            )?;
            let to = match (n + 1 == layers, level + 1 < LEVELS) {
                (true, true) => Slot::Skip(level),
                _ => from.other(level),
            };
            ops.push(Op::Conv {
                level,
                layer,
                from,
                to,
            });
            from = to;
        }
    }
    for level in (0..LEVELS - 1).rev() {
        let coarse = level + 1;
        let (shape, values) = named(&format!("rises.{level}.weight"))?;
        let &[output, input, 1, 1] = shape else {
            return Err(format!("rises.{level} is {shape:?}, not a 1x1 convolution"));
        };
        let (_, bias) = named(&format!("rises.{level}.bias"))?;
        let weights_at = packed.len();
        for i in 0..input {
            for o in 0..output {
                packed.push(values[o * input + i]);
            }
        }
        let bias_at = packed.len();
        packed.extend_from_slice(bias);
        packed.resize(packed.len().next_multiple_of(4), 0.0);
        let risen = from.other(coarse);
        ops.push(Op::Rise {
            level: coarse,
            input,
            output,
            weights_at,
            bias_at,
            from,
            to: risen,
        });
        from = Slot::A(level);
        ops.push(Op::Double {
            level,
            channels: output,
            rise: risen,
            skip: Slot::Skip(level),
            to: from,
        });
        for n in 0..decoders[level] {
            let layer = conv(
                &mut packed,
                &mut blocks,
                &format!("decoders.{level}.{}", 2 * n),
                Some(&format!("decoders.{level}.{}.weight", 2 * n + 1)),
            )?;
            let to = from.other(level);
            ops.push(Op::Conv {
                level,
                layer,
                from,
                to,
            });
            from = to;
        }
    }
    let layer = conv(&mut packed, &mut blocks, "out", None)?;
    let to = from.other(0);
    ops.push(Op::Conv {
        level: 0,
        layer,
        from,
        to,
    });
    ops.push(Op::Leave { from: to });
    Ok((ops, packed, blocks))
}

/// `slang/upscale.slang` as WGSL, holding its tensors in `half` or in `float`.
fn forward_pass(half: bool) -> &'static str {
    match half {
        true => include_str!(concat!(env!("OUT_DIR"), "/wgsl/upscale_half.wgsl")),
        false => include_str!(concat!(env!("OUT_DIR"), "/wgsl/upscale.wgsl")),
    }
}

/// The fragment this device's matrix units multiply, `None` where it has none this reaches.
fn coop_fragment(gpu: &crate::gpu::Gpu) -> Option<usize> {
    if !gpu
        .describing()
        .features()
        .contains(crate::pmrid::tensor_features())
    {
        return None;
    }
    match gpu.backend {
        wgpu::Backend::Vulkan => Some(SPIRV_FRAGMENT),
        wgpu::Backend::Metal => Some(METAL_FRAGMENT),
        _ => None,
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn coop_kernels(gpu: &crate::gpu::Gpu, fragment: usize, blocks: &[u16]) -> Option<Coop> {
    let device = gpu.describing();
    let mut handed = wgpu::ShaderModuleDescriptorPassthrough {
        label: Some("upscale coop"),
        ..Default::default()
    };
    match (gpu.backend, fragment) {
        (wgpu::Backend::Metal, METAL_FRAGMENT) => {
            handed.msl = Some(
                include_str!(concat!(env!("OUT_DIR"), "/passthrough/upscale_coop.metal")).into(),
            );
        }
        (wgpu::Backend::Vulkan, SPIRV_FRAGMENT) => {
            handed.spirv = Some(wgpu::util::make_spirv_raw(include_bytes!(concat!(
                env!("OUT_DIR"),
                "/passthrough/upscale_coop.spv"
            ))));
        }
        _ => return None,
    }
    let names: Vec<String> = CONVS
        .iter()
        .map(|&(input, output, _)| {
            format!("coop_{}_{output}", input.next_multiple_of(MATRIX_PLANES))
        })
        .collect();
    let entry_points: Vec<wgpu::PassthroughShaderEntryPoint<'_>> = names
        .iter()
        .map(|name| wgpu::PassthroughShaderEntryPoint {
            name: name.clone().into(),
            workgroup_size: (128, 1, 1),
        })
        .collect();
    let module = {
        #[expect(unsafe_code)]
        // SAFETY: the kernel is this repository's, compiled by `build.rs` from
        // `slang/passthrough/upscale_coop.slang`, and the layout below is what it declares.
        unsafe {
            device.create_shader_module_passthrough(wgpu::ShaderModuleDescriptorPassthrough {
                entry_points: entry_points.into(),
                ..handed
            })
        }
    };
    let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("upscale coop"),
        entries: &[
            storage(0, true),
            storage(1, true),
            storage(2, false),
            storage(3, true),
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("upscale coop"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: std::mem::size_of::<Step>() as u32,
    });
    let convs = names
        .iter()
        .map(|name| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        })
        .collect();
    let mut recording = gpu.record();
    let blocks = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("upscale coop blocks"),
        contents: bytemuck::cast_slice(blocks),
        usage: wgpu::BufferUsages::STORAGE,
    });
    recording.submit();
    Some(Coop {
        layout,
        convs,
        blocks,
    })
}

#[cfg(target_arch = "wasm32")]
fn coop_kernels(_gpu: &crate::gpu::Gpu, _fragment: usize, _blocks: &[u16]) -> Option<Coop> {
    None
}

#[cfg(test)]
mod tests {
    use super::{Arm, Placement, Upscaler};
    use crate::condition::Mosaic;

    /// 100 is the network's light alone, 75 adds a quarter of the photo's grain, 0 is the input,
    /// and the noise left in rises with every step down.
    #[test]
    fn luminance_runs_from_clean_through_grain_to_the_input() {
        assert_eq!(super::light_of(100.0), (1.0, 0.0));
        assert_eq!(super::light_of(75.0), (1.0, 0.25));
        assert_eq!(super::light_of(0.0), (0.0, 0.0));
        let left_in = |luminance: f64| {
            let (luma, grain) = super::light_of(luminance);
            (1.0 - luma).powi(2) + grain
        };
        for step in 0..100 {
            let luminance = f64::from(step);
            assert!((left_in(luminance) - (1.0 - luminance / 100.0)).abs() < 1e-12);
            assert!(left_in(luminance) > left_in(luminance + 1.0));
        }
    }

    #[test]
    fn a_held_model_replaces_the_built_one() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(before) = super::device(gpu) else {
            return;
        };
        let weights = super::BUNDLED.expect("a built network has weights");
        super::hold_model(super::MANIFEST.to_string(), weights.to_vec());
        let after = super::device(gpu).expect("the held model builds");
        assert!(!std::ptr::eq(before, after));
    }

    /// Any rectangle of a frame, cut into any tiles, upscales to that part of the whole frame's
    /// answer, grain and all, on every arm: what lets a loupe tile be the rendition.
    #[test]
    fn a_rectangle_is_the_whole_frames() {
        let Some(gpu) = crate::gpu::device() else {
            return;
        };
        let Some(weights) = super::BUNDLED else {
            return;
        };
        let (width, height) = (520, 392);
        let gains = [0.5, 1.0, 0.7];
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut noise = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0 - 0.5
        };
        let frame: Vec<f32> = (0..width * height)
            .map(|at| {
                let (x, y) = (at % width, at / width);
                let edge = if (x / 37 + y / 23) % 2 == 0 {
                    0.6
                } else {
                    0.15
                };
                let gain = gains[usize::from(cfa.colour_at(y % 2, x % 2))];
                (edge + 0.05 * noise()) * gain
            })
            .collect();
        let whole = Mosaic::upload(gpu, &frame, width, height);
        let noise = crate::galosh::NoiseModel {
            alpha: 4.121e-4,
            sigma_sq: 3.494e-6,
        };

        for arm in Arm::ALL {
            let Some(upscaler) =
                Upscaler::new(gpu, super::MANIFEST, weights, arm).expect("the network")
            else {
                continue;
            };
            let photo = upscaler
                .photo(gains, &cfa, noise, (75.0, 60.0))
                .expect("a photo");
            let upscaled = |rect: (usize, usize, usize, usize), tile: Option<usize>| {
                let margin = upscaler.margin();
                let left = rect.0.saturating_sub(margin);
                let top = rect.1.saturating_sub(margin);
                let right = (rect.0 + rect.2 + margin).min(width);
                let bottom = (rect.1 + rect.3 + margin).min(height);
                let window = whole.window(gpu, left, top, right - left, bottom - top);
                let into = Mosaic::plane(gpu, rect.2 * 2, rect.3 * 2);
                let at = Placement {
                    window: (left, top, window.width, window.height),
                    frame: (width, height),
                    rect,
                };
                upscaler
                    .upscale(gpu, &window.buffer, at, &into.buffer, &photo, tile)
                    .expect("an upscale");
                pollster::block_on(into.read(gpu)).expect("the answer reads back")
            };
            let reference = upscaled((0, 0, width, height), None);
            for (rect, tile) in [
                ((0, 0, width, height), Some(64)),
                ((130, 66, 200, 150), None),
                ((width - 96, height - 72, 96, 72), Some(32)),
            ] {
                let cut = upscaled(rect, tile);
                let mut worst = 0.0f32;
                for row in 0..rect.3 * 2 {
                    for column in 0..rect.2 * 2 {
                        let from = (rect.1 * 2 + row) * width * 2 + rect.0 * 2 + column;
                        let off = (reference[from] - cut[row * rect.2 * 2 + column]).abs();
                        worst = worst.max(off);
                    }
                }
                assert_eq!(
                    worst, 0.0,
                    "{arm:?}: {rect:?} in tiles of {tile:?} is not the whole frame's"
                );
            }
        }
    }
}
