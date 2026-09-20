// Fitting the transform that takes a RAW render to the camera's own JPEG.
//
// The whole search runs in one place: it evaluates tens of candidate geometries, each of
// which is warped on the device, paired and fitted, and the scan's candidates go up in one
// submit.
//
// Order matters and is not negotiable: geometry first, colour second. A colour
// transform is fitted from pixel pairs, and a pair means nothing unless both
// pixels show the same point in the scene. On a frame whose JPEG is
// distortion-corrected, fitting colour first plateaus at deltaE 16 however much
// capacity the colour model is given - a 33^3 LUT included - because no tone curve
// can map a pixel onto a different pixel's colour.
//
// That conclusion stands on its effect size rather than on its metric: 16 against
// 1.51 is an order of magnitude, and it is an argument about correspondence rather
// than about colour accuracy. The sub-claim it is usually quoted with - that the
// capacities "all land within 1.5 of each other" - does not stand, being a small
// difference read off the blind measure described at the `deltaE` section below.

use crate::image::polynomial_knots;
#[cfg(test)]
use crate::rgb::RgbRef;

/// Long edge the fit runs at. Fitting small and applying at full resolution costs
/// nothing measurable, and every candidate warp is O(pixels), so this is the
/// biggest lever on how long a fit takes. 640 still leaves well over a hundred
/// thousand usable pairs, far more than 256-bin curves need.
pub(crate) const FIT_LONG_EDGE: usize = 640;

/// The falloff's pairs are blurred before pairing: the camera's sharpening and noise
/// reduction are not reproducible and must not leak into what is fitted from them. Only
/// that grid sees this; the geometry search and the output never do.
const FIT_BLUR_SIGMA: f64 = 3.0;

/// A pair from a steep gradient is worthless: a fraction of a pixel of
/// misalignment there swamps the colour difference being measured.
pub(crate) const MAX_PAIR_GRADIENT: i32 = 24;

const MIN_PAIRS: usize = 2000;
pub(crate) const MIN_BIN_SAMPLES: f64 = 8.0;

const REFINE_FLOOR: f64 = 0.0005;
const REFINE_MARGIN: f64 = 0.002;

/// The crop axis of every search, as slack below the tightest crop that fills the
/// frame rather than an absolute scale. Crop and curve otherwise lie along a diagonal
/// valley; expressed this way a step along the curve carries its crop with it, and
/// the grid only has to land in the valley for the joint refine to walk down it.
const SLACK_SCAN: [f64; 3] = [-0.06, -0.03, 0.0];
const SLACK_STEP: f64 = 0.01;

/// The radial coefficient, where the curve has to be fitted from nothing.
const K1_SCAN: [f64; 7] = [-0.06, -0.04, -0.02, 0.0, 0.02, 0.04, 0.06];
const K1_STEP: f64 = 0.01;

/// How strongly a known curve is applied, as a multiplier on its knots.
///
/// Fitted rather than trusted at 1.0, because a profile is one average of every copy
/// of a lens and measurably not what this body did: over 32 EOS R8 frames the ones
/// lensfun calls barrel wanted more than it states while the pincushion ones wanted
/// about 0.4 of it, worth a mean 0.08 deltaE76 and up to 0.46. 0 is in the grid on
/// purpose - it is the rescale-with-no-curve candidate, which several frames turn out
/// to want outright, and having it here is what lets a curve lose without the scale
/// being lost with it.
const GAIN_SCAN: [f64; 4] = [0.0, 0.5, 1.0, 1.5];
const GAIN_STEP: f64 = 0.25;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Train = 0,
    Test = 1,
}

impl Phase {
    pub(crate) fn held_out(self) -> Phase {
        match self {
            Phase::Train => Phase::Test,
            Phase::Test => Phase::Train,
        }
    }
}

/// What is known about the geometry before any searching.
pub enum Geometry {
    /// The body states it applied no correction, so its preview needs none undone.
    Uncorrected,
    /// The spline the body recorded for this shot.
    Recorded(Vec<f64>),
    /// The lensfun database's profile for the lens, where the body recorded none.
    Profiled(Vec<f64>),
    /// Nothing knows this lens, so the geometry has to be fitted.
    Unstated,
}

pub const SOURCE_CAMERA: u32 = 1;
pub const SOURCE_FITTED: u32 = 2;
pub const SOURCE_LENSFUN: u32 = 3;
/// The settle found a curve where no tier offered one.
pub const SOURCE_MEASURED: u32 = 4;

/// What the lens did to the frame, as this fit resolved it: the halves that depend on
/// where a pixel sits rather than what colour it is.
///
/// One struct because §10.8.1 lifts all of it into the HDR grade together and nothing
/// may lift a subset. Passed as three loose arguments first, and `fit_all` promptly
/// forgot the falloff on one of the two routes with every test still green.
#[derive(Clone)]
pub struct Lens {
    /// Radial knots in `SPLINE_UNIT`s, or None where no correction is needed.
    pub distortion: Option<Vec<f64>>,
    /// Overall rescale accompanying the distortion.
    pub crop: f64,
    /// The falloff's two coefficients, in the currency `Gain::at` reads.
    pub falloff: Option<(f64, f64)>,
    /// Red and blue's radial correction against green, where the lens imaged them at
    /// different magnifications (`tca.rs`). Knots rather than a scalar because a
    /// database curve is radius-dependent and a measured scale is the flat case of one.
    pub tca: Option<[Vec<f64>; 2]>,
}

impl Lens {
    /// A lens that did nothing, for a caller with no fit to hand.
    pub fn none() -> Self {
        Lens { distortion: None, crop: 1.0, falloff: None, tca: None }
    }

    /// The radius each channel is read at, relative to green's.
    ///
    /// The warp folds these into its own ratio, so the lateral aberration is undone by
    /// the resample that undoes the distortion rather than by a pass of its own.
    pub fn channels(&self) -> crate::image::Channels {
        match &self.tca {
            Some([red, blue]) => [red.clone(), Vec::new(), blue.clone()],
            None => crate::image::registered(),
        }
    }

    /// Whether applying this would change any pixel.
    ///
    /// The crop counts. It is a geometry on its own - a rescale - so a lens with no
    /// curve beside it is not an identity, and reading only `distortion` drops the
    /// scale a fit measured for a frame whose curve it declined.
    pub fn is_identity(&self) -> bool {
        !crate::image::moves_pixels(self.distortion.as_deref(), self.crop)
            && self.falloff.is_none()
            && !self.corrects_channels()
    }

    /// Whether any channel is read at its own radius.
    pub fn corrects_channels(&self) -> bool {
        !crate::image::is_registered(&self.channels())
    }
}

pub struct Profile {
    pub knots: Option<Vec<f64>>,
    /// The falloff the camera corrected and the render did not, or None where the
    /// frame is better off without one.
    pub gain: Option<Gain>,
    /// Red and blue's radial correction against green, or None where the lens
    /// registered them well enough that correcting would only resample for nothing.
    pub tca: Option<[Vec<f64>; 2]>,
    pub crop: f64,
    /// 0 none, or one of the `SOURCE_` codes. Reported so a rendition can be
    /// re-cut when the cascade changes under it, and so the fit can be judged by
    /// where its geometry came from.
    pub source: u32,
}

impl Profile {
    /// Everything §10.8.1 lifts, in one piece so it cannot lift half.
    pub fn lens(&self) -> Lens {
        Lens {
            distortion: self.knots.clone(),
            crop: self.crop,
            falloff: self.gain.as_ref().map(Gain::coefficients),
            tca: self.tca.clone(),
        }
    }
}

/// The render and the camera's JPEG on one common grid.
///
/// Both stay where `fit_grids.slang` reduced them, in the 0..1 f32 `fit_warp.slang` reads: every
/// candidate the search scores is the render through a different lens, and the objective that
/// scores it is `slang/fit_objective.slang`. Neither side comes back.
struct Grid {
    source: crate::gpu::Buffer,
    source_size: (usize, usize),
    jpeg: Sampled,
    /// The objective's buffers for a single candidate, kept because the refine asks about fifty of
    /// them one at a time and allocating the set per step costs more than the dispatches do.
    alone: std::cell::OnceCell<crate::fit_objective::Paired>,
}

impl Grid {
    /// The render through each candidate, at the JPEG's size, in one submit.
    fn warped(&self, gpu: &'static crate::gpu::Gpu, lenses: &[Lens]) -> Vec<crate::gpu::Buffer> {
        let size = (self.jpeg.width, self.jpeg.height);
        crate::hdr_fit::warped_planes(gpu, &self.source, self.source_size, lenses, size)
    }

    fn size(&self) -> (usize, usize) {
        (self.jpeg.width, self.jpeg.height)
    }

    /// Room for one candidate's pairs, made once and asked about many times.
    fn alone(&self, gpu: &'static crate::gpu::Gpu) -> &crate::fit_objective::Paired {
        self.alone.get_or_init(|| {
            crate::fit_objective::paired(gpu, 1, &self.jpeg.buffer, self.size())
        })
    }
}

fn candidate(knots: &[f64], crop: f64) -> Lens {
    Lens { distortion: Some(knots.to_vec()), crop, falloff: None, tca: None }
}

/// Both resolutions the geometry search works at - cheap for scanning, full for refining -
/// and the prefiltered pair of planes the falloff is fitted from.
struct Grids {
    full: Grid,
    search: Grid,
    /// Prefiltered, and only the falloff may read it: the geometry is measured on detail
    /// this filter is there to destroy.
    falloff: Grid,
}

// ------------------------------------------------------------------ the grids, on the device

/// `fit_grids.slang`'s two resamplers, built once for the process.
struct Resamplers {
    layout: wgpu::BindGroupLayout,
    lanczos: wgpu::ComputePipeline,
    blur: wgpu::ComputePipeline,
    box_blur: wgpu::ComputePipeline,
}

fn resamplers(gpu: &'static crate::gpu::Gpu) -> &'static Resamplers {
    static BUILT: std::sync::OnceLock<Resamplers> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fit_grids"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/fit_grids.wgsl")).into(),
            ),
        });
        let entry = |binding: u32, ty: wgpu::BufferBindingType| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let read = wgpu::BufferBindingType::Storage { read_only: true };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("fit_grids"),
            entries: &[
                entry(0, read),
                entry(2, wgpu::BufferBindingType::Storage { read_only: false }),
                entry(4, read),
                entry(20, wgpu::BufferBindingType::Uniform),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fit_grids"),
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
        Resamplers {
            lanczos: build("fit_lanczos"),
            blur: build("fit_stack_blur"),
            box_blur: build("fit_box_blur"),
            layout,
        }
    })
}

/// A plane a pass reads or wrote: interleaved f32 RGB in 0..1, or the bytes an 8-bit plane was
/// uploaded as.
pub(crate) struct Sampled {
    pub(crate) buffer: crate::gpu::Buffer,
    pub(crate) width: usize,
    pub(crate) height: usize,
    /// 8-bit, four samples to a word, which the shader reads through 1/255.
    pub(crate) packed: bool,
}

impl Sampled {
    fn into_grid(self, jpeg: Sampled) -> Grid {
        Grid {
            source: self.buffer,
            source_size: (self.width, self.height),
            jpeg,
            alone: std::cell::OnceCell::new(),
        }
    }
}

/// One `fit_grids.slang` pass, in a compute pass of its own so the axis after it reads what this
/// one wrote.
pub(crate) fn pass(
    gpu: &'static crate::gpu::Gpu,
    recording: &mut crate::gpu::Recording<'_>,
    pipeline: &wgpu::ComputePipeline,
    source: &Sampled,
    (width, height): (usize, usize),
    axis: usize,
    radius: usize,
) -> Sampled {
    let out = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit grid plane"),
        size: (width * height * 3 * 4) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    // One layout serves both entry points and both of them name both source bindings, so whichever
    // this pass does not read is bound to something rather than left out.
    let idle = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("unused"),
        size: 4,
        usage: wgpu::BufferUsages::STORAGE,
        mapped_at_creation: false,
    });
    let mut block = [
        (source.width as i32).to_ne_bytes(),
        (source.height as i32).to_ne_bytes(),
        (width as i32).to_ne_bytes(),
        (height as i32).to_ne_bytes(),
        (axis as i32).to_ne_bytes(),
        i32::from(source.packed).to_ne_bytes(),
        (radius as i32).to_ne_bytes(),
    ]
    .concat();
    block.resize(48, 0);
    let push = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("fit grids push"),
        contents: &block,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let (floats, bytes) = match source.packed {
        true => (&idle, &source.buffer),
        false => (&source.buffer, &idle),
    };
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("fit grids"),
        layout: &resamplers(gpu).layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: floats.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: out.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 4, resource: bytes.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
        ],
    });
    {
        let mut compute = recording.encoder().begin_compute_pass(&Default::default());
        compute.set_pipeline(pipeline);
        compute.set_bind_group(0, &group, &[]);
        compute.dispatch_workgroups((width as u32).div_ceil(16), (height as u32).div_ceil(16), 1);
    }
    Sampled { buffer: out, width, height, packed: false }
}

/// `source` reduced onto `(width, height)`, an axis a pass.
///
/// Vertical first, which is the order `fast_image_resize` takes an 8-bit plane in: the two axes
/// would otherwise commute, but each pass writes through a clamp and a Lanczos window overshoots.
fn reduced(
    gpu: &'static crate::gpu::Gpu,
    recording: &mut crate::gpu::Recording<'_>,
    source: &Sampled,
    (width, height): (usize, usize),
) -> Sampled {
    let lanczos = &resamplers(gpu).lanczos;
    let down = pass(gpu, recording, lanczos, source, (source.width, height), 1, 0);
    pass(gpu, recording, lanczos, &down, (width, height), 0, 0)
}

/// The stack blur, the prefilter on both planes of the falloff's grid.
///
/// Not a Gaussian, and it does not need to be: both planes of a grid are filtered the same way, so
/// the prefilter only has to suppress noise and detail the residual should not be measuring. The
/// radii below are what a Gaussian of the same sigma answers to, so the fit's recorded numbers
/// still describe the picture it is fitted on; `the_blur_is_the_triangular_window_it_claims`
/// holds the kernel itself.
fn blurred(
    gpu: &'static crate::gpu::Gpu,
    recording: &mut crate::gpu::Recording<'_>,
    source: &Sampled,
    sigma: f64,
) -> Sampled {
    // Swept against vips at both sigmas the fit uses: sigma 3 wants radius 5 and sigma 6 wants
    // 11, so a stack blur's support is twice a Gaussian's standard deviation.
    let radius = (2.0 * sigma - 1.0).round().max(1.0) as usize;
    let blur = &resamplers(gpu).blur;
    let size = (source.width, source.height);
    let across = pass(gpu, recording, blur, source, size, 0, radius);
    pass(gpu, recording, blur, &across, size, 1, radius)
}

/// How many passes of the box make the colour fit's prefilter.
///
/// Three, which is near enough a Gaussian that the radii the fit's numbers were measured against
/// still describe the picture it is fitted on.
const BOX_PASSES: usize = 3;

/// The colour fit's prefilter: three passes of a truncated box an axis, over a plane whose values
/// may run past one.
pub(crate) fn box_blurred(
    gpu: &'static crate::gpu::Gpu,
    recording: &mut crate::gpu::Recording<'_>,
    source: &Sampled,
    radius: usize,
) -> Sampled {
    let kernel = &resamplers(gpu).box_blur;
    let size = (source.width, source.height);
    let mut plane = pass(gpu, recording, kernel, source, size, 0, radius);
    for sweep in 1..2 * BOX_PASSES {
        plane = pass(gpu, recording, kernel, &plane, size, sweep % 2, radius);
    }
    plane
}

/// An 8-bit plane on the device as its own bytes, and a grid back off it.
///
/// Only the tests that look at a resampled grid want either: the fit uploads its preview once,
/// through `hdr_fit::preview_planes`, and reads no grid back at all.
#[cfg(test)]
fn uploaded(
    recording: &mut crate::gpu::Recording<'_>,
    label: &str,
    plane: RgbRef<'_>,
) -> Sampled {
    Sampled {
        buffer: recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some(label),
            contents: plane.data,
            usage: wgpu::BufferUsages::STORAGE,
        }),
        width: plane.width,
        height: plane.height,
        packed: true,
    }
}

#[cfg(test)]
fn staged(recording: &mut crate::gpu::Recording<'_>, plane: &Sampled) -> crate::gpu::Buffer {
    let bytes = (plane.width * plane.height * 3 * 4) as u64;
    let staging = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("fit grid out"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    recording.encoder().copy_buffer_to_buffer(&plane.buffer, 0, &staging, 0, bytes);
    staging
}

#[cfg(test)]
async fn read_rgb(
    gpu: &'static crate::gpu::Gpu,
    staging: &crate::gpu::Buffer,
    plane: &Sampled,
) -> Option<crate::rgb::Rgb> {
    use crate::parallel::*;
    let data: Vec<u8> = crate::gpu::read_back(gpu, staging, |mapped| {
        mapped
            .par_chunks_exact(4)
            .map(|word| {
                (f32::from_ne_bytes([word[0], word[1], word[2], word[3]]) * 255.0).round() as u8
            })
            .collect()
    })
    .await?;
    Some(crate::rgb::Rgb { width: plane.width, height: plane.height, data })
}

// ------------------------------------------------------------------ colour model

/// The shared tail of every curve fit: gaps interpolated, ends extended, monotone.
///
/// **`fit_obj_curve` is the one that runs**, in the same submit as the bins that feed it and the
/// score that reads it. This is the reference it took over, and what the tests below state the
/// shape against: a curve that dips posterises a gradient, and a bin backed by a handful of pixels
/// states a ratio rather than a measurement.
#[cfg(test)]
fn curve_from_bins(sum: [f64; 256], count: [f64; 256]) -> [u8; 256] {
    let mut curve = [f64::NAN; 256];
    for level in 0..256 {
        if count[level] >= MIN_BIN_SAMPLES {
            curve[level] = sum[level] / count[level];
        }
    }
    let known: Vec<usize> = (0..256).filter(|l| curve[*l].is_finite()).collect();
    if known.len() < 2 {
        let mut identity = [0u8; 256];
        for (level, slot) in identity.iter_mut().enumerate() {
            *slot = level as u8;
        }
        return identity;
    }

    let first = known[0];
    let last = known[known.len() - 1];
    let prev = known[known.len() - 2];
    let tail_slope = (curve[last] - curve[prev]) / (last - prev) as f64;
    let mut cursor = 0usize;
    for level in 0..256 {
        if curve[level].is_finite() {
            continue;
        }
        if level < first {
            curve[level] = curve[first] * level as f64 / first.max(1) as f64;
            continue;
        }
        if level > last {
            curve[level] = curve[last] + tail_slope * (level - last) as f64;
            continue;
        }
        while cursor < known.len() - 1 && known[cursor + 1] < level {
            cursor += 1;
        }
        let (lo, hi) = (known[cursor], known[cursor + 1]);
        curve[level] = curve[lo] + (curve[hi] - curve[lo]) * (level - lo) as f64 / (hi - lo) as f64;
    }

    let mut out = [0u8; 256];
    let mut ceiling = 0.0f64;
    for level in 0..256 {
        ceiling = ceiling.max(curve[level]);
        out[level] = ceiling.min(255.0).round() as u8;
    }
    out
}

/// A radial brightness gain, as a level-in/level-out table per quantised radius.
///
/// The camera corrects its lens's falloff and the render does not, and that is a
/// gain that varies over the frame - which per-channel curves and a 3x3 cannot
/// express at all, since both are position-independent. Modelled as `1 + a r^2 +
/// b r^4` in linear light, the shape falloff actually has, so two coefficients
/// carry it and a thin radius bin cannot bend it on its own.
///
/// **Achromatic**: one scalar for all three channels, fitted from luma. Falloff does
/// carry a slight cast on real glass, which this cannot express and does not try to -
/// what the 3x3 absorbs globally it absorbs, and the rest stays in the residual.
pub struct Gain {
    lut: Vec<u8>,
    coefficients: (f64, f64),
}

impl Gain {
    /// The 256x256 level table as the objective's kernel reads it, four levels to a word.
    pub(crate) fn table(&self) -> &[u8] {
        &self.lut
    }

    /// Bounded because these are two free parameters fitted to one frame, and a
    /// degenerate solve should distort the corners rather than black them out or
    /// blow them away: no lens falls off by four stops, and none gains.
    const LIMIT: (f64, f64) = (0.25, 4.0);

    /// Tabulated rather than left to be evaluated, because the geometry search reads it
    /// per pair and evaluating it is a `powf` for the transfer.
    pub(crate) fn from_poly(a: f64, b: f64) -> Self {
        let linear = linear_table();
        let mut lut = vec![0u8; 256 * 256];
        for radius in 0..256 {
            for level in 0..256 {
                lut[radius * 256 + level] = to_srgb8(linear[level] * Gain::at(a, b, radius as u8));
            }
        }
        Gain { lut, coefficients: (a, b) }
    }

    /// The multiplier itself, in linear light, at a quantised radius.
    ///
    /// Kept separate from the table so a caller working in linear light already can
    /// evaluate it rather than round-trip through 8 bits (`hdr_fit`).
    #[inline]
    pub(crate) fn at(a: f64, b: f64, radius: u8) -> f64 {
        let r2 = (f64::from(radius) / 255.0).powi(2);
        (1.0 + a * r2 + b * r2 * r2).clamp(Self::LIMIT.0, Self::LIMIT.1)
    }

    /// The two coefficients, for the HDR fit to reuse.
    ///
    /// A falloff correction is a multiplication in linear light, so unlike the curves
    /// - whose domain stops at display white - it means the same thing in any linear
    /// domain and lifts to the grade exactly as the geometry does (10.8.1).
    pub(crate) fn coefficients(&self) -> (f64, f64) {
        self.coefficients
    }

    /// The level `level` becomes at this radius, which is what `table` hands the objective and
    /// what `fit_objective.slang` indexes for itself.
    #[cfg(all(test, feature = "fixtures"))]
    fn of(&self, radius: u8, level: u8) -> u8 {
        self.lut[radius as usize * 256 + level as usize]
    }

    /// What this gain does to a corner pixel of mid grey, as a ratio - the one number
    /// that says how much falloff was corrected, and the one the tests assert on
    /// because `(a, b)` trade off against each other and it does not.
    #[cfg(all(test, feature = "fixtures"))]
    pub(crate) fn corner(&self) -> f64 {
        let linear = linear_table();
        linear[self.of(255, 128) as usize] / linear[128]
    }

}

fn to_srgb8(linear: f64) -> u8 {
    (crate::hdr_fit::srgb_oetf(linear.clamp(0.0, 1.0)) * 255.0).round() as u8
}

/// The gain the pairs ask for, given a luma curve fitted under the current one.
///
/// Run backwards rather than searched, which is one pass where a search over candidate
/// gains would be one pass each (10.8).
///
/// The answer is absolute, not an increment on the gain already in hand - the
/// inverted target lands in gained-source levels and the pair's own source is
/// ungained, so their ratio is the whole of what the gain has to supply. An
/// increment would have to compose, and two of these do not compose into one.
///
/// Against luma rather than a colour transform, for the reason the geometry search
/// scores luma: `Gain` is one achromatic scalar per radius and cannot express a cast, so
/// all the transform was ever doing here was undoing the tone difference between the two
/// images, which one curve does. Measured against the camera's own falloff on the two
/// frames the arms disagreed most about, the two land within a few percent of each other
/// and both far inside no correction at all.
async fn refit_gain(
    paired: &crate::fit_objective::Paired,
    admitted: usize,
    phase: Phase,
    curve: &[u8; 256],
) -> Option<(f64, f64)> {
    let back = invert_curve(curve);
    let linear = linear_table();
    // Binned where the records are: what crosses is the two tables going up and thirty-six numbers
    // coming back, rather than the whole admitted pair list coming down.
    let binned = paired.falloff(admitted, phase, &back, &linear).await?;

    const BINS: usize = crate::fit_objective::FALLOFF_BINS;
    /// A bin backed by a handful of pixels states a ratio, not a measurement, and the
    /// bins most likely to be that thin are the outer ones - `pairs` drops near-black
    /// samples, and the corners of a frame that needs this correction are exactly
    /// where the render is darkest. Left unguarded, one such bin sets the end of the
    /// curve and the held-out gate cannot object, its own half being thin in the same
    /// place. The same floor `fit_curve` puts on a tone bin, for the same reason.
    const MIN_BIN_PAIRS: u32 = 64;

    let wanted: Vec<f64> = binned.iter().map(|bin| bin[0]).collect();
    let had: Vec<f64> = binned.iter().map(|bin| bin[1]).collect();
    let counted: Vec<u32> = binned.iter().map(|bin| bin[2] as u32).collect();

    // Least squares of `g - 1 = a r^2 + b r^4` over the bins that got samples,
    // weighted by how many linear units each carries so a dark bin cannot swing it.
    let (mut a11, mut a12, mut a22, mut b1, mut b2) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut bins = 0usize;
    for bin in 0..BINS {
        if counted[bin] < MIN_BIN_PAIRS || had[bin] <= 0.0 {
            continue;
        }
        let r2 = ((bin as f64 + 0.5) / BINS as f64).powi(2);
        let (x1, x2) = (r2, r2 * r2);
        let y = wanted[bin] / had[bin] - 1.0;
        let w = had[bin];
        a11 += w * x1 * x1;
        a12 += w * x1 * x2;
        a22 += w * x2 * x2;
        b1 += w * x1 * y;
        b2 += w * x2 * y;
        bins += 1;
    }
    if bins < 4 {
        return None;
    }
    let det = a11 * a22 - a12 * a12;
    if det.abs() < 1e-12 {
        return None;
    }
    let (a, b) = ((b1 * a22 - b2 * a12) / det, (b2 * a11 - b1 * a12) / det);
    keeps_its_direction(a, b).then_some((a, b))
}

/// How far a fitted gain may double back on itself before it is a scene rather than a lens.
///
/// The same shape of gate as `GAIN_MARGIN` and sized the same way, on the gap: the real
/// recoveries reverse by about 0.01 of unit gain - the injected-corner fixture's first round
/// solves to `a 0.107, b -0.320`, which rises 0.9% before falling 21% - where the frame this gate
/// was written for reverses by 0.85. Two orders apart, and nothing measured lands between.
const GAIN_REVERSAL: f64 = 0.05;

/// Whether `1 + a r^2 + b r^4` climbs or falls the whole way out, rather than turning over in the
/// middle of the frame and coming back.
///
/// **The least squares above has two free parameters and nothing in it knows what a lens is.**
/// Handed a frame whose brightness varies with radius for its own reasons - a lit subject in the
/// middle of a dark room - it fits the *scene*, and the shape it finds is one no lens has. One
/// such frame solved to `a -4.68, b +6.43`: a 4x darkening of the mid-radii, hard against
/// `Gain::LIMIT`'s floor, with the extreme corners then 1.9x brighter than the centre. Neither
/// `GAIN_MARGIN` nor the held-out score can object, because that gain genuinely does predict that
/// frame's luma better; only the shape gives it away.
///
/// What it costs is not confined to the falloff. `hdr_fit` multiplies this into the render before
/// pairing it against the camera's rendering, so a radial gain spanning 7.6x stops the pairs being
/// a function of level at all - one render level arrives carrying whatever the camera printed
/// anywhere on its ring. The tone curve's binned means come out non-monotone, `pool_violators`
/// flattens a third of the curve into plateaus, and skin under a coloured light renders as bands
/// of flat red. Rejected here, that frame's match goes from deltaE 5.09 to 1.38.
///
/// Tolerant rather than strict, because the alternation's first round recovers only part of a
/// falloff and lands a little curvature noise at the origin with it: demanding an exact turning
/// point outside the frame rejects every genuine recovery too.
fn keeps_its_direction(a: f64, b: f64) -> bool {
    // In `u = r^2` the gain is `1 + a u + b u^2`, so a turning point inside the frame is the one
    // root of its slope, and what doubles back is the shorter of the two legs either side.
    let turn = -a / (2.0 * b);
    if !(0.0..=1.0).contains(&turn) {
        return true;
    }
    let peak = 1.0 + a * turn + b * turn * turn;
    (peak - 1.0).abs().min((peak - (1.0 + a + b)).abs()) <= GAIN_REVERSAL
}

/// `curve` maps a source level to a target level; this maps back. Monotone by
/// construction, so one forward walk fills it.
fn invert_curve(curve: &[u8; 256]) -> [u8; 256] {
    let mut back = [0u8; 256];
    let mut source = 0usize;
    for target in 0..256 {
        while source < 255 && (curve[source] as usize) < target {
            source += 1;
        }
        back[target] = source as u8;
    }
    back
}


/// How much the first falloff has to buy before it is believed at all.
///
/// Two free parameters fitted to one frame will always find something, and a plain
/// improvement gate is not enough to stop them: over the 35-frame set the falloffs that
/// are really there buy at least 6.3% of the held-out luma score on their first round,
/// where the three frames that invented one bought 0.2%, 0.4% and 2.5%. Nothing lands
/// between, so this sits in the gap.
const GAIN_MARGIN: f64 = 0.04;

/// The gain and a luma curve together, alternating: neither can be fitted without the
/// other, since a falloff looks like a tone difference to a curve and a tone difference
/// looks like falloff to a gain.
///
/// The gain is None where the frame is better off without one, which is the point of
/// the gate: a body that corrected no falloff would otherwise have two free
/// parameters fitted to its noise. Judged on the pairs the round was not fitted on,
/// for exactly that reason - extra free parameters can only ever look better on their
/// own.
///
/// The margin applies only to the first round, which is the one deciding whether this
/// frame has a falloff at all. The rounds after it are refining a falloff already
/// believed in, and asking each of them for another 4% would stop the refinement that
/// exists because the first round's curve still had some of the falloff in it.
async fn fit_gain(
    paired: &crate::fit_objective::Paired,
    warped: &[crate::gpu::Buffer],
    phase: Phase,
    admitted: usize,
) -> Option<Gain> {
    let score_of =
        async |gain: Option<&Gain>| Some(paired.scored(warped, phase, gain).await?.first()?.delta);
    let mut best = score_of(None).await?;
    // The curve the score just drew, which is the one thing `refit_gain` needs that the device
    // does not keep: 256 levels, against the pair list it never reads.
    let mut curve = paired.curve(0).await?;
    let mut gain: Option<Gain> = None;
    // Three, because the first round's curve was fitted with the falloff still in it
    // and so partly absorbs it - measured on an injected 0.65 corner, one round
    // recovers 0.78 and the next two land it.
    for _ in 0..3 {
        let Some((a, b)) = refit_gain(paired, admitted, phase, &curve).await else { break };
        let candidate = Gain::from_poly(a, b);
        let delta = score_of(Some(&candidate)).await?;
        let bar = match gain {
            None => best * (1.0 - GAIN_MARGIN),
            Some(_) => best,
        };
        if !(delta < bar) {
            break;
        }
        best = delta;
        curve = paired.curve(0).await?;
        gain = Some(candidate);
    }
    gain
}

// ------------------------------------------------------------------------ deltaE
//
// **This measure cannot see the errors that ruin a picture, and every comparative
// claim in this crate settled by it is therefore unsafe.** Three separate blind
// spots, all measured:
//
// - It is ΔE76, Euclidean in Lab, so a unit of error counts the same on a grey wall
//   as on a saturated glaze. Perceptually it is worth several times more on the
//   wall. Every failure this crate has been burned by is near-neutral - speckle on
//   fur, a blotchy wall, a mint-green bird bath, a magenta sky - so the metric
//   discounts exactly the damage and inflates exactly what does not matter. ΔE2000
//   against the same fits moves the score by 0.78x to 1.10x depending on the frame,
//   so it is not even a rescale: it reorders how bad two frames are relative to
//   each other.
// - It is a *magnitude*, so it cannot tell a hundred pixels each 1.5 off in the
//   same direction from a hundred each 1.5 off in random ones. The first is a cast
//   you see across a wall; the second is invisible. Measured on IMG_8789, the light
//   low-chroma content - a bird bath, a stone wall - sits at da* -2.0 against a
//   control frame's +0.2, and the aggregate signed cast still reads 0.35 because it
//   flips sign with level and cancels.
// - It is a *mean*. IMG_8789 reads 1.99 mean ΔE2000 and p99 7.2, max 16.2.
//
// So a number here going down is not evidence a render got better. It was reported
// as such throughout this crate's history, including for the choice of model: what
// is written up as "777 coefficients beat a 17^3 LUT and tie a 33^3" and as the
// chroma map's win over the shape constraint were both decided on this. **Treat
// those as unrun, not as settled.**
//
// What survives, being metric-independent: anything measured against an injected
// ground truth (the falloff alternation), anything read off a parameter directly
// (the magenta sky's end slopes), anything signed on neutrals (grey_balance's +2.3%
// green), a named object's hue angle (the blue pot), and every timing.
//
// Rebuilding this properly means ΔE2000, reported as a distribution, beside a
// *signed* per-hue statistic that can see a cast - and judged on the wide planes,
// not here, because a small object is nine pairs at this grid.

fn to_linear(value: f64) -> f64 {
    let s = value / 255.0;
    if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
}

/// The scoring loop only ever linearises 8-bit levels, and the transfer's pow() is
/// the most expensive arithmetic in the fit.
pub(crate) fn linear_table() -> [f64; 256] {
    let mut table = [0.0f64; 256];
    for (level, slot) in table.iter_mut().enumerate() {
        *slot = to_linear(level as f64);
    }
    table
}

// ------------------------------------------------------------------------ fitting

/// How well the pair corresponds under a candidate geometry, measured as the luma
/// residual one tone curve can still not explain.
///
/// Using a residual as the geometry objective is what makes this robust: a wrong warp
/// cannot be rescued by any tone curve, so a good score means genuine correspondence.
/// Feature matching was tried first, in four variants, and every one produced a
/// confident wrong answer on repetitive texture; this cannot, and it needs no band
/// selection, subpixel interpolation or outlier rejection.
///
/// Luma rather than deltaE, which is one curve instead of three plus a 3x3 and drops
/// six cbrt per pair. Every question this stage asks is about correspondence - which
/// warp aligns the two frames, and whether any of them beats leaving the frame alone -
/// and none of them needs to know what colour the pixels are. Measured over 204 frames
/// the two rank candidates equally well: recovering an injected distortion, luma is out
/// by a mean 0.0119 and deltaE by 0.0134, on an identical median. Luma is ~45% faster.
///
/// That comparison is against an *injected* distortion whose answer is known, so it does
/// not rest on deltaE being a good measure of a picture - which it is not, per the
/// `deltaE` section. Both scorers are being asked to find the same known warp.
/// Each candidate's held-out residual: the curve fitted on one half of its pairs, scored on the
/// other. `INFINITY` where a candidate kept too few pairs to be believed at all.
async fn residuals(
    paired: &crate::fit_objective::Paired,
    warped: &[crate::gpu::Buffer],
) -> Option<Vec<f64>> {
    Some(
        paired
            .scored(warped, Phase::Train, None)
            .await?
            .into_iter()
            .map(|scored| match scored.pairs >= MIN_PAIRS {
                true => scored.delta,
                false => f64::INFINITY,
            })
            .collect(),
    )
}

async fn residual_for(
    gpu: &'static crate::gpu::Gpu,
    grid: &Grid,
    knots: &[f64],
    crop: f64,
) -> Option<f64> {
    let warped = grid.warped(gpu, &[candidate(knots, crop)]);
    let delta = residuals(grid.alone(gpu), &warped).await?.first().copied()?;
    delta.is_finite().then_some(delta)
}

/// BT.709 luma of a display-referred triple, in the same 8-bit levels a pair holds, which is what
/// `fit_objective.slang`'s `luma8` is over there.
///
/// Taken on the encoded values rather than in linear light, which is what Y' means and what makes
/// it free: the tone curve fitted over it absorbs any transfer difference between the two images.
#[cfg(test)]
fn luma8(r: u8, g: u8, b: u8) -> u8 {
    crate::image::luma709(f64::from(r), f64::from(g), f64::from(b)).round() as u8
}

// **Folded on the device, and exactly.** Both of the objective's accumulations add `u8`-valued
// terms - a camera luma into a bin's sum, a one into its count, a residual into a total - so every
// partial is an integer and the total is the same whatever order the lanes landed in. That is what
// lets `fit_objective.slang` use plain atomics where `fit_score` needs ordered partials. The
// falloff's bins are the exception and are folded the other way: they sum real light out of the
// sRGB transfer, so `fit_obj_falloff` sums them per block and the host adds the blocks in order.

// Nothing is filtered inside the gate. Both planes were blurred once when the grid was built, so a
// candidate is a warp and a pair pass over one buffer; blurring per candidate cost more than every
// other part of the search put together.
//
// Blurring before the warp rather than after is the same picture for this purpose: the filter
// exists to remove detail neither image can be trusted on, and a Gaussian commutes with a
// near-identity resample closely enough that the fitted deltaE does not move.

/// Warps every candidate in one submit, then scores every one of them in another. They share only
/// their inputs, which is what lets the whole scan be two dispatches rather than a round trip each;
/// the refine that follows is sequential by nature, each step depending on the last.
///
/// Ties break on position, not on whichever branch of a reduction happened to hold them. A frame
/// with no distortion to find scores several candidates identically - `min_by` alone then returned
/// whichever the work-stealing tree paired last, so the same build fitted IMG_5360 two different
/// ways depending on how many cores were free.
async fn scan<T: Send + Sync + Copy>(
    gpu: &'static crate::gpu::Gpu,
    grid: &Grid,
    candidates: &[T],
    knots_of: impl Fn(T) -> Vec<f64>,
    crop_of: impl Fn(T) -> f64,
) -> Option<(T, f64)> {
    let lenses: Vec<Lens> =
        candidates.iter().map(|c| candidate(&knots_of(*c), crop_of(*c))).collect();
    let warped = grid.warped(gpu, &lenses);
    let paired = crate::fit_objective::paired(gpu, lenses.len(), &grid.jpeg.buffer, grid.size());
    let scored = residuals(&paired, &warped).await?;
    candidates
        .iter()
        .zip(&scored)
        .enumerate()
        .filter(|(_, (_, delta))| delta.is_finite())
        .map(|(i, (c, delta))| (*delta, i, *c))
        .min_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
        .map(|(delta, _, candidate)| (candidate, delta))
}

/// A one-parameter family of curves and the crop that goes with it, searched jointly:
/// a coarse grid on the search grid, then a refine at full size.
///
/// The scan only has to land in the right valley, which a quarter of the pixels
/// answers just as well. The refine compares neighbours a fraction of a percent
/// apart, and at half resolution those differences fall below the improvement
/// threshold, so it halts early and leaves the geometry short - an injected 3%
/// distortion came back as 1.3% when the refine also ran coarse.
///
/// Returns the winning knots, its crop and the residual it left.
async fn fit_family(
    gpu: &'static crate::gpu::Gpu,
    grids: &Grids,
    family: impl Fn(f64) -> Vec<f64>,
    coarse: &[f64],
    mut step: f64,
) -> Option<(Vec<f64>, f64, f64)> {
    let (width, height) = (grids.full.jpeg.width, grids.full.jpeg.height);
    let fill = |parameter: f64| crate::image::fill_crop(&family(parameter), width, height);
    let candidates: Vec<(f64, f64)> = coarse
        .iter()
        .flat_map(|parameter| SLACK_SCAN.iter().map(move |slack| (*parameter, *slack)))
        .collect();
    let ((mut parameter, mut slack), _) = scan(
        gpu,
        &grids.search,
        &candidates,
        |(parameter, _)| family(parameter),
        |(parameter, slack)| fill(parameter) + slack,
    )
    .await?;
    let mut delta =
        residual_for(gpu, &grids.full, &family(parameter), fill(parameter) + slack).await?;

    let mut step_slack = SLACK_STEP;
    while step_slack > REFINE_FLOOR {
        let mut improved = false;
        for axis in 0..2 {
            // A zero step is a family of one - a bare scale - whose curve axis would
            // otherwise be re-scored at the same point on every round of the refine.
            if axis == 0 && step <= 0.0 {
                continue;
            }
            for sign in [1.0, -1.0] {
                let trial_parameter = if axis == 0 { parameter + sign * step } else { parameter };
                // Slack above zero is a crop that does not fill, which no camera ships.
                let trial_slack = if axis == 1 { slack + sign * step_slack } else { slack };
                if trial_slack > 0.0 {
                    continue;
                }
                let trial_knots = family(trial_parameter);
                let trial_crop = fill(trial_parameter) + trial_slack;
                if let Some(candidate) =
                    residual_for(gpu, &grids.full, &trial_knots, trial_crop).await
                {
                    if candidate < delta - REFINE_MARGIN {
                        parameter = trial_parameter;
                        slack = trial_slack;
                        delta = candidate;
                        improved = true;
                    }
                }
            }
        }
        if !improved {
            step /= 2.0;
            step_slack /= 2.0;
        }
    }
    Some((family(parameter), fill(parameter) + slack, delta))
}

/// Eight bins over sixteen knots, so a pair of knots move together and the curve cannot
/// grow a kink between two noisy bins.
const SETTLE_BINS: usize = 8;

/// A budget rather than a stride, so a portrait frame and a landscape one are measured to
/// the same precision.
const SETTLE_POINTS: usize = 6000;

const SETTLE_KNOTS: usize = 16;
const SETTLE_ROUNDS: usize = 5;

/// Wide-plane pixels. Below this a bin's mean is as likely the search's own precision as a
/// geometry left to correct.
const SETTLE_FLOOR: f64 = 0.1;

/// Damped because a full step rings.
const SETTLE_FEEDBACK: f64 = 0.6;

/// What a knot's change costs against the curvature it adds, in the solve's own weighted units.
/// Swept over the 32 Canon frames: a tenth flattens the inner magnification a lens really has,
/// and a thousandth leaves the curve as far apart between two adapters as no penalty at all.
const SETTLE_SMOOTHING: f64 = 1e-2;

/// Enough to keep the solve from being singular where a radius answered with nothing, and far
/// enough below the data's own weights to decide nothing that was measured.
const SETTLE_RIDGE: f64 = 1e-6;

/// The knots the camera's own picture asks for, starting from whatever curve a family
/// search settled on: the family picks the neighbourhood, the measurement picks the curve.
async fn settled_on_registration(
    gpu: &'static crate::gpu::Gpu,
    render: &crate::hdr_fit::Source,
    preview: &crate::hdr_fit::Source,
    knots: &[f64],
    crop: f64,
) -> Option<(Vec<f64>, f64)> {
    let lens_of = |knots: &[f64]| Lens {
        distortion: Some(knots.to_vec()),
        crop,
        falloff: None,
        tca: None,
    };
    let stride = (((render.width * render.height) as f64 / SETTLE_POINTS as f64).sqrt() as usize).max(1);
    // **Everything the rounds share, uploaded once.** Only the lens moves between them; the plane
    // it warps, the plane it is matched against, and the grid it is asked about do not.
    let settling = crate::hdr_fit::Settling::new(gpu, render, preview, stride);
    let measure = async |knots: &[f64]| {
        crate::hdr_fit::registration(gpu, &settling, &lens_of(knots), SETTLE_BINS).await
    };

    let half = ((preview.width as f64 / 2.0).powi(2) + (preview.height as f64 / 2.0).powi(2)).sqrt();
    let resolved = |measured: &crate::hdr_fit::Registration| {
        measured.radial.iter().flatten().all(|shift| shift.abs() * half < SETTLE_FLOOR)
    };

    let mut current = on_knot_grid(knots);
    let mut best = measure(&current).await?;
    let mut feedback = SETTLE_FEEDBACK;
    for _ in 0..SETTLE_ROUNDS {
        if resolved(&best) {
            break;
        }
        let trial = nudged(&current, &best, feedback);
        let Some(measured) = measure(&trial).await else { break };
        if measured.misfit >= best.misfit {
            feedback /= 2.0;
            continue;
        }
        (current, best) = (trial, measured);
    }
    // A crop the settled curve no longer fills is black in the corners.
    let crop = crop.min(crate::image::fill_crop(&current, preview.width, preview.height));
    Some((current, crop))
}

fn on_knot_grid(knots: &[f64]) -> Vec<f64> {
    (0..SETTLE_KNOTS)
        .map(|i| {
            let radius = i as f64 / (SETTLE_KNOTS - 1) as f64;
            crate::image::spline_at(knots, radius) * crate::image::SPLINE_UNIT
        })
        .collect()
}

/// The knots moved by the least-squares change that cancels every bin's displacement, weighted by
/// how many matches each bin's mean is over and held smooth by a curvature penalty.
///
/// The centre knot is solved for like the rest even though no pixel is read at radius zero, so
/// the curvature term alone places it: held at what it was, a lens whose correction is already
/// several hundred at the first knot reads as a kink, and the penalty flattens the magnification
/// it actually has.
fn nudged(knots: &[f64], measured: &crate::hdr_fit::Registration, feedback: f64) -> Vec<f64> {
    let n = knots.len();
    let total: f64 = measured
        .radial
        .iter()
        .zip(&measured.counts)
        .filter_map(|(shift, count)| shift.map(|_| *count))
        .sum();
    let mut normal = vec![0.0; n * n];
    let mut rhs = vec![0.0; n];
    let bins = measured.radial.iter().zip(&measured.counts).zip(&measured.radii);
    for ((shift, count), radius) in bins {
        let Some(shift) = shift else { continue };
        let weight = count / total;
        let position = (radius * (n - 1) as f64).clamp(0.0, (n - 1) as f64);
        let below = (position.floor() as usize).min(n - 2);
        let above = position - below as f64;
        // `sample_radius` reads a pixel at `crop * r * (1 + spline)`, so raising the spline by
        // `d` at `r` moves what lands there inward by `r * d` - a displacement that fades to
        // nothing at the centre, which is why a knot there cannot be read off the shift alone.
        let row = [(below, radius * (1.0 - above)), (below + 1, radius * above)];
        for &(i, a) in &row {
            rhs[i] -= weight * a * shift;
            for &(j, b) in &row {
                normal[i * n + j] += weight * a * b;
            }
        }
    }
    for middle in 1..n - 1 {
        let taps = [(middle - 1, 1.0), (middle, -2.0), (middle + 1, 1.0)];
        for &(i, a) in &taps {
            for &(j, b) in &taps {
                normal[i * n + j] += SETTLE_SMOOTHING * a * b;
            }
        }
    }
    for i in 0..n {
        normal[i * n + i] += SETTLE_RIDGE;
    }
    let Some(change) = gaussian(&normal, &rhs, n) else {
        return knots.to_vec();
    };
    knots
        .iter()
        .zip(change)
        .map(|(knot, change)| knot + feedback * change * crate::image::SPLINE_UNIT)
        .collect()
}

/// The scale alone, where the body states there is no curve to undo.
///
/// It is not nothing: the ~0.4-0.5% rescale between a render and the camera's own JPEG
/// shows up on bodies with unrelated optics - ILCE-6300 frames land on crop 0.996 and
/// EOS R8 frames on 0.995 - which is what makes it look like framing rather than a lens.
async fn fit_scale(gpu: &'static crate::gpu::Gpu, grids: &Grids) -> Option<(Vec<f64>, f64, f64)> {
    fit_family(gpu, grids, |_| Vec::new(), &[0.0], 0.0).await
}

/// A curve someone else already knows, applied at a fitted strength.
///
/// The gain is what keeps a wrong profile from being all-or-nothing. Before it, a curve
/// that could not beat leaving the frame alone was dropped along with the crop that
/// came with it - so a frame whose lens lensfun overstates shipped with no geometry at
/// all, when the scale on its own was worth 0.22 deltaE76. Gain 0 is exactly that
/// candidate, so the search now contains the fallback rather than falling back to it.
async fn with_curve(
    gpu: &'static crate::gpu::Gpu,
    grids: &Grids,
    knots: Vec<f64>,
    baseline: f64,
    source: u32,
) -> (Option<Vec<f64>>, f64, u32) {
    let scaled = |gain: f64| knots.iter().map(|knot| knot * gain).collect::<Vec<f64>>();
    chosen(fit_family(gpu, grids, scaled, &GAIN_SCAN, GAIN_STEP).await, baseline, source)
}

/// What a search settled on, as the cascade reports it.
///
/// Every family contains the curve that does nothing - gain 0, k1 0, and the bare scale
/// is only that - so a winner can carry a crop and no curve at all. That is a geometry
/// and its crop has to survive, but the tier did not supply a curve for it and must not
/// be credited with one: reporting it as a fitted or database geometry is how a tier's
/// own numbers come to disagree with what it actually did.
fn chosen(found: Option<(Vec<f64>, f64, f64)>, baseline: f64, source: u32) -> (Option<Vec<f64>>, f64, u32) {
    match found {
        Some((knots, crop, delta)) if delta < baseline => match knots.iter().any(|knot| *knot != 0.0) {
            true => (Some(knots), crop, source),
            false => (None, crop, 0),
        },
        _ => (None, 1.0, 0),
    }
}

/// Fits the lens taking `render` to `preview`, against a preview the caller has already decoded.
///
/// **Off the caller's preview**, because both halves of an HDR fit want the same picture
/// from the same embedded JPEG. Decoding it here as well meant a 6000x4000 preview
/// decoded in full, resized to 640 and dropped, beside the copy the colour fit was
/// already holding.
///
/// Sharing was tried once before and rejected, on a preview DCT-shrunk almost to the fit
/// grid: that arrives barely filtered and cost the 35-frame set 1.654 to 1.774 mean
/// deltaE. What is shared now is not that. The colour fit needs twice the grid, so the
/// preview is DCT-shrunk only to 1500 and brought to 1280 by a real reduce, leaving this
/// a properly filtered resize down to its own 640 rather than a DCT approximation of one.
pub async fn fit_from_preview(
    gpu: &'static crate::gpu::Gpu,
    render: &crate::fit_source::Rendered,
    preview: &crate::hdr_fit::Source,
    geometry: Geometry,
) -> Result<Option<Profile>, String> {
    let mut lap = crate::clock::laps("  geometry ");
    let Some((grids, sampled)) = grids_from_preview(gpu, render, preview).await else {
        return Ok(None);
    };
    lap("grids");
    fit_grids(gpu, grids, geometry, &sampled, preview).await
}

/// The three grids and the render at the preview's own size, off one upload.
///
/// **Nothing here resamples on the host, and the render is never sent anywhere.** `fit_render`
/// wrote it on the device beside the plane it came from, so what this binds is that buffer; only
/// the camera's preview goes up, as its own 8-bit bytes. Every grid is reduced and prefiltered by
/// `fit_grids.slang` and each grid's render stays where the search is going to read it. What comes
/// back is the JPEG side alone, which `corresponding` and `pairs` walk pixel by pixel.
///
/// None where the device declined, which is a frame with no fit rather than a frame fitted some
/// other way.
async fn grids_from_preview(
    gpu: &'static crate::gpu::Gpu,
    render: &crate::fit_source::Rendered,
    preview: &crate::hdr_fit::Source,
) -> Option<(Grids, crate::hdr_fit::Source)> {
    // Already f32 and already on the device: `fit_render` wrote it in the submit that made the
    // plane, so this is the buffer itself rather than a copy of one.
    let render = Sampled {
        buffer: render.buffer.clone(),
        width: render.width,
        height: render.height,
        packed: false,
    };
    if render.width == 0 || render.height == 0 || preview.width == 0 || preview.height == 0 {
        return None;
    }
    let mut recording = gpu.record();
    recording.holding(&preview.buffer);
    let preview_bytes = Sampled {
        buffer: preview.buffer.clone(),
        width: preview.width,
        height: preview.height,
        packed: false,
    };
    let jpeg_full = reduced(gpu, &mut recording, &preview_bytes, fit_size(preview.width, preview.height));

    // Twice the fit grid, so the warp resamples from prefiltered pixels: warping
    // straight from 60MP with bilinear taps would alias, and resizing after the
    // warp would blur the geometry being measured.
    let source_width = jpeg_full.width * 2;
    let source_height = ((render.height as f64 / render.width as f64) * source_width as f64).round() as usize;
    let source = reduced(gpu, &mut recording, &render, (source_width, source_height.max(1)));

    let search_source = reduced(gpu, &mut recording, &source, halved(&source));
    let search_jpeg = reduced(gpu, &mut recording, &jpeg_full, halved(&jpeg_full));

    // Filtered once here rather than per candidate; the falloff is fitted from one
    // geometry, so there is nothing to re-filter. Both sides have to end up filtered the
    // same way, and the source is held at twice the grid, so its sigma is scaled to match
    // or it arrives half as filtered as the JPEG and the pairs carry the difference in
    // blur as if it were a difference in level.
    let source_sigma = FIT_BLUR_SIGMA * (source.width as f64 / jpeg_full.width as f64);
    let falloff_source = blurred(gpu, &mut recording, &source, source_sigma);
    let falloff_jpeg = blurred(gpu, &mut recording, &jpeg_full, FIT_BLUR_SIGMA);

    // 1:1 with the preview, which the full grid's render is not - it is held at twice it.
    let sampled = reduced(gpu, &mut recording, &render, (preview.width, preview.height));

    // Nothing comes back. The three grids the search compares against stay where they were
    // reduced, and so does the 1:1 plane the settle warps.
    recording.submit();
    let sampled = crate::hdr_fit::Source {
        buffer: sampled.buffer,
        width: sampled.width,
        height: sampled.height,
    };

    Some((
        Grids {
            full: source.into_grid(jpeg_full),
            search: search_source.into_grid(search_jpeg),
            falloff: falloff_source.into_grid(falloff_jpeg),
        },
        sampled,
    ))
}

/// `width` by `height` at [`FIT_LONG_EDGE`] on the long side, or its own where it is already no
/// larger: a fit grid exists to make the comparison cheaper, and an embedded preview smaller than
/// one would otherwise be upscaled into invented detail.
fn fit_size(width: usize, height: usize) -> (usize, usize) {
    let longest = width.max(height);
    if longest <= FIT_LONG_EDGE {
        return (width, height);
    }
    let scaled = |d: usize| ((d as u64 * FIT_LONG_EDGE as u64 / longest as u64) as usize).max(1);
    (scaled(width), scaled(height))
}

fn halved(plane: &Sampled) -> (usize, usize) {
    ((plane.width / 2).max(1), (plane.height / 2).max(1))
}

async fn fit_grids(
    gpu: &'static crate::gpu::Gpu,
    grids: Grids,
    geometry: Geometry,
    render: &crate::hdr_fit::Source,
    preview: &crate::hdr_fit::Source,
) -> Result<Option<Profile>, String> {
    let mut lap = crate::clock::laps("  geometry ");
    // The uncorrected frame has the most pairs of any geometry, so a baseline that cannot be
    // measured is a frame nothing can be measured on - or a device that did not answer - and
    // not a reason to accept whatever candidate does score.
    let Some(baseline_delta) = residual_for(gpu, &grids.full, &[], 1.0).await else {
        return Ok(None);
    };
    lap("baseline");

    // Decided entirely on the search grid; the winner is re-fitted at full size
    // below, so nothing reported was measured coarse.
    let settled: (Option<Vec<f64>>, f64, u32) = match geometry {
        // Taken at its word for the curve, which is most of what a search costs. The
        // scale still has to be fitted: the body is saying it undistorted nothing, not
        // that it framed the JPEG exactly as the decode frames the render.
        Geometry::Uncorrected => chosen(fit_scale(gpu, &grids).await, baseline_delta, 0),
        Geometry::Recorded(knots) => {
            with_curve(gpu, &grids, knots, baseline_delta, SOURCE_CAMERA).await
        }
        Geometry::Profiled(knots) => {
            with_curve(gpu, &grids, knots, baseline_delta, SOURCE_LENSFUN).await
        }
        // Two parameters reach the same residual as a camera's spline, but it is the
        // expensive way there: fitting the same frames both ways is 1643ms against
        // 360ms on an RX100M3 and 1216ms against 589ms on an ILCE-7CR.
        Geometry::Unstated => chosen(
            fit_family(gpu, &grids, |k1| polynomial_knots(k1, 0.0, 16), &K1_SCAN, K1_STEP).await,
            baseline_delta,
            SOURCE_FITTED,
        ),
    };
    lap("scan, refine");

    // Ahead of the falloff below, whose pairs correspond through whatever geometry is in
    // hand when it runs - so it has to be this one, not the one the settle replaced.
    let (curve, crop, source) = settled;
    let (curve, crop, source) =
        match settled_on_registration(gpu, render, preview, curve.as_deref().unwrap_or_default(), crop)
            .await
        {
            Some((knots, crop)) => match (knots.iter().any(|knot| *knot != 0.0), source) {
                // A curve where the tier supplied none is the measurement's alone, and
                // reporting it as the tier's is how a tier's numbers come to disagree with
                // what it did.
                (true, 0) => (Some(knots), crop, SOURCE_MEASURED),
                (true, tier) => (Some(knots), crop, tier),
                // Settled onto nothing, which is a geometry of crop alone.
                (false, _) => (None, crop, 0),
            },
            None => (curve, crop, source),
        };
    lap("settle");

    let knots = curve.clone().unwrap_or_default();
    let warped = grids.falloff.warped(gpu, &[candidate(&knots, crop)]);
    let paired = grids.falloff.alone(gpu);
    // The gate's own count comes back with the first score, so the pair list is placed once and
    // asked about rather than measured first.
    let Some(admitted) = paired
        .scored(&warped, Phase::Train, None)
        .await
        .and_then(|scored| scored.first().map(|one| one.pairs))
    else {
        return Ok(None);
    };
    if admitted < MIN_PAIRS {
        return Ok(None);
    }
    let gain = fit_gain(paired, &warped, Phase::Train, admitted).await;
    lap("falloff");

    Ok(Some(Profile {
        knots: curve,
        gain,
        // Measured off the render at full size instead, by `with_lateral`: the JPEG has
        // none of it left to compare against, and three attempts to fit it through this
        // search went wrong on that (`tca.rs`).
        tca: None,
        crop,
        source,
    }))
}

/// Resolves the lateral aberration and folds it into the profile.
///
/// **Separate from the fit, because it does not use the JPEG.** Everything in
/// `fit_from_preview` is render-against-preview; this is measured off the render alone - the camera's JPEG has
/// no lateral fringe left in it to compare against - so it needs neither the reference nor
/// the search, and threading the body's recorded curve through both of them only to reach
/// the last three lines was plumbing a value past the function that was supposed to use it.
///
/// The cascade: the curve the body recorded for this shot, then the fringe measured off
/// the frame's own point sources, then a regression. The order is the point - the
/// regression reads a slope off the whole frame at a quarter resolution, which is where
/// point sources go, so it ends up fitting scene edges that carry no radial signal. Every
/// tier is verified against the frame afterwards regardless (`tca::improves`).
///
/// A 5px corner shift is a tenth of a pixel by the time the fit grid has been reduced to
/// 640px and blurred at sigma 3, which is where three earlier attempts to fit this through
/// the search went wrong (`tca.rs`). So it is read at full size, here.
pub async fn with_lateral(
    gpu: &'static crate::gpu::Gpu,
    profile: &mut Profile,
    render: &crate::fit_source::Rendered,
    recorded: Option<[Vec<f64>; 2]>,
) {
    let Some(frame) = crate::tca_device::frame(gpu, render).await else { return };
    profile.tca = match recorded {
        Some(curve) => crate::tca::supplied_curve(&frame, curve).await,
        None => match crate::tca::measure(&frame).await {
            Some(curve) => Some(curve),
            None => crate::tca::estimate(&frame).await,
        },
    };
    // A channel read further out than green needs the room to be there, so the crop
    // tightens by however much the widest one reaches past it. At the scales a real lens
    // shows this is under a fifth of a percent.
    profile.crop /= crate::tca::widest(profile.tca.as_ref());
}

/// Gaussian elimination with partial pivoting over one right-hand side.
///
/// `matrix` is `n` by `n`, row-major. None where a pivot column is numerically empty, which is a
/// singular system and never a result to carry on with.
pub(crate) fn gaussian(matrix: &[f64], rhs: &[f64], n: usize) -> Option<Vec<f64>> {
    let mut a = matrix.to_vec();
    let mut b = rhs.to_vec();
    for col in 0..n {
        let pivot = (col..n).max_by(|p, q| a[p * n + col].abs().total_cmp(&a[q * n + col].abs()))?;
        if a[pivot * n + col].abs() < 1e-14 {
            return None;
        }
        if pivot != col {
            for k in 0..n {
                a.swap(col * n + k, pivot * n + k);
            }
            b.swap(col, pivot);
        }
        for row in col + 1..n {
            let factor = a[row * n + col] / a[col * n + col];
            for k in col..n {
                a[row * n + k] -= factor * a[col * n + k];
            }
            b[row] -= factor * b[col];
        }
    }
    for col in (0..n).rev() {
        let mut sum = b[col];
        for k in col + 1..n {
            sum -= a[col * n + k] * b[k];
        }
        b[col] = sum / a[col * n + col];
    }
    Some(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rgb::Rgb;

    fn scene(width: usize, height: usize) -> Rgb {
        // Smooth, low-gradient content: the pair gate rejects steep edges, so a
        // noise field would leave nothing to fit.
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                data[i] = (60.0 + 120.0 * (x as f64 / width as f64)) as u8;
                data[i + 1] = (50.0 + 130.0 * (y as f64 / height as f64)) as u8;
                data[i + 2] = (90.0 + 60.0 * ((x + y) as f64 / (width + height) as f64)) as u8;
            }
        }
        Rgb { width, height, data }
    }

    /// Noise, hard edges and a gradient: content a blur has something to flatten.
    fn textured(width: usize, height: usize) -> Rgb {
        let mut data = vec![0u8; width * height * 3];
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        for y in 0..height {
            for x in 0..width {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                let noise = ((seed >> 40) & 0x3F) as f64 - 32.0;
                let edge = if (x / 37 + y / 41) % 2 == 0 { 45.0 } else { 0.0 };
                let i = (y * width + x) * 3;
                for (c, base) in [70.0, 110.0, 150.0].into_iter().enumerate() {
                    let v = base + edge + noise + 40.0 * ((x + c * 37) as f64 / width as f64);
                    data[i + c] = v.clamp(0.0, 255.0) as u8;
                }
            }
        }
        Rgb { width, height, data }
    }

    fn blurred_on_device(gpu: &'static crate::gpu::Gpu, source: RgbRef<'_>, sigma: f64) -> Option<Rgb> {
        let mut recording = gpu.record();
        let held = uploaded(&mut recording, "test source", source);
        let out = blurred(gpu, &mut recording, &held, sigma);
        let read = staged(&mut recording, &out);
        recording.submit();
        pollster::block_on(read_rgb(gpu, &read, &out))
    }

    fn reduced_on_device(
        gpu: &'static crate::gpu::Gpu,
        source: RgbRef<'_>,
        size: (usize, usize),
    ) -> Option<Rgb> {
        let mut recording = gpu.record();
        let held = uploaded(&mut recording, "test source", source);
        let out = reduced(gpu, &mut recording, &held, size);
        let read = staged(&mut recording, &out);
        recording.submit();
        pollster::block_on(read_rgb(gpu, &read, &out))
    }

    #[test]
    fn blur_flattens_detail_without_shifting_the_average() {
        let Some(gpu) = crate::gpu::device() else { return };
        let source = textured(64, 64);
        let out = blurred_on_device(gpu, source.as_ref(), 3.0).expect("the device blurs");
        assert_eq!((out.width, out.height), (64, 64));
        let mean = |d: &[u8]| d.iter().map(|v| u64::from(*v)).sum::<u64>() / d.len() as u64;
        assert!(
            (mean(&source.data) as i64 - mean(&out.data) as i64).abs() < 3,
            "a blur should not move the overall level"
        );
        let spread = |d: &[u8]| {
            let (lo, hi) = d.iter().fold((255u8, 0u8), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
            hi - lo
        };
        assert!(spread(&out.data) < spread(&source.data), "a blur should flatten detail");
    }

    /// The blur's kernel, against the window it says it is.
    ///
    /// `blur_flattens_detail_without_shifting_the_average` only asks that it flatten, which a box,
    /// a Gaussian and a wrong radius all do. This states the weights: triangular, `radius + 1 -
    /// |k|` over `(radius + 1)^2`, the edge pixel repeated past the frame, and the radius the one
    /// `blurred` derives from sigma. Both planes of the falloff's grid are filtered through it and
    /// the residual between them is what the gain is fitted from, so a kernel that drifted would
    /// move a fitted falloff with nothing else reporting it.
    #[test]
    fn the_blur_is_the_triangular_window_it_claims() {
        let Some(gpu) = crate::gpu::device() else { return };
        // A single lit column on black: what comes back is the kernel itself, one row of it.
        let (width, height) = (33usize, 3usize);
        let sigma = 3.0f64;
        // The radius `blurred` derives, restated so a change to that derivation fails here.
        let radius = (2.0 * sigma - 1.0).round().max(1.0) as isize;
        let divisor = ((radius + 1) * (radius + 1)) as f64;
        let weight = |k: isize| (radius + 1 - k.abs()).max(0) as f64;

        // Two columns: one clear of both edges, and one inside the radius of the left one, where
        // every tap that runs off the frame reads the edge pixel again. A window that dropped
        // those taps, or padded them with black, passes the first column and fails the second.
        for lit in [width / 2, 1] {
            let mut data = vec![0u8; width * height * 3];
            for y in 0..height {
                data[(y * width + lit) * 3..(y * width + lit) * 3 + 3].fill(255);
            }
            let source = Rgb { width, height, data };
            let out = blurred_on_device(gpu, source.as_ref(), sigma).expect("the device blurs");

            let middle = (height / 2) * width;
            for x in 0..width as isize {
                // What the horizontal pass reads at `x`: every tap, clamped into the frame, so a
                // tap landing on the lit column counts however many times it is repeated.
                let want = 255.0
                    * (-radius..=radius)
                        .filter(|k| (x + k).clamp(0, width as isize - 1) == lit as isize)
                        .map(weight)
                        .sum::<f64>()
                    / divisor;
                let got = f64::from(out.data[(middle + x as usize) * 3]);
                assert!(
                    (got - want).abs() <= 1.0,
                    "column {lit}, pixel {x} came out {got:.1} where the window wants {want:.1}",
                );
            }
        }
    }

    /// A reduce has to actually filter, not point-sample: a two-tap gather reads four of every
    /// hundred source pixels at this ratio, which is not a reduce at all.
    #[test]
    fn a_reduce_averages_the_pixels_it_skips() {
        let Some(gpu) = crate::gpu::device() else { return };
        // Alternating columns: any filter with support averages them to the midpoint, while a
        // point sample lands on one column or the other.
        let (width, height) = (640usize, 8usize);
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                let level = if x % 2 == 0 { 40 } else { 200 };
                data[(y * width + x) * 3..(y * width + x) * 3 + 3].fill(level);
            }
        }
        let source = Rgb { width, height, data };

        let out = reduced_on_device(gpu, source.as_ref(), (80, height)).expect("the device reduces");
        let worst = out.data.iter().map(|v| (i32::from(*v) - 120).abs()).max().unwrap();
        assert!(worst <= 8, "a reduce should average the columns it drops, worst was {worst} off");
    }

    /// The device reduce against `image::resize`, which is the convention it was written to.
    ///
    /// **What this pins is the half-pixel and the support**, which nothing else can see: a filter
    /// centred on the source pixel's corner rather than its centre, or one whose window does not
    /// widen with the ratio, still averages and still passes the test above. Held to a couple of
    /// codes rather than exactly, because `fast_image_resize` quantises between its two axes and
    /// carries its taps as fixed point where this works in floats throughout.
    #[test]
    fn the_device_reduce_lands_where_the_host_resize_does() {
        let Some(gpu) = crate::gpu::device() else { return };
        let source = textured(300, 200);
        let ours = reduced_on_device(gpu, source.as_ref(), (97, 65)).expect("the device reduces");
        let theirs = crate::image::resize(source.as_ref(), 97, 65);
        let off: Vec<i32> = ours
            .data
            .iter()
            .zip(&theirs.data)
            .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
            .collect();
        let worst = off.iter().copied().max().expect("a plane");
        let mean = off.iter().sum::<i32>() as f64 / off.len() as f64;
        assert!(worst <= 4, "worst {worst} of 255 from the host reduce");
        assert!(mean < 1.0, "mean {mean} of 255 from the host reduce");
    }

    /// A reduce onto the size it already is gives the plane back.
    ///
    /// `fit_size` returns the source's own size for a preview no larger than the fit grid, which
    /// is a real case: a small embedded JPEG. The host resize answered that with a copy. This
    /// convolves instead - and the Lanczos window is `sinc` at every integer offset, so it is the
    /// identity, but only to whatever `sin` does near a multiple of pi in f32. This is the check
    /// that the difference stays under the byte.
    #[test]
    fn a_reduce_onto_its_own_size_gives_the_plane_back() {
        let Some(gpu) = crate::gpu::device() else { return };
        let source = textured(61, 43);
        let out = reduced_on_device(gpu, source.as_ref(), (61, 43)).expect("the device reduces");
        let worst = out
            .data
            .iter()
            .zip(&source.data)
            .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
            .max()
            .expect("a plane");
        assert_eq!(worst, 0, "a 1:1 reduce moved a pixel by {worst}");
    }

    #[test]
    fn a_recorded_curve_reaches_the_profile_and_takes_its_crop_room_with_it() {
        // **The cascade had no coverage through this function at all.** Stubbing the body
        // of `with_lateral` to `profile.tca = None` left the whole suite green, and so did
        // deleting the crop division - so neither the curve reaching the profile nor the
        // room the widest channel needs was pinned anywhere.
        let Some(gpu) = crate::gpu::device() else { return };
        let render = scene(96, 72);
        let mut profile = Profile { knots: None, gain: None, tca: None, crop: 1.0, source: 0 };
        // 0.6% outward on red: over `MIN_SHIFT`'s quarter-pixel floor at this frame size
        // and well under `MAX_SCALE`, so `plausible` accepts it, and `improves` cannot
        // refuse it on a frame with no point sources to check against.
        let recorded = crate::tca::flat(1.006, 1.0);
        let render = crate::fit_source::uploaded_render(gpu, render.as_ref());
        pollster::block_on(with_lateral(gpu, &mut profile, &render, Some(recorded)));

        let tca = profile.tca.as_ref().expect("a recorded curve reaches the profile");
        let widest = crate::tca::widest(Some(tca));
        assert!(widest > 1.0, "red reads past green, so the widest reach is over 1: {widest}");
        // The crop has to tighten by exactly that reach, or the channel read furthest out
        // samples past the edge of the frame it was cropped to.
        assert!(
            (profile.crop - 1.0 / widest).abs() < 1e-12,
            "crop {} against the {widest} of room the curve needs",
            profile.crop,
        );
    }

    /// The geometry search minimises this and nothing else, so a luma curve that does
    /// not track the tone difference between the two frames would leave the search
    /// ranking candidates on the difference in exposure rather than in alignment.
    /// The bins `fit_obj_bins` fills, for a mapping stated outright: twenty pairs a level, each
    /// grey, so luma is the level itself and the mapping is the only thing a curve can be reading.
    fn bins_of(mapping: impl Fn(u8) -> u8) -> ([f64; 256], [f64; 256]) {
        let (mut sum, mut count) = ([0.0f64; 256], [0.0f64; 256]);
        for level in 0..=255u8 {
            for _ in 0..20 {
                sum[level as usize] += f64::from(mapping(level));
                count[level as usize] += 1.0;
            }
        }
        (sum, count)
    }

    fn tone_mapped(level: u8) -> u8 {
        (f64::from(level) * 0.75 + 20.0).min(255.0) as u8
    }

    #[test]
    fn a_luma_curve_recovers_a_known_tone_mapping() {
        let (sum, count) = bins_of(tone_mapped);
        let curve = curve_from_bins(sum, count);
        for level in [10usize, 80, 200] {
            let expected = (level as f64 * 0.75 + 20.0).min(255.0);
            assert!(
                (curve[level] as f64 - expected).abs() <= 1.5,
                "level {level}: {} vs {expected}",
                curve[level],
            );
        }
    }

    /// Two grids where the camera's side is a stated mapping of ours, in flat patches so the
    /// gate's gradient test has an interior to admit.
    fn mapped_grids(
        gpu: &'static crate::gpu::Gpu,
        mapping: impl Fn(u8) -> u8,
    ) -> (crate::gpu::Buffer, crate::gpu::Buffer, (usize, usize)) {
        const PATCH: usize = 8;
        const ACROSS: usize = 16;
        let (width, height) = (ACROSS * PATCH, ACROSS * PATCH);
        let (mut ours, mut theirs) = (Vec::new(), Vec::new());
        for y in 0..height {
            for x in 0..width {
                // Levels 2..254, since the gate drops both ends as carrying no mapping.
                let level = (2 + ((y / PATCH) * ACROSS + x / PATCH)) as u8;
                for _ in 0..3 {
                    ours.push(f32::from(level) / 255.0);
                    theirs.push(f32::from(mapping(level)) / 255.0);
                }
            }
        }
        let upload = |label, values: &[f32]| {
            let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_ne_bytes()).collect();
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: &bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            })
        };
        (upload("objective ours", &ours), upload("objective theirs", &theirs), (width, height))
    }

    /// Held-out pairs the curve maps exactly must score at the floor, or every candidate
    /// carries a constant the comparison then has to see past.
    ///
    /// Through the device objective rather than a host fold of the same pairs, because the fold is
    /// the device's now: what this asks is whether the gate, the bins and the residual agree about
    /// a mapping stated outright.
    #[test]
    fn a_luma_score_bottoms_out_when_the_curve_maps_every_pair() {
        let Some(gpu) = crate::gpu::device() else { return };
        let (ours, theirs, size) = mapped_grids(gpu, tone_mapped);
        let paired = crate::fit_objective::paired(gpu, 1, &theirs, size);
        let scored = pollster::block_on(paired.scored(&[ours], Phase::Train, None))
            .expect("the device scored");
        assert!(scored[0].pairs > 1000, "the gate admitted {}", scored[0].pairs);
        // One level of rounding is 100/255 of a unit, so anything under that is exact.
        assert!(
            scored[0].delta < 100.0 / 255.0,
            "a curve that maps every pair scored {}",
            scored[0].delta,
        );

        // The curve it drew is the mapping, which is what makes the score above a measurement of
        // the fold rather than of a coincidence.
        let curve = pollster::block_on(paired.curve(0)).expect("the device drew a curve");
        for level in [40u8, 120, 200] {
            let want = tone_mapped(level);
            assert!(
                curve[level as usize].abs_diff(want) <= 1,
                "level {level}: {} against {want}",
                curve[level as usize],
            );
        }
    }

    /// BT.709, not an average: a frame's green carries most of its luma, and getting
    /// these weights wrong would be invisible on the grey pairs above.
    #[test]
    fn luma_weights_green_the_most_and_blue_the_least() {
        assert_eq!(luma8(255, 255, 255), 255);
        assert_eq!(luma8(0, 255, 0), 182);
        assert_eq!(luma8(255, 0, 0), 54);
        assert_eq!(luma8(0, 0, 255), 18);
    }

    #[test]
    fn a_curve_is_monotone_even_from_noisy_bins() {
        // A target that jumps around: the fit must still not invert.
        let (sum, count) = bins_of(|level| match level % 2 {
            0 => level.saturating_sub(30),
            _ => level.saturating_add(30),
        });
        let curve = curve_from_bins(sum, count);
        for level in 1..256 {
            assert!(curve[level] >= curve[level - 1], "curve dipped at {level}");
        }
    }

    /// A falloff that dips through the middle of the frame and climbs back is not one.
    ///
    /// **The shape, not the amplitude, is what says whether a solve fitted a lens or a scene.**
    /// `Gain::LIMIT` bounds how far a gain may go and cannot see this at all: the first pair below
    /// stays inside it the whole way and is still a 4x dip in the mid-radii with the corners
    /// brighter than the centre. Rejected, the frame it came off goes from deltaE 5.09 to 1.38, so
    /// what this gate is worth is most of a picture rather than a decimal.
    ///
    /// The second group is what stops it being written as strict monotonicity. A real recovery
    /// arrives with a little curvature noise at the origin - the third is the injected-corner
    /// fixture's own first round - and an exact test throws every one of them away with the
    /// invented ones.
    #[test]
    fn a_falloff_that_dips_before_it_climbs_is_not_a_falloff() {
        assert!(!keeps_its_direction(-4.6781, 6.4322), "a measured solve, dipping to the clamp");
        assert!(!keeps_its_direction(1.0, -1.5), "a lift that turns over well before the corner");

        assert!(keeps_its_direction(0.6, 0.2), "a plain corner lift");
        assert!(keeps_its_direction(-0.4, -0.1), "the same shape darkening");
        assert!(keeps_its_direction(0.1074, -0.3198), "a 0.9% rise before a 21% fall");
        assert!(keeps_its_direction(0.8, -0.4), "a lift flattening at the corner without falling");
        assert!(keeps_its_direction(0.0, 0.0), "no falloff at all");
    }

    #[test]
    fn every_crop_candidate_fills_the_frame() {
        // Slack is measured down from the tightest fill, so a positive entry here would
        // put a black margin back in the search - which the residual cannot see, the
        // pair gate skipping black, and so would score as well as the crop that fills.
        assert!(SLACK_SCAN.iter().all(|slack| *slack <= 0.0), "{SLACK_SCAN:?}");
        assert!(SLACK_SCAN.contains(&0.0), "the tightest fill has to be a candidate");
    }

    /// The claim the settle exists for: a curve is recovered from where the camera put the
    /// features, rather than from a family that could express it.
    ///
    /// A mustache that vanishes at both the centre and the corner, which no `k1` and no
    /// gain over one can produce, started at half strength - the shape of error a search
    /// scored on blurred luma leaves behind. Sized so the error it starts with is a pixel
    /// or two on the plane the search runs in: below that a whole-pixel search has nothing
    /// to report, and above it the corner leaves the search range entirely.
    #[test]
    fn the_settle_recovers_a_mustache_it_was_started_at_half_of() {
        let (width, height) = (512, 340);
        let render = textured(width, height);
        let truth: Vec<f64> = (0..16)
            .map(|i| {
                let radius = i as f64 / 15.0;
                -0.02 * (std::f64::consts::PI * radius).sin() * crate::image::SPLINE_UNIT
            })
            .collect();
        let start: Vec<f64> = truth.iter().map(|knot| knot * 0.5).collect();

        let gpu = crate::gpu::device().expect("an adapter for the fit's search");
        let source = crate::hdr_fit::Source {
            buffer: crate::hdr_fit::levelled_source(gpu, render.as_ref()),
            width,
            height,
        };
        let warped = crate::hdr_fit::warped_planes(
            gpu,
            &source.buffer,
            (width, height),
            &[candidate(&truth, 1.0)],
            (width, height),
        );
        let preview = crate::hdr_fit::Source {
            buffer: warped.into_iter().next().expect("the device warps the truth in"),
            width,
            height,
        };
        let (settled, crop) =
            pollster::block_on(settled_on_registration(gpu, &source, &preview, &start, 1.0))
        .expect("a frame this textured has something to register on");
        assert_eq!(crop, 1.0, "a curve that only magnifies still fills the frame");
        for radius in [0.4, 0.5, 0.6] {
            let want = crate::image::spline_at(&truth, radius);
            let got = crate::image::spline_at(&settled, radius);
            let started = crate::image::spline_at(&start, radius);
            assert!(
                (got - want).abs() < (started - want).abs() / 3.0,
                "at r {radius}: settled {got}, wanted {want}, started {started}"
            );
        }
    }
}
