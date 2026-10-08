//! The 2x mosaic upscaler of `models/upscaler` on the device.
//!
//! A conditioned RGGB mosaic in, the mosaic of a sensor with twice the photosites each way out.
//! `slang/upscale.slang` packs the input and writes the answer on every arm; the 3x3 layers between
//! run there too, or on the matrix units through `slang/passthrough/upscale_coop.slang` where the
//! device reaches them. A browser has no passthrough shader, so a page runs [`Arm::Half`] or
//! [`Arm::Float`].
//!
//! `examples/upscale_bench.rs` times every arm, and `models/upscaler`'s `upscaler.device_check`
//! holds each against torch.
//!
//! The frame is cut into tiles of one size, each grown by the network's reach so that a tile's
//! interior sees what the whole frame would: one packed pixel for every 3x3 layer.

use std::sync::Mutex;

/// What the forward pass computes on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Arm {
    /// The 3x3 layers on the matrix units, accumulated in `float`, over `half` tensors, a
    /// workgroup `rows` of 64 pixels: 1 or 2.
    MatrixWide { rows: usize },
    /// The same, accumulated in `half`, `rows` 1, 2 or 4.
    MatrixNarrow { rows: usize },
    /// The 3x3 layers as Winograd's F(2x2, 3x3) on the matrix units, accumulated in `half`.
    Winograd,
    /// All of it in WGSL over `half` tensors and in `half` arithmetic, which needs `shader-f16`,
    /// each thread `pixels` of a row: 4 or 8.
    Half { pixels: usize },
    /// All of it in WGSL in `float`.
    Float { pixels: usize },
}

impl Arm {
    fn on_matrix_units(self) -> bool {
        !matches!(self, Arm::Half { .. } | Arm::Float { .. })
    }

    /// The pixels a 3x3 layer's workgroup covers, across and down.
    fn tile(self) -> (usize, usize) {
        match self {
            Arm::MatrixWide { rows } | Arm::MatrixNarrow { rows } => (COOP_WIDE, rows),
            Arm::Winograd => (WINOGRAD_WIDE, WINOGRAD_TALL),
            Arm::Half { pixels } | Arm::Float { pixels } => (4 * pixels, WGSL_TALL),
        }
    }

    /// The pixels each thread of a WGSL 3x3 layer holds, on the arms with any.
    fn wgsl_pixels(self) -> usize {
        match self {
            Arm::Half { pixels } | Arm::Float { pixels } => pixels,
            _ => WGSL_PIXELS[0],
        }
    }
}

/// The channels between the first layer and the last, which are the only widths the kernels have.
const CHANNELS: usize = 48;
/// The input's planes, and what the last layer's channels shuffle into.
const PLANES: usize = 4;
const SHUFFLED: usize = PLANES * 4;
/// The input's planes as the matrix units read them, padded to a whole fragment.
const MATRIX_PLANES: usize = 16;

/// `pack` and `leave`'s workgroup in `slang/upscale.slang`, the height of its 3x3 layers' tile, and
/// the pixels a thread of those layers is compiled to hold.
const WGSL_WIDE: usize = 16;
const WGSL_TALL: usize = 8;
const WGSL_PIXELS: [usize; 2] = [4, 8];
/// `WIDE` in `slang/passthrough/upscale_coop.slang`, and the rows its entry points are compiled
/// for, by accumulator.
const COOP_WIDE: usize = 64;
const COOP_ROWS_WIDE: [usize; 2] = [1, 2];
const COOP_ROWS_NARROW: [usize; 3] = [1, 2, 4];
/// `WINO_WIDE` and `WINO_TALL` there, in pixels.
const WINOGRAD_WIDE: usize = 16;
const WINOGRAD_TALL: usize = 4;

/// `FRAGMENT` there, by backend, as `pmrid`'s kernel has it.
const SPIRV_FRAGMENT: usize = 16;
const METAL_FRAGMENT: usize = 8;

/// The most cells a tensor of a tile may hold.
const TENSOR_CELLS_MOST: usize = 1 << 28;

/// `Step` in `slang/upscale.slang` and `slang/passthrough/upscale_coop.slang`.
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
    floor: f32,
    floor_root: f32,
}

struct Layer {
    input: usize,
    output: usize,
    linear: bool,
    /// Where its taps, `[tap][in][out]`, its biases and its slopes are in the `float` weights.
    weights_at: usize,
    bias_at: usize,
    slope_at: usize,
    /// Where its fragments are in [`Coop::blocks`], directly or Winograd-transformed.
    blocks_at: usize,
    wino_at: usize,
}

/// Winograd's F(2x2, 3x3) `G`, which takes a 3x3 of taps to the 4x4 the transformed input meets.
const WINOGRAD_G: [[f32; 3]; 4] = [
    [1.0, 0.0, 0.0],
    [0.5, 0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.0, 0.0, 1.0],
];

pub struct Upscaler {
    arm: Arm,
    layers: Vec<Layer>,
    floor: f32,
    weights: crate::gpu::Buffer,
    layout: wgpu::BindGroupLayout,
    pack: wgpu::ComputePipeline,
    /// `conv_4_48`, `conv_48_48` and `conv_48_16`, each thread the arm's pixels.
    convs: [wgpu::ComputePipeline; 3],
    leave: wgpu::ComputePipeline,
    coop: Option<Coop>,
    held: Mutex<Option<Tensors>>,
}

struct Coop {
    layout: wgpu::BindGroupLayout,
    /// `coop_16_48`, `coop_48_48` and `coop_48_16`, accumulated as the arm says.
    convs: [wgpu::ComputePipeline; 3],
    blocks: crate::gpu::Buffer,
}

/// A tile's tensors, kept for the next frame cut the same way.
struct Tensors {
    region: (usize, usize),
    planes: crate::gpu::Buffer,
    a: crate::gpu::Buffer,
    b: crate::gpu::Buffer,
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
        let floor = manifest["stabiliser_floor"]
            .as_f64()
            .ok_or("the manifest has no stabiliser_floor")? as f32;
        let floats: Vec<f32> = weights
            .chunks_exact(4)
            .map(|word| f32::from_le_bytes(word.try_into().expect("four")))
            .collect();
        let tensors = tensors(&manifest, &floats)?;
        let compiled = match arm {
            Arm::MatrixWide { rows } => COOP_ROWS_WIDE.contains(&rows),
            Arm::MatrixNarrow { rows } => COOP_ROWS_NARROW.contains(&rows),
            Arm::Half { pixels } | Arm::Float { pixels } => WGSL_PIXELS.contains(&pixels),
            Arm::Winograd => true,
        };
        if !compiled {
            return Err(format!(
                "{arm:?} is not a shape the kernels are compiled for"
            ));
        }
        let device = gpu.describing();
        let half = !matches!(arm, Arm::Float { .. });
        if half && !device.features().contains(wgpu::Features::SHADER_F16) {
            return Ok(None);
        }
        let fragment = match arm.on_matrix_units() {
            true => match coop_fragment(gpu) {
                Some(fragment) => fragment,
                None => return Ok(None),
            },
            false => SPIRV_FRAGMENT,
        };
        let (layers, packed, blocks, wino) = lay_out(&tensors, fragment)?;

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("upscale"),
            source: wgpu::ShaderSource::Wgsl(forward_pass(half).into()),
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
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
                        min_binding_size: wgpu::BufferSize::new(std::mem::size_of::<Step>() as u64),
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
        let coop = match arm {
            Arm::Winograd => coop_kernels(gpu, arm, fragment, &wino),
            _ if arm.on_matrix_units() => coop_kernels(gpu, arm, fragment, &blocks),
            _ => None,
        };
        if arm.on_matrix_units() && coop.is_none() {
            return Ok(None);
        }

        let mut recording = gpu.record();
        let held = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("upscale weights"),
            contents: bytemuck::cast_slice(&packed),
            usage: wgpu::BufferUsages::STORAGE,
        });
        recording.submit();

        Ok(Some(Upscaler {
            arm,
            layers,
            floor,
            weights: held,
            pack: pipeline("pack"),
            convs: [
                pipeline(&format!("conv_4_48_{}", arm.wgsl_pixels())),
                pipeline(&format!("conv_48_48_{}", arm.wgsl_pixels())),
                pipeline(&format!("conv_48_16_{}", arm.wgsl_pixels())),
            ],
            leave: pipeline("leave"),
            layout,
            coop,
            held: Mutex::new(None),
        }))
    }

    pub fn arm(&self) -> Arm {
        self.arm
    }

    /// The network's reach in packed pixels, which each tile is grown by.
    fn reach(&self) -> usize {
        self.layers.len()
    }

    /// `mosaic`, a `width` by `height` RGGB mosaic of `f32`, upscaled into `into`, `2 * width` by
    /// `2 * height` of them ([`answer_bytes`]), in tiles of at most `tile` packed pixels a side or
    /// as large as fit. Recorded and submitted, not waited for.
    pub fn upscale(
        &self,
        gpu: &'static crate::gpu::Gpu,
        mosaic: &crate::gpu::Buffer,
        width: usize,
        height: usize,
        into: &crate::gpu::Buffer,
        tile: Option<usize>,
    ) -> Result<(), String> {
        if width % 2 != 0 || height % 2 != 0 || width == 0 || height == 0 {
            return Err(format!("a {width}x{height} mosaic is not whole RGGB quads"));
        }
        let (pw, ph) = (width / 2, height / 2);
        let reach = self.reach();
        let planes_channels = match self.arm.on_matrix_units() {
            true => MATRIX_PLANES,
            false => PLANES,
        };
        let cell = match self.arm {
            Arm::Float { .. } => 4,
            _ => 2,
        };
        let region_of = |(tw, th): (usize, usize)| {
            (
                (tw + 2 * reach).next_multiple_of(COOP_WIDE.max(WGSL_WIDE)),
                (th + 2 * reach).next_multiple_of(WGSL_TALL),
            )
        };
        let binding = gpu.limits().max_storage_buffer_binding_size as usize;
        let fits = |side: usize| {
            let (rw, rh) = region_of((side, side));
            let cells = (rw + 2) * (rh + 2) * CHANNELS;
            cells <= TENSOR_CELLS_MOST && cells * cell <= binding
        };
        let most = match tile {
            Some(asked) => asked,
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
            let count = extent.div_ceil(most);
            (count, extent.div_ceil(count))
        };
        let ((across, tw), (down, th)) = (cut(pw), cut(ph));
        let region = region_of((tw, th));
        if into.size() < answer_bytes(width, height) {
            return Err(format!("{} bytes cannot hold the answer", into.size()));
        }

        let mut kept = self.held.lock().expect("the tensors' lock");
        if kept.as_ref().map(|t| t.region) != Some(region) {
            *kept = Some(self.tensors(gpu, region, planes_channels, cell));
        }
        let tensors = kept.as_ref().expect("just made");

        let mut recording = gpu.record();
        recording.holding(mosaic);
        recording.holding(into);
        recording.holding(&self.weights);
        recording.holding(&tensors.planes);
        recording.holding(&tensors.a);
        recording.holding(&tensors.b);

        let stride = (std::mem::size_of::<Step>() as u64)
            .next_multiple_of(u64::from(gpu.limits().min_uniform_buffer_offset_alignment));
        let mut steps: Vec<Step> = Vec::new();
        for ty in 0..down {
            for tx in 0..across {
                let base = Step {
                    width: region.0 as u32,
                    height: region.1 as u32,
                    left: (tx * tw) as i32 - reach as i32,
                    top: (ty * th) as i32 - reach as i32,
                    frame_width: pw as u32,
                    frame_height: ph as u32,
                    planes_channels: planes_channels as u32,
                    inner_left: reach as u32,
                    inner_top: reach as u32,
                    inner_width: tw.min(pw - tx * tw) as u32,
                    inner_height: th.min(ph - ty * th) as u32,
                    floor: self.floor,
                    floor_root: self.floor.sqrt(),
                    ..Default::default()
                };
                steps.push(base);
                for layer in &self.layers {
                    steps.push(Step {
                        weights_at: match self.arm {
                            Arm::Winograd => layer.wino_at as u32,
                            Arm::Half { .. } | Arm::Float { .. } => layer.weights_at as u32,
                            _ => layer.blocks_at as u32,
                        },
                        bias_at: layer.bias_at as u32,
                        slope_at: layer.slope_at as u32,
                        ..base
                    });
                }
                steps.push(base);
            }
        }
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

        let group =
            |given: &crate::gpu::Buffer, made: &crate::gpu::Buffer, planes: &crate::gpu::Buffer| {
                gpu.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("upscale"),
                    layout: &self.layout,
                    entries: &[
                        entry(0, &self.weights),
                        entry(1, given),
                        entry(2, made),
                        entry(3, planes),
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
                    ],
                })
            };
        let (planes, a, b) = (&tensors.planes, &tensors.a, &tensors.b);
        let packing = group(a, planes, b);
        let first = group(planes, a, planes);
        let ab = group(a, b, planes);
        let ba = group(b, a, planes);
        let coop_groups = self.coop.as_ref().map(|coop| {
            let group = |given: &crate::gpu::Buffer, made: &crate::gpu::Buffer| {
                gpu.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("upscale coop"),
                    layout: &coop.layout,
                    entries: &[
                        entry(0, &coop.blocks),
                        entry(1, given),
                        entry(2, made),
                        entry(3, &self.weights),
                    ],
                })
            };
            [group(planes, a), group(a, b), group(b, a)]
        });

        let pack_grid = ((region.0 / WGSL_WIDE) as u32, (region.1 / WGSL_TALL) as u32);
        let (tile_wide, tile_tall) = self.arm.tile();
        let layer_grid = ((region.0 / tile_wide) as u32, (region.1 / tile_tall) as u32);
        let last = self.layers.len() - 1;
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            let mut at = 0u32;
            let mut next = || {
                let offset = at * stride as u32;
                at += 1;
                offset
            };
            for step_of_tile in steps.chunks(self.layers.len() + 2) {
                pass.set_pipeline(&self.pack);
                pass.set_bind_group(0, &packing, &[next()]);
                pass.dispatch_workgroups(pack_grid.0, pack_grid.1, 1);
                for (index, _) in self.layers.iter().enumerate() {
                    let kind = match index {
                        0 => 0,
                        _ if index == last => 2,
                        _ => 1,
                    };
                    let offset = next();
                    let groups = match index {
                        0 => 0,
                        _ if index % 2 == 1 => 1,
                        _ => 2,
                    };
                    match (&self.coop, &coop_groups) {
                        (Some(coop), Some(coop_groups)) => {
                            pass.set_pipeline(&coop.convs[kind]);
                            pass.set_bind_group(0, &coop_groups[groups], &[]);
                            pass.set_immediates(0, bytemuck::bytes_of(&step_of_tile[index + 1]));
                            pass.dispatch_workgroups(layer_grid.0, layer_grid.1, 1);
                        }
                        _ => {
                            pass.set_pipeline(&self.convs[kind]);
                            pass.set_bind_group(0, [&first, &ab, &ba][groups], &[offset]);
                            pass.dispatch_workgroups(layer_grid.0, layer_grid.1, 1);
                        }
                    }
                }
                let leaving = step_of_tile[self.layers.len() + 1];
                let answer = match last % 2 {
                    1 => &ba,
                    _ => &ab,
                };
                pass.set_pipeline(&self.leave);
                pass.set_bind_group(0, answer, &[next()]);
                pass.dispatch_workgroups(
                    leaving.inner_width.div_ceil(WGSL_WIDE as u32),
                    leaving.inner_height.div_ceil(WGSL_TALL as u32),
                    1,
                );
            }
        }
        recording.submit();
        Ok(())
    }

    fn tensors(
        &self,
        gpu: &crate::gpu::Gpu,
        region: (usize, usize),
        planes_channels: usize,
        cell: usize,
    ) -> Tensors {
        let pixels = (region.0 + 2) * (region.1 + 2);
        let mut recording = gpu.record();
        let mut tensor = |label: &str, channels: usize| {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: (pixels * channels * cell) as u64,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        Tensors {
            region,
            planes: tensor("upscale planes", planes_channels),
            a: tensor("upscale a", CHANNELS),
            b: tensor("upscale b", CHANNELS),
        }
    }
}

/// The bytes [`Upscaler::upscale`]'s answer for a `width` by `height` mosaic takes.
pub fn answer_bytes(width: usize, height: usize) -> u64 {
    (width * 2 * height * 2 * std::mem::size_of::<f32>()) as u64
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

/// The `float` weights the WGSL reads and the fragments the matrix units read, and each layer's
/// place in them.
///
/// The network is `models/upscaler/src/upscaler/model.py`'s `Upscaler`: `body.N.weight` and
/// `body.N.bias` of each 3x3 convolution, followed by `body.N+1.weight`, its PReLU's slopes, on
/// every layer but the last.
fn lay_out(
    tensors: &[(String, Vec<usize>, &[f32])],
    fragment: usize,
) -> Result<(Vec<Layer>, Vec<f32>, Vec<u16>, Vec<u16>), String> {
    let named = |name: &str| tensors.iter().find(|(n, _, _)| n == name);
    let mut layers = Vec::new();
    let mut packed = Vec::new();
    let mut blocks: Vec<u16> = Vec::new();
    let mut wino: Vec<u16> = Vec::new();
    let mut index = 0;
    while let Some((_, shape, values)) = named(&format!("body.{index}.weight")) {
        let &[out, input, 3, 3] = shape.as_slice() else {
            return Err(format!("body.{index} is {shape:?}, not a 3x3 convolution"));
        };
        let (_, _, bias) = named(&format!("body.{index}.bias"))
            .ok_or_else(|| format!("body.{index} has no bias"))?;
        let slopes = named(&format!("body.{}.weight", index + 1))
            .filter(|(_, shape, _)| shape.len() == 1)
            .map(|(_, _, values)| *values);

        let weights_at = packed.len();
        for tap in 0..9 {
            for i in 0..input {
                for o in 0..out {
                    packed.push(values[(o * input + i) * 9 + tap]);
                }
            }
        }
        let bias_at = packed.len();
        packed.extend_from_slice(bias);
        let slope_at = packed.len();
        if let Some(slopes) = slopes {
            packed.extend_from_slice(slopes);
        }
        // `float4` reads of a layer's taps want each start on a fourth float.
        packed.resize(packed.len().next_multiple_of(4), 0.0);

        // The first layer reads the planes as the matrix units are handed them, padded to 16.
        let deep = input.next_multiple_of(MATRIX_PLANES);
        let blocks_at = blocks.len();
        blocks.resize(blocks_at + 9 * deep * out, 0);
        let (depth, across) = (deep / fragment, out / fragment);
        for tap in 0..9 {
            for i in 0..input {
                for o in 0..out {
                    let block = (tap * depth + i / fragment) * across + o / fragment;
                    let at = blocks_at
                        + block * fragment * fragment
                        + (i % fragment) * fragment
                        + o % fragment;
                    blocks[at] = half::f16::from_f32(values[(o * input + i) * 9 + tap]).to_bits();
                }
            }
        }

        let wino_at = wino.len();
        wino.resize(wino_at + 16 * deep * out, 0);
        for i in 0..input {
            for o in 0..out {
                let g = |a: usize, b: usize| values[(o * input + i) * 9 + a * 3 + b];
                let left: [[f32; 3]; 4] = std::array::from_fn(|r| {
                    std::array::from_fn(|b| (0..3).map(|a| WINOGRAD_G[r][a] * g(a, b)).sum())
                });
                for place in 0..16 {
                    let (r, c) = (place / 4, place % 4);
                    let u: f32 = (0..3).map(|b| left[r][b] * WINOGRAD_G[c][b]).sum();
                    let block = (place * depth + i / fragment) * across + o / fragment;
                    let at = wino_at
                        + block * fragment * fragment
                        + (i % fragment) * fragment
                        + o % fragment;
                    wino[at] = half::f16::from_f32(u).to_bits();
                }
            }
        }

        layers.push(Layer {
            input,
            output: out,
            linear: slopes.is_none(),
            weights_at,
            bias_at,
            slope_at,
            blocks_at,
            wino_at,
        });
        index += if slopes.is_some() { 2 } else { 1 };
    }

    let (Some(head), Some(tail)) = (layers.first(), layers.last()) else {
        return Err("the manifest has no body.0.weight".into());
    };
    let middle_fits = layers[1..layers.len() - 1]
        .iter()
        .all(|l| l.input == CHANNELS && l.output == CHANNELS && !l.linear);
    if head.input != PLANES
        || head.output != CHANNELS
        || head.linear
        || tail.input != CHANNELS
        || tail.output != SHUFFLED
        || !tail.linear
        || !middle_fits
        || layers.len() < 3
    {
        return Err(format!(
            "the kernels hold {PLANES} to {CHANNELS} channels, {CHANNELS} to {CHANNELS} and \
             {CHANNELS} to {SHUFFLED}, which this network is not"
        ));
    }
    Ok((layers, packed, blocks, wino))
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
fn coop_kernels(gpu: &crate::gpu::Gpu, arm: Arm, fragment: usize, blocks: &[u16]) -> Option<Coop> {
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
    let layers = ["16_48", "48_48", "48_16"];
    let names = match arm {
        Arm::MatrixWide { rows } => layers.map(|n| format!("coop_{n}_wide_{rows}")),
        Arm::MatrixNarrow { rows } => layers.map(|n| format!("coop_{n}_narrow_{rows}")),
        Arm::Winograd => layers.map(|n| format!("wino_{n}")),
        Arm::Half { .. } | Arm::Float { .. } => return None,
    };
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
    let convs = names.map(|name| {
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(&name),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(&name),
            compilation_options: Default::default(),
            cache: None,
        })
    });
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
fn coop_kernels(
    _gpu: &crate::gpu::Gpu,
    _arm: Arm,
    _fragment: usize,
    _blocks: &[u16],
) -> Option<Coop> {
    None
}
