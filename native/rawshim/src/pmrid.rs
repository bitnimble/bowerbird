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

/// What each tile is grown by so that its interior has context, in mosaic pixels.
///
/// The halo is what stops the seam: four halvings put a decoder pixel's receptive field over a
/// hundred packed pixels away, so a tile denoised against its own edge disagrees with its neighbour
/// along the join.
const HALO: usize = 128;

/// The most cells the arena may hold, where the device would bind more.
///
/// The arena is every tensor the forward pass holds at once, about 150 cells a packed pixel, so
/// this is a window of about 1300 by 1300 packed pixels: 512MB in `half` and a gigabyte in `float`
/// ([`Pmrid::cell`]). Counted in cells so that both arms cut a frame the same way.
///
/// **Not all it would bind, though fewer tiles put fewer photosites through.** On an RTX 3080's
/// matrix units a 24MP frame is 56ms through six windows of 2304 and 60 through four of 3328.
const ARENA_CELLS_MOST: usize = 1 << 28;

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
///
/// **A depthwise's input lives through the 1x1 after it**, since the two are taken as one dispatch
/// that reads the one while it writes the other, so they must not share room.
fn lay_out(net: &Net, prediction: usize, pw: usize, ph: usize) -> (Vec<usize>, usize) {
    let floats = |plane: &Plane| plane.channels * (pw >> plane.level) * (ph >> plane.level);
    let mut last_read = vec![0usize; net.tensors.len()];
    for (at, layer) in net.layers.iter().enumerate() {
        last_read[layer.input] = at + usize::from(layer.op == Op::Depthwise);
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

/// Where each entry point of `slang/pmrid.slang` sits in [`Pmrid::pipelines`], the pointwise shapes
/// between `ADD` and `SOW` being [`TILES`]', and their separable twins the same order from
/// `SEPARABLE`.
const SPATIAL_16: usize = 0;
const SPATIAL_4: usize = 1;
const DEPTHWISE: usize = 2;
const UPSAMPLE: usize = 3;
const ADD: usize = 4;
const SOW: usize = 10;
const REAP: usize = 11;
const SEPARABLE: usize = 12;

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
    [(5, 32, 128), (6, 16, 128), (7, 32, 64), (8, 32, 32), (9, 16, 64)];

/// `tile_wide` in `slang/pmrid.slang`: how many pixels across a separable tile of `columns` is.
fn tile_wide(columns: usize) -> usize {
    if columns >= 128 { 16 } else { 8 }
}

/// `LANES` in `slang/passthrough/pmrid_coop.slang`: the subgroup a cooperative matrix is shared
/// across, which is a warp on the cards the sweep ran on and a SIMD group on an Apple one.
const LANES: usize = 32;

/// `FRAGMENT` in `slang/passthrough/pmrid_coop.slang`: the fragment one subgroup multiplies.
///
/// **The instruction's shape rather than a choice, and the drivers do not agree on it.** Vulkan
/// offers 16x16x16 in `half` on the parts this was measured on, and the host refuses a device whose
/// reported configurations do not include it. Metal has `simdgroup_matrix` at 8x8 and nothing else
/// - slangc refuses any other size by name - so the same tile of the output takes four multiplies
/// there for every one it takes on Vulkan.
///
/// Neither is read in a browser, which has no passthrough shader to be handed either kernel.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
const SPIRV_FRAGMENT: usize = 16;
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
const METAL_FRAGMENT: usize = 8;

/// The output rows a workgroup of `separable_<rows>`, `pointwise_<rows>` and `upsample_<rows>`
/// covers, the rows
/// the shader marks `DISPATCHED`, widest first. A layer takes the first its own divide by.
///
/// **64 at the most, where a workgroup of 128 or 256 would stage and filter each patch fewer
/// times.** Measured on an RTX 3080, neither moved a 24MP frame by more than its noise, and 256
/// made it slower: the depthwise a narrower workgroup repeats is not what the layer waits on.
const COOP_ROWS: [usize; 3] = [64, 32, 16];

/// `SEPARABLE_THREADS` in `slang/passthrough/pmrid_coop.slang`, which both kernels have.
const COOP_THREADS: u32 = (LANES * 4) as u32;

/// `PIXELS_WIDE` and `PIXELS_TALL` there: the tile of output pixels a `separable` workgroup covers.
const SEPARABLE_WIDE: usize = 8;
const SEPARABLE_TALL: usize = 8;

/// `PIXELS` there: the run of a plane a `pointwise` workgroup covers, which the plane has to
/// divide by.
const POINTWISE_PIXELS: usize = 64;

/// The fewest [`SEPARABLE_WIDE`] by [`SEPARABLE_TALL`] tiles a plane has for its layers to take
/// `separable` rather than `pointwise`.
///
/// **A small plane is a serial loop over too few workgroups.** `separable` stages and filters one
/// step of the depth between two barriers, so a layer 512 channels deep is thirty-two such steps
/// one after another, and a 40x40 plane is 25 tiles to spread them over. There the depthwise as a
/// dispatch of its own and a multiply with no barrier in its loop is faster. Over a 24MP frame on
/// an RTX 3080 this cut is 56.3ms, `separable` everywhere 57.2, and `pointwise` below 1000 tiles
/// 57.6: the windows [`window`] cuts leave few planes near it. Those are an Ampere card's numbers,
/// and no Apple part has been measured ([`passthrough`]).
const SEPARABLE_TILES_LEAST: usize = 100;

/// How the matrix units take a 1x1 layer, at which of [`COOP_ROWS`].
#[derive(Clone, Copy)]
enum Matrix {
    /// Together with the depthwise before it, whose plane never reaches the arena.
    Separable(usize),
    /// On its own, over the plane the WGSL depthwise wrote.
    Pointwise(usize),
    /// A 2x2 transposed convolution, as `pointwise` over its input with `out_channels * 4` rows,
    /// one for each channel and tap.
    Upsample(usize),
}

/// The device a cooperative multiply needs: the kernel handed to the driver as it stands, the
/// instruction itself, the shape pushed with each dispatch, and `half` to hold the matrices in.
fn tensor_features() -> wgpu::Features {
    wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX
        | wgpu::Features::PASSTHROUGH_SHADERS
        | wgpu::Features::IMMEDIATES
        | wgpu::Features::SHADER_F16
}

/// What the forward pass computes on, fastest first. A device builds the fastest it offers of
/// those no faster than it is asked for.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Arm {
    /// The 1x1 layers on the matrix units and the rest in WGSL, over a `half` arena.
    Matrix,
    /// All of it in WGSL, over a `half` arena, which needs `shader-f16`.
    Half,
    /// All of it in WGSL, over a `float` arena.
    Float,
}

/// Every kernel of the forward pass, built once for the process.
pub struct Pmrid {
    arm: Arm,
    layout: wgpu::BindGroupLayout,
    /// In the order [`SPATIAL_16`] and its neighbours say.
    pipelines: Vec<wgpu::ComputePipeline>,
    weights: crate::gpu::Buffer,
    /// The matrix units, where this device has them, for the two thirds of the network they take.
    coop: Option<Coop>,
    net: Net,
    prediction: usize,
    /// The bytes an arena cell is held in: `float` on [`Arm::Float`], `half` on the others.
    cell: usize,
}

/// The 1x1 convolutions on the matrix units: what `slang/passthrough/pmrid_coop.slang` is
/// dispatched with, beside the WGSL the rest of the network is.
struct Coop {
    layout: wgpu::BindGroupLayout,
    /// `separable_<rows>`, `pointwise_<rows>` and `upsample_<rows>` for each of [`COOP_ROWS`].
    separable: Vec<wgpu::ComputePipeline>,
    pointwise: Vec<wgpu::ComputePipeline>,
    upsample: Vec<wgpu::ComputePipeline>,
    /// The pointwise weights in `half`, each layer's held a fragment at a time.
    weights: crate::gpu::Buffer,
    /// Where each layer's weights are in that buffer, `usize::MAX` for a layer this is not one of.
    weights_at: Vec<usize>,
    /// [`SPIRV_FRAGMENT`] or [`METAL_FRAGMENT`], whichever this adapter's kernel was built for.
    fragment: usize,
}

/// The kernels, built on the first frame that asks for them and kept for the process.
///
/// Two holders for the one thing, as `gpu::device` has them and for its reason: the weights are a
/// buffer, and a browser's buffer is neither `Send` nor `Sync`, so the page holds what it built
/// where it built it.
#[cfg(not(target_arch = "wasm32"))]
pub fn device(gpu: &'static crate::gpu::Gpu) -> Option<&'static Pmrid> {
    static BUILT: std::sync::OnceLock<Option<Pmrid>> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| Some(build_kernels(gpu, weights()?, Arm::Matrix))).as_ref()
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
    let built: &'static Pmrid = Box::leak(Box::new(build_kernels(gpu, weights()?, Arm::Matrix)));
    BUILT.with(|held| held.set(Some(built)));
    Some(built)
}

/// The forward pass on the fastest [`Arm`] this device offers that is no faster than `fastest`.
fn build_kernels(gpu: &'static crate::gpu::Gpu, weights: &'static [u8], fastest: Arm) -> Pmrid {
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
    let coop = (fastest == Arm::Matrix).then(|| coop_kernels(gpu, &net, weights)).flatten();
    let device = gpu.describing();
    let arm = match coop {
        Some(_) => Arm::Matrix,
        None if fastest <= Arm::Half && device.features().contains(wgpu::Features::SHADER_F16) => {
            Arm::Half
        }
        None => Arm::Float,
    };

    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("pmrid"),
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
        entries: &[
            storage(0, true),
            storage(1, false),
            storage(2, true),
            storage(3, false),
            uniform(20),
            uniform(21),
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("pmrid"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipelines = [
        "spatial_16",
        "spatial_4",
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
        "separable",
        "separable_narrow",
        "separable_short",
        "separable_stub",
        "separable_small",
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

    let mut recording = gpu.record();
    let held = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pmrid weights"),
        contents: weights,
        usage: wgpu::BufferUsages::STORAGE,
    });
    recording.submit();

    let cell = match arm {
        Arm::Float => std::mem::size_of::<f32>(),
        Arm::Matrix | Arm::Half => std::mem::size_of::<half::f16>(),
    };
    Pmrid { arm, layout, pipelines, weights: held, coop, net, prediction, cell }
}

/// `slang/pmrid.slang` as WGSL, holding its arena in `half` or in `float` ([`Pmrid::cell`]).
fn forward_pass(half: bool) -> &'static str {
    match half {
        true => include_str!(concat!(env!("OUT_DIR"), "/wgsl/pmrid_half.wgsl")),
        false => include_str!(concat!(env!("OUT_DIR"), "/wgsl/pmrid.wgsl")),
    }
}

/// The kernel in the driver's own language, and the fragment its matrix instruction is.
///
/// **Named backend by backend, never a fallthrough.** What the driver is handed decides how the
/// host packs the weights, so a backend guessed at is a picture that comes out wrong rather than a
/// kernel that fails to build. A backend `build.rs` emits nothing for has no arm - the layers stay
/// on the WGSL pass, which is the answer the editor takes and the one pinned against this.
///
/// **Neither artefact is in the browser's module**, which is what the `cfg` is for rather than the
/// `None`: a page has no passthrough shader of any kind, and these are a quarter of a megabyte a
/// reader would download to never dispatch.
#[cfg(not(target_arch = "wasm32"))]
fn passthrough(
    backend: wgpu::Backend,
) -> Option<(wgpu::ShaderModuleDescriptorPassthrough<'static>, usize)> {
    let mut handed =
        wgpu::ShaderModuleDescriptorPassthrough { label: Some("pmrid coop"), ..Default::default() };
    match backend {
        wgpu::Backend::Metal => {
            handed.msl =
                Some(include_str!(concat!(env!("OUT_DIR"), "/passthrough/pmrid_coop.metal")).into());
            Some((handed, METAL_FRAGMENT))
        }
        wgpu::Backend::Vulkan => {
            handed.spirv = Some(wgpu::util::make_spirv_raw(include_bytes!(concat!(
                env!("OUT_DIR"),
                "/passthrough/pmrid_coop.spv"
            ))));
            Some((handed, SPIRV_FRAGMENT))
        }
        _ => None,
    }
}

#[cfg(target_arch = "wasm32")]
fn passthrough(
    _backend: wgpu::Backend,
) -> Option<(wgpu::ShaderModuleDescriptorPassthrough<'static>, usize)> {
    None
}

/// The cooperative-matrix kernels, or `None` on a device without the instruction.
///
/// **The editor is always the `None` arm.** A browser offers no cooperative matrix and no way to
/// hand a driver a kernel of its own, so what a page runs is the WGSL pass over a `float` arena -
/// the same network, a dispatch for each depthwise and each 1x1 - and the two arms are pinned
/// against each other by a test rather than trusted.
fn coop_kernels(gpu: &crate::gpu::Gpu, net: &Net, weights: &[u8]) -> Option<Coop> {
    let device = gpu.describing();
    if !device.features().contains(tensor_features()) {
        return None;
    }
    let (handed, fragment) = passthrough(gpu.backend)?;
    let named = |kernel: &str| COOP_ROWS.map(|rows| format!("{kernel}_{rows}"));
    let entry_points: Vec<wgpu::PassthroughShaderEntryPoint<'_>> = named("separable")
        .into_iter()
        .chain(named("pointwise"))
        .chain(named("upsample"))
        .map(|name| wgpu::PassthroughShaderEntryPoint {
            name: name.into(),
            workgroup_size: (COOP_THREADS, 1, 1),
        })
        .collect();
    let module = {
        #[expect(unsafe_code)]
        // SAFETY: the kernel is this repository's, compiled by `build.rs` from
        // `slang/passthrough/pmrid_coop.slang`, and the layout below is what it declares. Nothing
        // about either is a caller's to choose.
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
        label: Some("pmrid coop"),
        entries: &[storage(0, true), storage(1, false), storage(2, true)],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("pmrid coop"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: std::mem::size_of::<Shape>() as u32,
    });
    let pipelines = |kernel: &str| {
        named(kernel)
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
            .collect()
    };
    let (separable, pointwise, upsample) =
        (pipelines("separable"), pipelines("pointwise"), pipelines("upsample"));

    let (packed, weights_at) = coop_weights(net, weights, fragment);
    let mut recording = gpu.record();
    let held = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pmrid coop weights"),
        contents: bytemuck::cast_slice(&packed),
        usage: wgpu::BufferUsages::STORAGE,
    });
    recording.submit();

    Some(Coop { layout, separable, pointwise, upsample, weights: held, weights_at, fragment })
}

/// The pointwise weights in `half`, each layer's held a fragment at a time, and where each one is.
///
/// **A fragment at a time is how the matrices are stored rather than anything the instruction asks
/// for**: a 16x16 fragment of a row-major plane is sixteen rows of 32 bytes in sixteen lines, where
/// held together it is four.
fn coop_weights(net: &Net, weights: &[u8], fragment: usize) -> (Vec<u16>, Vec<usize>) {
    // Read rather than cast: neither a binary's own bytes nor a page's download is aligned to four.
    let source = |at: usize| f32::from_le_bytes(weights[at * 4..][..4].try_into().expect("four"));
    let mut packed: Vec<u16> = Vec::new();
    let mut at = vec![usize::MAX; net.layers.len()];
    for (index, layer) in net.layers.iter().enumerate() {
        let out_c = net.tensors[layer.output].channels;
        let depth = net.tensors[layer.input].channels;
        // A 1x1's weights are `[out][in]` already; an upsample's are `[in][out][2][2]`, and its
        // rows are `(out, tap)` ([`Matrix`]).
        let (rows, weight): (usize, &dyn Fn(usize, usize) -> usize) = match layer.op {
            Op::Upsample => (out_c * 4, &|row, cell| (cell * out_c + row / 4) * 4 + row % 4),
            _ if as_matrix(layer, net) => (out_c, &|row, cell| row * depth + cell),
            _ => continue,
        };
        if rows % fragment != 0 || depth % fragment != 0 {
            continue;
        }
        let start = packed.len();
        at[index] = start;
        packed.resize(start + rows * depth, 0);
        for row in 0..rows {
            for cell in 0..depth {
                let value = source(layer.weights_at + weight(row, cell));
                packed[start + blocked(row, cell, depth, fragment)] =
                    half::f16::from_f32(value).to_bits();
            }
        }
    }
    (packed, at)
}

/// `fragment_at` in `slang/passthrough/pmrid_coop.slang`, down to the cell.
fn blocked(row: usize, column: usize, columns: usize, fragment: usize) -> usize {
    ((row / fragment) * (columns / fragment) + column / fragment) * fragment * fragment
        + (row % fragment) * fragment
        + column % fragment
}

/// `Shape` in `slang/passthrough/pmrid_coop.slang`: what every dispatch of it is pushed.
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
    /// 1 rectifies what a layer writes, 2 adds the residual to it first.
    after: u32,
    in_width: u32,
    in_height: u32,
    out_width: u32,
    kernel: u32,
    stride: u32,
    spread_at: u32,
}

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
    mosaic: &mut crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
    detail: crate::galosh::Detail,
    fit: crate::galosh::NoiseFit,
) {
    let through = window(gpu, pmrid, mosaic.width, mosaic.height);
    denoise_through(gpu, pmrid, mosaic, cfa, gains, detail, fit, through);
}

/// [`denoise`] through a window of the caller's, as mosaic `(width, height)`.
#[allow(clippy::too_many_arguments)]
fn denoise_through(
    gpu: &'static crate::gpu::Gpu,
    pmrid: &Pmrid,
    mosaic: &mut crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    gains: [f32; 3],
    detail: crate::galosh::Detail,
    fit: crate::galosh::NoiseFit,
    (window_w, window_h): (usize, usize),
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
    let (pw, ph) = (window_w / 2, window_h / 2);
    let mut held = Session::take(gpu, pmrid, pw, ph);
    // Seeded from the caller's, so a photosite no tile keeps - the odd row or column past the last
    // whole 2x2 site - comes back as it arrived rather than as zero.
    let filtered = mosaic.duplicate(gpu);
    held.bind(gpu, pmrid, mosaic, &filtered);

    for (origin_y, top, bottom) in tiles(mosaic.height, window_h) {
        for (origin_x, left, right) in tiles(mosaic.width, window_w) {
            let edges = Edges {
                stride: mosaic.width as u32,
                origin_x: origin_x as u32,
                origin_y: origin_y as u32,
                width: window_w as u32,
                height: window_h as u32,
                keep_x: (left - origin_x) as u32,
                keep_y: (top - origin_y) as u32,
                keep_width: (right - left) as u32,
                keep_height: (bottom - top) as u32,
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
    *mosaic = filtered;
    held.put_back();
}

/// The window every tile of a `width` by `height` mosaic is taken through: of those whose arena
/// this device binds, the one that puts the fewest photosites through the network.
///
/// **Every tile pays its halo, and a small plane pays again**: a window of 1280 over a 24MP frame
/// runs the network over 1.6 times its photosites, and its deepest layers are too few workgroups to
/// fill the card. So the window is cut to the frame rather than the frame to a window, as large as
/// the arena allows - which is not the same answer on both hosts, a browser binding 128MB where a
/// native rendition holds [`ARENA_CELLS_MOST`].
fn window(gpu: &crate::gpu::Gpu, pmrid: &Pmrid, width: usize, height: usize) -> (usize, usize) {
    let bound = gpu.limits().max_storage_buffer_binding_size as usize / pmrid.cell;
    let most = ARENA_CELLS_MOST.min(bound) as u64;
    // Linear in the packed area, which the halvings divide, so one plane of them says it for all.
    let (_, cells) = lay_out(&pmrid.net, pmrid.prediction, HALVINGS, HALVINGS);
    let binds = |across: usize, down: usize| {
        let packed = (across / 2 * down / 2 / (HALVINGS * HALVINGS)) as u64;
        packed * cells as u64 <= most
    };
    let (widths, heights) = (spans(width), spans(height));
    let tried = widths.iter().flat_map(|across| heights.iter().map(move |down| (across, down)));
    tried
        .filter(|((across, _), (down, _))| binds(*across, *down))
        .min_by_key(|((across, wide), (down, tall))| across * wide * down * tall)
        .map_or_else(
            || (widths[widths.len() - 1].0, heights[heights.len() - 1].0),
            |((across, _), (down, _))| (*across, *down),
        )
}

/// The windows worth trying along an extent, widest first, each with how many tiles it takes.
fn spans(extent: usize) -> Vec<(usize, usize)> {
    let site = HALVINGS * 2;
    let widest = (even(extent) / site).max(1) * site;
    let mut spans: Vec<(usize, usize)> = (1..=extent.div_ceil(site))
        .map(|count| {
            let window = (extent.div_ceil(count) + 2 * HALO).next_multiple_of(site).min(widest);
            (window, tiles(extent, window).len())
        })
        .collect();
    spans.dedup();
    spans
}

/// The largest even extent no larger than this one, since every 2x2 site needs both of its rows.
fn even(extent: usize) -> usize {
    extent & !1
}

/// The frame cut into the regions each tile keeps, as `(window's origin, kept from, kept to)`.
///
/// **The kept regions partition the frame**: whole regions as wide as a window leaves between its
/// two halos, then whatever remains. It is the *window* that is pulled back inside the frame at its
/// far edge, never the region, so no photosite is kept twice.
///
/// **Sized from the window, not the tile.** A frame narrower than a tile and its halos gets a window
/// rounded down to what the halvings divide, which can be narrower than the frame itself, and a
/// region sized from the tile would then run past the window's edge and never be written. The halo
/// shrinks with the window for the same reason, so that a region always fits inside one.
fn tiles(extent: usize, window: usize) -> Vec<(usize, usize, usize)> {
    let extent = even(extent);
    if window >= extent {
        return vec![(0, 0, extent)];
    }
    let halo = even(HALO.min(window / 4));
    let step = window - 2 * halo;
    (0..extent)
        .step_by(step)
        .map(|from| {
            let origin = even(from.saturating_sub(halo).min(extent - window));
            (origin, from, (from + step).min(extent))
        })
        .collect()
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

/// Arenas kept between frames while anyone holds them ([`hold_arenas`]), keyed by the shape of
/// arena they are: packed width, packed height and the arm that built it.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
struct Kept<K, T> {
    holds: usize,
    idle: Vec<(K, T)>,
}

#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
impl<K: PartialEq, T> Kept<K, T> {
    const fn new() -> Kept<K, T> {
        Kept { holds: 0, idle: Vec::new() }
    }

    fn release(&mut self) {
        self.holds = self.holds.saturating_sub(1);
        if self.holds == 0 {
            self.idle.clear();
        }
    }

    fn take(&mut self, shape: K) -> Option<T> {
        let at = self.idle.iter().position(|(kept, _)| *kept == shape)?;
        Some(self.idle.swap_remove(at).1)
    }

    /// **Only the last shape put back is kept**, since a queue renders one camera's frames at a
    /// time and a pool of every size it has met would hold as many arenas. Of that shape, one arena
    /// for each frame that was denoised at once, which is what those frames held anyway.
    fn put(&mut self, shape: K, arena: T) {
        if self.holds == 0 {
            return;
        }
        self.idle.retain(|(kept, _)| *kept == shape);
        self.idle.push((shape, arena));
    }
}

#[cfg(not(target_arch = "wasm32"))]
static KEPT: std::sync::Mutex<Kept<(usize, usize, Arm), Session>> =
    std::sync::Mutex::new(Kept::new());

#[cfg(not(target_arch = "wasm32"))]
fn kept() -> std::sync::MutexGuard<'static, Kept<(usize, usize, Arm), Session>> {
    KEPT.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Keeps each frame's arena for the next frame of its size, until every hold is released: for a
/// queue of renders, where allocating the arena and freeing it is a tenth of the denoise. Without
/// one an arena is freed with its frame.
#[cfg(not(target_arch = "wasm32"))]
pub fn hold_arenas() {
    kept().holds += 1;
}

/// Ends one [`hold_arenas`]; the last frees every arena kept.
#[cfg(not(target_arch = "wasm32"))]
pub fn release_arenas() {
    kept().release();
}

/// Whether any [`hold_arenas`] is still unreleased.
#[cfg(not(target_arch = "wasm32"))]
pub fn arenas_held() -> bool {
    kept().holds > 0
}

/// The arena and the bindings one tile size needs, built once and dispatched over every tile.
struct Session {
    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    shape: (usize, usize, Arm),
    arena: crate::gpu::Buffer,
    edges: crate::gpu::Buffer,
    /// Held because a bind group does not: dropping these destroys the buffers under it.
    _uniforms: Vec<crate::gpu::Buffer>,
    groups: Vec<wgpu::BindGroup>,
    at: Vec<usize>,
    /// Which of [`TILES`] each 1x1 layer is dispatched in.
    tiles: Vec<usize>,
    /// How the matrix units take each 1x1 layer, where they take it at all.
    matrices: Vec<Option<Matrix>>,
    /// Which 1x1 layers the WGSL pass takes together with the depthwise before them.
    separable: Vec<bool>,
    coop_group: Option<wgpu::BindGroup>,
}

impl Session {
    /// An idle arena of this shape where one is kept, or a new one.
    fn take(gpu: &'static crate::gpu::Gpu, pmrid: &Pmrid, pw: usize, ph: usize) -> Session {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(kept) = kept().take((pw, ph, pmrid.arm)) {
            return kept;
        }
        Session::hold(gpu, pmrid, pw, ph)
    }

    /// Back among the idle arenas while anyone holds them, and freed otherwise.
    fn put_back(self) {
        #[cfg(not(target_arch = "wasm32"))]
        {
            let mut session = self;
            // The frame's bind groups hold its mosaic, which is the caller's to free.
            session.groups.clear();
            session.coop_group = None;
            kept().put(session.shape, session);
        }
    }

    fn hold(gpu: &'static crate::gpu::Gpu, pmrid: &Pmrid, pw: usize, ph: usize) -> Session {
        let net = &pmrid.net;
        let (at, cells) = lay_out(net, pmrid.prediction, pw, ph);
        let mut recording = gpu.record();
        let arena = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pmrid arena"),
            size: (cells * pmrid.cell) as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let edges = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pmrid edges"),
            size: std::mem::size_of::<Edges>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let matrices: Vec<Option<Matrix>> = (0..net.layers.len())
            .map(|index| pmrid.coop.as_ref().and_then(|coop| matrix(net, coop, index, pw, ph)))
            .collect();
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
        let separable: Vec<bool> = (0..net.layers.len())
            .map(|index| separable_on_wgsl(net, &matrices, &tiles, index))
            .collect();

        let mut uniforms = Vec::new();
        for (index, layer) in net.layers.iter().enumerate() {
            // A 1x1 that takes its depthwise reads that depthwise's input, at its kernel and stride.
            let reads = match separable[index] {
                true => &net.layers[index - 1],
                false => layer,
            };
            let input = net.tensors[reads.input];
            let output = net.tensors[layer.output];
            let params: [u32; 17] = [
                (pw >> input.level) as u32,
                (ph >> input.level) as u32,
                input.channels as u32,
                (pw >> output.level) as u32,
                (ph >> output.level) as u32,
                output.channels as u32,
                reads.kernel as u32,
                reads.stride as u32,
                reads.pad as u32,
                u32::from(layer.relu),
                at[reads.input] as u32,
                at[layer.output] as u32,
                layer.weights_at as u32,
                layer.bias_at as u32,
                at[layer.skip] as u32,
                u32::from(layer.fused),
                reads.weights_at as u32,
            ];
            let mut contents: Vec<u8> = params.iter().flat_map(|v| v.to_ne_bytes()).collect();
            // A uniform block is a whole number of sixteen bytes, however many it uses.
            contents.resize(contents.len().next_multiple_of(16), 0);
            uniforms.push(recording.init(&wgpu::util::BufferInitDescriptor {
                label: Some("pmrid params"),
                contents: &contents,
                usage: wgpu::BufferUsages::UNIFORM,
            }));
        }
        recording.submit();

        Session {
            shape: (pw, ph, pmrid.arm),
            arena,
            edges,
            groups: Vec::new(),
            _uniforms: uniforms,
            at,
            tiles,
            matrices,
            separable,
            coop_group: None,
        }
    }

    /// The bind groups, which need the mosaic this tile is being taken from.
    ///
    /// One per layer, differing only in which parameter block they carry; `sow` and `reap` read
    /// none, so they are dispatched with the first layer's.
    fn bind(
        &mut self,
        gpu: &'static crate::gpu::Gpu,
        pmrid: &Pmrid,
        mosaic: &crate::condition::Mosaic,
        filtered: &crate::condition::Mosaic,
    ) {
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
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: filtered.buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry { binding: 20, resource: uniform.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 21, resource: self.edges.as_entire_binding() },
                    ],
                })
            })
            .collect();

        // The cooperative arm's own, and one for the whole network: what a layer is differs only in
        // what its dispatch is pushed.
        self.coop_group = pmrid.coop.as_ref().map(|coop| {
            gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("pmrid coop"),
                layout: &coop.layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: coop.weights.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.arena.as_entire_binding() },
                    wgpu::BindGroupEntry {
                        binding: 2,
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
                // A depthwise taken together with its 1x1 is that layer's dispatch.
                let taken = matches!(self.matrices.get(at + 1), Some(Some(Matrix::Separable(_))));
                if taken || self.separable.get(at + 1) == Some(&true) {
                    continue;
                }
                if let Some(matrix) = self.matrices[at] {
                    let coop = pmrid.coop.as_ref().expect("a matrix means the kernels are built");
                    let group = self.coop_group.as_ref().expect("and a group to dispatch them in");
                    let (width, height) = (pw >> output.level, ph >> output.level);
                    let mut shape = Shape {
                        rows: output.channels as u32,
                        columns: (width * height) as u32,
                        depth: input.channels as u32,
                        weights_at: coop.weights_at[at] as u32,
                        plane_at: self.at[layer.input] as u32,
                        into_at: self.at[layer.output] as u32,
                        skip_at: self.at[layer.skip] as u32,
                        bias_at: layer.bias_at as u32,
                        after: u32::from(layer.relu) | (u32::from(layer.fused) << 1),
                        ..Default::default()
                    };
                    let (pipeline, (across, down), rows) = match matrix {
                        Matrix::Separable(rows) => {
                            let spread = &net.layers[at - 1];
                            let before = net.tensors[spread.input];
                            shape.plane_at = self.at[spread.input] as u32;
                            shape.in_width = (pw >> before.level) as u32;
                            shape.in_height = (ph >> before.level) as u32;
                            shape.out_width = width as u32;
                            shape.kernel = spread.kernel as u32;
                            shape.stride = spread.stride as u32;
                            shape.spread_at = spread.weights_at as u32;
                            let tiles =
                                (width.div_ceil(SEPARABLE_WIDE), height.div_ceil(SEPARABLE_TALL));
                            (&coop.separable[rows], tiles, rows)
                        }
                        Matrix::Pointwise(rows) => {
                            (&coop.pointwise[rows], (width * height / POINTWISE_PIXELS, 1), rows)
                        }
                        Matrix::Upsample(rows) => {
                            let (width, height) = (pw >> input.level, ph >> input.level);
                            shape.rows = output.channels as u32 * 4;
                            shape.columns = (width * height) as u32;
                            shape.in_width = width as u32;
                            shape.in_height = height as u32;
                            (&coop.upsample[rows], (width * height / POINTWISE_PIXELS, 1), rows)
                        }
                    };
                    pass.set_bind_group(0, group, &[]);
                    pass.set_pipeline(pipeline);
                    pass.set_immediates(0, bytemuck::bytes_of(&shape));
                    pass.dispatch_workgroups(
                        across as u32,
                        shape.rows / COOP_ROWS[rows] as u32,
                        down as u32,
                    );
                    continue;
                }
                pass.set_bind_group(0, &self.groups[at], &[]);
                // A 1x1 convolution is a matrix multiply over the whole plane at once, so it is
                // dispatched over pixels and channels rather than over the picture's own shape.
                if self.tiles[at] != usize::MAX {
                    let (pipeline, rows, columns) = TILES[self.tiles[at]];
                    let (width, height) = (pw >> output.level, ph >> output.level);
                    let wide = tile_wide(columns);
                    let (pipeline, across, down) = match self.separable[at] {
                        true => (
                            SEPARABLE + self.tiles[at],
                            width.div_ceil(wide),
                            height.div_ceil(columns / wide),
                        ),
                        false => (pipeline, (width * height).div_ceil(columns), 1),
                    };
                    pass.set_pipeline(&pmrid.pipelines[pipeline]);
                    pass.dispatch_workgroups(
                        across as u32,
                        output.channels.div_ceil(rows) as u32,
                        down as u32,
                    );
                    continue;
                }
                pass.set_pipeline(match layer.op {
                    Op::Dense => &pmrid.pipelines[spatial(layer, net)],
                    Op::Depthwise => &pmrid.pipelines[DEPTHWISE],
                    Op::Upsample => &pmrid.pipelines[UPSAMPLE],
                    Op::Add => &pmrid.pipelines[ADD],
                });
                // `spatial` carries every output channel a thread and `upsample` the 2x2 one input
                // pixel becomes, so each is dispatched over less than the output it writes.
                let (across, down) = match layer.op {
                    Op::Upsample => (pw >> input.level, ph >> input.level),
                    _ => (pw >> output.level, ph >> output.level),
                };
                let depth = match layer.op {
                    Op::Dense => 1,
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

/// Which `spatial` kernel a convolution that is not a matrix multiply is dispatched with.
///
/// **The network has two such layers and the shader is compiled for exactly them**: 3x3 at stride
/// 1, 4 channels to 16 at the start and 16 to 4 at the end. A layer of any other shape is a network
/// this was not written for, and is refused by name rather than dispatched against the wrong
/// kernel.
fn spatial(layer: &Layer, net: &Net) -> usize {
    let (input, output) = (net.tensors[layer.input], net.tensors[layer.output]);
    let shape = (layer.kernel, layer.stride, layer.pad, input.channels, output.channels);
    match shape {
        (3, 1, 1, 4, 16) => SPATIAL_16,
        (3, 1, 1, 16, 4) => SPATIAL_4,
        (k, stride, _, from, to) => panic!(
            "no spatial kernel for a {k}x{k} convolution at stride {stride} from {from} channels \
             to {to}"
        ),
    }
}

/// How the matrix units take layer `index` of a tile whose packed plane is `pw` by `ph`, or `None`
/// where they do not.
///
/// **Every 1x1 has a depthwise before it, so `separable` can always take it**, bounds and all;
/// `pointwise` is the faster answer on a small plane ([`SEPARABLE_TILES_LEAST`]), and only where
/// its plane divides into the runs it covers. An upsample is `pointwise`'s multiply over its input
/// with its own answer, and has to divide the same way.
fn matrix(net: &Net, coop: &Coop, index: usize, pw: usize, ph: usize) -> Option<Matrix> {
    let layer = &net.layers[index];
    let output = net.tensors[layer.output];
    if coop.weights_at[index] == usize::MAX {
        return None;
    }
    let widest = |rows: usize| COOP_ROWS.iter().position(|over| rows % over == 0);
    if layer.op == Op::Upsample {
        let input = net.tensors[layer.input];
        let columns = (pw >> input.level) * (ph >> input.level);
        return match columns % POINTWISE_PIXELS {
            0 => widest(output.channels * 4).map(Matrix::Upsample),
            _ => None,
        };
    }
    let spread = &net.layers[index.checked_sub(1)?];
    let taken = spread.op == Op::Depthwise
        && spread.output == layer.input
        && net.tensors[layer.input].channels % coop.fragment == 0;
    if !taken {
        return None;
    }
    let rows = widest(output.channels)?;
    let (width, height) = (pw >> output.level, ph >> output.level);
    let tiles = width.div_ceil(SEPARABLE_WIDE) * height.div_ceil(SEPARABLE_TALL);
    match tiles < SEPARABLE_TILES_LEAST && (width * height) % POINTWISE_PIXELS == 0 {
        true => Some(Matrix::Pointwise(rows)),
        false => Some(Matrix::Separable(rows)),
    }
}

/// Whether the WGSL pass takes 1x1 layer `index` together with the depthwise before it, in
/// [`TILES`]`[tiles[index]]`.
///
/// **Only where one workgroup covers every output channel.** Each workgroup filters the whole
/// depth of its patch, so a layer spread over several row blocks filters it once per block, and
/// that repeated depthwise costs more than the plane it saves writing. On an RTX 3080 over a 24MP
/// frame: 105.2ms unfused in `half`, 105.2 fusing one block, 115.6 two, 220.7 every layer; in
/// `float` 122.8, 119.7, 128.6 and 217.8.
fn separable_on_wgsl(
    net: &Net,
    matrices: &[Option<Matrix>],
    tiles: &[usize],
    index: usize,
) -> bool {
    let layer = &net.layers[index];
    let Some(spread) = index.checked_sub(1).map(|before| &net.layers[before]) else {
        return false;
    };
    matrices[index].is_none()
        && tiles[index] != usize::MAX
        && net.tensors[layer.output].channels <= TILES[tiles[index]].1
        && matches!((spread.kernel, spread.stride), (3 | 5, 1 | 2))
        && spread.op == Op::Depthwise
        && spread.output == layer.input
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
    /// An arena outlives its frame only while held, only for a frame of its shape, and not past
    /// the last release.
    #[test]
    fn an_arena_is_kept_only_while_held() {
        let (shape, other) = ((640, 640, 2), (512, 640, 2));
        let mut kept = super::Kept::new();
        kept.put(shape, 'a');
        assert_eq!(kept.take(shape), None, "kept with nothing holding it");

        kept.holds = 2;
        kept.put(shape, 'a');
        assert_eq!(kept.take(other), None);
        assert_eq!(kept.take(shape), Some('a'));
        kept.put(shape, 'a');
        kept.put(other, 'b');
        assert_eq!(kept.take(shape), None, "a shape no longer rendered is still held");

        kept.release();
        assert_eq!(kept.take(other), Some('b'), "freed while a hold remains");
        kept.put(other, 'b');
        kept.release();
        assert_eq!(kept.take(other), None, "kept past the last release");
    }

    /// Every window tried is one the halvings divide and the frame holds, and a frame they divide
    /// is tried whole.
    #[test]
    fn a_window_tried_is_one_the_network_can_take() {
        let site = super::HALVINGS * 2;
        for extent in [64, 100, 1000, 4024, 6048, 9728] {
            let spans = super::spans(extent);
            if extent % site == 0 {
                assert_eq!(spans[0], (extent, 1), "{extent}");
            }
            for (window, _) in spans {
                assert_eq!(window % site, 0, "{extent}: {window}");
                assert!(window <= extent.max(site), "{extent}: {window}");
            }
        }
    }

    /// [`super::COOP_ROWS`] is the rows the shader marks `DISPATCHED`.
    ///
    /// **The Metal artefact holds those kernels and nothing else**, `build.rs` reading them off the
    /// same lines, so a row this table names and that file does not is a module with no such entry
    /// point - on a Mac, and on no machine this is developed on. The shader's default `FRAGMENT` is
    /// here too, the Vulkan artefact taking it as it stands.
    #[test]
    fn the_rows_are_the_ones_the_shader_marks() {
        let source = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../slang/passthrough/pmrid_coop.slang"
        ))
        .expect("the shader is beside its host");
        let mut marked: Vec<usize> = source
            .lines()
            .filter_map(|line| line.strip_prefix("DISPATCHED(")?.strip_suffix(')')?.parse().ok())
            .collect();
        let mut held = super::COOP_ROWS.to_vec();
        marked.sort_unstable();
        held.sort_unstable();
        assert_eq!(marked, held, "the shader dispatches rows the host does not");
        assert!(
            source.contains(&format!("#define FRAGMENT {}", super::SPIRV_FRAGMENT)),
            "the shader's own fragment is not the one the Vulkan artefact is read with",
        );
        let build = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/build.rs"))
            .expect("the build script is this crate's");
        assert!(
            build.contains(&format!("-DFRAGMENT={}", super::METAL_FRAGMENT)),
            "the Metal artefact is compiled for a fragment this host does not pack for",
        );
    }

    /// Every photosite is denoised once, however the tiles fall across the frame.
    ///
    /// **Two ways a band of the photograph used to come out wrong.** A frame is rarely a whole
    /// number of tiles, so the last column of them was pulled back over the one before, and filtered
    /// in place the overlap was read back already denoised and denoised again - visibly smoother than
    /// the rest. And a frame narrower than a tile and its halos gets a window rounded down to what
    /// the halvings divide, which a region sized from the tile ran past, leaving its last columns
    /// never written.
    #[test]
    fn a_photosite_is_denoised_once() {
        let Some(gpu) = crate::gpu::device() else { return };
        let network = super::device(gpu).expect("the network built");
        let height = 256;
        let tile = 1024;
        let denoised = |width: usize, through: (usize, usize)| {
            let mut seed = 0x9e37_79b9_7f4a_7c15u64;
            let mut noise = || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed >> 40) as f32 / 16777216.0 - 0.5
            };
            let frame: Vec<f32> = (0..width * height).map(|_| 0.3 + 0.04 * noise()).collect();
            let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");
            let fit = crate::galosh::NoiseFit {
                alpha: 4.121e-4,
                sigma_sq: 3.494e-6,
                unified_sigma: 0.003,
                dark_ref: [0.0; 4],
            };
            let mut mosaic = crate::condition::Mosaic::upload(gpu, &frame, width, height);
            let detail = crate::galosh::Detail::at(100.0, 100.0);
            let gains = [1.0, 1.0, 1.0];
            super::denoise_through(gpu, network, &mut mosaic, &cfa, gains, detail, fit, through);
            pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back")
        };
        // The noise left in a band of columns, away from the top and bottom, where the network's
        // padding is its own.
        let spread = |filtered: &[f32], width: usize, from: usize, to: usize| {
            let samples: Vec<f64> = (32..height - 32)
                .flat_map(|y| (from..to).map(move |x| y * width + x))
                .map(|at| f64::from(filtered[at]))
                .collect();
            let mean = samples.iter().sum::<f64>() / samples.len() as f64;
            (samples.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
        };

        let width = tile * 3 / 2;
        let half = tile / 2;
        let wide = denoised(width, (tile + 2 * super::HALO, height));
        let bands = [
            spread(&wide, width, 32, half - 32),
            spread(&wide, width, half + 32, 2 * half - 32),
            spread(&wide, width, 2 * half + 32, 3 * half - 32),
        ];
        let outer = (bands[0] + bands[2]) / 2.0;
        assert!(
            (bands[1] / outer - 1.0).abs() < 0.1,
            "the overlap keeps {:.2e} of noise where either side keeps {:.2e} and {:.2e}",
            bands[1],
            bands[0],
            bands[2],
        );

        let width = 1000;
        let narrow = denoised(width, super::window(gpu, network, width, height));
        let (inside, edge) =
            (spread(&narrow, width, 100, 500), spread(&narrow, width, width - 64, width - 8));
        assert!(
            (edge / inside - 1.0).abs() < 0.1,
            "the last columns keep {edge:.2e} of noise where the rest keeps {inside:.2e}",
        );
    }

    /// A frame denoised in an arena another frame left behind comes out as it does in a new one.
    #[test]
    fn a_kept_arena_denoises_what_a_new_one_does() {
        let Some(gpu) = crate::gpu::device() else { return };
        let network = super::device(gpu).expect("the network built");
        let (width, height) = (512, 256);
        let denoised = |seed: u64| {
            let mut seed = seed;
            let frame: Vec<f32> = (0..width * height)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    0.3 + 0.04 * ((seed >> 40) as f32 / 16777216.0 - 0.5)
                })
                .collect();
            let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB is a pattern");
            let fit = crate::galosh::NoiseFit {
                alpha: 4.121e-4,
                sigma_sq: 3.494e-6,
                unified_sigma: 0.003,
                dark_ref: [0.0; 4],
            };
            let mut mosaic = crate::condition::Mosaic::upload(gpu, &frame, width, height);
            let detail = crate::galosh::Detail::at(100.0, 100.0);
            super::denoise(gpu, network, &mut mosaic, &cfa, [1.0, 1.0, 1.0], detail, fit);
            pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back")
        };
        let fresh = denoised(7);

        super::hold_arenas();
        denoised(3);
        let reused = denoised(7);
        super::release_arenas();

        assert!(fresh == reused, "the second frame read what the first left in its arena");
    }

    /// What each arm costs over a whole photograph on this adapter, and how far apart their
    /// pictures are.
    ///
    /// **A report more than a test**: the times go to stderr past the harness's capture, so a plain
    /// `bun run test:native pmrid_arms --features fixtures` prints them. With the arena held, as a
    /// render queue holds it, so what is timed is the network rather than an allocation. What is
    /// asserted is only that the arms paint the same picture, which the synthetic comparison beside
    /// this one cannot say about a frame with real highlights in it.
    #[cfg(feature = "fixtures")]
    #[test]
    fn pmrid_arms_on_a_photograph() {
        use std::io::Write;
        const RUNS: usize = 5;
        let Some(gpu) = crate::gpu::device() else { return };
        let weights = super::weights().expect("the weights");
        let arms: Vec<(super::Arm, super::Pmrid)> =
            [super::Arm::Matrix, super::Arm::Half, super::Arm::Float]
                .into_iter()
                .map(|arm| (arm, super::build_kernels(gpu, weights, arm)))
                .filter(|(arm, kernels)| kernels.arm == *arm)
                .collect();
        let mut report = std::io::stderr();

        super::hold_arenas();
        for path in [crate::fixture_tests::sony(), crate::fixture_tests::clipped()] {
            let bytes = std::fs::read(&path).expect("the fixture reads");
            let held = pollster::block_on(crate::decode_rawler::hold_bytes(&bytes)).expect("held");
            let fit = pollster::block_on(held.fit()).expect("a Bayer frame has a noise fit");
            let image = rawler::decode_file(&path).expect("rawler reads the coefficients");
            let gains = crate::decode_rawler::channel_ceilings(&image);
            let (cfa, mosaic) = (held.cfa(), held.device_mosaic());
            let detail = crate::galosh::Detail::at(100.0, 100.0);
            let run = |network: &super::Pmrid| {
                let mut frame = mosaic.duplicate(gpu);
                gpu.block_until_done();
                let started = std::time::Instant::now();
                super::denoise(gpu, network, &mut frame, &cfa, gains, detail, fit);
                gpu.block_until_done();
                (started.elapsed(), frame)
            };

            // The first of each compiles whatever pipelines the driver has not cached.
            let answers: Vec<Vec<f32>> = arms
                .iter()
                .map(|(_, kernels)| {
                    pollster::block_on(run(kernels).1.read(gpu)).expect("the mosaic reads back")
                })
                .collect();
            let mut fastest = vec![std::time::Duration::MAX; arms.len()];
            for _ in 0..RUNS {
                for (at, (_, kernels)) in arms.iter().enumerate() {
                    fastest[at] = fastest[at].min(run(kernels).0);
                }
            }

            let name = path.file_name().expect("a file").to_string_lossy();
            let megapixels = (mosaic.width * mosaic.height) as f64 / 1e6;
            let _ = writeln!(
                report,
                "pmrid on {}, {name} ({megapixels:.1}MP), fastest of {RUNS}:",
                gpu.adapter
            );
            let float = answers.last().expect("every device builds the float arm");
            let slowest = fastest.last().expect("and times it").as_secs_f64();
            let mut apart_most = (super::Arm::Float, 0.0);
            for (at, (arm, _)) in arms.iter().enumerate() {
                let took = fastest[at].as_secs_f64();
                if *arm == super::Arm::Float {
                    let _ = writeln!(report, "  {:<7} {:>7.1}ms", "Float", took * 1e3);
                    continue;
                }
                let apart: Vec<f64> = answers[at]
                    .iter()
                    .zip(float)
                    .map(|(a, b)| f64::from((a - b).abs()) * 255.0)
                    .collect();
                let mean = apart.iter().sum::<f64>() / apart.len() as f64;
                let worst = apart.iter().copied().fold(0.0, f64::max);
                let _ = writeln!(
                    report,
                    "  {:<7} {:>7.1}ms  {:.2}x Float's speed, {mean:.4} codes of 255 from it on \
                     average, {worst:.2} at the worst photosite",
                    format!("{arm:?}"),
                    took * 1e3,
                    slowest / took,
                );
                if mean > apart_most.1 {
                    apart_most = (*arm, mean);
                }
            }
            let (arm, mean) = apart_most;
            assert!(mean < 0.05, "{name}: {arm:?} is {mean:.4} codes from Float on average");
        }
        super::release_arenas();
    }

    /// Every shader holds the arena in the type the host sizes it for: `float` in the WGSL pass a
    /// device without `shader-f16` runs, `half` in the one a device with it runs and in the matrix
    /// units.
    ///
    /// **A mismatch reads as a picture, never as an error**: a `half` arena sized for `float` is
    /// twice the room it needs, and a `float` one sized for `half` is every tensor past the first
    /// half overwriting its neighbour.
    #[test]
    fn the_arena_is_held_in_what_the_host_sizes_it_for() {
        let read = |path: &str| {
            std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR")))
                .unwrap_or_else(|e| panic!("{path}: {e}"))
        };
        assert!(
            read("../../slang/pmrid.slang").contains("#define STORED float"),
            "the WGSL pass without `shader-f16` does not hold its arena in `float`",
        );
        assert!(
            read("build.rs").contains("-DSTORED=half"),
            "the WGSL pass with `shader-f16` does not hold its arena in `half`",
        );
        assert!(
            read("../../slang/passthrough/pmrid_coop.slang").contains("typealias Stored = half;"),
            "the matrix units do not hold the arena in what the pass beside them does",
        );
    }

    /// Every arm this device builds answers the same picture as the `float` WGSL a page without
    /// `shader-f16` runs.
    ///
    /// **This is the rule about a rendition and the editor agreeing, at the one place the hosts
    /// genuinely run different kernels.** A page takes the WGSL pass, over `half` where it has
    /// `shader-f16` and `float` where it does not; a rendition on a device with the matrix units
    /// takes those, over `half`. What `half` costs the picture is what this measures - on whichever
    /// arms the adapter built, so a Mac is measuring `simdgroup_matrix` here and a Vulkan card its
    /// own.
    #[test]
    fn every_arm_denoises_what_the_float_arm_does() {
        let Some(gpu) = crate::gpu::device() else { return };
        let weights = super::weights().expect("the weights");
        let float = super::build_kernels(gpu, weights, super::Arm::Float);

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
            let mut mosaic = crate::condition::Mosaic::upload(gpu, &frame, width, height);
            super::denoise(gpu, kernels, &mut mosaic, &cfa, [1.0, 1.0, 1.0], detail, fit);
            pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back")
        };
        let against = filtered(&float);
        for arm in [super::Arm::Matrix, super::Arm::Half] {
            let kernels = super::build_kernels(gpu, weights, arm);
            // A device builds the fastest arm it offers, which may be slower than the one asked.
            if kernels.arm != arm {
                continue;
            }
            let worst = filtered(&kernels)
                .iter()
                .zip(&against)
                .map(|(a, b)| f64::from((a - b).abs()))
                .fold(0.0, f64::max);
            // 0.08 on this frame, and a quarter of a code is the room another driver's rounding has.
            assert!(worst * 255.0 < 0.25, "{arm:?} is {:.4} codes from Float", worst * 255.0);
        }
    }
}
