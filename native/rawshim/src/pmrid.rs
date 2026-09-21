//! PMRID on the Bayer mosaic: the learned denoiser, beside GALOSH and chosen instead of it.
//!
//! A published network (`slang/pmrid.slang` is its forward pass, `bun run get:pmrid` its weights),
//! run where GALOSH runs and over the same thing: a conditioned mosaic in [0, 1], filtered in
//! place. What it predicts is a *residual*, so the two Detail sliders are a blend of what it found
//! rather than a retrained strength, and the split between them is the one `reap` makes.
//!
//! **What is approximate, and is the reason this is a choice rather than the default.** The network
//! was trained on one sensor's raw photosites where ours are black-subtracted, normalised and white
//! balanced, so the gains are divided back out before the pack and multiplied in after it. Its
//! input is variance-stabilised to its own calibration's ISO 1600 anchor, which is a polynomial in
//! *that* sensor's ISO; what stands in for it is this frame's own fitted noise model converted into
//! the same `k`/`sigma` pair, off green, whose gain is not 1 here so both terms are rescaled by it.
//! The photographs say that is close enough to be worth offering. It is not a calibration.

use std::collections::HashMap;

/// Their calibration's anchor, from `run_benchmark.py`: `K(1600)` and `Sigma(1600)` of the
/// polynomials fitted to the sensor PMRID was trained on.
const ANCHOR_K: f64 = 0.0005995267 * 1600.0 + 0.00868861;
const ANCHOR_SIGMA: f64 = 7.11772e-7 * 1600.0 * 1600.0 + 6.514934e-4 * 1600.0 + 0.11492713;

/// The code range their `k` and `sigma` are stated over, and the scale the network's input is
/// multiplied by once stabilised. Both are `run_benchmark.py`'s.
const V: f64 = 959.0;
const INPUT_SCALE: f64 = 256.0;

/// The mosaic a tile covers, and what each one is grown by so that its interior has context.
///
/// **Both are in mosaic pixels, and the network sees half of each.** The arena is every tensor the
/// forward pass holds at once, which at this tile is 134MB; a frame put through whole would be
/// hundreds of times that. The halo is what stops the seam: four halvings put a decoder pixel's
/// receptive field over a hundred packed pixels away, so a tile denoised against its own edge
/// disagrees with its neighbour along the join.
const TILE: usize = 1024;
const HALO: usize = 128;

/// The network's four halvings, which every tile's packed plane has to divide by.
const HALVINGS: usize = 32;

/// The plan for walking the weights, which is 20KB of names and offsets and is embedded on both
/// hosts. The weights themselves are four megabytes and are not ([`weights`]).
const MANIFEST: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/.pmrid/weights.json"));

/// The weights as `bun run get:pmrid` unpacks them.
///
/// **Embedded in a rendition's binary and fetched by a page, which is one network either way.** A
/// rendition is the picture this application promises, so a machine missing a file beside the
/// binary would render a different photograph rather than fail; a tab is a download, and four
/// megabytes of weights inside the module is four megabytes every reader pays whether or not they
/// choose this filter - and pays again on the next build, the module's name being its own hash.
/// Served apart, the browser caches them apart, and only a reader who asks for the network fetches
/// them at all ([`crate::wasm::hold_pmrid_weights`]).
#[cfg(not(target_arch = "wasm32"))]
fn weights() -> Option<&'static [u8]> {
    Some(include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/.pmrid/weights.bin")))
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static WEIGHTS: std::cell::Cell<Option<&'static [u8]>> = const { std::cell::Cell::new(None) };
}

#[cfg(target_arch = "wasm32")]
fn weights() -> Option<&'static [u8]> {
    WEIGHTS.with(std::cell::Cell::get)
}

/// What the page fetched, kept for the rest of the tab.
///
/// Leaked because the kernels built from it are, and for the same reason: a browser's buffer is
/// neither `Send` nor `Sync`, so what a page builds it holds where it built it.
#[cfg(target_arch = "wasm32")]
pub fn hold_weights(bytes: Vec<u8>) {
    WEIGHTS.with(|held| held.set(Some(Box::leak(bytes.into_boxed_slice()))));
}

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Dense,
    Depthwise,
    Upsample,
    Add,
}

struct Layer {
    op: Op,
    input: usize,
    skip: usize,
    output: usize,
    kernel: usize,
    stride: usize,
    pad: usize,
    relu: bool,
    /// Whether this layer adds `skip` to what it computed before its ReLU, which is a residual the
    /// layer after it would otherwise be.
    fused: bool,
    weights_at: usize,
    bias_at: usize,
}

/// A tensor as the arena holds it: channels at a power-of-two fraction of the tile.
#[derive(Clone, Copy)]
struct Plane {
    channels: usize,
    level: u32,
}

struct Net {
    tensors: Vec<Plane>,
    layers: Vec<Layer>,
    offsets: HashMap<String, usize>,
}

impl Net {
    fn at(&self, name: &str) -> usize {
        *self.offsets.get(name).unwrap_or_else(|| panic!("the weights hold {name}"))
    }

    fn plane(&mut self, channels: usize, level: u32) -> usize {
        self.tensors.push(Plane { channels, level });
        self.tensors.len() - 1
    }

    fn dense(
        &mut self,
        input: usize,
        name: &str,
        out_c: usize,
        k: usize,
        stride: usize,
        relu: bool,
    ) -> usize {
        let level = self.tensors[input].level + u32::from(stride == 2);
        let output = self.plane(out_c, level);
        self.layers.push(Layer {
            op: Op::Dense,
            input,
            skip: 0,
            output,
            kernel: k,
            stride,
            pad: k / 2,
            relu,
            fused: false,
            weights_at: self.at(&format!("{name}.weight")),
            bias_at: self.at(&format!("{name}.bias")),
        });
        output
    }

    /// `Conv2D(..., is_seperable=True)`: a depthwise convolution and a 1x1 that mixes it.
    fn separable(
        &mut self,
        input: usize,
        name: &str,
        out_c: usize,
        k: usize,
        stride: usize,
        relu: bool,
    ) -> usize {
        let in_c = self.tensors[input].channels;
        let level = self.tensors[input].level + u32::from(stride == 2);
        let spread = self.plane(in_c, level);
        self.layers.push(Layer {
            op: Op::Depthwise,
            input,
            skip: 0,
            output: spread,
            kernel: k,
            stride,
            pad: k / 2,
            relu: false,
            fused: false,
            weights_at: self.at(&format!("{name}.depthwise.weight")),
            bias_at: 0,
        });
        self.dense(spread, &format!("{name}.pointwise"), out_c, 1, 1, relu)
    }

    /// A residual, folded into the layer that produced its first side where that is possible.
    ///
    /// **Every residual here follows its own convolution.** A block's last convolution writes a
    /// tensor that nothing but this add reads, so the add is a dispatch that reads two tensors and
    /// writes a third to do what the convolution could have done as it stored. Folded, the tensor
    /// between them never exists.
    fn add(&mut self, input: usize, skip: usize, relu: bool) -> usize {
        let last = self.layers.last_mut().expect("a residual follows something");
        let shaped = self.tensors[input].channels == self.tensors[skip].channels
            && self.tensors[input].level == self.tensors[skip].level;
        // **The producing layer must not rectify its own output first.** A decoder stage's
        // `proj_conv` does, and folding the addition into it would put that ReLU after the addition
        // rather than before it, which is a different network.
        let foldable = shaped
            && last.output == input
            && !last.fused
            && !last.relu
            && matches!(last.op, Op::Dense | Op::Upsample);
        if foldable {
            last.fused = true;
            last.skip = skip;
            last.relu = relu;
            return input;
        }

        let output = self.plane(self.tensors[input].channels, self.tensors[input].level);
        self.layers.push(Layer {
            op: Op::Add,
            input,
            skip,
            output,
            kernel: 1,
            stride: 1,
            pad: 0,
            relu,
            fused: false,
            weights_at: 0,
            bias_at: 0,
        });
        output
    }

    fn upsample(&mut self, input: usize, name: &str, out_c: usize) -> usize {
        let output = self.plane(out_c, self.tensors[input].level - 1);
        self.layers.push(Layer {
            op: Op::Upsample,
            input,
            skip: 0,
            output,
            kernel: 2,
            stride: 2,
            pad: 0,
            relu: false,
            fused: false,
            weights_at: self.at(&format!("{name}.weight")),
            bias_at: self.at(&format!("{name}.bias")),
        });
        output
    }

    fn encoder_block(
        &mut self,
        input: usize,
        name: &str,
        mid_c: usize,
        out_c: usize,
        stride: usize,
    ) -> usize {
        let in_c = self.tensors[input].channels;
        let projected = match stride == 1 && in_c == out_c {
            true => input,
            false => self.separable(input, &format!("{name}.proj"), out_c, 3, stride, false),
        };
        let x = self.separable(input, &format!("{name}.conv1"), mid_c, 5, stride, true);
        let x = self.separable(x, &format!("{name}.conv2"), out_c, 5, 1, false);
        self.add(x, projected, true)
    }

    fn encoder_stage(&mut self, input: usize, name: &str, out_c: usize, blocks: usize) -> usize {
        let mut x = self.encoder_block(input, &format!("{name}.0"), out_c / 4, out_c, 2);
        for block in 1..blocks {
            x = self.encoder_block(x, &format!("{name}.{block}"), out_c / 4, out_c, 1);
        }
        x
    }

    fn decoder_block(&mut self, input: usize, name: &str) -> usize {
        let channels = self.tensors[input].channels;
        let x = self.separable(input, &format!("{name}.conv0"), channels, 3, 1, true);
        let x = self.separable(x, &format!("{name}.conv1"), channels, 3, 1, false);
        self.add(x, input, false)
    }

    /// **The projection is emitted before the upsample it is added to, which the network does not
    /// say and nothing minds.** They read different tensors, so either order computes the same
    /// thing - and with the projection already written, the addition folds into the upsample's
    /// store rather than being a dispatch of its own.
    fn decoder_stage(&mut self, input: usize, skip: usize, name: &str, out_c: usize) -> usize {
        let x = self.decoder_block(input, &format!("{name}.decode_conv"));
        let projected = self.separable(skip, &format!("{name}.proj_conv"), out_c, 3, 1, true);
        let x = self.upsample(x, &format!("{name}.upsample"), out_c);
        self.add(x, projected, false)
    }
}

/// The network of `models/net_torch.py`, as the layers this shader dispatches.
fn build(offsets: HashMap<String, usize>) -> (Net, usize) {
    let mut net = Net { tensors: Vec::new(), layers: Vec::new(), offsets };
    let input = net.plane(4, 0);

    let conv0 = net.dense(input, "conv0.conv", 16, 3, 1, true);
    let conv1 = net.encoder_stage(conv0, "enc1", 64, 2);
    let conv2 = net.encoder_stage(conv1, "enc2", 128, 2);
    let conv3 = net.encoder_stage(conv2, "enc3", 256, 4);
    let conv4 = net.encoder_stage(conv3, "enc4", 512, 4);

    let conv5 = net.separable(conv4, "encdec", 64, 3, 1, true);

    let up3 = net.decoder_stage(conv5, conv3, "dec1", 64);
    let up2 = net.decoder_stage(up3, conv2, "dec2", 32);
    let up1 = net.decoder_stage(up2, conv1, "dec3", 32);
    let up0 = net.decoder_stage(up1, conv0, "dec4", 16);

    let out = net.decoder_block(up0, "out0");
    let out = net.dense(out, "out1.conv", 4, 3, 1, false);
    let pred = net.add(out, input, false);
    (net, pred)
}

/// Where each tensor sits in the arena, and how many cells that takes in total.
///
/// **A tensor holds its room only while something still has to read it.** Fifteen of these are the
/// skips a decoder stage reaches back for and live most of the network; the rest are handed
/// straight to the next layer and are dead a dispatch later. Giving every one its own room is four
/// times the arena, and it is the 2GiB a binding may be that decides how large a tile can get.
fn lay_out(net: &Net, prediction: usize, pw: usize, ph: usize) -> (Vec<usize>, usize) {
    let floats = |plane: &Plane| plane.channels * (pw >> plane.level) * (ph >> plane.level);
    let mut last_read = vec![0usize; net.tensors.len()];
    for (at, layer) in net.layers.iter().enumerate() {
        last_read[layer.input] = at;
        if layer.op == Op::Add || layer.fused {
            last_read[layer.skip] = at;
        }
    }
    // Both of these outlive every dispatch: `reap` reads the prediction against the input the
    // network was handed, so the first tensor has to survive the last layer.
    last_read[prediction] = net.layers.len();
    last_read[0] = net.layers.len();

    let mut at = vec![usize::MAX; net.tensors.len()];
    let mut free: Vec<(usize, usize)> = Vec::new();
    let mut high = 0usize;
    let room = |free: &mut Vec<(usize, usize)>, want: usize, high: &mut usize| -> usize {
        match free.iter().position(|(_, size)| *size >= want) {
            Some(found) => {
                let (offset, size) = free.remove(found);
                if size > want {
                    free.push((offset + want, size - want));
                }
                offset
            }
            None => {
                let offset = *high;
                *high += want;
                offset
            }
        }
    };
    at[0] = room(&mut free, floats(&net.tensors[0]), &mut high);
    for (index, layer) in net.layers.iter().enumerate() {
        at[layer.output] = room(&mut free, floats(&net.tensors[layer.output]), &mut high);
        // Whatever this dispatch was the last reader of is room the next one can have.
        for (tensor, plane) in net.tensors.iter().enumerate() {
            if last_read[tensor] == index && at[tensor] != usize::MAX {
                free.push((at[tensor], floats(plane)));
            }
        }
    }
    (at, high)
}

/// `BLOCK` in `slang/pmrid.slang`: how many output channels one `dense` thread carries.
const DENSE_BLOCK: usize = 4;

/// `WIDE` and `TALL` in `slang/pmrid.slang`: a workgroup's shape in output pixels.
const WIDE: u32 = 16;
const TALL: u32 = 16;

/// `STEP` in `slang/pmrid.slang`: the input channels a pointwise workgroup takes at a time.
const STEP: usize = 16;

/// The tiles `slang/pmrid.slang` compiles `tiled` in, as `(pipeline, output channels, pixels)`.
///
/// **A tile is a trade between filling the card and filling itself**, and no one of them wins: the
/// network's planes run from 262144 pixels down to 1024, so a tile wide enough to carry the shallow
/// layers leaves eight workgroups across at the deepest ones, and a tile tall enough for 512 output
/// channels does most of its work on rows a 16-channel layer does not have.
const TILES: [(usize, usize, usize); 5] =
    [(4, 32, 128), (5, 16, 128), (6, 32, 64), (7, 32, 32), (8, 16, 64)];

/// `FRAG` in `slang/spirv/pmrid_coop.slang`: the fragment one subgroup multiplies.
const FRAG: usize = 16;

/// `CROSSING` there: one fragment a workgroup, which is how `stage` and `finish` are dispatched.
const CROSSING: u32 = (FRAG * FRAG) as u32;

/// The cooperative-matrix shapes, widest first, as `(entry point, rows, columns, depth)` one
/// workgroup covers and the threads it takes to. A layer takes the first whose three divide its
/// own.
///
/// **Two, where the sweep that chose them timed 123.** `slang/spirv/pmrid_coop.slang`'s header has
/// what the shape of that loop is worth: everything lands within a millisecond of the first row
/// here, and the network's best possible arrangement - every layer on its own fastest shape - two
/// milliseconds under it. The second row is what the layers too shallow or too narrow for the first
/// fall back to, and which one that is decides more than the first does.
const ARMS: [(&str, usize, usize, usize, u32); 2] =
    [("halff_2x2x2_2", 32, 64, 32, 64), ("halff_1x2x1", 16, 32, 16, 32)];

/// Where `stage` and `finish` sit in [`Coop::pipelines`], after [`ARMS`].
const STAGE: usize = ARMS.len();
const FINISH: usize = ARMS.len() + 1;

/// The device a cooperative multiply needs: the SPIR-V handed to the driver as it stands, the
/// instruction itself, the shape pushed with each dispatch, and `half` to hold the matrices in.
fn tensor_features() -> wgpu::Features {
    wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX
        | wgpu::Features::PASSTHROUGH_SHADERS
        | wgpu::Features::IMMEDIATES
        | wgpu::Features::SHADER_F16
}

/// Every kernel of the forward pass, built once for the process.
pub struct Pmrid {
    layout: wgpu::BindGroupLayout,
    /// `dense`, `depthwise`, `upsample`, `add`, then [`TILES`]' pointwise shapes, then `sow` and
    /// `reap`.
    pipelines: Vec<wgpu::ComputePipeline>,
    weights: crate::gpu::Buffer,
    /// The tensor cores, where this device has them, for the two thirds of the network they take.
    coop: Option<Coop>,
    net: Net,
    prediction: usize,
}

/// The 1x1 convolutions on the tensor cores: what `slang/spirv/pmrid_coop.slang` is dispatched
/// with, beside the WGSL the rest of the network is.
struct Coop {
    layout: wgpu::BindGroupLayout,
    /// [`ARMS`] in order, then `stage` and `finish`.
    pipelines: Vec<wgpu::ComputePipeline>,
    /// The pointwise weights in `half`, each layer's held a fragment at a time.
    weights: crate::gpu::Buffer,
    /// Where each layer's weights are in that buffer, `usize::MAX` for a layer this is not one of.
    weights_at: Vec<usize>,
}

/// The kernels, built on the first frame that asks for them and kept for the process.
///
/// Two holders for the one thing, as `gpu::device` has them and for its reason: the weights are a
/// buffer, and a browser's buffer is neither `Send` nor `Sync`, so the page holds what it built
/// where it built it.
#[cfg(not(target_arch = "wasm32"))]
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Pmrid> {
    static BUILT: std::sync::OnceLock<Option<Pmrid>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Some(build_kernels(gpu, weights()?))).as_ref()
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static BUILT: std::cell::Cell<Option<&'static Pmrid>> = const { std::cell::Cell::new(None) };
}

/// `None` until the page has handed over what it fetched, which is the one way this answers `None`.
#[cfg(target_arch = "wasm32")]
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Pmrid> {
    if let Some(built) = BUILT.with(std::cell::Cell::get) {
        return Some(built);
    }
    let built: &'static Pmrid = Box::leak(Box::new(build_kernels(gpu, weights()?)));
    BUILT.with(|held| held.set(Some(built)));
    Some(built)
}

fn build_kernels(gpu: &'static crate::gpu::Gpu, weights: &'static [u8]) -> Pmrid {
    let device = gpu.describing();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("pmrid"),
        source: wgpu::ShaderSource::Wgsl(
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/pmrid.wgsl")).into(),
        ),
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
    let uniform = |binding: u32| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    };
    // One layout for every entry point, because they share their bindings: a bind group built for
    // one layer is what `sow` and `reap` are dispatched with too.
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("pmrid"),
        entries: &[storage(0, true), storage(1, false), storage(2, false), uniform(20), uniform(21)],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("pmrid"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipelines = [
        "dense",
        "depthwise",
        "upsample",
        "add",
        "pointwise",
        "pointwise_narrow",
        "pointwise_short",
        "pointwise_stub",
        "pointwise_small",
        "sow",
        "reap",
    ]
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

    let manifest: serde_json::Value =
        serde_json::from_str(MANIFEST).expect("the weights manifest parses");
    let offsets: HashMap<String, usize> = manifest["tensors"]
        .as_array()
        .expect("tensors")
        .iter()
        .map(|t| {
            (
                t["name"].as_str().expect("a name").to_string(),
                t["offset"].as_u64().expect("an offset") as usize,
            )
        })
        .collect();
    let (net, prediction) = build(offsets);

    let mut recording = gpu.record();
    let held = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pmrid weights"),
        contents: weights,
        usage: wgpu::BufferUsages::STORAGE,
    });
    recording.submit();

    let coop = coop_kernels(gpu, &net, weights);
    Pmrid { layout, pipelines, weights: held, coop, net, prediction }
}

/// The cooperative-matrix kernels, or `None` on a device without the instruction.
///
/// **The editor is always the `None` arm.** A browser offers no cooperative matrix and no way to
/// hand a driver SPIR-V, so what a page runs is the WGSL pointwise pass - the same network over the
/// same arena, one dispatch a layer instead of three - and the two arms are pinned against each
/// other by a test rather than trusted.
fn coop_kernels(gpu: &crate::gpu::Gpu, net: &Net, weights: &[u8]) -> Option<Coop> {
    let device = gpu.describing();
    if !device.features().contains(tensor_features()) {
        return None;
    }
    let named = || {
        ARMS.iter()
            .map(|(name, .., threads)| (*name, *threads))
            .chain([("stage", CROSSING), ("finish", CROSSING)])
    };
    let entry_points: Vec<wgpu::PassthroughShaderEntryPoint<'_>> = named()
        .map(|(name, threads)| wgpu::PassthroughShaderEntryPoint {
            name: name.into(),
            workgroup_size: (threads, 1, 1),
        })
        .collect();
    let module = {
        #[expect(unsafe_code)]
        // SAFETY: the SPIR-V is this repository's, compiled by `build.rs` from
        // `slang/spirv/pmrid_coop.slang`, and the layout below is what it declares. Nothing about
        // either is a caller's to choose.
        unsafe {
            device.create_shader_module_passthrough(wgpu::ShaderModuleDescriptorPassthrough {
                label: Some("pmrid coop"),
                entry_points: entry_points.into(),
                spirv: Some(wgpu::util::make_spirv_raw(include_bytes!(concat!(
                    env!("OUT_DIR"),
                    "/spirv/pmrid_coop.spv"
                )))),
                ..Default::default()
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
        label: Some("pmrid coop"),
        entries: &[
            storage(0, true),
            storage(1, false),
            storage(2, false),
            storage(3, false),
            storage(4, true),
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("pmrid coop"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: std::mem::size_of::<Shape>() as u32,
    });
    let pipelines = named()
        .map(|(name, _)| {
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

    let (packed, weights_at) = coop_weights(net, weights);
    let mut recording = gpu.record();
    let held = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pmrid coop weights"),
        contents: bytemuck::cast_slice(&packed),
        usage: wgpu::BufferUsages::STORAGE,
    });
    recording.submit();

    Some(Coop { layout, pipelines, weights: held, weights_at })
}

/// The pointwise weights in `half`, each layer's held a fragment at a time, and where each one is.
///
/// **A fragment at a time is what the blocked arms buy, and it is how the matrices are stored
/// rather than anything the instruction asks for**: a 16x16 fragment of a row-major plane is sixteen
/// rows of 32 bytes in sixteen lines, where held together it is four. The weights can be packed
/// once for the process; an activation plane is `stage`'s work, every layer of every tile.
fn coop_weights(net: &Net, weights: &[u8]) -> (Vec<u16>, Vec<usize>) {
    // Read rather than cast: neither a binary's own bytes nor a page's download is aligned to four.
    let source = |at: usize| f32::from_le_bytes(weights[at * 4..][..4].try_into().expect("four"));
    let mut packed: Vec<u16> = Vec::new();
    let mut at = vec![usize::MAX; net.layers.len()];
    for (index, layer) in net.layers.iter().enumerate() {
        let rows = net.tensors[layer.output].channels;
        let depth = net.tensors[layer.input].channels;
        if !as_matrix(layer, net) || rows % FRAG != 0 {
            continue;
        }
        let start = packed.len();
        at[index] = start;
        packed.resize(start + rows * depth, 0);
        for row in 0..rows {
            for cell in 0..depth {
                let value = source(layer.weights_at + row * depth + cell);
                packed[start + blocked(row, cell, depth)] = half::f16::from_f32(value).to_bits();
            }
        }
    }
    (packed, at)
}

/// `fragment_at` in `slang/spirv/pmrid_coop.slang`, down to the cell.
fn blocked(row: usize, column: usize, columns: usize) -> usize {
    ((row / FRAG) * (columns / FRAG) + column / FRAG) * FRAG * FRAG
        + (row % FRAG) * FRAG
        + column % FRAG
}

/// `Shape` in `slang/spirv/pmrid_coop.slang`: what every dispatch of it is pushed.
#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Shape {
    rows: u32,
    columns: u32,
    depth: u32,
    weights_at: u32,
    samples_at: u32,
    out_at: u32,
    plane_at: u32,
    into_at: u32,
    skip_at: u32,
    bias_at: u32,
    /// 1 rectifies what `finish` wrote, 2 adds the residual to it first.
    after: u32,
}

/// Where `sow` and `reap` sit in [`Pmrid::pipelines`].
const SOW: usize = 9;
const REAP: usize = 10;

/// One 1x1 convolution of the network as the matrix multiply it is.
pub struct Pointwise {
    /// Out channels by pixels, accumulated over in channels.
    pub rows: usize,
    pub columns: usize,
    pub depth: usize,
    pub weights_at: usize,
}

/// Every 1x1 convolution over a packed plane of `packed` square, which is two thirds of what the
/// network costs and the only part a cooperative-matrix kernel can take.
///
/// Here rather than in `examples/coopmat.rs` so that what that measures is this network and not a
/// transcription of it.
pub fn pointwise(packed: usize) -> Vec<Pointwise> {
    let manifest: serde_json::Value =
        serde_json::from_str(MANIFEST).expect("the weights manifest parses");
    let offsets: HashMap<String, usize> = manifest["tensors"]
        .as_array()
        .expect("tensors")
        .iter()
        .map(|t| {
            (
                t["name"].as_str().expect("a name").to_string(),
                t["offset"].as_u64().expect("an offset") as usize,
            )
        })
        .collect();
    let (net, _) = build(offsets);
    let mut at = 0;
    let mut found = Vec::new();
    for layer in &net.layers {
        if layer.op != Op::Dense || layer.kernel != 1 {
            continue;
        }
        let input = net.tensors[layer.input];
        let output = net.tensors[layer.output];
        let side = packed >> output.level;
        found.push(Pointwise {
            rows: output.channels,
            columns: side * side,
            depth: input.channels,
            weights_at: at,
        });
        at += output.channels * input.channels;
    }
    found
}

/// Whether this sensor's pattern is one the network's four planes describe.
///
/// The pack is a 2x2 of red, both greens and blue, which is what a Bayer CFA is and what PMRID was
/// trained on. An X-Trans frame has no such site.
pub fn filters(cfa: &crate::cfa::Cfa) -> bool {
    crate::galosh::filters(cfa)
}

/// The whole denoise: a mosaic in [0, 1] goes in, the same mosaic denoised comes back.
///
/// `gains` are the conditioning's own, by CFA colour, which this divides back out before the
/// network reads a photosite and multiplies in again afterwards.
///
/// **The sliders mean something else here than they do for GALOSH, and that is not a mismatch to
/// paper over.** GALOSH's Luminance is a multiple of the noise it measured, calibrated so that 62.5
/// is once; what the network predicts is a residual it already decided the size of, so a position
/// is the share of that residual to keep and 100 is the whole of it. The panel shows one pair of
/// positions either way, and a reader moving between the two denoisers is choosing a different
/// filter, not the same filter at a different strength.
pub fn denoise(
    gpu: &'static crate::gpu::Gpu,
    pmrid: &Pmrid,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
    detail: crate::galosh::Detail,
    fit: crate::galosh::NoiseFit,
) {
    // Which of the 2x2's positions each plane takes: red, the green beside it, the other green,
    // blue, which is the order the network's four channels are in.
    let mut position_at = [0u32; 4];
    let mut greens = 0;
    for position in 0..4u32 {
        match cfa.colour_at(position as usize / 2, position as usize % 2) {
            0 => position_at[0] = position,
            2 => position_at[3] = position,
            _ => {
                position_at[1 + greens] = position;
                greens += 1;
            }
        }
    }
    let gain_at: [f32; 4] = std::array::from_fn(|plane| {
        let position = position_at[plane] as usize;
        gains[usize::from(cfa.colour_at(position / 2, position % 2)).min(2)]
    });

    // The k-sigma transform of `run_benchmark.py`, against our own fitted model rather than their
    // ISO polynomial: the same variance in the same units, off green, whose gain the fit carries.
    let green = f64::from(gains[1]);
    let model = fit.model();
    let k = V * f64::from(model.alpha) / green;
    let sigma = V * V * f64::from(model.sigma_sq) / (green * green);
    let cvt_k = ANCHOR_K / k;
    let cvt_b = (sigma / (k * k) - ANCHOR_SIGMA / (ANCHOR_K * ANCHOR_K)) * ANCHOR_K / V;

    let (luma, colour) = detail.resolved(Some(fit));
    let tile = fits(gpu, pmrid);
    let (tile_w, tile_h) = (tile.min(even(mosaic.width)), tile.min(even(mosaic.height)));
    let window_w = grown(tile_w, mosaic.width);
    let window_h = grown(tile_h, mosaic.height);
    let (pw, ph) = (window_w / 2, window_h / 2);
    let mut held = Session::hold(gpu, pmrid, pw, ph);
    held.bind(gpu, pmrid, mosaic);

    for top in origins(even(mosaic.height), tile_h) {
        for left in origins(even(mosaic.width), tile_w) {
            let origin_x = pulled(left, window_w, even(mosaic.width));
            let origin_y = pulled(top, window_h, even(mosaic.height));
            let edges = Edges {
                stride: mosaic.width as u32,
                origin_x: origin_x as u32,
                origin_y: origin_y as u32,
                width: window_w as u32,
                height: window_h as u32,
                keep_x: (left - origin_x) as u32,
                keep_y: (top - origin_y) as u32,
                keep_width: tile_w.min(even(mosaic.width) - left) as u32,
                keep_height: tile_h.min(even(mosaic.height) - top) as u32,
                input_at: held.at[0] as u32,
                predicted_at: held.at[pmrid.prediction] as u32,
                position_at,
                gain_at,
                cvt_k: cvt_k as f32,
                cvt_b: cvt_b as f32,
                scale: INPUT_SCALE as f32,
                luma: (luma / 100.0) as f32,
                colour: (colour / 100.0) as f32,
            };
            held.run(gpu, pmrid, &edges, pw, ph);
        }
    }
}

/// The largest tile whose arena this device will bind, which is not the same answer on both hosts.
///
/// **A browser's floor is 128MB and the arena is every tensor the forward pass holds at once**, so
/// the tile a native rendition takes is one no page could allocate: at 1024 the window is 1280
/// mosaic pixels and the arena 210MB. Halved until it fits rather than fixed at the smallest that
/// always would, because a smaller tile pays the halo over more of the frame - and the editor asks
/// for this on a window, where it is the frame's own size that decides.
fn fits(gpu: &crate::gpu::Gpu, pmrid: &Pmrid) -> usize {
    let most = gpu.limits().max_storage_buffer_binding_size as usize;
    let mut tile = TILE;
    while tile > HALVINGS * 2 {
        let packed = grown(tile, usize::MAX) / 2;
        let (_, cells) = lay_out(&pmrid.net, pmrid.prediction, packed, packed);
        if cells * 4 <= most {
            break;
        }
        tile /= 2;
    }
    tile
}

/// The largest even extent no larger than this one, since every 2x2 site needs both of its rows.
fn even(extent: usize) -> usize {
    extent & !1
}

/// A tile grown by the halo on both sides, or the whole extent where that is smaller, rounded to
/// what the network's four halvings divide.
fn grown(tile: usize, extent: usize) -> usize {
    let grown = (tile + 2 * HALO).min(even(extent));
    let packed = (grown / 2 / HALVINGS).max(1) * HALVINGS;
    packed * 2
}

/// Where each tile starts, the last one of a row pulled back inside the frame rather than shrunk.
fn origins(extent: usize, tile: usize) -> Vec<usize> {
    let mut at = Vec::new();
    let mut start = 0;
    while start + tile < extent {
        at.push(start);
        start += tile;
    }
    at.push(even(extent.saturating_sub(tile)));
    at
}

/// Where a window of this size sits if it is to hold `tile` and stay inside the frame.
fn pulled(tile_at: usize, window: usize, extent: usize) -> usize {
    even(tile_at.saturating_sub(HALO).min(extent.saturating_sub(window)))
}

/// `Edges` in `slang/pmrid.slang`, which this has to agree with field for field. Both vectors
/// first, for the reason the shader's own comment gives: that way neither side has any padding.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Edges {
    position_at: [u32; 4],
    gain_at: [f32; 4],
    stride: u32,
    origin_x: u32,
    origin_y: u32,
    width: u32,
    height: u32,
    keep_x: u32,
    keep_y: u32,
    keep_width: u32,
    keep_height: u32,
    input_at: u32,
    predicted_at: u32,
    cvt_k: f32,
    cvt_b: f32,
    scale: f32,
    luma: f32,
    colour: f32,
}

/// The arena and the bindings one tile size needs, built once and dispatched over every tile.
struct Session {
    arena: crate::gpu::Buffer,
    edges: crate::gpu::Buffer,
    /// Held because a bind group does not: dropping these destroys the buffers under it.
    _uniforms: Vec<crate::gpu::Buffer>,
    groups: Vec<wgpu::BindGroup>,
    at: Vec<usize>,
    /// Which of [`TILES`] each 1x1 layer is dispatched in.
    tiles: Vec<usize>,
    /// Which of [`ARMS`] takes each 1x1 layer, where the tensor cores take it at all.
    arms: Vec<usize>,
    /// One layer's activations in `half`, the multiply's input and its answer, sized to the widest
    /// layer of the network.
    fragments: Option<[crate::gpu::Buffer; 2]>,
    coop_group: Option<wgpu::BindGroup>,
}

impl Session {
    fn hold(gpu: &'static crate::gpu::Gpu, pmrid: &Pmrid, pw: usize, ph: usize) -> Session {
        let net = &pmrid.net;
        let (at, cells) = lay_out(net, pmrid.prediction, pw, ph);
        let mut recording = gpu.record();
        let arena = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pmrid arena"),
            size: (cells * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let edges = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pmrid edges"),
            size: std::mem::size_of::<Edges>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut uniforms = Vec::new();
        for layer in &net.layers {
            let input = net.tensors[layer.input];
            let output = net.tensors[layer.output];
            let params: [u32; 16] = [
                (pw >> input.level) as u32,
                (ph >> input.level) as u32,
                input.channels as u32,
                (pw >> output.level) as u32,
                (ph >> output.level) as u32,
                output.channels as u32,
                layer.kernel as u32,
                layer.stride as u32,
                layer.pad as u32,
                u32::from(layer.relu),
                at[layer.input] as u32,
                at[layer.output] as u32,
                layer.weights_at as u32,
                layer.bias_at as u32,
                at[layer.skip] as u32,
                u32::from(layer.fused),
            ];
            uniforms.push(recording.init(&wgpu::util::BufferInitDescriptor {
                label: Some("pmrid params"),
                contents: &params.iter().flat_map(|v| v.to_ne_bytes()).collect::<Vec<u8>>(),
                usage: wgpu::BufferUsages::UNIFORM,
            }));
        }
        recording.submit();

        let tiles: Vec<usize> = net
            .layers
            .iter()
            .map(|layer| match as_matrix(layer, net) {
                true => {
                    let output = net.tensors[layer.output];
                    let plane = (pw >> output.level) * (ph >> output.level);
                    widest_that_fills(output.channels, plane)
                }
                false => usize::MAX,
            })
            .collect();
        // A layer whose plane no arm's tile divides stays on the WGSL pass, which is the same
        // answer from the same arena; the two dispatch into each other freely.
        let arms: Vec<usize> = net
            .layers
            .iter()
            .enumerate()
            .map(|(index, layer)| {
                let Some(coop) = &pmrid.coop else { return usize::MAX };
                if coop.weights_at[index] == usize::MAX {
                    return usize::MAX;
                }
                let output = net.tensors[layer.output];
                let columns = (pw >> output.level) * (ph >> output.level);
                let (rows, depth) = (output.channels, net.tensors[layer.input].channels);
                ARMS.iter()
                    .position(|(_, tall, wide, deep, _)| {
                        rows % tall == 0 && columns % wide == 0 && depth % deep == 0
                    })
                    .unwrap_or(usize::MAX)
            })
            .collect();
        let widest = |channels: fn(&Layer, &Net) -> usize| {
            net.layers
                .iter()
                .enumerate()
                .filter(|(index, _)| arms[*index] != usize::MAX)
                .map(|(_, layer)| {
                    let level = net.tensors[layer.output].level;
                    channels(layer, net) * (pw >> level) * (ph >> level)
                })
                .max()
                .unwrap_or(0)
        };
        let sized = [
            widest(|layer, net| net.tensors[layer.input].channels),
            widest(|layer, net| net.tensors[layer.output].channels),
        ];
        let mut recording = gpu.record();
        let fragments = (sized[0] > 0).then(|| {
            sized.map(|halves| {
                recording.buffer(&wgpu::BufferDescriptor {
                    label: Some("pmrid fragments"),
                    size: (halves * 2) as u64,
                    usage: wgpu::BufferUsages::STORAGE,
                    mapped_at_creation: false,
                })
            })
        });
        recording.submit();

        Session {
            arena,
            edges,
            groups: Vec::new(),
            _uniforms: uniforms,
            at,
            tiles,
            arms,
            fragments,
            coop_group: None,
        }
    }

    /// The bind groups, which need the mosaic this tile is being taken from.
    ///
    /// One per layer, differing only in which parameter block they carry; `sow` and `reap` read
    /// none, so they are dispatched with the first layer's.
    fn bind(&mut self, gpu: &'static crate::gpu::Gpu, pmrid: &Pmrid, mosaic: &crate::condition::Mosaic) {
        self.groups = self
            ._uniforms
            .iter()
            .map(|uniform| {
                gpu.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("pmrid"),
                    layout: &pmrid.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: pmrid.weights.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry { binding: 1, resource: self.arena.as_entire_binding() },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: mosaic.buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry { binding: 20, resource: uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 21, resource: self.edges.as_entire_binding() },
                    ],
                })
            })
            .collect();

        // The cooperative arm's own, and one for the whole network: what a layer is differs only in
        // what its dispatch is pushed.
        self.coop_group =
            pmrid.coop.as_ref().zip(self.fragments.as_ref()).map(|(coop, [samples, predicted])| {
                gpu.bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("pmrid coop"),
                    layout: &coop.layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: coop.weights.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: predicted.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry { binding: 3, resource: self.arena.as_entire_binding() },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: pmrid.weights.as_entire_binding(),
                        },
                    ],
                })
            });
    }

    /// One tile: the window packed, the ninety-two layers, the prediction blended back over it.
    fn run(
        &self,
        gpu: &'static crate::gpu::Gpu,
        pmrid: &Pmrid,
        edges: &Edges,
        pw: usize,
        ph: usize,
    ) {
        gpu.queue.write_buffer(&self.edges, 0, bytemuck::bytes_of(edges));
        let net = &pmrid.net;
        let mut recording = gpu.record();
        recording.holding(&self.arena);
        recording.holding(&self.edges);
        recording.holding(&pmrid.weights);
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            let sites = ((pw as u32).div_ceil(WIDE), (ph as u32).div_ceil(TALL));
            pass.set_pipeline(&pmrid.pipelines[SOW]);
            pass.set_bind_group(0, &self.groups[0], &[]);
            pass.dispatch_workgroups(sites.0, sites.1, 1);

            for (at, layer) in net.layers.iter().enumerate() {
                let output = net.tensors[layer.output];
                let input = net.tensors[layer.input];
                pass.set_bind_group(0, &self.groups[at], &[]);
                // A 1x1 convolution is a matrix multiply over the whole plane at once, so it is
                // dispatched over pixels and channels rather than over the picture's own shape.
                //
                // Three dispatches where the tensor cores take it: the plane into the `half` a
                // fragment load reads, the multiply, and the bias, the residual and the rectifier
                // the accumulator alone has no way to carry.
                if self.arms[at] != usize::MAX {
                    let coop = pmrid.coop.as_ref().expect("an arm means the kernels are built");
                    let group = self.coop_group.as_ref().expect("and a group to dispatch them in");
                    let columns = (pw >> output.level) * (ph >> output.level);
                    let shape = Shape {
                        rows: output.channels as u32,
                        columns: columns as u32,
                        depth: input.channels as u32,
                        weights_at: coop.weights_at[at] as u32,
                        samples_at: 0,
                        out_at: 0,
                        plane_at: self.at[layer.input] as u32,
                        into_at: self.at[layer.output] as u32,
                        skip_at: self.at[layer.skip] as u32,
                        bias_at: layer.bias_at as u32,
                        after: u32::from(layer.relu) | (u32::from(layer.fused) << 1),
                    };
                    let across = (columns / FRAG) as u32;
                    let (_, tall, wide, ..) = ARMS[self.arms[at]];
                    pass.set_bind_group(0, group, &[]);
                    for (pipeline, groups) in [
                        (STAGE, (across, (input.channels / FRAG) as u32)),
                        (self.arms[at], ((columns / wide) as u32, (output.channels / tall) as u32)),
                        (FINISH, (across, (output.channels / FRAG) as u32)),
                    ] {
                        pass.set_pipeline(&coop.pipelines[pipeline]);
                        pass.set_immediates(0, bytemuck::bytes_of(&shape));
                        pass.dispatch_workgroups(groups.0, groups.1, 1);
                    }
                    continue;
                }
                if self.tiles[at] != usize::MAX {
                    let (pipeline, rows, columns) = TILES[self.tiles[at]];
                    let plane = (pw >> output.level) * (ph >> output.level);
                    pass.set_pipeline(&pmrid.pipelines[pipeline]);
                    pass.dispatch_workgroups(
                        plane.div_ceil(columns) as u32,
                        output.channels.div_ceil(rows) as u32,
                        1,
                    );
                    continue;
                }
                pass.set_pipeline(match layer.op {
                    Op::Dense => &pmrid.pipelines[0],
                    Op::Depthwise => &pmrid.pipelines[1],
                    Op::Upsample => &pmrid.pipelines[2],
                    Op::Add => &pmrid.pipelines[3],
                });
                // `dense` carries `BLOCK` output channels a thread and `upsample` the 2x2 one input
                // pixel becomes, so each is dispatched over less than the output it writes.
                let (across, down) = match layer.op {
                    Op::Upsample => (pw >> input.level, ph >> input.level),
                    _ => (pw >> output.level, ph >> output.level),
                };
                let depth = match layer.op {
                    Op::Dense => output.channels.div_ceil(DENSE_BLOCK),
                    _ => output.channels,
                };
                pass.dispatch_workgroups(
                    (across as u32).div_ceil(WIDE),
                    (down as u32).div_ceil(TALL),
                    depth as u32,
                );
            }

            pass.set_pipeline(&pmrid.pipelines[REAP]);
            pass.set_bind_group(0, &self.groups[0], &[]);
            pass.dispatch_workgroups(sites.0, sites.1, 1);
        }
        recording.submit();
    }
}

/// Whether a layer is a matrix multiply the pointwise kernels dispatch as one.
fn as_matrix(layer: &Layer, net: &Net) -> bool {
    layer.op == Op::Dense
        && layer.kernel == 1
        && net.tensors[layer.input].channels % STEP == 0
        && layer.stride == 1
}

/// The pointwise shape for a layer: the widest tile that still fills the card with workgroups.
fn widest_that_fills(out_channels: usize, plane: usize) -> usize {
    /// What it takes to have every multiprocessor holding several workgroups.
    const ENOUGH: usize = 1024;
    TILES
        .iter()
        .enumerate()
        .filter(|(_, (_, rows, columns))| {
            out_channels.div_ceil(*rows) * plane.div_ceil(*columns) >= ENOUGH
        })
        .map(|(index, _)| index)
        .next()
        .unwrap_or(TILES.len() - 1)
}

#[cfg(test)]
mod tests {
    /// The tensor cores answer the same picture as the WGSL a page runs.
    ///
    /// **This is the rule about a rendition and the editor agreeing, at the one place the two hosts
    /// genuinely run different kernels.** The editor has no cooperative matrix and no way to hand a
    /// driver SPIR-V, so it takes the WGSL pointwise pass; a rendition on a card with the
    /// instruction takes this one, whose accumulator is `half` where the other's is `float`. What
    /// that accumulator costs the picture is what this measures.
    #[test]
    fn the_tensor_arm_denoises_what_the_wgsl_arm_does() {
        let Some(gpu) = crate::gpu::device() else { return };
        let network = super::device(gpu).expect("the network built");
        if network.coop.is_none() {
            return;
        }
        let mut wgsl_only = super::build_kernels(gpu, super::weights().expect("the weights"));
        wgsl_only.coop = None;

        let (width, height) = (512, 512);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut noise = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 40) as f32 / 16777216.0 - 0.5
        };
        let frame: Vec<f32> = (0..width * height)
            .map(|at| {
                let level = [0.20, 0.34, 0.34, 0.12][(at / width) % 2 * 2 + at % 2];
                (level + 0.03 * noise()).clamp(0.0, 1.0)
            })
            .collect();
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");
        let fit = crate::galosh::NoiseFit {
            alpha: 4.121e-4,
            sigma_sq: 3.494e-6,
            unified_sigma: 0.003,
            dark_ref: [0.0; 4],
        };
        let detail = crate::galosh::Detail::at(100.0, 100.0);
        let filtered = |kernels: &super::Pmrid| {
            let mosaic = crate::condition::Mosaic::upload(gpu, &frame, width, height);
            super::denoise(gpu, kernels, &mosaic, &cfa, [1.0, 1.0, 1.0], detail, fit);
            pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back")
        };
        let (tensors, wgsl) = (filtered(network), filtered(&wgsl_only));

        let worst =
            tensors.iter().zip(&wgsl).map(|(a, b)| f64::from((a - b).abs())).fold(0.0, f64::max);
        // 0.04 on this frame, and a quarter of a code is the room another driver's rounding has.
        assert!(worst * 255.0 < 0.25, "the two arms are {:.4} codes apart", worst * 255.0);
    }
}
