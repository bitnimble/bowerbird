//! The reflection remover (`models/dereflect`): LightRR, told what the picture shows by DINOv2
//! ViT-S/14, on the device. `models/dereflect`'s `device_check` holds it against torch.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::gpu::dispatch::Whole;
use crate::gpu::{Buffer, Gpu};
use crate::resident::Resident;
use units::px::{At, Coordinate, Drawn, Extent, Looked, Point, Size, Stored};

const WGSL: &str = shaders::DEREFLECT.source;
const WGSL_HALF: &str = shaders::DEREFLECT_HALF.source;

/// What the device holds the weights and every tensor in. Arithmetic is `float` either way.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cells {
    Float,
    Half,
}

impl Cells {
    /// `Half` where the device has `shader-f16`.
    pub fn of(features: wgpu::Features) -> Cells {
        match features.contains(wgpu::Features::SHADER_F16) {
            true => Cells::Half,
            false => Cells::Float,
        }
    }

    fn bytes(self) -> usize {
        match self {
            Cells::Float => 4,
            Cells::Half => 2,
        }
    }

    fn encoded(self, values: &[f32]) -> Vec<u8> {
        let mut bytes = match self {
            Cells::Float => bytemuck::cast_slice(values).to_vec(),
            Cells::Half => values
                .iter()
                .flat_map(|&v| half::f16::from_f32(v).to_le_bytes())
                .collect(),
        };
        bytes.resize(bytes.len().next_multiple_of(4).max(16), 0);
        bytes
    }
}

/// Each side of the network's input is a multiple of this: three halvings, and a fourth inside the
/// coarsest level's blocks.
pub const MULTIPLE: usize = 16;
/// Brush planes after the picture's three: where the user marked reflection, and where none.
pub const HINTS: usize = 2;
/// The long edge the network looks at a frame on.
pub const EDGE: usize = 1024;
const WHITE_QUANTILE: f64 = 0.99;
const CODING_FLOOR: f64 = 0.002;
const LEVEL_BINS: usize = 65536;

const DIMS: [usize; 4] = [32, 64, 128, 256];
const HEADS: [usize; 3] = [4, 2, 1];
const STATE: usize = 16;
const THREADS: usize = 64;
const TILE: usize = 64;
const SCAN_CHUNK: usize = 1024;
/// Floats in the largest buffer a run asks for, the first level's scan over a square plane: each
/// direction's `y`, then the chunks' states. Always `float` (`Run::wide`), whatever the cells.
const LARGEST_TENSOR: usize = {
    let inner = 2 * DIMS[0];
    let band = EDGE * EDGE / 4;
    4 * inner * band + band.div_ceil(SCAN_CHUNK) * 4 * inner * 2 * STATE
};
const OPEN_GATE: f32 = 5.0;
const LIGHTRR_EPS: f32 = 1e-5;

const DINO_WIDTH: usize = 384;
const DINO_HEADS: usize = 6;
const DINO_EPS: f32 = 1e-6;
const PATCH: usize = 14;
const TRAINED_GRID: usize = 37;
const POSITION_OFFSET: f64 = 0.1;

const GATHER_PLAIN: u32 = 0;
const GATHER_3X3: u32 = 1;
const GATHER_PATCH: u32 = 2;
const A_FROM_SRC2: u32 = 1;
const ACCUMULATE: u32 = 2;
const WIDE: u32 = 4;
const UNSET: u32 = u32::MAX;

const KERNELS: [&str; 26] = [
    "gemm",
    "depthwise",
    "layernorm",
    "silu_inplace",
    "gelu_inplace",
    "copy",
    "gate",
    "scale_add",
    "add_scaled",
    "fuse",
    "located",
    "dwt",
    "idwt",
    "scan_ends",
    "scan_carry",
    "scan_out",
    "sum4",
    "gram",
    "softmax",
    "resize_axis",
    "standardise",
    "tokens",
    "attention",
    "spread",
    "admit",
    "widen",
];

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    span: u32,
    count: u32,
    width: u32,
    height: u32,
    in_channels: u32,
    out_channels: u32,
    mode: u32,
    flags: u32,
    src_at: u32,
    src2_at: u32,
    dst_at: u32,
    weight_at: u32,
    bias_at: u32,
    extra0: u32,
    extra1: u32,
    extra2: u32,
    extra3: u32,
    state_at: u32,
    eps: f32,
    scale: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Set {
    Net,
    Dino,
}

#[derive(Clone, Copy)]
struct Weight {
    set: Set,
    at: u32,
}

impl Weight {
    fn plus(self, floats: usize) -> Weight {
        Weight {
            at: self.at + floats as u32,
            ..self
        }
    }
}

/// The network, its weights on the device.
pub struct Remover {
    layout: wgpu::BindGroupLayout,
    pipelines: HashMap<&'static str, wgpu::ComputePipeline>,
    cells: Cells,
    net: Buffer,
    dino: Buffer,
    empty: Buffer,
    /// `wide_dst` where nothing writes it: `empty` is bound for reading in the same dispatch.
    sink: Buffer,
    tensors: HashMap<String, Weight>,
    /// DINOv2's learned positions, `[1 + 37 * 37][width]`, interpolated on the host per grid.
    positions: Vec<f32>,
    blocks: Vec<usize>,
    dino_depth: usize,
    uniform_stride: u64,
}

/// A bundle's tensors on the host, split into the two sets the device holds.
struct Unpacked {
    net: Vec<f32>,
    dino: Vec<f32>,
    tensors: HashMap<String, Weight>,
    positions: Vec<f32>,
    blocks: Vec<usize>,
    dino_depth: usize,
}

impl Unpacked {
    /// The bundle `models/dereflect`'s `bundle` writes, as `manifest` (`weights.json`) and `weights`
    /// (`weights.bin`): the network's tensors, and DINOv2's under `dino.`.
    fn new(manifest: &str, weights: &[u8]) -> Result<Unpacked, String> {
        let manifest: serde_json::Value =
            serde_json::from_str(manifest).map_err(|e| format!("the manifest: {e}"))?;
        let expect = |key: &str, value: serde_json::Value| -> Result<(), String> {
            match manifest[key] == value {
                true => Ok(()),
                false => Err(format!(
                    "the manifest's {key} is {}, not {value}",
                    manifest[key]
                )),
            }
        };
        expect("architecture", "lightrr".into())?;
        expect("predicts", "reflection".into())?;
        expect("semantics", "vits14".into())?;
        expect("passes", 1.into())?;
        expect("hints", HINTS.into())?;
        expect("dims", DIMS.to_vec().into())?;
        expect("heads", HEADS.to_vec().into())?;
        expect("edge", EDGE.into())?;
        expect("white_quantile", WHITE_QUANTILE.into())?;
        expect("coding_floor", CODING_FLOOR.into())?;
        let blocks: Vec<usize> = manifest["blocks"]
            .as_array()
            .ok_or("the manifest has no blocks")?
            .iter()
            .map(|b| b.as_u64().map(|b| b as usize).ok_or("a block count"))
            .collect::<Result<_, _>>()?;
        if blocks.len() != DIMS.len() {
            return Err(format!("{} levels of blocks", blocks.len()));
        }
        let floats: Vec<f32> = match manifest["stored"].as_str().unwrap_or("f32") {
            "f32" => bytemuck::try_cast_slice(weights)
                .map_err(|e| format!("the weights are not whole floats: {e}"))?
                .to_vec(),
            "f16" => weights
                .chunks_exact(2)
                .map(|word| half::f16::from_le_bytes([word[0], word[1]]).to_f32())
                .collect(),
            other => return Err(format!("the weights are stored as {other}")),
        };
        let mut net = Vec::new();
        let mut dino = Vec::new();
        let mut tensors = HashMap::new();
        let mut positions = Vec::new();
        for tensor in manifest["tensors"]
            .as_array()
            .ok_or("the manifest has no tensors")?
        {
            let name = tensor["name"].as_str().ok_or("a tensor's name")?;
            let offset = tensor["offset"].as_u64().ok_or("a tensor's offset")? as usize;
            let size: usize = tensor["shape"]
                .as_array()
                .ok_or("a tensor's shape")?
                .iter()
                .map(|side| side.as_u64().unwrap_or(0) as usize)
                .product();
            let values = floats
                .get(offset..offset + size)
                .ok_or_else(|| format!("{name} runs past the weights"))?;
            let (set, held) = match name.strip_prefix("dino.") {
                Some(_) => (Set::Dino, &mut dino),
                None => (Set::Net, &mut net),
            };
            if name == "dino.pos_embed" {
                positions = values.to_vec();
            }
            tensors.insert(
                name.to_string(),
                Weight {
                    set,
                    at: held.len() as u32,
                },
            );
            held.extend_from_slice(values);
        }
        if positions.len() != (1 + TRAINED_GRID * TRAINED_GRID) * DINO_WIDTH {
            return Err("the bundle has no DINOv2 ViT-S/14 positions".into());
        }
        let dino_depth = (0..)
            .take_while(|i| tensors.contains_key(&format!("dino.blocks.{i}.norm1.weight")))
            .count();
        Ok(Unpacked {
            net,
            dino,
            tensors,
            positions,
            blocks,
            dino_depth,
        })
    }
}

impl Remover {
    pub fn new(gpu: &Gpu, manifest: &str, weights: &[u8], cells: Cells) -> Result<Remover, String> {
        Remover::built(gpu, Unpacked::new(manifest, weights)?, cells)
    }

    fn built(gpu: &Gpu, unpacked: Unpacked, cells: Cells) -> Result<Remover, String> {
        let Unpacked {
            net,
            dino,
            tensors,
            positions,
            blocks,
            dino_depth,
        } = unpacked;
        let limit = gpu.most_bound();
        let sets = [
            ("network weights", net.len() * cells.bytes()),
            ("DINOv2 weights", dino.len() * cells.bytes()),
            ("largest tensor", LARGEST_TENSOR * 4),
        ];
        for (set, bytes) in sets {
            let bytes = bytes as u64;
            if bytes > limit {
                return Err(format!("{set}: {bytes} bytes, past the adapter's {limit}"));
            }
        }

        let device = gpu.describing();
        let source = match (cells, Cells::of(device.features())) {
            (Cells::Float, _) => WGSL,
            (Cells::Half, Cells::Half) => WGSL_HALF,
            (Cells::Half, Cells::Float) => {
                return Err("half cells need shader-f16, which the adapter lacks".into());
            }
        };
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dereflect"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
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
            label: Some("dereflect"),
            entries: &[
                storage(0, true),
                storage(1, true),
                storage(2, false),
                storage(3, true),
                storage(4, true),
                storage(5, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 20,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: true,
                        min_binding_size: wgpu::BufferSize::new(
                            std::mem::size_of::<Params>() as u64
                        ),
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("dereflect"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipelines = KERNELS
            .iter()
            .map(|&name| {
                let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(name),
                    layout: Some(&pipeline_layout),
                    module: &module,
                    entry_point: Some(name),
                    compilation_options: Default::default(),
                    cache: None,
                });
                (name, pipeline)
            })
            .collect();
        let upload = |label: &'static str, contents: &[u8]| {
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents,
                usage: wgpu::BufferUsages::STORAGE,
            })
        };
        let alignment = u64::from(gpu.limits().min_uniform_buffer_offset_alignment);
        Ok(Remover {
            layout,
            pipelines,
            cells,
            net: upload("dereflect weights", &cells.encoded(&net)),
            dino: upload("dereflect DINOv2", &cells.encoded(&dino)),
            empty: upload("dereflect empty", &[0; 16]),
            sink: upload("dereflect sink", &[0; 16]),
            tensors,
            positions,
            blocks,
            dino_depth,
            uniform_stride: (std::mem::size_of::<Params>() as u64).next_multiple_of(alignment),
        })
    }

    /// The reflection in `given`, coded as it is: `given` holds `3 + HINTS` planes of `width` by
    /// `height`, the picture coded by `stabilise` then the brush, each side a multiple of
    /// [`MULTIPLE`]. Returns 3 planes in a buffer of their own.
    pub fn predict(&self, gpu: &Gpu, given: &Buffer, width: usize, height: usize) -> Buffer {
        assert!(
            width > 0 && height > 0 && width % MULTIPLE == 0 && height % MULTIPLE == 0,
            "the network takes sides that are multiples of {MULTIPLE}, not {width}x{height}"
        );
        let run = Run {
            remover: self,
            gpu,
            free: Free::default(),
            ops: RefCell::new(Vec::new()),
        };
        let admitted = run.tensor(3 + HINTS, height, width);
        run.admit(given, &admitted);
        let coded = run.forward(&admitted);
        let reflection = match self.cells {
            Cells::Float => coded.slot.buffer.clone(),
            Cells::Half => {
                let wide = gpu.own_buffer(&wgpu::BufferDescriptor {
                    label: Some("dereflect reflection"),
                    size: (coded.len() * 4) as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                });
                run.widen(&coded, &wide);
                wide
            }
        };
        run.flush();
        reflection
    }

    fn weight(&self, name: &str) -> Weight {
        *self
            .tensors
            .get(name)
            .unwrap_or_else(|| panic!("the weights hold no {name}"))
    }

    fn bias(&self, name: &str) -> Option<Weight> {
        self.tensors.get(&format!("{name}.bias")).copied()
    }

    /// DINOv2's positions for a `rows` by `columns` grid, `[width][1 + rows * columns]`, as Meta's
    /// `interpolate_pos_encoding` resamples them, its scale offset included.
    fn positions(&self, rows: usize, columns: usize) -> Vec<f32> {
        let grid = TRAINED_GRID;
        let tokens = 1 + rows * columns;
        let mut out = vec![0.0; DINO_WIDTH * tokens];
        for d in 0..DINO_WIDTH {
            out[d * tokens] = self.positions[d];
        }
        let learned = |y: isize, x: isize, d: usize| {
            let y = y.clamp(0, grid as isize - 1) as usize;
            let x = x.clamp(0, grid as isize - 1) as usize;
            self.positions[(1 + y * grid + x) * DINO_WIDTH + d]
        };
        let along = |size: usize, i: usize| {
            // torch takes the reciprocal of the scale it is handed in double, then works in float.
            let scale = (1.0 / ((size as f64 + POSITION_OFFSET) / grid as f64)) as f32;
            let real = scale * (i as f32 + 0.5) - 0.5;
            let floor = real.floor();
            (floor as isize, cubic(real - floor))
        };
        for y in 0..rows {
            let (iy, wy) = along(rows, y);
            for x in 0..columns {
                let (ix, wx) = along(columns, x);
                for d in 0..DINO_WIDTH {
                    let mut value = 0.0;
                    for (a, wy) in wy.iter().enumerate() {
                        let mut row = 0.0;
                        for (b, wx) in wx.iter().enumerate() {
                            row += wx * learned(iy - 1 + a as isize, ix - 1 + b as isize, d);
                        }
                        value += wy * row;
                    }
                    out[d * tokens + 1 + y * columns + x] = value;
                }
            }
        }
        out
    }
}

/// The removal as an edit document asks for it, `strength` a gain on the reflection from 0 to 2.
#[derive(Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct Settings {
    pub enabled: bool,
    pub strength: f64,
    pub strokes: Vec<Stroke>,
}

impl Settings {
    pub fn takes_out(&self) -> bool {
        self.enabled && self.strength > 0.0
    }
}

/// A brush stroke, on the [`Stored`] grid of the picture as the lens left it.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct Stroke {
    pub kind: Brush,
    pub radius: u16,
    pub points: Vec<[u16; 2]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Brush {
    Remove,
    Keep,
}

/// What the network found in one photograph: its coded reflection on the [`Looked`] plane and
/// the white it was coded against, both left on the device.
pub struct Layer {
    coded: Buffer,
    white: Buffer,
    looked: Size<Looked>,
    plane: Size<Looked>,
}

/// A photograph's layer and how much of it every frame of the photograph takes out.
#[derive(Clone)]
pub struct Removal {
    pub layer: std::sync::Arc<Layer>,
    pub strength: f64,
}

impl Removal {
    /// The reflection taken out of `window`, which starts at `origin` in a whole frame of `full`.
    pub fn take_out(
        &self,
        gpu: &'static Gpu,
        window: &Resident,
        origin: At<Drawn>,
        full: Size<Drawn>,
    ) {
        self.layer
            .take_out(gpu, window, origin, full, self.strength);
    }
}

/// What `settings` takes out of a photograph whose frame of `full` shrank to `looked`, its strokes
/// drawn through `matched`'s lens. None where the setting is off, or no model has been handed over.
pub fn removal(
    gpu: &'static Gpu,
    looked: &Resident,
    full: Size<Drawn>,
    settings: &Settings,
    matched: Option<&crate::hdr_fit::HdrMatch>,
) -> Option<Removal> {
    if !settings.takes_out() {
        return None;
    }
    let Some(remover) = device(gpu) else {
        trace::warn("rawshim: reflection removal is on, and no model has been downloaded");
        return None;
    };
    let none = crate::fit::Lens::none();
    let lens = matched.map_or(&none, |matched| &matched.lens);
    Some(Removal {
        layer: std::sync::Arc::new(remover.layer(gpu, looked, full, &settings.strokes, lens)),
        strength: settings.strength,
    })
}

/// What a layer is a function of besides the model: the photograph, its strokes, the lens they
/// are drawn through, and the decode's denoise and dust.
#[cfg(not(target_arch = "wasm32"))]
#[derive(PartialEq)]
pub struct Found {
    pub photograph: String,
    pub strokes: Vec<Stroke>,
    pub lens: Option<crate::fit::Lens>,
    pub detail: crate::galosh::Detail,
    pub dust: crate::dust::Settings,
    pub half_size: bool,
}

/// The layers found most recently, for a host that cuts many windows from one photograph and holds
/// no frame between them.
#[cfg(not(target_arch = "wasm32"))]
static KEPT: std::sync::Mutex<Vec<(Found, std::sync::Arc<Layer>)>> =
    std::sync::Mutex::new(Vec::new());
#[cfg(not(target_arch = "wasm32"))]
const MOST_KEPT: usize = 4;

/// The layer kept for `found`, or the one `find` finds, kept in turn.
#[cfg(not(target_arch = "wasm32"))]
pub fn kept(
    found: Found,
    find: impl FnOnce() -> Option<std::sync::Arc<Layer>>,
) -> Option<std::sync::Arc<Layer>> {
    // Held across `find`: a loupe's tiles arrive together, and each would otherwise run the network,
    // and `hold_model`'s clear waits for a layer of the model it replaces.
    let mut kept = KEPT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((_, layer)) = kept.iter().find(|(key, _)| *key == found) {
        return Some(layer.clone());
    }
    let layer = find()?;
    if kept.len() == MOST_KEPT {
        kept.remove(0);
    }
    kept.push((found, layer.clone()));
    Some(layer)
}

/// `frame` shrunk to the network's long edge as `frames.shrunk` shrinks one, by area.
pub fn looked(gpu: &'static Gpu, frame: &Resident) -> Option<Resident> {
    let (width, height) = frame.size();
    let shrink = (width.max(height) as f64 / EDGE as f64).max(1.0);
    let out = (
        (width as f64 / shrink).round() as usize,
        (height as f64 / shrink).round() as usize,
    );
    if out == (width, height) {
        return Some(frame.duplicate());
    }
    crate::base::resize_scene(gpu, crate::base::device(gpu)?, frame, out)
}

impl Remover {
    /// The reflection in `looked`, the [`looked`] of a frame of `full`, brushed by `strokes`; `lens`
    /// is the correction the strokes' picture was drawn through.
    pub fn layer(
        &self,
        gpu: &'static Gpu,
        looked: &Resident,
        full: Size<Drawn>,
        strokes: &[Stroke],
        lens: &crate::fit::Lens,
    ) -> Layer {
        let (width, height) = looked.size();
        let looked_size = Size::<Looked>::exact(width, height);
        let plane = Size::<Looked>::exact(
            width.next_multiple_of(MULTIPLE),
            height.next_multiple_of(MULTIPLE),
        );
        let (plane_width, plane_height) = plane.raw();
        let segments = segments(strokes, full, looked_size, lens);
        let kernels = frame_kernels(gpu);
        let mut recording = gpu.record();
        recording.holding(looked.buffer());
        let planes = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("dereflect input"),
            size: ((3 + HINTS) * plane_width * plane_height * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let histogram = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("dereflect white histogram"),
            // Zeroed by the driver, which the counting adds into.
            size: (LEVEL_BINS * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let white = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("dereflect white"),
            size: 16,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let strokes = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("dereflect strokes"),
            contents: bytemuck::cast_slice(match segments.is_empty() {
                true => &[0.0; SEGMENT],
                false => &segments,
            }),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let pixels = width * height;
        let params = FrameParams {
            width: width as u32,
            height: height as u32,
            plane_width: plane_width as u32,
            plane_height: plane_height as u32,
            looked_width: width as u32,
            looked_height: height as u32,
            segments: (segments.len() / SEGMENT) as u32,
            white_mark: ((WHITE_QUANTILE * (pixels - 1) as f64).floor() as u32) + 1,
            coding_floor: CODING_FLOOR as f32,
            ..Default::default()
        };
        let bound = [looked.buffer(), &planes, &histogram, &strokes, &white];
        kernels.dispatch(
            gpu,
            &mut recording,
            &kernels.white_count,
            params,
            bound,
            pixels,
            Whole::Fixed,
        );
        kernels.dispatch(
            gpu,
            &mut recording,
            &kernels.white_find,
            params,
            bound,
            1,
            Whole::Fixed,
        );
        kernels.dispatch(
            gpu,
            &mut recording,
            &kernels.ingest,
            params,
            bound,
            plane_width * plane_height,
            Whole::Fixed,
        );
        Layer {
            coded: self.predict(gpu, &planes, plane_width, plane_height),
            white,
            looked: looked_size,
            plane,
        }
    }
}

impl Layer {
    /// `strength` of the reflection taken out of `window`, a frame of the photograph starting at
    /// `origin` in a whole frame of `full`, both in `window`'s pixels.
    pub fn take_out(
        &self,
        gpu: &'static Gpu,
        window: &Resident,
        origin: At<Drawn>,
        full: Size<Drawn>,
        strength: f64,
    ) {
        if strength <= 0.0 {
            return;
        }
        let kernels = frame_kernels(gpu);
        let (width, height) = window.size();
        let (plane_width, plane_height) = self.plane.raw();
        let (looked_width, looked_height) = self.looked.raw();
        let (full_width, full_height) = full.raw();
        let mut recording = gpu.record();
        recording.holding(window.buffer());
        let params = FrameParams {
            width: width as u32,
            height: height as u32,
            plane_width: plane_width as u32,
            plane_height: plane_height as u32,
            looked_width: looked_width as u32,
            looked_height: looked_height as u32,
            origin_x: origin.x.raw() as u32,
            origin_y: origin.y.raw() as u32,
            full_width: full_width as u32,
            full_height: full_height as u32,
            strength: strength as f32,
            coding_floor: CODING_FLOOR as f32,
            ..Default::default()
        };
        let mut empty = || {
            recording.buffer(&wgpu::BufferDescriptor {
                label: Some("dereflect_frame empty"),
                size: 16,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        // Two: one buffer bound writable and read-only in one dispatch is refused.
        let (histogram, strokes) = (empty(), empty());
        let bound = [
            window.buffer(),
            &self.coded,
            &histogram,
            &strokes,
            &self.white,
        ];
        kernels.dispatch(
            gpu,
            &mut recording,
            &kernels.take_out,
            params,
            bound,
            window.words(),
            Whole::Measured,
        );
    }
}

/// The strokes as `dereflect_frame.slang` draws them: segments on the [`Looked`] plane, a lone
/// point a segment of no length.
fn segments(
    strokes: &[Stroke],
    full: Size<Drawn>,
    looked: Size<Looked>,
    lens: &crate::fit::Lens,
) -> Vec<f32> {
    let stored = full.stored();
    let on_drawn: Vec<Point<Drawn>> = strokes
        .iter()
        .flat_map(|stroke| &stroke.points)
        .map(|&[x, y]| {
            Point::<Stored> {
                x: Coordinate::exactly(f64::from(x)),
                y: Coordinate::exactly(f64::from(y)),
            }
            .onto(stored, full)
        })
        .collect();
    let mut read = crate::image::lens_sources(full, &on_drawn, lens)
        .into_iter()
        .map(|point| point.onto(full, looked))
        .map(|point| [point.x.raw() as f32, point.y.raw() as f32]);
    let mut drawn = Vec::new();
    for stroke in strokes {
        let radius = Extent::<Stored>::exactly(f64::from(stroke.radius))
            .onto(stored.width, looked.width)
            .raw();
        let points: Vec<[f32; 2]> = read.by_ref().take(stroke.points.len()).collect();
        let pairs: Vec<([f32; 2], [f32; 2])> = match points.len() {
            1 => vec![(points[0], points[0])],
            _ => points.windows(2).map(|pair| (pair[0], pair[1])).collect(),
        };
        let kind = match stroke.kind {
            Brush::Remove => 0.0,
            Brush::Keep => 1.0,
        };
        for (a, b) in pairs {
            drawn.extend([a[0], a[1], b[0], b[1], radius as f32, kind]);
        }
    }
    drawn
}

const SEGMENT: usize = 6;

#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct FrameParams {
    span: u32,
    count: u32,
    width: u32,
    height: u32,
    plane_width: u32,
    plane_height: u32,
    looked_width: u32,
    looked_height: u32,
    origin_x: u32,
    origin_y: u32,
    full_width: u32,
    full_height: u32,
    segments: u32,
    white_mark: u32,
    strength: f32,
    coding_floor: f32,
}

struct FrameKernels {
    layout: wgpu::BindGroupLayout,
    white_count: wgpu::ComputePipeline,
    white_find: wgpu::ComputePipeline,
    ingest: wgpu::ComputePipeline,
    take_out: wgpu::ComputePipeline,
}

fn frame_kernels(gpu: &'static Gpu) -> &'static FrameKernels {
    static BUILT: crate::gpu::Cache<FrameKernels> = crate::gpu::Cache::new();
    BUILT.get(gpu, || {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dereflect_frame"),
            source: wgpu::ShaderSource::Wgsl(shaders::DEREFLECT_FRAME.source.into()),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let write = wgpu::BufferBindingType::Storage { read_only: false };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("dereflect_frame"),
            entries: &[
                entry(0, write),
                entry(1, write),
                entry(2, write),
                entry(3, read),
                entry(4, write),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("dereflect_frame"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let build = |name: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(name),
                layout: Some(&pipeline_layout),
                module: &module,
                entry_point: Some(name),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        FrameKernels {
            white_count: build("white_count"),
            white_find: build("white_find"),
            ingest: build("ingest"),
            take_out: build("take_out"),
            layout,
        }
    })
}

impl FrameKernels {
    #[track_caller]
    fn dispatch(
        &self,
        gpu: &Gpu,
        recording: &mut crate::gpu::Recording<'_>,
        pipeline: &wgpu::ComputePipeline,
        params: FrameParams,
        bound: [&Buffer; 5],
        threads: usize,
        because: Whole,
    ) {
        let groups = threads.div_ceil(THREADS);
        let wide = groups.clamp(1, 65535);
        let params = FrameParams {
            span: (wide * THREADS) as u32,
            count: threads as u32,
            ..params
        };
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("dereflect_frame params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let mut entries: Vec<wgpu::BindGroupEntry<'_>> = bound
            .iter()
            .enumerate()
            .map(|(binding, buffer)| wgpu::BindGroupEntry {
                binding: binding as u32,
                resource: buffer.as_entire_binding(),
            })
            .collect();
        entries.push(wgpu::BindGroupEntry {
            binding: 20,
            resource: uniform.as_entire_binding(),
        });
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("dereflect_frame"),
            layout: &self.layout,
            entries: &entries,
        });
        recording.dispatch(
            [wide as u32, groups.div_ceil(wide) as u32, 1],
            because,
            |pass| {
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &group, &[]);
            },
        );
    }
}

struct Model {
    unpacked: Option<Unpacked>,
    built: Option<Option<&'static Remover>>,
}

const UNHELD: Model = Model {
    unpacked: None,
    built: None,
};

#[cfg(not(target_arch = "wasm32"))]
fn with_model<R>(f: impl FnOnce(&mut Model) -> R) -> R {
    static MODEL: std::sync::Mutex<Model> = std::sync::Mutex::new(UNHELD);
    f(&mut MODEL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner))
}

// A page's network holds WebGPU handles, which are neither `Send` nor `Sync`.
#[cfg(target_arch = "wasm32")]
fn with_model<R>(f: impl FnOnce(&mut Model) -> R) -> R {
    thread_local! {
        static MODEL: std::cell::RefCell<Model> = const { std::cell::RefCell::new(UNHELD) };
    }
    MODEL.with(|held| f(&mut held.borrow_mut()))
}

/// The model the app downloaded, from the next frame on, or why this build cannot run it.
pub fn hold_model(manifest: &str, weights: &[u8]) -> Result<(), String> {
    let unpacked = Unpacked::new(manifest, weights)?;
    with_model(|held| {
        held.unpacked = Some(unpacked);
        held.built = None;
    });
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    #[cfg(not(target_arch = "wasm32"))]
    KEPT.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    Ok(())
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Which model is held, for a host keeping layers of its own to tell one model's from the next.
pub fn generation() -> u64 {
    GENERATION.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether a model is held that builds on this device, for a host to check before it decodes a
/// frame for the network.
pub fn ready(gpu: &'static Gpu) -> bool {
    device(gpu).is_some()
}

/// The network, built on the first frame that asks for it and kept until a model replaces it.
/// `None` until the app has handed one over.
fn device(gpu: &'static Gpu) -> Option<&'static Remover> {
    with_model(|held| {
        if let Some(tried) = held.built {
            return tried;
        }
        let cells = Cells::of(gpu.describing().features());
        let made = Remover::built(gpu, held.unpacked.take()?, cells)
            .map_err(|why| {
                trace::warn(&format!(
                    "rawshim: the reflection remover did not build: {why}"
                ))
            })
            .ok()
            // ponytail: one network leaked per model update, since a frame mid-render may hold it.
            .map(|made| &*Box::leak(Box::new(made)));
        held.built = Some(made);
        made
    })
}

/// Bicubic weights of the four taps around a point `t` past the second, torch's `A = -0.75`.
fn cubic(t: f32) -> [f32; 4] {
    const A: f32 = -0.75;
    let near = |x: f32| ((A + 2.0) * x - (A + 3.0)) * x * x + 1.0;
    let far = |x: f32| ((A * x - 5.0 * A) * x + 8.0 * A) * x - 4.0 * A;
    [far(t + 1.0), near(t), near(1.0 - t), far(2.0 - t)]
}

type Free = Rc<RefCell<Vec<Buffer>>>;

/// A device buffer one run hands out, back to the run's free list once nothing reads it.
struct Slot {
    buffer: Buffer,
    free: Free,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.free.borrow_mut().push(self.buffer.clone());
    }
}

/// `c` planes of `h` by `w` floats, from `at` floats into a slot.
#[derive(Clone)]
struct Planes {
    slot: Rc<Slot>,
    at: usize,
    c: usize,
    h: usize,
    w: usize,
}

impl Planes {
    fn plane(&self) -> usize {
        self.h * self.w
    }

    fn len(&self) -> usize {
        self.c * self.plane()
    }

    fn channels(&self, from: usize, count: usize) -> Self {
        Planes {
            at: self.at + from * self.plane(),
            c: count,
            ..self.clone()
        }
    }

    fn buffer(&self) -> &Buffer {
        &self.slot.buffer
    }
}

struct Op {
    kernel: &'static str,
    params: Params,
    /// `src`, `weights`, `dst`, `src2`, `wide_src`, `wide_dst`.
    bound: [Buffer; 6],
    groups: (u32, u32),
}

/// Every binding of a dispatch, `Run::idle`'s placeholders where it uses none.
#[derive(Clone, Copy)]
struct Bound<'b> {
    src: &'b Buffer,
    weights: &'b Buffer,
    dst: &'b Buffer,
    src2: &'b Buffer,
    wide_src: &'b Buffer,
    wide_dst: &'b Buffer,
}

/// What a dispatch reads and writes.
struct Bind<'p> {
    src: Option<&'p Planes>,
    src2: Option<&'p Buffer>,
    weights: Set,
    dst: &'p Planes,
}

/// One forward pass: its ops, recorded until the next flush, and the buffers it reuses.
///
/// Reusing a buffer whose tensor is gone while earlier ops still read it is safe because one queue
/// runs every op in the order recorded.
struct Run<'a> {
    remover: &'a Remover,
    gpu: &'a Gpu,
    free: Free,
    ops: RefCell<Vec<Op>>,
}

impl<'a> Run<'a> {
    fn forward(&self, given: &Planes) -> Planes {
        let image = given.channels(0, 3);
        let hints = given.channels(3, HINTS);
        let mut x = self.conv3(&image, "img_tokenizer", DIMS[0]);
        self.gemm(
            &hints,
            GATHER_3X3,
            self.remover.weight("hint_tokenizer.weight"),
            None,
            &x,
            9 * HINTS,
            ACCUMULATE,
        );
        let mut encoded = Vec::new();
        let mut bands = Vec::new();
        for (level, &dim) in DIMS.iter().enumerate() {
            if level == DIMS.len() - 1 {
                self.adapt(&image, &x);
            }
            x = self.stage(&x, &format!("encoders.{level}"), self.remover.blocks[level]);
            encoded.push(x.clone());
            if level < DIMS.len() - 1 {
                let split = self.dwt(&x);
                x = self.conv3(
                    &split.channels(0, dim),
                    &format!("downs.{level}.body"),
                    2 * dim,
                );
                bands.push(split);
            }
        }
        for (i, level) in [2, 1, 0].into_iter().enumerate() {
            let dim = DIMS[level];
            let decoded = self.stage(&x, &format!("decoders.{i}"), self.remover.blocks[level + 1]);
            let y = self.conv1(&decoded, &format!("reduces.{i}"), dim);
            drop(decoded);
            let low = bands[level].channels(0, dim);
            let middle = self.stage(&low, &format!("middlers.{i}"), self.remover.blocks[level]);
            let joined = self.tensor(2 * dim, y.h, y.w);
            self.fusion(
                &y,
                &middle,
                &joined.channels(dim, dim),
                &format!("restormer_attentions.{i}"),
                HEADS[i],
            );
            self.copy(&y, &joined.channels(0, dim));
            drop((y, middle));
            // The level's own LL band is spent, so the reduction takes its place beside the
            // high bands it rejoins.
            self.gemm(
                &joined,
                GATHER_3X3,
                self.remover.weight(&format!("ups.{i}.reduce.weight")),
                None,
                &low,
                9 * joined.c,
                0,
            );
            drop(joined);
            x = self.idwt(&bands[level], if level == 0 { 2 * dim } else { dim });
        }
        drop(bands);
        let features = x;
        self.copy(&encoded[0], &features.channels(DIMS[0], DIMS[0]));
        drop(encoded);
        let located = self.conv3(&features, "locate", 1);
        let coded = self.conv3(&features, "output", 3);
        let open_share = 1.0 / (1.0 + (-OPEN_GATE).exp());
        self.threads(
            "located",
            Params {
                width: coded.plane() as u32,
                src2_at: located.at as u32,
                dst_at: coded.at as u32,
                scale: 1.0 / open_share,
                ..Default::default()
            },
            Bind {
                src: None,
                src2: Some(located.buffer()),
                weights: Set::Net,
                dst: &coded,
            },
            coded.len(),
        );
        coded
    }

    /// `x += Adapter(describe(image))`, the coarsest level told what the picture shows.
    fn adapt(&self, image: &Planes, x: &Planes) {
        let described = self.describe(image, x.h, x.w);
        let normed = self.layernorm(&described, "semantics.norm", LIGHTRR_EPS);
        drop(described);
        let inner = self.conv1(&normed, "semantics.inner", DIMS[3]);
        self.elementwise("gelu_inplace", &inner);
        let remover = self.remover;
        self.gemm(
            &inner,
            GATHER_PLAIN,
            remover.weight("semantics.out.weight"),
            remover.bias("semantics.out"),
            x,
            DIMS[3],
            ACCUMULATE,
        );
    }

    /// DINOv2's description of `image`, a patch per two of the coarsest level's pixels, spread
    /// bilinearly over its `h` by `w`.
    fn describe(&self, image: &Planes, h: usize, w: usize) -> Planes {
        let remover = self.remover;
        let (rows, columns) = (h.div_ceil(2), w.div_ceil(2));
        let wide = self.resize_axis(image, columns * PATCH, true);
        let given = self.resize_axis(&wide, rows * PATCH, false);
        drop(wide);
        self.threads(
            "standardise",
            Params {
                width: given.plane() as u32,
                dst_at: given.at as u32,
                ..Default::default()
            },
            Bind {
                src: None,
                src2: None,
                weights: Set::Dino,
                dst: &given,
            },
            given.len(),
        );
        let patches = self.tensor(DINO_WIDTH, rows, columns);
        self.gemm(
            &given,
            GATHER_PATCH,
            remover.weight("dino.patch_embed.proj.weight"),
            remover.bias("dino.patch_embed.proj"),
            &patches,
            3 * PATCH * PATCH,
            0,
        );
        drop(given);
        let tokens = 1 + rows * columns;
        let positions = self.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("dereflect positions"),
            contents: &remover.cells.encoded(&remover.positions(rows, columns)),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let mut x = self.tensor(DINO_WIDTH, 1, tokens);
        self.threads(
            "tokens",
            Params {
                width: (rows * columns) as u32,
                src_at: patches.at as u32,
                dst_at: x.at as u32,
                weight_at: remover.weight("dino.cls_token").at,
                ..Default::default()
            },
            Bind {
                src: Some(&patches),
                src2: Some(&positions),
                weights: Set::Dino,
                dst: &x,
            },
            x.len(),
        );
        drop(patches);
        for block in 0..remover.dino_depth {
            x = self.dino_block(&x, &format!("dino.blocks.{block}"));
            self.flush();
        }
        let normed = self.layernorm(&x, "dino.norm", DINO_EPS);
        drop(x);
        let spread = self.tensor(DINO_WIDTH, h, w);
        self.threads(
            "spread",
            Params {
                width: w as u32,
                height: h as u32,
                src_at: normed.at as u32,
                dst_at: spread.at as u32,
                extra0: columns as u32,
                extra1: rows as u32,
                ..Default::default()
            },
            Bind {
                src: Some(&normed),
                src2: None,
                weights: Set::Dino,
                dst: &spread,
            },
            spread.len(),
        );
        spread
    }

    fn dino_block(&self, x: &Planes, p: &str) -> Planes {
        let remover = self.remover;
        let normed = self.layernorm(x, &format!("{p}.norm1"), DINO_EPS);
        let qkv = self.conv1(&normed, &format!("{p}.attn.qkv"), 3 * DINO_WIDTH);
        drop(normed);
        let attended = self.tensor(DINO_WIDTH, 1, x.w);
        self.groups(
            "attention",
            Params {
                width: x.w as u32,
                src_at: qkv.at as u32,
                dst_at: attended.at as u32,
                extra0: DINO_HEADS as u32,
                scale: 1.0 / ((DINO_WIDTH / DINO_HEADS) as f32).sqrt(),
                ..Default::default()
            },
            Bind {
                src: Some(&qkv),
                src2: None,
                weights: Set::Dino,
                dst: &attended,
            },
            (x.w.div_ceil(THREADS) as u32, DINO_HEADS as u32),
        );
        drop(qkv);
        let projected = self.conv1(&attended, &format!("{p}.attn.proj"), DINO_WIDTH);
        drop(attended);
        let x = x.clone();
        self.add_scaled(&x, &projected, remover.weight(&format!("{p}.ls1.gamma")));
        drop(projected);
        let normed = self.layernorm(&x, &format!("{p}.norm2"), DINO_EPS);
        let hidden = self.conv1(&normed, &format!("{p}.mlp.fc1"), 4 * DINO_WIDTH);
        drop(normed);
        self.elementwise("gelu_inplace", &hidden);
        let out = self.conv1(&hidden, &format!("{p}.mlp.fc2"), DINO_WIDTH);
        drop(hidden);
        self.add_scaled(&x, &out, remover.weight(&format!("{p}.ls2.gamma")));
        x
    }

    fn stage(&self, x: &Planes, p: &str, blocks: usize) -> Planes {
        let mut x = x.clone();
        for block in 0..blocks {
            x = self.afm(&x, &format!("{p}.blocks.{block}"));
            self.flush();
        }
        x
    }

    /// `AFMBlock`: `x * skip_scale + scan(ln_1(x))`.
    fn afm(&self, x: &Planes, p: &str) -> Planes {
        let remover = self.remover;
        let (c, h, w) = (x.c, x.h, x.w);
        let inner = 2 * c;
        let rank = c.div_ceil(16);
        let sa = format!("{p}.self_attention");
        let normed = self.layernorm(x, &format!("{p}.ln_1"), LIGHTRR_EPS);
        let in_proj = remover.weight(&format!("{sa}.in_proj.weight"));
        let xs = self.tensor(inner, h, w);
        self.gemm(&normed, GATHER_PLAIN, in_proj, None, &xs, c, 0);
        let z = self.tensor(inner, h, w);
        self.gemm(
            &normed,
            GATHER_PLAIN,
            in_proj.plus(inner * c),
            None,
            &z,
            c,
            0,
        );
        drop(normed);

        let split = self.dwt(&xs);
        drop(xs);
        let bands = self.depthwise(&split, &format!("{sa}.DWConv2d"));
        drop(split);
        self.elementwise("silu_inplace", &bands);
        let ll = bands.channels(0, inner);
        let rows = rank + 2 * STATE;
        let x_dbl = self.tensor(4 * rows, ll.h, ll.w);
        self.gemm(
            &ll,
            GATHER_PLAIN,
            remover.weight(&format!("{sa}.x_proj_weight")),
            None,
            &x_dbl,
            inner,
            0,
        );
        let n = ll.plane();
        let chunks = n.div_ceil(SCAN_CHUNK);
        let scanners = 4 * inner;
        // `float` in any cells from the scan to `out_norm`: a state sums thousands of steps, and
        // `y` reaches millions on real frames, past `half`'s 65504.
        let ys = self.wide(
            4 * inner * n + chunks * scanners * 2 * STATE,
            4 * inner,
            ll.h,
            ll.w,
        );
        let scan = Params {
            width: ll.w as u32,
            height: ll.h as u32,
            in_channels: chunks as u32,
            mode: SCAN_CHUNK as u32,
            src_at: ll.at as u32,
            src2_at: x_dbl.at as u32,
            dst_at: ys.at as u32,
            state_at: (ys.at + ys.len()) as u32,
            weight_at: remover.weight(&format!("{sa}.dt_projs_weight")).at,
            bias_at: remover.weight(&format!("{sa}.dt_projs_bias")).at,
            extra0: remover.weight(&format!("{sa}.A_logs")).at,
            extra1: remover.weight(&format!("{sa}.Ds")).at,
            extra2: rank as u32,
            extra3: inner as u32,
            ..Default::default()
        };
        let scanned = Bound {
            src: ll.buffer(),
            src2: x_dbl.buffer(),
            wide_dst: ys.buffer(),
            ..self.idle()
        };
        self.threads_bound("scan_ends", scan, scanned, scanners * chunks);
        self.threads_bound("scan_carry", scan, scanned, scanners);
        self.threads_bound("scan_out", scan, scanned, scanners * chunks);
        let summed = self.wide(inner * n, inner, ll.h, ll.w);
        drop((x_dbl, ll));
        self.threads_bound(
            "sum4",
            Params {
                src_at: ys.at as u32,
                dst_at: summed.at as u32,
                ..Default::default()
            },
            Bound {
                wide_src: ys.buffer(),
                wide_dst: summed.buffer(),
                ..self.idle()
            },
            summed.len(),
        );
        drop(ys);
        let inverse = self.wide(inner * h * w, inner, h, w);
        self.threads_bound(
            "idwt",
            Params {
                width: summed.w as u32,
                height: summed.h as u32,
                out_channels: inner as u32,
                flags: WIDE,
                src_at: bands.at as u32,
                src2_at: summed.at as u32,
                dst_at: inverse.at as u32,
                ..Default::default()
            },
            Bound {
                src: bands.buffer(),
                wide_src: summed.buffer(),
                wide_dst: inverse.buffer(),
                ..self.idle()
            },
            summed.len(),
        );
        drop((bands, summed));
        let y = self.tensor(inner, h, w);
        self.threads_bound(
            "layernorm",
            Params {
                in_channels: inner as u32,
                flags: WIDE,
                src_at: inverse.at as u32,
                dst_at: y.at as u32,
                weight_at: remover.weight(&format!("{sa}.out_norm.weight")).at,
                bias_at: remover.weight(&format!("{sa}.out_norm.bias")).at,
                eps: LIGHTRR_EPS,
                ..Default::default()
            },
            Bound {
                dst: y.buffer(),
                wide_src: inverse.buffer(),
                ..self.idle()
            },
            inverse.plane(),
        );
        drop(inverse);
        let gated = self.tensor(inner, h, w);
        self.threads(
            "gate",
            Params {
                src_at: y.at as u32,
                src2_at: z.at as u32,
                dst_at: gated.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(&y),
                src2: Some(z.buffer()),
                weights: Set::Net,
                dst: &gated,
            },
            gated.len(),
        );
        drop((y, z));
        let out = self.conv1(&gated, &format!("{sa}.out_proj"), c);
        drop(gated);
        let sum = self.tensor(c, h, w);
        self.threads(
            "scale_add",
            Params {
                width: x.plane() as u32,
                src_at: x.at as u32,
                src2_at: out.at as u32,
                dst_at: sum.at as u32,
                weight_at: remover.weight(&format!("{p}.skip_scale")).at,
                ..Default::default()
            },
            Bind {
                src: Some(x),
                src2: Some(out.buffer()),
                weights: Set::Net,
                dst: &sum,
            },
            sum.len(),
        );
        sum
    }

    /// `CrossScaleFusion` of one `CrossChannelAtt` into `into`: `att(q, kv) + kv * alpha + q * beta`.
    fn fusion(&self, q_in: &Planes, kv_in: &Planes, into: &Planes, p: &str, heads: usize) {
        let remover = self.remover;
        let c = q_in.c;
        let b = format!("{p}.blocks.0");
        let q = self.conv1(q_in, &format!("{b}.q"), c);
        let q = self.depthwise(&q, &format!("{b}.q_conv"));
        let kv = self.conv1(kv_in, &format!("{b}.kv"), 2 * c);
        let kv = self.depthwise(&kv, &format!("{b}.kv_conv"));
        let attention = self.tensor(c, c, 1);
        let params = Params {
            width: q.w as u32,
            height: q.h as u32,
            in_channels: c as u32,
            src_at: q.at as u32,
            src2_at: kv.at as u32,
            dst_at: attention.at as u32,
            extra0: heads as u32,
            extra1: remover.weight(&format!("{b}.temperature")).at,
            ..Default::default()
        };
        let entries = c * c;
        let wide = entries.min(65535);
        self.groups(
            "gram",
            Params {
                span: wide as u32,
                ..params
            },
            Bind {
                src: Some(&q),
                src2: Some(kv.buffer()),
                weights: Set::Net,
                dst: &attention,
            },
            (wide as u32, entries.div_ceil(wide) as u32),
        );
        drop(q);
        self.threads(
            "softmax",
            params,
            Bind {
                src: None,
                src2: None,
                weights: Set::Net,
                dst: &attention,
            },
            c,
        );
        let attended = self.tensor(c, q_in.h, q_in.w);
        let v = kv.channels(c, c);
        self.dispatch_gemm(
            Params {
                mode: GATHER_PLAIN,
                flags: A_FROM_SRC2,
                in_channels: c as u32,
                out_channels: c as u32,
                src_at: v.at as u32,
                dst_at: attended.at as u32,
                weight_at: attention.at as u32,
                bias_at: UNSET,
                ..Default::default()
            },
            Bind {
                src: Some(&v),
                src2: Some(attention.buffer()),
                weights: Set::Net,
                dst: &attended,
            },
        );
        drop((attention, kv, v));
        self.gemm(
            &attended,
            GATHER_PLAIN,
            remover.weight(&format!("{b}.project_out.weight")),
            None,
            into,
            c,
            0,
        );
        drop(attended);
        self.threads(
            "fuse",
            Params {
                src_at: kv_in.at as u32,
                src2_at: q_in.at as u32,
                dst_at: into.at as u32,
                weight_at: remover.weight(&format!("{p}.alpha")).at,
                bias_at: remover.weight(&format!("{p}.beta")).at,
                ..Default::default()
            },
            Bind {
                src: Some(kv_in),
                src2: Some(q_in.buffer()),
                weights: Set::Net,
                dst: into,
            },
            into.len(),
        );
    }

    /// A 1x1 convolution (or a linear layer over tokens) into a fresh tensor, bias where the
    /// weights hold one.
    fn conv1(&self, x: &Planes, name: &str, out: usize) -> Planes {
        let y = self.tensor(out, x.h, x.w);
        let remover = self.remover;
        self.gemm(
            x,
            GATHER_PLAIN,
            remover.weight(&format!("{name}.weight")),
            remover.bias(name),
            &y,
            x.c,
            0,
        );
        y
    }

    fn conv3(&self, x: &Planes, name: &str, out: usize) -> Planes {
        let y = self.tensor(out, x.h, x.w);
        let remover = self.remover;
        self.gemm(
            x,
            GATHER_3X3,
            remover.weight(&format!("{name}.weight")),
            remover.bias(name),
            &y,
            9 * x.c,
            0,
        );
        y
    }

    #[allow(clippy::too_many_arguments)]
    fn gemm(
        &self,
        b: &Planes,
        mode: u32,
        weight: Weight,
        bias: Option<Weight>,
        dst: &Planes,
        inner: usize,
        flags: u32,
    ) {
        if let Some(bias) = bias {
            assert_eq!(
                bias.set, weight.set,
                "a bias in another buffer from its weights"
            );
        }
        let (width, height) = match mode {
            GATHER_PATCH => (dst.w, dst.h),
            _ => (b.w, b.h),
        };
        self.dispatch_gemm(
            Params {
                mode,
                flags,
                width: width as u32,
                height: height as u32,
                in_channels: inner as u32,
                out_channels: dst.c as u32,
                src_at: b.at as u32,
                dst_at: dst.at as u32,
                weight_at: weight.at,
                bias_at: bias.map_or(UNSET, |bias| bias.at),
                ..Default::default()
            },
            Bind {
                src: Some(b),
                src2: None,
                weights: weight.set,
                dst,
            },
        );
    }

    fn dispatch_gemm(&self, params: Params, bind: Bind<'_>) {
        let columns = bind.dst.plane();
        let rows = params.out_channels as usize;
        self.groups(
            "gemm",
            Params {
                count: columns as u32,
                ..params
            },
            bind,
            (columns.div_ceil(TILE) as u32, rows.div_ceil(TILE) as u32),
        );
    }

    fn depthwise(&self, x: &Planes, name: &str) -> Planes {
        let y = self.tensor(x.c, x.h, x.w);
        self.threads(
            "depthwise",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                src_at: x.at as u32,
                dst_at: y.at as u32,
                weight_at: self.remover.weight(&format!("{name}.weight")).at,
                bias_at: self.remover.bias(name).map_or(UNSET, |bias| bias.at),
                ..Default::default()
            },
            Bind {
                src: Some(x),
                src2: None,
                weights: Set::Net,
                dst: &y,
            },
            y.len(),
        );
        y
    }

    fn layernorm(&self, x: &Planes, name: &str, eps: f32) -> Planes {
        let y = self.tensor(x.c, x.h, x.w);
        let weight = self.remover.weight(&format!("{name}.weight"));
        self.threads(
            "layernorm",
            Params {
                in_channels: x.c as u32,
                src_at: x.at as u32,
                dst_at: y.at as u32,
                weight_at: weight.at,
                bias_at: self.remover.weight(&format!("{name}.bias")).at,
                eps,
                ..Default::default()
            },
            Bind {
                src: Some(x),
                src2: None,
                weights: weight.set,
                dst: &y,
            },
            x.plane(),
        );
        y
    }

    fn elementwise(&self, kernel: &'static str, x: &Planes) {
        self.threads(
            kernel,
            Params {
                dst_at: x.at as u32,
                ..Default::default()
            },
            Bind {
                src: None,
                src2: None,
                weights: Set::Net,
                dst: x,
            },
            x.len(),
        );
    }

    /// `x += y * gamma`, `gamma` per channel.
    fn add_scaled(&self, x: &Planes, y: &Planes, gamma: Weight) {
        self.threads(
            "add_scaled",
            Params {
                width: x.plane() as u32,
                src_at: y.at as u32,
                dst_at: x.at as u32,
                weight_at: gamma.at,
                ..Default::default()
            },
            Bind {
                src: Some(y),
                src2: None,
                weights: gamma.set,
                dst: x,
            },
            x.len(),
        );
    }

    fn copy(&self, from: &Planes, to: &Planes) {
        assert_eq!(from.len(), to.len(), "a copy between sizes");
        self.threads(
            "copy",
            Params {
                src_at: from.at as u32,
                dst_at: to.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(from),
                src2: None,
                weights: Set::Net,
                dst: to,
            },
            to.len(),
        );
    }

    fn dwt(&self, x: &Planes) -> Planes {
        let y = self.tensor(x.c * 4, x.h / 2, x.w / 2);
        self.threads(
            "dwt",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                in_channels: x.c as u32,
                src_at: x.at as u32,
                dst_at: y.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(x),
                src2: None,
                weights: Set::Net,
                dst: &y,
            },
            x.len() / 4,
        );
        y
    }

    /// The inverse of [`Run::dwt`] into a tensor of `room` channels, the first quarter of `x`'s
    /// filled.
    fn idwt(&self, x: &Planes, room: usize) -> Planes {
        let c = x.c / 4;
        let y = self.tensor(room, x.h * 2, x.w * 2);
        self.threads(
            "idwt",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                out_channels: c as u32,
                src_at: x.at as u32,
                dst_at: y.at as u32,
                ..Default::default()
            },
            Bind {
                src: Some(x),
                src2: None,
                weights: Set::Net,
                dst: &y,
            },
            c * x.plane(),
        );
        y
    }

    fn resize_axis(&self, x: &Planes, to: usize, along_x: bool) -> Planes {
        let (h, w) = match along_x {
            true => (x.h, to),
            false => (to, x.w),
        };
        let y = self.tensor(x.c, h, w);
        self.threads(
            "resize_axis",
            Params {
                width: x.w as u32,
                height: x.h as u32,
                src_at: x.at as u32,
                dst_at: y.at as u32,
                extra0: to as u32,
                extra1: along_x as u32,
                ..Default::default()
            },
            Bind {
                src: Some(x),
                src2: None,
                weights: Set::Dino,
                dst: &y,
            },
            y.len(),
        );
        y
    }

    fn tensor(&self, c: usize, h: usize, w: usize) -> Planes {
        self.planes(c * h * w * self.remover.cells.bytes(), c, h, w)
    }

    fn wide(&self, floats: usize, c: usize, h: usize, w: usize) -> Planes {
        self.planes(floats * 4, c, h, w)
    }

    fn planes(&self, bytes: usize, c: usize, h: usize, w: usize) -> Planes {
        debug_assert!(
            bytes <= LARGEST_TENSOR * 4,
            "{bytes} bytes, past LARGEST_TENSOR"
        );
        let size = bytes.next_multiple_of(4).max(16) as u64;
        let mut free = self.free.borrow_mut();
        let fit = free
            .iter()
            .enumerate()
            .filter(|(_, buffer)| buffer.size() >= size && buffer.size() <= 2 * size)
            .min_by_key(|(_, buffer)| buffer.size())
            .map(|(at, _)| at);
        let buffer = match fit {
            Some(at) => free.swap_remove(at),
            None => self.gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some("dereflect tensor"),
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
        };
        Planes {
            slot: Rc::new(Slot {
                buffer,
                free: self.free.clone(),
            }),
            at: 0,
            c,
            h,
            w,
        }
    }

    fn threads(&self, kernel: &'static str, params: Params, bind: Bind<'_>, threads: usize) {
        self.threads_bound(kernel, params, self.bound(bind), threads);
    }

    fn threads_bound(
        &self,
        kernel: &'static str,
        params: Params,
        bound: Bound<'_>,
        threads: usize,
    ) {
        assert!(threads > 0, "{kernel} has no work");
        let groups = threads.div_ceil(THREADS);
        let across = groups.min(65535);
        self.push(
            kernel,
            Params {
                span: (across * THREADS) as u32,
                count: threads as u32,
                ..params
            },
            bound,
            (across as u32, groups.div_ceil(across) as u32),
        );
    }

    fn groups(&self, kernel: &'static str, params: Params, bind: Bind<'_>, groups: (u32, u32)) {
        self.push(kernel, params, self.bound(bind), groups);
    }

    fn bound<'b>(&'b self, bind: Bind<'b>) -> Bound<'b> {
        let remover = self.remover;
        Bound {
            src: bind.src.map_or(&remover.empty, Planes::buffer),
            weights: match bind.weights {
                Set::Net => &remover.net,
                Set::Dino => &remover.dino,
            },
            dst: bind.dst.buffer(),
            src2: bind.src2.unwrap_or(&remover.empty),
            ..self.idle()
        }
    }

    /// Placeholders in every binding, each read one `empty` and each written one `sink`.
    fn idle(&self) -> Bound<'_> {
        let remover = self.remover;
        Bound {
            src: &remover.empty,
            weights: &remover.net,
            dst: &remover.sink,
            src2: &remover.empty,
            wide_src: &remover.empty,
            wide_dst: &remover.sink,
        }
    }

    fn push(&self, kernel: &'static str, params: Params, bound: Bound<'_>, groups: (u32, u32)) {
        let Bound {
            src,
            weights,
            dst,
            src2,
            wide_src,
            wide_dst,
        } = bound;
        self.ops.borrow_mut().push(Op {
            kernel,
            params,
            bound: [src, weights, dst, src2, wide_src, wide_dst].map(Buffer::clone),
            groups,
        });
    }

    /// The frame's `float` planes in `wide` into this run's cells, as bfloat16 (`admit`).
    fn admit(&self, wide: &Buffer, into: &Planes) {
        let params = Params {
            dst_at: into.at as u32,
            ..Default::default()
        };
        let bound = Bound {
            dst: into.buffer(),
            wide_src: wide,
            ..self.idle()
        };
        self.threads_bound("admit", params, bound, into.len());
    }

    /// `from` out to `float` planes in `wide`.
    fn widen(&self, from: &Planes, wide: &Buffer) {
        let params = Params {
            src_at: from.at as u32,
            ..Default::default()
        };
        let bound = Bound {
            src: from.buffer(),
            wide_dst: wide,
            ..self.idle()
        };
        self.threads_bound("widen", params, bound, from.len());
    }

    fn flush(&self) {
        let ops = std::mem::take(&mut *self.ops.borrow_mut());
        if ops.is_empty() {
            return;
        }
        let remover = self.remover;
        let stride = remover.uniform_stride as usize;
        let mut uniforms = vec![0u8; stride * ops.len()];
        for (i, op) in ops.iter().enumerate() {
            uniforms[i * stride..i * stride + std::mem::size_of::<Params>()]
                .copy_from_slice(bytemuck::bytes_of(&op.params));
        }
        let mut recording = self.gpu.record();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("dereflect params"),
            contents: &uniforms,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let groups: Vec<wgpu::BindGroup> = ops
            .iter()
            .map(|op| {
                fn entry(binding: u32, buffer: &Buffer) -> wgpu::BindGroupEntry<'_> {
                    wgpu::BindGroupEntry {
                        binding,
                        resource: buffer.as_entire_binding(),
                    }
                }
                self.gpu.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some(op.kernel),
                    layout: &remover.layout,
                    entries: &[
                        entry(0, &op.bound[0]),
                        entry(1, &op.bound[1]),
                        entry(2, &op.bound[2]),
                        entry(3, &op.bound[3]),
                        entry(4, &op.bound[4]),
                        entry(5, &op.bound[5]),
                        wgpu::BindGroupEntry {
                            binding: 20,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: &uniform,
                                offset: 0,
                                size: wgpu::BufferSize::new(std::mem::size_of::<Params>() as u64),
                            }),
                        },
                    ],
                })
            })
            .collect();
        for op in &ops {
            for buffer in &op.bound {
                recording.holding(buffer);
            }
        }
        for (i, (op, group)) in ops.iter().zip(&groups).enumerate() {
            recording.dispatch([op.groups.0, op.groups.1, 1], Whole::Fixed, |pass| {
                pass.set_pipeline(&remover.pipelines[op.kernel]);
                pass.set_bind_group(0, group, &[(i * stride) as u32]);
            });
        }
    }
}
