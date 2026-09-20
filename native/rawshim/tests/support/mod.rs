//! The fixtures every analysis test is written against. One place, so that "a bright patch" and
//! "the noise it sits in" mean the same thing in every test that says them.
#![allow(dead_code)]

use rawshim::gpu::{self, Gpu};
use rawshim::light::{Light, SceneNits};
use rawshim::resident::Resident;
use rawshim::tone;

/// What a synthetic frame has in it. Every frame is the same textured ground so that "agrees" and
/// "differs" both have something to measure; a patch is laid over it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Patch {
    None,
    /// A bright square, 16px a side, centred.
    Bright,
}

pub struct Rig {
    pub gpu: &'static Gpu,
    pub base: &'static rawshim::base::Base,
}

/// The device, or none where no adapter answered - said aloud, since a test that quietly passes
/// because it never ran is worse than no test.
pub fn rig() -> Option<Rig> {
    let Some(gpu) = gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the analysis fixtures were not built.");
        return None;
    };
    let base = rawshim::base::device(gpu).expect("the shipped kernels");
    Some(Rig { gpu, base })
}

/// The inverse of `base::light_of_code`, the table the device reads a code's light from: light 1
/// is PQ's 10000-nit ceiling, so `light_of_code[code_of_light(l)] == l`. Anchored at diffuse white
/// instead, a sample caps at code 38024 and no gain can clip one.
pub fn code_of_light(light: f32) -> u16 {
    let ceiling = tone::pq_inv::<SceneNits>(Light::measured(1.0));
    let nits = Light::<SceneNits>::measured(f64::from(light) * ceiling.raw());
    (tone::pq(nits).raw() * f64::from(u16::MAX)).round() as u16
}

/// Light, in [0, 1] of PQ's ceiling, before noise and before coding.
pub fn ground(x: usize, y: usize) -> f32 {
    // 64 levels of texture, so a flat frame is not what "agrees" means.
    0.18 + 0.06 * (((x / 4 + y / 4) % 8) as f32 / 8.0)
}

/// The noise model every synthetic frame is generated under, stated at a signal in the mosaic's
/// normalisation as every fit in this pipeline is.
///
/// The frames below code that signal as light directly - a plane whose `full_scale_light` is 1 -
/// so here the two normalisations coincide and a stage reading `light_of_code` reads this model.
pub fn noise() -> rawshim::galosh::NoiseModel {
    rawshim::galosh::NoiseModel {
        alpha: 2e-4,
        sigma_sq: 1e-6,
    }
}

/// One sigma of that model at a signal, which is how far a sample of it can stray.
pub fn sigma_at(signal: f32) -> f32 {
    let model = noise();
    (model.alpha * signal + model.sigma_sq).sqrt()
}

fn patched(light: f32, x: usize, y: usize, patch: &Patch, size: (usize, usize)) -> f32 {
    let (w, h) = size;
    let inside = |cx: usize, cy: usize, half: usize| {
        x + half >= cx && x < cx + half && y + half >= cy && y < cy + half
    };
    match patch {
        Patch::Bright if inside(w / 2, h / 2, 8) => 0.9,
        _ => light,
    }
}

/// Deterministic per pixel, so a test is the same test twice.
fn grain(x: usize, y: usize, frame: usize) -> f32 {
    let seed = (x as u64).wrapping_mul(73_856_093)
        ^ (y as u64).wrapping_mul(19_349_663)
        ^ (frame as u64).wrapping_mul(83_492_791);
    let u = (seed.wrapping_mul(2_654_435_761) % 10_007) as f32 / 10_007.0;
    u - 0.5
}

fn frame(rig: &Rig, index: usize, patch: &Patch, gain: f32, size: (usize, usize)) -> Resident {
    let (w, h) = size;
    let mut samples = vec![0u16; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let light = patched(ground(x, y), x, y, patch, size) * gain;
            let noisy = (light + 2.0 * sigma_at(light) * grain(x, y, index)).clamp(0.0, 1.0);
            let code = code_of_light(noisy);
            let at = (y * w + x) * 3;
            samples[at] = code;
            samples[at + 1] = code;
            samples[at + 2] = code;
        }
    }
    Resident::upload(rig.gpu, &samples, w, h)
}

/// Frames on the device, coded PQ, all at `size`, in this pipeline's own 16-bit layout.
pub fn synthetic(rig: &Rig, patches: &[Patch], size: (usize, usize)) -> Vec<Resident> {
    patches
        .iter()
        .enumerate()
        .map(|(i, p)| frame(rig, i, p, 1.0, size))
        .collect()
}

/// The same with every frame `gain` times brighter in light.
pub fn synthetic_gained(
    rig: &Rig,
    patches: &[Patch],
    gains: &[f32],
    size: (usize, usize),
) -> Vec<Resident> {
    patches
        .iter()
        .enumerate()
        .map(|(i, p)| frame(rig, i, p, gains[i], size))
        .collect()
}

/// `bytes` of `buffer`, on the host. The buffer has to have been made `COPY_SRC`.
fn read_bytes(rig: &Rig, buffer: &gpu::Buffer, bytes: usize) -> Vec<u8> {
    let mut recording = rig.gpu.record();
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("test readback"),
        size: bytes as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(buffer, 0, &readback, 0, bytes as u64);
    recording.submit();
    pollster::block_on(gpu::read_back(rig.gpu, &readback, <[u8]>::to_vec))
        .expect("a readable buffer")
}

/// A buffer's floats. NOT `read_back`: that one is async, takes a closure and a `wgpu::Buffer`,
/// and this has to stage the copy a storage buffer cannot be mapped without.
pub fn floats_of(rig: &Rig, buffer: &gpu::Buffer, count: usize) -> Vec<f32> {
    read_bytes(rig, buffer, count * 4)
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

pub fn u32s_of(rig: &Rig, buffer: &gpu::Buffer, count: usize) -> Vec<u32> {
    read_bytes(rig, buffer, count * 4)
        .chunks_exact(4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// `_rig` is unused - `Resident` carries its own device - and stays so the nine `codes_of(&rig,
/// &plane)` call sites already written against this signature compile.
pub fn codes_of(_rig: &Rig, plane: &Resident) -> Vec<u16> {
    pollster::block_on(plane.host()).expect("a readable plane")
}

/// The mean and worst sample difference between a frame and its fixture, and where the worst is.
///
/// Lengths first, and as an assertion rather than a `zip`: a frame that came back the wrong shape
/// is the regression a size-changing fault produces, and zipping over the shorter of the two would
/// compare its prefix and then divide the total by the *fixture's* length - so a missing tail would
/// report a mean nearer zero, which is to say it would pass.
pub fn drift(got: &[u16], want: &[u16]) -> (f64, i64, usize) {
    assert_eq!(
        got.len(),
        want.len(),
        "the fixture has {} samples and the frame {}",
        want.len(),
        got.len(),
    );
    let (mut worst, mut at, mut total) = (0i64, 0usize, 0i64);
    for (index, (a, b)) in got.iter().zip(want.iter()).enumerate() {
        let error = (i64::from(*a) - i64::from(*b)).abs();
        total += error;
        if error > worst {
            (worst, at) = (error, index);
        }
    }
    (total as f64 / want.len() as f64, worst, at)
}

/// A storage buffer holding these floats, COPY_SRC so it can be read back.
pub fn upload_f32(rig: &Rig, values: &[f32]) -> gpu::Buffer {
    rig.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("test f32"),
        contents: bytemuck::cast_slice(values),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    })
}

pub fn upload_u32(rig: &Rig, values: &[u32]) -> gpu::Buffer {
    rig.gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("test u32"),
        contents: bytemuck::cast_slice(values),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    })
}

pub fn centre(size: (usize, usize)) -> usize {
    (size.1 / 2) * size.0 + size.0 / 2
}

pub fn at(size: (usize, usize), x: usize, y: usize) -> usize {
    y * size.0 + x
}
