//! The grade, on whatever GPU this machine has, from the shaders the editor runs.
//!
//! **This exists so there is one implementation of the grade.** The editor's tick has to be
//! WGSL - it runs in a browser - so the choice was ever a second implementation in Rust or
//! this. DESIGN 21.1 records what the second one cost: the editor lost the camera match
//! twice, silently, because two implementations of one picture drifted. Sharing the source
//! makes that unexpressible rather than tested-for.
//!
//! The shaders are `include_str!`'d out of `OUT_DIR`, which is what the browser's build compiles
//! too, so the module the page runs and the module this runs are the same bytes. A copy beside
//! either host would pass every test it had while diverging from what ships.
//!
//! **The device is process-wide and built once.** Adapter enumeration and shader
//! compilation are tens of milliseconds; a rendition job that paid them per photo would
//! spend more there than on the grade. Held behind a `OnceLock` rather than passed down
//! through every caller, because the alternative is threading a device through
//! `job::run` -> `hdr::graded` -> `tone` for a resource there is exactly one of.

// The grade's callers all reach it through `device`, which is None in a browser (see below), so
// the encode, the peak and the readback are unreachable there rather than unwanted.
#![cfg_attr(target_arch = "wasm32", allow(dead_code))]

use crate::hdr_fit::{self, HdrColour};

mod print_surface;

/// `frame.slang`'s `FROM_FRAME`, as the draw's two pipelines name it.
const FROM_FRAME_ID: &str = "0";

const FRAME_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/frame.wgsl"));
const PEAK_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/peak.wgsl"));
const DETAIL_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/detail.wgsl"));

/// `DETAIL_LONG` in `detail.slang`, which is the long edge of that blur's working texture.
///
/// The shader declares it and this allocates for it, so the two are pinned together by
/// `the_shader_sizes_match_the_buffers_allocated_for_them`.
const DETAIL_LONG: u32 = 512;

/// The working texture for a frame of this size: the long edge capped, never scaled up.
///
/// The only place this is decided. The editor is told the answer on `PreparedHeader`, because
/// how large a share of the picture each blur covers follows from it - two hosts rounding it
/// differently would apply two different clarities and both would look like photographs.
pub fn detail_size(width: usize, height: usize) -> DetailSize {
    detail_within(width, height, width.max(height))
}

/// The same, for a frame that is a *piece* of a photograph whose long edge is `photograph_long`.
///
/// **At the photograph's rate rather than its own.** The blur is a shrink of the frame it is
/// built from, so a loupe tile scaled to fill the working texture would blur a twelfth of the
/// distance the export blurs - the same Clarity, acting on something else. Sized here and its
/// *window* carried in the uniform (`edit.detail_long`), because the two are separate facts: how
/// much of the photograph this texture holds, and how far across the photograph the filter
/// reaches.
pub fn detail_within(width: usize, height: usize, photograph_long: usize) -> DetailSize {
    let step = detail_step(photograph_long) as usize;
    DetailSize {
        width: width.div_ceil(step).max(1) as u32,
        height: height.div_ceil(step).max(1) as u32,
    }
}

/// How many of the photograph's pixels one texel of that texture covers.
///
/// **A step, so that the partition does not move with the window.** Dividing the frame given by
/// the texture allocated for it is the same thing for a whole photograph and is not the same
/// thing for a piece of one: a tile's texel boundaries land between the frame's, so every texel
/// averages a different set of pixels and the guided filter
/// was fitted from a picture the export never sees. With a step, a window whose origin is a whole
/// number of them gets the photograph's own texels.
pub fn detail_step(photograph_long: usize) -> u32 {
    (photograph_long.max(1) as u32).div_ceil(DETAIL_LONG).max(1)
}

/// The working texture's long edge for a whole photograph of `photograph_long`, which is what
/// `detail.slang` takes its window and its sigma as a fraction of.
pub fn detail_long(photograph_long: usize) -> u32 {
    (photograph_long.max(1) as u32).div_ceil(detail_step(photograph_long))
}

/// `GUIDE_RADIUS` in `detail.slang`: the guided filter's window, as a fraction of that long edge.
const GUIDE_RADIUS: f64 = 1.0 / 64.0;

/// `FINE_SIGMA` there: the fine reference's blur, in the same units.
const FINE_SIGMA: f64 = 1.0 / 1024.0;

/// How far the presence sliders read past a texel, in texels of a working texture this long.
///
/// **Two windows and a blur**, which is what the filter is: the moments are gathered over one
/// window and the models it fits are averaged over another, so an output texel depends on twice
/// the radius, and the fine reference adds its own taps on top. A caller building the blur for a
/// *piece* of a photograph needs this to know how much of the surroundings it has to hold
/// (`job::presence_reach`); a whole frame has them already.
///
/// The arithmetic is `detail.slang`'s, in Rust, which `the_detail_reach_is_the_shaders_own` pins
/// against the shader rather than trusting.
/// **Texels of the working texture, not pixels of the frame.** The two differ by `detail_step`, and
/// a caller that used this as a pixel reach would grow a window by a fraction of what the filter
/// actually reads - `tile::presence_reach` is the one that converts.
pub fn detail_reach_texels(detail_long: u32) -> crate::px::Span<crate::px::Texel> {
    // Off the working texture's own long edge, which is what keeps it a share of the photograph
    // rather than a count of texels: `detail_reach` is `GUIDE_RADIUS` and `FINE_SIGMA` of it.
    crate::px::Span::measured(detail_reach(detail_long))
}

pub fn detail_reach(detail_long: u32) -> usize {
    let long = f64::from(detail_long);
    let guide = (long * GUIDE_RADIUS).round().max(1.0);
    let fine = (3.0 * (long * FINE_SIGMA).max(0.5)).ceil();
    (2.0 * guide + fine) as usize
}

/// The blur's working texture, named so it can travel to the editor as one.
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetailSize {
    pub width: u32,
    pub height: u32,
}

/// The frame's coding undone, and nothing of `colour` because it binds the same table
/// read-only.
const DECODE_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/decode.wgsl"));

const MEAN_FRAME_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/mean_frame.wgsl"));
const CHROMA_SMOOTH_WGSL: &str =
    include_str!(concat!(env!("OUT_DIR"), "/wgsl/chroma_smooth.wgsl"));

/// How many texels the chroma-smoothing pass's blur reaches, held against `chroma_smooth.slang`.
const CHROMA_BLUR_REACH: u32 = 4;

/// Photograph long edges to a texel of that pass's shrunk frame.
///
/// **A share of the photograph, not a count of this frame's pixels**, for the reason
/// `DETAIL_LONG` is one and `mean_grid`'s block is one: the frame is a rendition of a
/// photograph and its pixels are whatever size that rendition asked for. A texel per four
/// pixels covers four times as much of a photograph rendered at 3840 as of the same one at a
/// 61MP sensor's own size, so the same picture's colour was smoothed over 2.5x more of itself
/// in the viewer's rendition than in the editor at 1:1 - measured as three times the chroma
/// noise in the larger render (`examples/supersample.rs`).
///
/// A 960th is four pixels at the size the viewer's rendition ships, so that rendition is
/// unchanged and every other size now agrees with it rather than the other way about.
///
/// A [`crate::px::Share`] and not a number of pixels, which is the type saying what went wrong
/// here: `Output`'s pixels are as large as the rendition is small, so it is not [`Absolute`] and
/// a constant distance in it does not compile.
const CHROMA_GRID: crate::px::Share = crate::px::Share::of(1, 960);

/// This frame's pixels to a texel of `chroma_smoothed`, given the photograph it is part of.
pub fn chroma_shrink(photograph_long: crate::px::Span<crate::px::Output>) -> crate::px::Span<crate::px::Output> {
    CHROMA_GRID.over(photograph_long)
}

/// How far, in frame pixels, a pixel's chroma can be moved by a neighbour: the texel the
/// bilinear read straddles, the blur's reach beyond it, and the texel that reach lands in.
/// A comparison that expects a pixel's colour to be a function of its own value alone has
/// to stay this far from anything that differs, and a window that must render as the
/// whole frame does has to carry this much of it past what it keeps.
pub fn chroma_smooth_reach(
    photograph_long: crate::px::Span<crate::px::Output>,
) -> crate::px::Span<crate::px::Output> {
    chroma_shrink(photograph_long) * (CHROMA_BLUR_REACH + 2) as usize
}

/// The reader's temperature and tint solved into one matrix.
const BALANCE_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/white_balance.wgsl"));

/// Floats that pass writes: three rows of four, the fourth of each unread.
const BALANCE_FLOATS: u64 = 12;

/// Entries in that table, which is every `u16` a sample can hold. `PQ_CODES` on the client.
const PQ_CODES: u64 = 65536;

/// The scene's own top end, measured once and read by every rendition of the photograph.
///
/// **Once per photograph, not once per size.** It is a property of the scene - what the
/// roll-off compresses into the display - so two renditions measuring it separately would
/// compress their highlights by different amounts, which is the drift `tone::QUANTILE_SAMPLES`
/// exists to prevent at the other end of the range. `job::run` uploads once per size group, so a
/// grid-and-full job would otherwise measure it twice, on two differently sized frames.
///
/// Four words, filled on the GPU by `Uploaded::measure_peak` and read there by the grade. The
/// CPU never sees the number.
pub struct ScenePeak {
    buffer: Buffer,
    measured: std::cell::Cell<bool>,
    revision: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl ScenePeak {
    /// Whether this still wants filling, claiming it if so.
    fn claim(&self) -> bool {
        !self.measured.replace(true)
    }
}

/// How the peak samples a frame: every nth row, for about `tone::QUANTILE_SAMPLES` pixels.
///
/// Whole rows rather than a scatter because `peak.slang` reads a frame: consecutive lanes stay
/// adjacent, where a stride applied per pixel would take a cache line each and fetch the whole
/// frame to read a tenth of it.
pub fn sampled_rows(width: usize, height: usize) -> (u32, u32) {
    let pixels = width * height;
    let stride =
        (((pixels as f64) / (crate::tone::QUANTILE_SAMPLES as f64)).round() as u32).max(1);
    (stride, (height as u32).div_ceil(stride))
}

pub struct Gpu {
    /// What answered, for the one line the entrypoint prints at boot.
    ///
    /// Kept because *which* adapter answered is a deployment fault nothing else reports. The
    /// image carries SwiftShader, so a container that cannot reach the host's card does not fail
    /// at boot - it answers on a CPU rasteriser, and the first evidence is every render taking
    /// minutes. Measured in a container: with `devices:` and `group_add:` this reads
    /// `RADV RAPHAEL_MENDOCINO`, and dropping `group_add` alone makes the same container fall
    /// back to software. Naming it at boot is what tells a misconfigured deployment from a
    /// machine that genuinely has no GPU.
    pub adapter: String,
    /// Which API answered, because one kernel is handed to the driver as it stands and a driver
    /// takes only its own ([`crate::pmrid`]'s cooperative matrices, SPIR-V on Vulkan and MSL on
    /// Metal).
    pub backend: wgpu::Backend,
    /// How many workgroups a whole-frame reduction splits into to fill this device.
    ///
    /// **One workgroup per CFA channel fills a two-core integrated part and leaves 64 of a
    /// 68-core discrete one idle**, so the width has to come from the device rather than from a
    /// constant. Slicing is not free either: `sigma_per_cfa`'s workgroup zeroes a 4096-bin
    /// histogram and writes it back out, and paying that fixed cost 32 times over costs the
    /// integrated part four times what the slicing saves it - 62ms to 257, against 11ms to 3 on
    /// an RTX 3080.
    ///
    /// wgpu reports no core count, so the device class is the signal. It is the distinction that
    /// was measured, and it fails softly: a discrete part narrower than this assumes pays a fixed
    /// cost rather than producing a different answer, the reductions being bit-identical at every
    /// width.
    pub reduction_slices: u32,
    /// Private so that the four allocating calls on it are unreachable: [`Release`] says why they
    /// have to be, and [`Recording`], the `own_*` constructors and [`Describing`] are what is
    /// reachable instead.
    device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// Kept because a surface is asked of the instance rather than of the device, and the
    /// editor's canvas arrives long after the device is opened ([`Stage::attach`]). Read only
    /// in a browser, there being no window on this side to draw into.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    instance: wgpu::Instance,
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
    draw_layout: wgpu::BindGroupLayout,
    draw_from_frame: wgpu::RenderPipeline,
    draw_from_pyramid: wgpu::RenderPipeline,
    print_layout: wgpu::BindGroupLayout,
    print_pipeline: wgpu::RenderPipeline,
    print_pq_pipeline: wgpu::RenderPipeline,
    print_pigment_pipeline: wgpu::RenderPipeline,
    print_flat_pipeline: wgpu::RenderPipeline,
    print_surface: print_surface::Pipelines,
    print_albedo_layout: wgpu::BindGroupLayout,
    print_albedo_tabulate: wgpu::ComputePipeline,
    print_albedo_average: wgpu::ComputePipeline,
    print_light_calibrate: wgpu::ComputePipeline,
    peak_layout: wgpu::BindGroupLayout,
    peak_measure: wgpu::ComputePipeline,
    peak_collect: wgpu::ComputePipeline,
    peak_remeasure: wgpu::ComputePipeline,
    peak_quantile: wgpu::ComputePipeline,
    detail_shrink_layout: wgpu::BindGroupLayout,
    detail_moments_layout: wgpu::BindGroupLayout,
    detail_box_layout: wgpu::BindGroupLayout,
    detail_mean_layout: wgpu::BindGroupLayout,
    detail_apply_layout: wgpu::BindGroupLayout,
    detail_shrink: wgpu::ComputePipeline,
    detail_moments: wgpu::ComputePipeline,
    detail_coefficients: wgpu::ComputePipeline,
    detail_window_mean: wgpu::ComputePipeline,
    detail_apply: wgpu::ComputePipeline,
    balance_layout: wgpu::BindGroupLayout,
    balance_pipeline: wgpu::ComputePipeline,
    mean_layout: wgpu::BindGroupLayout,
    mean_pipeline: wgpu::ComputePipeline,
    chroma_model_layout: wgpu::BindGroupLayout,
    chroma_blur_layout: wgpu::BindGroupLayout,
    chroma_model: wgpu::ComputePipeline,
    chroma_blur: wgpu::ComputePipeline,
    sampler: wgpu::Sampler,
    /// The frame's coding undone. Filled once with the device, since `tone::encode_base`
    /// anchors every frame to the reference white before coding it and what comes back out
    /// is nits - nothing here depends on the photograph.
    nits_of_code: Buffer,
}

#[cfg(not(target_arch = "wasm32"))]
static GPU: std::sync::OnceLock<Option<Gpu>> = std::sync::OnceLock::new();

/// The device, or None where no adapter of any kind answered.
///
/// None is a refusal, not a fallback. There is no CPU grade to drop to - a second
/// implementation is what DESIGN 21.1 records the cost of - so `job::run` returns an error
/// naming the missing driver and the photo goes unrendered rather than rendered differently.
/// An `Option` rather than a panic so the refusal is the caller's to word.
#[cfg(not(target_arch = "wasm32"))]
pub fn device() -> Option<&'static Gpu> {
    let open = GPU.get_or_init(Gpu::new).as_ref();
    #[cfg(target_os = "linux")]
    if open.is_some() {
        leave::through_exit();
    }
    open
}

/// Leaving a cargo-run process without unwinding a driver that will not survive it.
///
/// **A test target that opened a device on NVIDIA faults at exit about one run in eight**, after
/// every test has printed `ok`, which cargo reports as a target that failed and `bench.ts` reads
/// as a stage that did not run. `LD_DEBUG=libs` puts the fault *after* the loader has called every
/// fini including libc's and ld.so's, so nothing of ours is running: the ICD keeps threads, this
/// device lives in a `static` that Rust never drops, and `exit` unmaps the address space out from
/// under them.
///
/// **Destroying the device first does not fix it, which is why this is `_exit` and not a drop.**
/// Measured on the 3080 over 25 runs each, with a real dispatch submitted: leaked, 5 faults;
/// `Device::destroy` first, 5; our `Instance` handle dropped first, 5 (wgpu holds its own while a
/// device lives); the whole instance-device-queue dropped at the end of `main`, 0. That last one
/// is the correct lifecycle and it is the one shape unavailable here - there is no owner to drop
/// a `&'static`, and dropping it from `atexit` instead is *not* the same thing and still faulted 4
/// in 25. Leaving before the window opens at all is 30 in 30 clean.
///
/// **Only where cargo launched the process.** `_exit` skips the host's own handlers, and this
/// crate is a cdylib the server loads through Bun - taking Bun's exit away from it to spare a
/// test suite would be trading a real flush for a cosmetic one. `CARGO_MANIFEST_DIR` is set by
/// cargo in the environment of the binaries it runs and by nothing else, so a `cargo test`, a
/// `cargo run --example` and a bench are covered and a deployment is not. A test binary invoked
/// by hand is not covered either, and still faults; `bun run test:native` is the supported way to
/// run one.
///
/// **Linux only, on both counts.** `on_exit` is a glibc extension that no Apple or MSVC toolchain
/// carries, so asking for one there is `ld: symbol(s) not found` rather than a slower path - and
/// the driver being worked around is the Linux NVIDIA ICD.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod leave {
    use std::io::Write;

    pub(super) fn through_exit() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            if std::env::var_os("CARGO_MANIFEST_DIR").is_none() {
                return;
            }
            unsafe extern "C" {
                fn on_exit(
                    handler: extern "C" fn(i32, *mut core::ffi::c_void),
                    arg: *mut core::ffi::c_void,
                ) -> i32;
            }
            unsafe { on_exit(now, core::ptr::null_mut()) };
        });
    }

    /// `on_exit` rather than `atexit` for the status: a suite that failed has to keep saying so.
    extern "C" fn now(status: i32, _: *mut core::ffi::c_void) {
        unsafe extern "C" {
            fn _exit(status: i32) -> !;
        }
        // Nothing after this point flushes, and a harness's last line has no newline forcing it.
        let _ = std::io::stdout().flush();
        let _ = std::io::stderr().flush();
        unsafe { _exit(status) };
    }
}

/// The device [`page_device`] opened, or None before anything has opened one.
///
/// The decode's entry point opens it and then asks, so a browser reaches the same RCD and GALOSH a
/// server does. What stands in the way is the readback, not the device: a blocking `Device::poll`
/// is answered with `QueueEmpty` here without waiting for anything, so every stage goes through
/// [`read_back`] instead.
#[cfg(target_arch = "wasm32")]
pub fn device() -> Option<&'static Gpu> {
    PAGE.with(std::cell::Cell::get)
}

/// The most storage buffers one shader stage binds: what an Apple GPU offers a page, where
/// Windows, Linux and Android mostly offer sixteen. Every host asks for no more, so a kernel that
/// binds an eleventh is refused on the machine it was written on rather than on a Mac.
pub const MOST_STORAGE_BUFFERS: u32 = 10;

/// What this device asks for beyond the base, where the adapter has it and nothing where it does
/// not.
///
/// Asked for rather than required: a shader that wants `f16` says so with `enable f16`, and one
/// that does not is unaffected either way, so requesting it can only add. A device that refuses is
/// a device with no adapter, which is a different failure entirely.
///
/// The other three are one thing: PMRID's 1x1 convolutions on the matrix units ([`crate::pmrid`]).
/// WGSL cannot spell a cooperative matrix, so that kernel is handed to the driver in the driver's
/// own language - SPIR-V on Vulkan, MSL on Metal - and dispatched with its shape in immediate data,
/// and the whole arrangement is on *this* device rather than a second one, so the frame it filters
/// never leaves the card. A browser offers none of the three, which is what makes the editor's arm
/// the WGSL one.
fn asked_features(adapter: &wgpu::Adapter) -> wgpu::Features {
    adapter.features()
        & (wgpu::Features::SHADER_F16
            | wgpu::Features::EXPERIMENTAL_COOPERATIVE_MATRIX
            | wgpu::Features::PASSTHROUGH_SHADERS
            | wgpu::Features::IMMEDIATES)
}

/// The adapter's own limits, bar the storage buffers a stage binds ([`MOST_STORAGE_BUFFERS`]).
fn limits_of(adapter: &wgpu::Adapter) -> wgpu::Limits {
    let offered = adapter.limits();
    wgpu::Limits {
        max_storage_buffers_per_shader_stage: offered
            .max_storage_buffers_per_shader_stage
            .min(MOST_STORAGE_BUFFERS),
        ..offered
    }
}

/// The device this crate opens for the page, on the first call and once: the app's only one, which
/// its own WebGPU drawing borrows through [`Gpu::webgpu_device`]. None where the browser offers no
/// adapter, which is supported rather than fatal.
#[cfg(target_arch = "wasm32")]
pub async fn page_device() -> Option<&'static Gpu> {
    if let Some(open) = PAGE.with(std::cell::Cell::get) {
        return Some(open);
    }
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::BROWSER_WEBGPU,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions::default()).await.ok()?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("rawshim"),
            required_limits: limits_of(&adapter),
            required_features: asked_features(&adapter),
            ..Default::default()
        })
        .await
        .ok()?;

    // **Said, where the native device panics.** A validation error on this device - a pipeline the
    // backend would not build, a dispatch it would not run - makes the offending call a no-op and
    // otherwise changes nothing a caller can see: the chain runs on, every stage after the missing
    // one filters whatever the stage before it left, and what comes back is a photograph that is
    // confidently wrong. Nothing else in the browser is listening, so without this the only symptom
    // is the picture. Reported rather than fatal, because a tab that has drawn a frame is worth
    // more than a tab that has stopped.
    device.on_uncaptured_error(std::sync::Arc::new(|error| {
        let said = format!("rawshim gpu: the browser refused a command: {error}");
        crate::warn(&said);
        // Kept as well as logged, so the next tick can hand it to the page. A console line is
        // the only symptom otherwise, and the reader is looking at a canvas that is told `live`.
        REFUSED.with(|held| {
            let mut held = held.borrow_mut();
            if held.is_none() {
                *held = Some(said);
            }
        });
    }));

    // Leaked because wgpu's WebGPU handles are `Rc`s, so a `Gpu` cannot sit in a `static` the way
    // the native one does, and a tab's device is alive until the tab is not.
    let open: &'static Gpu =
        Box::leak(Box::new(Gpu::build(&adapter.get_info(), instance, device, queue)));
    PAGE.with(|held| held.set(Some(open)));
    Some(open)
}

#[cfg(target_arch = "wasm32")]
thread_local! {
    static PAGE: std::cell::Cell<Option<&'static Gpu>> = const { std::cell::Cell::new(None) };
    /// The first command the browser refused, until a caller takes it ([`refusal`]).
    static REFUSED: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// The first refusal since this was last asked, taken rather than read.
///
/// **Why a tick has to ask.** A validation error rejects nothing: the offending call returns, the
/// dispatch is dropped, and the chain runs on over whatever the stage before it left. So the page
/// is told `live` over a canvas that is black or confidently wrong, and the only thing that ever
/// said otherwise was a console line nobody is reading. Taken so the reader is told once.
#[cfg(target_arch = "wasm32")]
pub fn refusal() -> Option<String> {
    REFUSED.with(|held| held.borrow_mut().take())
}

/// One buffer's contents, on the host, and the buffer unmapped again.
///
/// **The one seam that has to be awaited, because a browser cannot block for a map.** wgpu's WebGPU
/// backend answers `Device::poll` with `QueueEmpty` without waiting for anything, so the blocking
/// spelling hands `get_mapped_range` a buffer whose `mapAsync` has not resolved and the tab throws.
/// Native still blocks inside the poll and this future never suspends there, which is what lets the
/// native entry points stay `pollster::block_on` around the same work they always did.
pub async fn read_back<T>(
    gpu: &Gpu,
    buffer: &wgpu::Buffer,
    take: impl FnOnce(&[u8]) -> T,
) -> Option<T> {
    let Some(()) = mapped(gpu, buffer).await else {
        eprintln!("rawshim: the device did not map a buffer for reading; the stage that asked declines");
        return None;
    };
    let out = take(&buffer.slice(..).get_mapped_range().ok()?);
    buffer.unmap();
    Some(out)
}

/// **wgpu frees nothing in a browser, so this crate holds no bare `wgpu` resource.**
///
/// `WebBuffer::drop` and `WebTexture::drop` are both `// no-op`, so a handle going out of scope
/// releases the Rust value and leaves the allocation to a garbage collector that cannot see its
/// size. `destroy` is the only release, and it is safe against work already submitted - the driver
/// schedules it against that submission rather than taking it from under it. Native wgpu-core frees
/// on the last reference either way, which is why no native suite can see the difference.
trait Release {
    fn release(&self);
}

impl Release for wgpu::Buffer {
    fn release(&self) {
        self.destroy();
    }
}

impl Release for wgpu::Texture {
    fn release(&self) {
        self.destroy();
    }
}

struct Held<T: Release> {
    resource: T,
    bytes: u64,
}

impl<T: Release> Drop for Held<T> {
    fn drop(&mut self) {
        self.resource.release();
        LIVE.fetch_sub(self.bytes, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Device memory this process is holding, as the handles above count it.
static LIVE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Bytes outstanding across every [`Buffer`] and [`Texture`] still held.
///
/// A count of what was asked for rather than of what the driver reserved: alignment, mip padding
/// and the heap's own overhead are not in it. Take it before and after a run and compare, rather
/// than reading it as a total.
pub fn live_bytes() -> u64 {
    LIVE.load(std::sync::atomic::Ordering::Relaxed)
}

fn counted<T: Release>(resource: T, bytes: u64) -> std::sync::Arc<Held<T>> {
    LIVE.fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
    std::sync::Arc::new(Held { resource, bytes })
}

/// What a texture descriptor asks the driver for, summed over its mip chain.
fn texture_bytes(descriptor: &wgpu::TextureDescriptor<'_>) -> u64 {
    // `block_copy_size` is None only for the depth-stencil formats, which nothing here allocates.
    let each = u64::from(descriptor.format.block_copy_size(None).unwrap_or(4));
    let layers = u64::from(descriptor.size.depth_or_array_layers);
    (0..descriptor.mip_level_count.max(1))
        .map(|level| {
            let wide = u64::from((descriptor.size.width >> level).max(1));
            let tall = u64::from((descriptor.size.height >> level).max(1));
            wide * tall * layers * each
        })
        .sum()
}

/// A buffer that is destroyed when the last handle to it goes.
///
/// Counted rather than plain-owned because the editor's frame is bound by an [`Uploaded`] that
/// outlives no particular scope: a `Drawing` holds the frame and the grade built over it side by
/// side, and neither may free what the other is still drawing from.
#[derive(Clone)]
pub struct Buffer(std::sync::Arc<Held<wgpu::Buffer>>);

impl std::ops::Deref for Buffer {
    type Target = wgpu::Buffer;

    fn deref(&self) -> &wgpu::Buffer {
        &self.0.resource
    }
}

/// The same for a texture, which is where the presence blur and the pyramid live.
#[derive(Clone)]
pub struct Texture(std::sync::Arc<Held<wgpu::Texture>>);

impl std::ops::Deref for Texture {
    type Target = wgpu::Texture;

    fn deref(&self) -> &wgpu::Texture {
        &self.0.resource
    }
}

impl Texture {
    pub fn view(&self) -> wgpu::TextureView {
        self.create_view(&wgpu::TextureViewDescriptor::default())
    }
}

/// The device, narrowed to the calls that allocate nothing, for the one-time pipeline builds.
pub struct Describing<'a>(&'a wgpu::Device);

impl Describing<'_> {
    pub fn create_shader_module(
        &self,
        descriptor: wgpu::ShaderModuleDescriptor<'_>,
    ) -> wgpu::ShaderModule {
        self.0.create_shader_module(descriptor)
    }

    /// # Safety
    ///
    /// Nothing checks the module: what it declares has to be what the pipeline layout it is built
    /// with says, and a mismatch is undefined rather than refused. For the one kernel WGSL cannot
    /// say ([`crate::pmrid`]'s cooperative matrices).
    #[expect(unsafe_code)]
    pub unsafe fn create_shader_module_passthrough(
        &self,
        descriptor: wgpu::ShaderModuleDescriptorPassthrough<'_>,
    ) -> wgpu::ShaderModule {
        // SAFETY: the caller's, and stated above.
        unsafe { self.0.create_shader_module_passthrough(descriptor) }
    }

    pub fn create_bind_group_layout(
        &self,
        descriptor: &wgpu::BindGroupLayoutDescriptor<'_>,
    ) -> wgpu::BindGroupLayout {
        self.0.create_bind_group_layout(descriptor)
    }

    pub fn create_pipeline_layout(
        &self,
        descriptor: &wgpu::PipelineLayoutDescriptor<'_>,
    ) -> wgpu::PipelineLayout {
        self.0.create_pipeline_layout(descriptor)
    }

    pub fn create_compute_pipeline(
        &self,
        descriptor: &wgpu::ComputePipelineDescriptor<'_>,
    ) -> wgpu::ComputePipeline {
        self.0.create_compute_pipeline(descriptor)
    }

    pub fn create_render_pipeline(
        &self,
        descriptor: &wgpu::RenderPipelineDescriptor<'_>,
    ) -> wgpu::RenderPipeline {
        self.0.create_render_pipeline(descriptor)
    }

    pub fn create_bind_group(
        &self,
        descriptor: &wgpu::BindGroupDescriptor<'_>,
    ) -> wgpu::BindGroup {
        self.0.create_bind_group(descriptor)
    }

    pub fn create_sampler(&self, descriptor: &wgpu::SamplerDescriptor<'_>) -> wgpu::Sampler {
        self.0.create_sampler(descriptor)
    }

    pub fn limits(&self) -> wgpu::Limits {
        self.0.limits()
    }

    pub fn features(&self) -> wgpu::Features {
        self.0.features()
    }
}

/// One submission and everything allocated to feed it.
///
/// A plane cannot be freed while unsubmitted work reads it - there is no way to submit but through
/// the recording that holds it - and cannot outlive the recording either, so an early return frees
/// what it abandoned.
pub struct Recording<'a> {
    gpu: &'a Gpu,
    encoder: Option<wgpu::CommandEncoder>,
    /// One handle per resource, so the counts stay above zero until this drops.
    held: Vec<Kept>,
}

/// A handle held for its count alone, which is why neither variant is ever read out again.
#[expect(dead_code)]
enum Kept {
    Buffer(Buffer),
    Texture(Texture),
}

impl<'a> Recording<'a> {
    pub fn buffer(&mut self, descriptor: &wgpu::BufferDescriptor<'_>) -> Buffer {
        let buffer = self.gpu.own_buffer(descriptor);
        self.held.push(Kept::Buffer(buffer.clone()));
        buffer
    }

    pub fn init(&mut self, descriptor: &wgpu::util::BufferInitDescriptor<'_>) -> Buffer {
        let buffer = self.gpu.own_buffer_init(descriptor);
        self.held.push(Kept::Buffer(buffer.clone()));
        buffer
    }

    pub fn texture(&mut self, descriptor: &wgpu::TextureDescriptor<'_>) -> Texture {
        let texture = self.gpu.own_texture(descriptor);
        self.held.push(Kept::Texture(texture.clone()));
        texture
    }

    /// Keeps a resource this submission reads but did not allocate, so the count cannot reach zero
    /// under it - a frame handed in by a caller that is about to drop its own handle.
    pub fn holding(&mut self, buffer: &Buffer) {
        self.held.push(Kept::Buffer(buffer.clone()));
    }

    pub fn holding_texture(&mut self, texture: &Texture) {
        self.held.push(Kept::Texture(texture.clone()));
    }

    pub fn encoder(&mut self) -> &mut wgpu::CommandEncoder {
        self.encoder
            .get_or_insert_with(|| self.gpu.device.create_command_encoder(&Default::default()))
    }

    /// Everything recorded so far, handed to the queue.
    ///
    /// A second one may be recorded after it: the resources stay until this whole value drops, so
    /// a stage that has to read a measurement back before recording the rest of itself does not
    /// need a second pool for the second half.
    pub fn submit(&mut self) {
        if let Some(encoder) = self.encoder.take() {
            self.gpu.queue.submit([encoder.finish()]);
        }
    }

    pub fn gpu(&self) -> &'a Gpu {
        self.gpu
    }
}

/// Everything submitted so far, finished.
///
/// **A stage that reads nothing back still has to end somewhere.** A tiled run that only submits
/// otherwise holds every tile's working planes against work the driver has not started, and at the
/// sizes GALOSH allocates that is a gigabyte a tile.
pub async fn finished(gpu: &Gpu) -> Option<()> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
        Some(())
    }
    #[cfg(target_arch = "wasm32")]
    {
        let (state, signal) = Signal::pair();
        gpu.queue.on_submitted_work_done(move || signal(true));
        let _ = gpu.device.poll(wgpu::PollType::Poll);
        state.await.then_some(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn mapped(gpu: &Gpu, buffer: &wgpu::Buffer) -> Option<()> {
    buffer.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).ok()?;
    Some(())
}

#[cfg(target_arch = "wasm32")]
async fn mapped(gpu: &Gpu, buffer: &wgpu::Buffer) -> Option<()> {
    let (state, signal) = Signal::pair();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| signal(result.is_ok()));
    // The queue still has to be told to make progress; here that returns at once and the browser
    // resolves the callback from its own event loop, which is what the await below yields to.
    gpu.nudge();
    state.await.then_some(())
}

/// A wgpu callback turned into something a future can wait on.
///
/// `Arc<Mutex<_>>` rather than the `Rc<RefCell<_>>` a single-threaded target would want, because
/// `Queue::on_submitted_work_done` asks for `Send` and there is one page's worth of contention on
/// it either way.
#[cfg(target_arch = "wasm32")]
struct Signal {
    answer: Option<bool>,
    waker: Option<std::task::Waker>,
}

#[cfg(target_arch = "wasm32")]
impl Signal {
    fn pair() -> (impl std::future::Future<Output = bool>, impl FnOnce(bool) + Send + 'static) {
        let state =
            std::sync::Arc::new(std::sync::Mutex::new(Signal { answer: None, waker: None }));
        let wrote = state.clone();
        let signal = move |answer: bool| {
            let mut wrote = wrote.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            wrote.answer = Some(answer);
            if let Some(waker) = wrote.waker.take() {
                waker.wake();
            }
        };
        let waited = std::future::poll_fn(move |context| {
            let mut state = state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            match state.answer {
                Some(answer) => std::task::Poll::Ready(answer),
                None => {
                    state.waker = Some(context.waker().clone());
                    std::task::Poll::Pending
                }
            }
        });
        (waited, signal)
    }
}

impl Gpu {
    pub(crate) fn print_light_calibration(&self, parameters: [f32; 4], temperature: f32) -> Buffer {
        let mut recording = self.record();
        let buffer = self.own_buffer(&wgpu::BufferDescriptor {
            label: Some("print light calibration"), size: 80,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false,
        });
        recording.holding(&buffer);
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print lamp"), contents: &crate::print::light_uniform(parameters, temperature),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print light calibration"), layout: &self.print_albedo_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&self.print_light_calibrate);
            pass.dispatch_workgroups(1, 1, 1);
        }
        recording.submit();
        buffer
    }

    pub(crate) fn print_albedo_table(&self, eta: f32) -> Buffer {
        let mut recording = self.record();
        let buffer = self.own_buffer(&wgpu::BufferDescriptor {
            label: Some("print directional albedo"),
            size: crate::print::ALBEDO_BYTES,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        recording.holding(&buffer);
        let values = [eta, 0.0, 0.0, 0.0].into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print material"), contents: &values, usage: wgpu::BufferUsages::UNIFORM,
        });
        let group = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print albedo"), layout: &self.print_albedo_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_bind_group(0, &group, &[]);
            pass.set_pipeline(&self.print_albedo_tabulate);
            pass.dispatch_workgroups(crate::print::ALBEDO_VIEWS.div_ceil(64), crate::print::ALBEDO_ROUGHNESSES, 1);
            pass.set_pipeline(&self.print_albedo_average);
            pass.dispatch_workgroups(crate::print::ALBEDO_ROUGHNESSES.div_ceil(64), 1, 1);
        }
        recording.submit();
        buffer
    }

    /// One submission, and the pool everything it reads is allocated from.
    pub fn record(&self) -> Recording<'_> {
        Recording { gpu: self, encoder: None, held: Vec::new() }
    }

    /// A buffer whose life is its own rather than a submission's: a frame, a mosaic, a pyramid.
    pub fn own_buffer(&self, descriptor: &wgpu::BufferDescriptor<'_>) -> Buffer {
        Buffer(counted(self.device.create_buffer(descriptor), descriptor.size))
    }

    pub fn own_buffer_init(
        &self,
        descriptor: &wgpu::util::BufferInitDescriptor<'_>,
    ) -> Buffer {
        use wgpu::util::DeviceExt;
        let buffer = self.device.create_buffer_init(descriptor);
        let bytes = buffer.size();
        Buffer(counted(buffer, bytes))
    }

    pub fn own_texture(&self, descriptor: &wgpu::TextureDescriptor<'_>) -> Texture {
        Texture(counted(self.device.create_texture(descriptor), texture_bytes(descriptor)))
    }

    pub fn own_texture_with_data(
        &self,
        descriptor: &wgpu::TextureDescriptor<'_>,
        order: wgpu::util::TextureDataOrder,
        data: &[u8],
    ) -> Texture {
        use wgpu::util::DeviceExt;
        Texture(counted(
            self.device.create_texture_with_data(&self.queue, descriptor, order, data),
            texture_bytes(descriptor),
        ))
    }

    pub fn bind_group(&self, descriptor: &wgpu::BindGroupDescriptor<'_>) -> wgpu::BindGroup {
        self.device.create_bind_group(descriptor)
    }

    pub fn describing(&self) -> Describing<'_> {
        Describing(&self.device)
    }

    pub fn limits(&self) -> wgpu::Limits {
        self.device.limits()
    }

    /// The browser's own `GPUDevice` under this one.
    #[cfg(target_arch = "wasm32")]
    pub fn webgpu_device(&self) -> Option<wasm_bindgen::JsValue> {
        self.device.as_webgpu().map(|device| device.clone().into())
    }

    pub fn nudge(&self) {
        self.device.poll(wgpu::PollType::Poll).ok();
    }

    /// Native only in practice: a browser cannot block for a map, which is why [`read_back`] exists
    /// in the shape it does.
    pub fn block_until_done(&self) {
        self.device.poll(wgpu::PollType::wait_indefinitely()).expect("the dispatch finished");
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn new() -> Option<Gpu> {
        /// The adapter `BOWERBIRD_ADAPTER` names, where it names one.
        ///
        /// **A machine's second GPU is not reachable by preference.** `HighPerformance` asks for
        /// the fastest and there is no option that asks for the other one, so a box with an
        /// integrated GPU beside a discrete card can only ever be measured on the card - and the
        /// two answer very differently, a small stage paying a round trip on the discrete part
        /// that shared memory does not charge. `scripts/bench.ts` records a table for each.
        ///
        /// Matched on the description this prints below, case-folded, so `radv`, `3080` or
        /// `IntegratedGpu` all reach one. A name that matches nothing **panics** rather than
        /// falling back: a run that silently measured the other GPU is a table of numbers filed
        /// under the wrong heading, which is worse than no table.
        fn asked_for(instance: &wgpu::Instance) -> Option<wgpu::Adapter> {
            let want = std::env::var("BOWERBIRD_ADAPTER").ok()?;
            let want = want.to_lowercase();
            let offered = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
            let described = |a: &wgpu::Adapter| {
                let i = a.get_info();
                format!("{} ({:?}, {:?}) via {}", i.name, i.device_type, i.backend, i.driver)
            };
            if let Some(found) = offered.iter().find(|a| described(a).to_lowercase().contains(&want))
            {
                return Some(found.clone());
            }
            panic!(
                "BOWERBIRD_ADAPTER={want} matches none of: {}",
                offered.iter().map(described).collect::<Vec<_>>().join("; "),
            );
        }

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::METAL,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        /// SwiftShader, and never lavapipe: lavapipe binds 128MiB of storage buffer and a 24MP
        /// frame is 144MB, so it would take a box with no GPU and fail on its first photograph
        /// rather than at startup.
        fn software(instance: &wgpu::Instance) -> Option<wgpu::Adapter> {
            let offered = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all()));
            let found = offered.into_iter().find(|a| a.get_info().name.contains("SwiftShader"));
            if found.is_none() {
                eprintln!(
                    "rawshim gpu: no hardware adapter and no SwiftShader; `bun run get:swiftshader` \
                     fetches it, and VK_ADD_DRIVER_FILES=native/rawshim/.swiftshader/vk_swiftshader_icd.json \
                     points Vulkan at it"
                );
            }
            found
        }

        // Hardware first, and software only if there is none. That path is very slow - it
        // is a CPU rasteriser running a shader written for a GPU - and it is here so such a
        // box imports slowly rather than not at all.
        let hardware = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }));
        let adapter = match asked_for(&instance) {
            Some(asked) => asked,
            None => match hardware {
                Ok(adapter) if adapter.get_info().device_type != wgpu::DeviceType::Cpu => adapter,
                _ => software(&instance)?,
            },
        };

        // **Said once, because which GPU this is decides how everything here performs and
        // nothing else reports it.** A machine can offer several - an integrated one with a
        // mature driver beside a discrete one reachable only through an immature or a software
        // stack - and `HighPerformance` above asks for the discrete card without knowing which
        // driver it will arrive through. A container that is missing a vendor's ICD gets the
        // fallback silently, and the only symptom is renders that take twice as long as the
        // same code on the same hardware outside it.
        {
            // Every candidate, not only the winner: a missing ICD and a rejected one look
            // identical from the chosen adapter alone, and they want opposite fixes.
            for offered in pollster::block_on(instance.enumerate_adapters(wgpu::Backends::all())) {
                let info = offered.get_info();
                eprintln!(
                    "rawshim gpu offered: {} ({:?}, {:?}) via {}",
                    info.name, info.device_type, info.backend, info.driver,
                );
            }
            let info = adapter.get_info();
            eprintln!(
                "rawshim gpu: {} ({:?}, {:?}) via {}",
                info.name, info.device_type, info.backend, info.driver,
            );
        }

        // The adapter's own limits, not `downlevel_defaults`. Those are WebGPU's portable
        // floor and cap a storage binding at 128MB, which a real frame is nowhere near
        // fitting: the frame and `counts` are six bytes a pixel each, so 144MB at 24MP and
        // 366MB at 61MP. The browser lives with that floor because it has to; a native
        // process has no reason to ask for less than the hardware offers, and asking for
        // less turns every full-size rendition into a validation failure.
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
                label: Some("rawshim"),
                required_limits: limits_of(&adapter),
                required_features: asked_features(&adapter),
                // The cooperative matrices are behind this and refused without it: wgpu calls a
                // feature experimental while it is the backends rather than the driver it does not
                // trust yet. Ours is one kernel, pinned against the WGSL arm that computes the same
                // network.
                #[expect(unsafe_code)]
                // SAFETY: the token is a statement that the caller knows the feature is
                // work in progress, which this comment is.
                experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() },
                ..Default::default()
            }))
            .inspect_err(|refused| eprintln!("rawshim gpu: no device: {refused}"))
            .ok()?;
        // A validation error here is a bug in the shader or in what is bound to it, and
        // both are ours. Left to the default handler it would print and continue, and the
        // frame would come back wrong rather than not at all.
        device.on_uncaptured_error(std::sync::Arc::new(|error| panic!("rawshim gpu: {error}")));

        Some(Gpu::build(&adapter.get_info(), instance, device, queue))
    }

    /// Everything a `Gpu` is once a device exists, which is all of it bar asking for one.
    ///
    /// Split out so that the browser's request - async, and on a backend that enumerates nothing -
    /// builds the *same* shaders, layouts and PQ table as the server's rather than a second set.
    fn build(
        info: &wgpu::AdapterInfo,
        instance: wgpu::Instance,
        device: wgpu::Device,
        queue: wgpu::Queue,
    ) -> Gpu {
        let adapter = format!("{} ({:?}, {:?})", info.name, info.backend, info.device_type);
        // Thirty-two apiece is 128 workgroups for a four-channel reduction, a couple per core on
        // the discrete parts this is for and still far more than a narrow one is short of.
        let reduction_slices = match info.device_type {
            wgpu::DeviceType::DiscreteGpu => 32,
            _ => 1,
        };
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("edit"),
            source: wgpu::ShaderSource::Wgsl(FRAME_WGSL.into()),
        });
        let peak_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("peak"),
            source: wgpu::ShaderSource::Wgsl(PEAK_WGSL.into()),
        });
        let group_layout = |label: &str, bindings: &[(u32, Binding)]| {
            let entries: Vec<_> =
                bindings.iter().map(|(binding, kind)| kind.entry(*binding)).collect();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(label),
                entries: &entries,
            })
        };
        let layout = group_layout("encode", &ENCODE_BINDINGS);
        let peak_layout = group_layout("peak", &PEAK_BINDINGS);
        let draw_layout = {
            let entries: Vec<_> =
                DRAW_BINDINGS.iter().map(|(binding, kind)| kind.drawn(*binding)).collect();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("draw"),
                entries: &entries,
            })
        };
        let compute = |label: &str,
                       module: &wgpu::ShaderModule,
                       group: &wgpu::BindGroupLayout,
                       entry_point: &str| {
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &[Some(group)],
                ..Default::default()
            });
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: Some(&pipeline_layout),
                module,
                entry_point: Some(entry_point),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let detail_shrink_layout = group_layout("detail shrink", &DETAIL_SHRINK_BINDINGS);
        let detail_moments_layout = group_layout("detail moments", &DETAIL_MOMENTS_BINDINGS);
        let detail_box_layout = group_layout("detail box", &DETAIL_BOX_BINDINGS);
        let detail_mean_layout = group_layout("detail fit", &DETAIL_MEAN_BINDINGS);
        let detail_apply_layout = group_layout("detail apply", &DETAIL_APPLY_BINDINGS);
        let detail_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("detail"),
            source: wgpu::ShaderSource::Wgsl(DETAIL_WGSL.into()),
        });
        let detail_shrink = compute("shrink", &detail_module, &detail_shrink_layout, "shrink");
        let detail_moments =
            compute("moments_of", &detail_module, &detail_moments_layout, "moments_of");
        let detail_coefficients =
            compute("coefficients", &detail_module, &detail_box_layout, "coefficients");
        let detail_window_mean =
            compute("window_mean", &detail_module, &detail_mean_layout, "window_mean");
        let detail_apply =
            compute("apply_guided", &detail_module, &detail_apply_layout, "apply_guided");

        let balance_layout = group_layout("balance", &BALANCE_BINDINGS);
        let balance_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("balance"),
            source: wgpu::ShaderSource::Wgsl(BALANCE_WGSL.into()),
        });
        let balance_pipeline =
            compute("balance", &balance_module, &balance_layout, "balance");

        let mean_layout = group_layout(
            "mean_frame",
            &[
                (1, Binding::Storage { read_only: true }),
                (12, Binding::Storage { read_only: true }),
                (19, Binding::Written),
                (20, Binding::Uniform),
            ],
        );
        let mean_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("mean_frame"),
            source: wgpu::ShaderSource::Wgsl(MEAN_FRAME_WGSL.into()),
        });
        let mean_pipeline = compute("mean_frame", &mean_module, &mean_layout, "mean");

        let chroma_model_layout = group_layout("chroma model", &CHROMA_MODEL_BINDINGS);
        let chroma_blur_layout = group_layout(
            "chroma blur",
            &[(20, Binding::Uniform), (22, Binding::Written), (23, Binding::Detail)],
        );
        let chroma_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("chroma_smooth"),
            source: wgpu::ShaderSource::Wgsl(CHROMA_SMOOTH_WGSL.into()),
        });
        let chroma_model = compute("chroma model", &chroma_module, &chroma_model_layout, "model");
        let chroma_blur = compute("chroma blur", &chroma_module, &chroma_blur_layout, "blur");

        let pipeline = compute("encode", &module, &layout, "encode");
        // The draw, which is `encode` over the same frame writing a canvas pixel instead of an
        // output one. Two pipelines over one entry point: `FROM_FRAME` is a specialisation
        // constant rather than a branch because as a branch it cost the zoomed-out case a third
        // of its time for a path those fragments never take (`frame.slang`).
        let print_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print"),
            entries: &[
                Binding::Uniform.drawn(0), Binding::Storage { read_only: true }.drawn(1),
                Binding::Storage { read_only: true }.drawn(2), Binding::Storage { read_only: true }.drawn(3),
            ],
        });
        let print_albedo_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("print albedo"),
            source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_albedo.wgsl")).into()),
        });
        let print_albedo_layout = group_layout("print albedo", &[
            (0, Binding::Uniform), (1, Binding::Storage { read_only: false }),
        ]);
        let print_albedo_tabulate = compute("print albedo", &print_albedo_module, &print_albedo_layout, "tabulate");
        let print_albedo_average = compute("print average albedo", &print_albedo_module, &print_albedo_layout, "average");
        let print_light_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("print lamp"),
            source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_light_calibrate.wgsl")).into()),
        });
        let print_light_calibrate = compute("print light calibration", &print_light_module, &print_albedo_layout, "calibrate");
        let drawing = |from_frame: bool, entry: &str| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("draw"),
                layout: Some(&device.create_pipeline_layout(
                    &wgpu::PipelineLayoutDescriptor {
                        label: Some("draw"),
                        bind_group_layouts: &if entry != "fs" && entry != "fs_print_pigment" {
                            vec![Some(&draw_layout), Some(&print_layout)]
                        } else {
                            vec![Some(&draw_layout)]
                        },
                        ..Default::default()
                    },
                )),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        // Keyed by the id `frame.slang`'s `[vk::constant_id(0)]` fixes, not by
                        // the name: the generated WGSL renames it `FROM_FRAME_0`, and a key that
                        // matched no constant is a pipeline the driver refuses outright.
                        constants: &[(FROM_FRAME_ID, f64::from(u8::from(from_frame)))],
                        ..Default::default()
                    },
                    targets: &[Some(if entry == "fs_print_pq" {
                        wgpu::TextureFormat::Rgba16Uint.into()
                    } else {
                        CANVAS_FORMAT.into()
                    })],
                }),
                primitive: Default::default(),
                depth_stencil: None,
                multisample: Default::default(),
                multiview_mask: Default::default(),
                cache: None,
            })
        };
        let draw_from_frame = drawing(true, "fs");
        let draw_from_pyramid = drawing(false, "fs");
        let print_pipeline = drawing(true, "fs_print");
        let print_pq_pipeline = drawing(true, "fs_print_pq");
        let print_pigment_pipeline = drawing(true, "fs_print_pigment");
        let print_flat_pipeline = drawing(true, "fs_print_flat");
        let print_surface = print_surface::Pipelines::new(&device);
        let peak_measure = compute("measure", &peak_module, &peak_layout, "measure");
        // The editor's route to the same number, so that it has one here to be held against:
        // `collect` keeps the brightest of the sampled million and `remeasure` grades only
        // those again, which is what lets a slider move without re-sweeping the frame. A
        // rendition is graded at one exposure and never asks twice, so nothing on that path
        // dispatches these - `the_kept_candidates_answer_as_the_whole_sample_does` is what does.
        let peak_collect = compute("collect", &peak_module, &peak_layout, "collect");
        let peak_remeasure = compute("remeasure", &peak_module, &peak_layout, "remeasure");
        let peak_quantile = compute("quantile", &peak_module, &peak_layout, "quantile");
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        // Filled by the shader rather than by `tone::pq_inv` and uploaded, so that the coding
        // the frame arrives in is undone by the same source the client undoes it with. There
        // is a Rust `pq_inv` and it is not this one's twin: this table is what the *grade*
        // reads, and the grade has one implementation on purpose (21.1).
        let nits_of_code = Buffer(counted(
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("nits_of_code"),
                size: PQ_CODES * 4,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            }),
            PQ_CODES * 4,
        ));
        let decode_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("decode"),
            source: wgpu::ShaderSource::Wgsl(DECODE_WGSL.into()),
        });
        let decode_layout = group_layout("decode", &[(12, Binding::Storage { read_only: false })]);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("decode"),
            layout: &decode_layout,
            entries: &[wgpu::BindGroupEntry { binding: 12, resource: nits_of_code.as_entire_binding() }],
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(&compute("pq_table", &decode_module, &decode_layout, "pq_table"));
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups((PQ_CODES / 64) as u32, 1, 1);
        }
        queue.submit([encoder.finish()]);

        Gpu {
            adapter,
            backend: info.backend,
            reduction_slices,
            device,
            queue,
            instance,
            layout,
            pipeline,
            draw_layout,
            draw_from_frame,
            draw_from_pyramid,
            print_layout,
            print_pipeline,
            print_pq_pipeline,
            print_pigment_pipeline,
            print_flat_pipeline,
            print_surface,
            print_albedo_layout,
            print_albedo_tabulate,
            print_albedo_average,
            print_light_calibrate,
            peak_layout,
            peak_measure,
            peak_collect,
            peak_remeasure,
            peak_quantile,
            detail_shrink_layout,
            detail_moments_layout,
            detail_box_layout,
            detail_mean_layout,
            detail_apply_layout,
            detail_shrink,
            detail_moments,
            detail_coefficients,
            detail_window_mean,
            detail_apply,
            balance_layout,
            balance_pipeline,
            mean_layout,
            mean_pipeline,
            chroma_model_layout,
            chroma_blur_layout,
            chroma_model,
            chroma_blur,
            sampler,
            nits_of_code,
        }
    }

    /// The largest binding one frame needs: `encode`'s output, two `u16` components to a
    /// word, rounded up to the three whole words an invocation writes for its two pixels.
    fn binding_bytes(pixels: usize) -> u64 {
        (pixels.div_ceil(2) * 3 * 4) as u64
    }

    /// Drain the queue, so that a lap taken next times what the GPU did rather than what was recorded.
///
/// **Only where something is reading the laps**, which is a profile run or the benchmark: this is a
/// stall on the render path and buys a reader nothing the total does not already say. The stages it
/// separates are sequential anyway - each reads what the one before it wrote - so waiting between
/// them gives up little beyond the driver's own pipelining of submissions.
///
/// Without it a stage that only *records* passes reports the recording. On a 61MP rendition the
/// coding, the defringe and the warp reported 3.4ms between them while the grade reported 421,
/// because the grade's readback was the first thing in the job to wait on the queue - so three
/// hundred milliseconds of real work sat under the wrong name and every attempt to find it went
/// looking inside the grade's shader.
    pub fn settle(&self) {
        if !crate::clock::watched() {
            return;
        }
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }

/// The workgroups `encode` wants for a frame of this many pixels, as a 2D grid.
    ///
    /// Two dimensions because one is not enough: an invocation covers two pixels and a
    /// workgroup 64 of them, so a 61MP frame wants 476k of them against the 65535 a single
    /// dimension allows.
    fn encode_groups(&self, pixels: usize) -> (u32, u32) {
        crate::base::groups(pixels.div_ceil(2))
    }

    /// Whether a frame of this many pixels fits the adapter in one dispatch.
    ///
    /// Asked rather than assumed because the answer is a hardware limit and the frames are
    /// large: 137MiB of output at 24MP, 349MiB at 61MP. One question covers both bindings now
    /// that the output is packed - six bytes a pixel is exactly what the frame takes - where a
    /// `u32` per component made the output the larger of the two and this the only one asked
    /// about.
    ///
    /// **Measured, it does not bite on real hardware.** RADV on an integrated Radeon
    /// reports 2047MiB for both `max_storage_buffer_binding_size` and `max_buffer_size`,
    /// which is six times what the largest sensor here needs. So the banding this would
    /// otherwise force is unwritten on purpose - it would be complexity for a case no
    /// machine with a GPU reaches. Where it could bite is the software adapter, which is
    /// already the path that is very slow and not expected to be hit.
    ///
    /// A caller that gets `false` therefore has to band the frame or grade it another way;
    /// what it must not do is dispatch and find out, since a binding over the limit is a
    /// validation error and `on_uncaptured_error` makes those fatal.
    pub fn fits(&self, pixels: usize) -> bool {
        let limits = self.device.limits();
        let needed = Self::binding_bytes(pixels);
        needed <= u64::from(limits.max_storage_buffer_binding_size) && needed <= limits.max_buffer_size
    }
}

/// What `encodeLayout` names on the client, in one list so the layout and the bind group
/// cannot drift apart.
const ENCODE_BINDINGS: [(u32, Binding); 17] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (5, Binding::Storage { read_only: true }),
    (6, Binding::Storage { read_only: false }),
    (7, Binding::Sampler),
    (9, Binding::Pyramid),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
];

/// `drawLayout` on the client: `ENCODE_BINDINGS` without the buffer the encode writes, and seen by
/// the fragment stage rather than by a compute one.
const DRAW_BINDINGS: [(u32, Binding); 16] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (5, Binding::Storage { read_only: true }),
    (7, Binding::Sampler),
    (9, Binding::Pyramid),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
];

/// What the canvas holds, and what a native draw renders into: extended-range float, because the
/// values the fragment shader writes are display nits over an SDR white and go past one.
const CANVAS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

/// The gamut and the tone mapping every canvas the editor draws on is configured with.
///
/// **One constant because there is more than one canvas**: the stage and the loupe, and a
/// magnifier that tone mapped differently from the picture under it is the one fault a loupe
/// cannot have. `ExtendedDisplayP3` is wgpu's spelling of `colorSpace: "display-p3"` with
/// `toneMapping: { mode: "extended" }` - values past one reach the panel rather than being
/// clamped, and the gamut is the wide one (§7).
///
/// Read by [`Stage::resize`], so only in a browser: there is no canvas on this side to configure.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
const CANVAS_COLOR_SPACE: wgpu::SurfaceColorSpace = wgpu::SurfaceColorSpace::ExtendedDisplayP3;

/// The editor's canvas, as a surface on the device that prepared the frame.
///
/// **This is what keeps the frame on the GPU.** A `GPUDevice` does not cross a worker boundary and
/// a texture does not cross one either, so a canvas owned by the page and a frame owned by this
/// module could only meet through the host - the frame down into wasm memory, across as bytes, and
/// up again into a second device's buffer, every open. Handed the canvas instead
/// ([`crate::wasm::Editor::attach_stage`]), the draw is one more pass on the queue that already holds the
/// prepare, and nothing is read back at all.
///
/// `ExtendedDisplayP3` is `colorSpace: "display-p3"` with `toneMapping: { mode: "extended" }`,
/// which is what the page configured its context with and what §7 measured: values past one reach
/// the panel rather than being clamped, and the gamut is the wide one.
#[cfg(target_arch = "wasm32")]
pub struct Stage {
    surface: wgpu::Surface<'static>,
    width: u32,
    height: u32,
}

#[cfg(target_arch = "wasm32")]
impl Stage {
    /// Takes a canvas the page transferred into this worker, at the size it is already sized to.
    ///
    /// None where the browser refuses a surface on it, which is a tab that shows no picture rather
    /// than one that fails: the caller says so and the editor stays closed.
    pub fn attach(
        gpu: &'static Gpu,
        canvas: web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Option<Stage> {
        let surface = gpu
            .instance
            .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas))
            .ok()?;
        let mut held = Stage { surface, width: 0, height: 0 };
        held.resize(gpu, width, height);
        Some(held)
    }

    /// The backing store the reader's box asks for, which changes with the stage and the density.
    ///
    /// Configured rather than merely resized: a WebGPU canvas has no separate resize, and the
    /// dimensions are members of the configuration itself.
    pub fn resize(&mut self, gpu: &Gpu, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        if (width, height) == (self.width, self.height) {
            return;
        }
        self.surface.configure(
            &gpu.device,
            &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                format: CANVAS_FORMAT,
                color_space: CANVAS_COLOR_SPACE,
                width,
                height,
                present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 2,
                alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                view_formats: Vec::new(),
            },
        );
        (self.width, self.height) = (width, height);
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }
}

/// One tick, onto the image the canvas handed over.
///
/// **Nothing comes back.** The draw writes the swapchain's own texture and presents it, so a tick
/// is a uniform write, a pass and a submit - where the page's copy of this had to have the graded
/// frame in a buffer of its own first.
#[cfg(target_arch = "wasm32")]
pub fn present(
    uploaded: &Uploaded<'_>,
    stage: &Stage,
    grade: &Grade<'_>,
    pyramid: &crate::base::Pyramid,
    print: Option<&crate::print::Scene>,
) {
    use wgpu::CurrentSurfaceTexture::{Success, Suboptimal};
    // Suboptimal draws too: the image is the right one and only its configuration has drifted,
    // which the next `resize` settles. Everything else - a timeout, an occluded tab, a canvas
    // resized under the surface - skips this tick rather than drawing a stale image.
    let (Success(image) | Suboptimal(image)) = stage.surface.get_current_texture() else {
        return;
    };
    let target = image.texture.create_view(&Default::default());
    let mut recording = uploaded.gpu.record();
    uploaded.draw_into(&mut recording, grade, pyramid, &target, print, false);
    recording.submit();
    uploaded.gpu.queue.present(image);
}

/// `white_balance.slang`, which writes the matrix everything above reads.
const BALANCE_BINDINGS: [(u32, Binding); 2] =
    [(0, Binding::Uniform), (14, Binding::Storage { read_only: false })];

/// `detail.slang`'s four entry-point shapes, on layouts of their own: the downscale reads the
/// frame and the decode table, the moments read the working texture, the box means and the fit
/// read only the 32-bit texture before them, and the last reads both.
const DETAIL_SHRINK_BINDINGS: [(u32, Binding); 4] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (3, Binding::Written),
    (12, Binding::Storage { read_only: true }),
];

/// The order the guided filter's entry points run in.
///
/// A different order, or one box mean where it ran two, is a different neighbourhood from the same
/// frame - and nothing in the graded fixtures could see it, since those are pinned at every slider
/// zero where `adjusted` returns before it samples this texture at all. So it is stated as data
/// and pinned by `test/fixtures/tables/detail-passes.txt`, which makes a reordering deliberate.
///
/// The ping-pong between the two 32-bit textures is derived from this rather than written out:
/// every pass reads what the one before it wrote.
pub const DETAIL_PASSES: [&str; 6] = [
    "shrink",
    "moments_of",
    // Both means, and both bilateral: gathering the moments over a box and averaging the fitted
    // models over a box are the two ways a dark surface's statistics reach the bright pixels
    // beside it, which is a halo (`detail.slang`).
    "window_mean",
    "coefficients",
    "window_mean",
    "apply_guided",
];

const DETAIL_MOMENTS_BINDINGS: [(u32, Binding); 2] = [(2, Binding::Detail), (16, Binding::Wrote32)];

const DETAIL_BOX_BINDINGS: [(u32, Binding); 2] = [(15, Binding::Read32), (16, Binding::Wrote32)];

/// The uniform as well, for `detail_long`: the fine reference's sigma is a fraction of the
/// *photograph's* working texture and this pass may be writing a piece of one.
const DETAIL_APPLY_BINDINGS: [(u32, Binding); 4] =
    [(0, Binding::Uniform), (2, Binding::Detail), (15, Binding::Read32), (3, Binding::Written)];

/// The mean, which needs the guide as well as what it is averaging: it has to know which taps
/// describe the same surface as the texel it is writing. And the uniform, for the window's own
/// width, which is `detail_long`'s to say for the same reason.
const DETAIL_MEAN_BINDINGS: [(u32, Binding); 4] =
    [(0, Binding::Uniform), (2, Binding::Detail), (15, Binding::Read32), (16, Binding::Wrote32)];

/// The same colour bindings the encode takes, and the histogram, the peak and the candidates all
/// writable where the encode reads the peak and writes only the frame.
/// What the model pass binds of an upload, before the `Uploaded` that owns them exists.
struct ChromaModelInputs<'a> {
    matrix: &'a wgpu::Buffer,
    curves: &'a wgpu::TextureView,
    chroma: &'a wgpu::TextureView,
    chroma_luma: &'a wgpu::TextureView,
    chroma_tint: &'a wgpu::TextureView,
    surround: &'a wgpu::TextureView,
    mean: &'a wgpu::TextureView,
    detail: &'a wgpu::TextureView,
}

/// What `chroma_smooth.slang`'s model pass reads: the colour transform's own set, and the
/// texture it writes.
const CHROMA_MODEL_BINDINGS: [(u32, Binding); 15] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (7, Binding::Sampler),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
    (22, Binding::Written),
];

const PEAK_BINDINGS: [(u32, Binding); 17] = [
    (0, Binding::Uniform),
    (1, Binding::Storage { read_only: true }),
    (2, Binding::Curves),
    (3, Binding::Volume),
    (4, Binding::Storage { read_only: true }),
    (5, Binding::Storage { read_only: false }),
    (6, Binding::Storage { read_only: false }),
    (7, Binding::Sampler),
    (8, Binding::Storage { read_only: false }),
    (10, Binding::Volume),
    (11, Binding::Volume),
    (12, Binding::Storage { read_only: true }),
    (13, Binding::Detail),
    (14, Binding::Storage { read_only: true }),
    (17, Binding::Detail),
    (19, Binding::Detail),
    (21, Binding::Detail),
];

/// `BINS` in `peak.slang`, which this sizes the buffer for.
const PEAK_BINS: u64 = 8192;

/// `CANDIDATES` in `peak.slang`, likewise.
const PEAK_CANDIDATES: u64 = 16384;

#[derive(Clone, Copy)]
enum Binding {
    Uniform,
    Storage { read_only: bool },
    /// `r32float`, which without `float32-filterable` is unfilterable - and is only ever
    /// loaded, never sampled.
    Curves,
    Volume,
    Sampler,
    /// Declared by `frame.slang` and unread at `lod` 0, but an explicit layout has to supply
    /// everything the module declares.
    Pyramid,
    /// `detail.slang`'s output: the fine reference in stops, then the smooth fit's `a` and `b`
    /// for the grade to evaluate against the pixel's own luma, then the guided-filtered dark
    /// channel. Filterable, because the grade samples it at a frame coordinate rather than a
    /// texel of it - and because interpolating that pair is what a guided filter upsamples with.
    Detail,
    /// The same texture where a pass is writing it.
    Written,
    /// The guided filter's moments and coefficients. `rgba32float`, which is unfilterable
    /// wherever it is read - and it is only ever loaded, never sampled.
    Read32,
    Wrote32,
}

impl Binding {
    const fn entry(self, binding: u32) -> wgpu::BindGroupLayoutEntry {
        self.seen_by(binding, wgpu::ShaderStages::COMPUTE)
    }

    /// The same binding for the draw, whose only difference from the encode is the stage that
    /// reads it.
    const fn drawn(self, binding: u32) -> wgpu::BindGroupLayoutEntry {
        self.seen_by(binding, wgpu::ShaderStages::FRAGMENT)
    }

    const fn seen_by(
        self,
        binding: u32,
        visibility: wgpu::ShaderStages,
    ) -> wgpu::BindGroupLayoutEntry {
        let ty = match self {
            Binding::Uniform => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            Binding::Storage { read_only } => wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            Binding::Curves => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Volume => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D3,
                multisampled: false,
            },
            Binding::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            Binding::Pyramid => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Uint,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Detail => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Written => wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba16Float,
                view_dimension: wgpu::TextureViewDimension::D2,
            },
            Binding::Read32 => wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            Binding::Wrote32 => wgpu::BindingType::StorageTexture {
                access: wgpu::StorageTextureAccess::WriteOnly,
                format: wgpu::TextureFormat::Rgba32Float,
                view_dimension: wgpu::TextureViewDimension::D2,
            },
        };
        wgpu::BindGroupLayoutEntry { binding, visibility, ty, count: None }
    }
}

/// Everything a grade needs that is not the frame itself.
pub struct Grade<'a> {
    pub width: usize,
    pub height: usize,
    /// The long edge of the *photograph* this frame is a piece of, which is its own for every
    /// caller but the loupe's tile.
    ///
    /// Only the presence sliders read it, through the working texture `detail.slang` blurs on: how
    /// large a share of the picture that blur covers is a property of the photograph, and a crop
    /// left to answer it from its own dimensions applies a different Clarity from the export.
    pub photograph_long: crate::px::Span<crate::px::Output>,
    pub colour: Option<&'a HdrColour>,
    /// `tone::Levels`, as the uniform's `white`, `source_level` and `black_floor`.
    pub white: crate::light::Light<crate::light::Level>,
    pub source_level: crate::light::Light<crate::light::Level>,
    /// None where nothing walked a histogram for this frame, and then `adjust.slang` places the low
    /// pair at their deepest - which is where a photograph with real black in it puts them anyway.
    pub floor: Option<crate::light::Light<crate::light::Level>>,
    /// What diffuse white is anchored to, which is the divisor between the scene's nits and the
    /// scene-relative units the fit and the sliders are written in.
    pub reference_nits: crate::light::Light<crate::light::SceneNits>,
    /// Where this target's highlights roll into, which is `job::peak_nits` and not the library's
    /// mastering peak: an SDR target's sits at diffuse white.
    pub peak_nits: crate::light::Light<crate::light::DisplayNits>,
    pub exposure: crate::light::Stops,
    /// The reader's own sliders, on Camera Raw's -100..100 scales. All zero is unedited.
    pub adjust: Adjust,
    /// The illuminant the camera balanced this frame for, which is the baseline the reader's
    /// temperature and tint move away from. None where the file recorded no usable
    /// multipliers, in which case there is nothing to move relative to and the pair is ignored.
    pub as_shot: Option<crate::white_balance::AsShot>,
    /// Which transfer to write. The grade is the same either way; an SDR target differs by
    /// having its `peak_nits` at diffuse white (`job::peak_nits`) and by ending here.
    pub output: Output,
    /// The reader's crop, straighten and quarter turn, applied in the same dispatch as the grade.
    ///
    /// **Where a rendition applies it too, and that is what makes the two hosts one pipeline.** The
    /// editor has never had a choice - a reader dragging a crop handle would otherwise re-prepare
    /// the frame on every frame - so this is the draw's own mapping (`geometry.slang`), and a
    /// rendition reaching it through the same uniform is the same picture rather than a second
    /// route that agrees.
    pub geometry: crate::image::Geometry,
    /// Where the frame above sits in the photograph, when it is only a piece of one.
    ///
    /// **None is the whole picture**, which is the editor and every rendition that had no crop to
    /// decode less of - so the common case says nothing rather than repeating the frame's own size.
    pub window: Option<Window>,
    /// Where this frame sits in the photograph for the surround thumb alone: a loupe
    /// tile applies no geometry - `window` stays `None` there - but the thumb is the
    /// photograph's and has to be read in its UV. `None` falls back to `window`, then to
    /// the frame being the whole picture.
    pub surround_window: Option<Window>,
    /// What a draw is showing, where this grade is being drawn rather than encoded.
    ///
    /// None everywhere a rendition runs - `encode` reads none of these fields - and the words go
    /// out as zeroes there.
    pub canvas: Option<Canvas>,
    /// How an sRGB output or a print is brought inside its gamut. A PQ draw rolls off to its
    /// display and never looks at this.
    pub intent: Intent,
    /// How far one printed mark reaches (`print::Scene::ink_blur`); zero everywhere but a print.
    pub print_blur: crate::px::Extent<crate::px::Output>,
}

/// How a picture is brought inside what its target can show, as ICC's rendering intents promise.
/// `gamut_map.slang` reads these by number.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    /// The whole range compressed, highlights rolled and the gamut's edge approached through a
    /// knee, so gradients survive.
    #[default]
    Perceptual,
    /// Every colour the target can show left exactly, and the rest clipped to its edge.
    RelativeColorimetric,
}

/// The reader's view: which rectangle of the output is on screen, and how large the screen is.
///
/// **The only thing that differs between the editor's draw and a rendition's dispatch.** Both run
/// `frame.slang` over the same frame through the same geometry; a rendition writes one output pixel
/// per output pixel, and a draw writes one per *canvas* pixel and averages whatever falls inside it
/// (`covered`). So zoom and pan are these four numbers rather than another route through the grade.
#[derive(Clone, Copy)]
pub struct Canvas {
    /// The window on the output, in output pixels: what pan and zoom move.
    pub region: (f64, f64, f64, f64),
    /// The canvas itself, in its own pixels - the browser's, which are neither the frame's nor the
    /// output's however the two happen to compare at one zoom.
    pub size: crate::px::Size<crate::px::Canvas>,
    /// How deep the pyramid bound with it goes. Zero draws from the frame's buffer whatever the
    /// ratio, which is what a tile does: it is only ever magnified.
    pub max_lod: u32,
}

/// A frame that is a window on a larger photograph, for the geometry's sake.
///
/// The crop fractions and the straighten are defined over the *photograph*, so a render that let
/// its crop restrict the decode has to say what the photograph was and where its buffer starts in
/// it. `geometry.slang` reads both, and takes the origin off after the mapping rather than before -
/// `warp.slang`'s `Params::centre` says what folding those together costs.
/// **Both in the pixels of the frame being graded**, which at `Scale::Half` are not the
/// photograph's. Handing this the unhalved photograph while the buffer beside it was halved put
/// the crop's fractions over a picture twice the size of the one they were fractions of.
#[derive(Clone, Copy)]
pub struct Window {
    pub photograph: crate::px::Size<crate::px::Drawn>,
    pub origin: crate::px::At<crate::px::Drawn>,
}

impl<'a> Grade<'a> {
    /// A whole `width` by `height` frame graded as it stands: no colour match, no edits, upright,
    /// written as PQ, and drawn nowhere.
    pub fn new(
        width: usize,
        height: usize,
        levels: crate::tone::Levels,
        reference_nits: crate::light::Light<crate::light::SceneNits>,
        peak_nits: crate::light::Light<crate::light::DisplayNits>,
    ) -> Grade<'a> {
        Grade {
            width,
            height,
            photograph_long: crate::px::Span::measured(width.max(height)),
            colour: None,
            white: levels.white,
            source_level: levels.peak,
            floor: levels.floor,
            reference_nits,
            peak_nits,
            exposure: crate::light::Stops::ZERO,
            adjust: Adjust::none(),
            as_shot: None,
            output: Output::Pq,
            geometry: crate::image::Geometry::none(),
            window: None,
            surround_window: None,
            canvas: None,
            intent: Intent::Perceptual,
            print_blur: crate::px::Extent::measured(0.0),
        }
    }

    /// The same grade showing the reader's crop, straighten and turn.
    pub fn showing(self, geometry: crate::image::Geometry) -> Grade<'a> {
        Grade { geometry, ..self }
    }

    /// The same grade over a frame that is a *piece* of `photograph`.
    ///
    /// **The one place a piece takes the whole picture's scale.** `detail.slang` blurs at a fraction
    /// of the photograph's long edge, so a frame answering that from its own dimensions applies a
    /// Clarity the export never does - twelve times finer, for a loupe tile. Three callers need the
    /// rule and each spelled it, which is one rule too many for something that fails as a
    /// photograph rather than as an error.
    pub fn within(self, photograph: (usize, usize)) -> Grade<'a> {
        Grade {
            photograph_long: crate::px::Span::measured(photograph.0.max(photograph.1)),
            ..self
        }
    }

    /// The same grade, drawn onto a canvas: what a tick is, against what an encode is.
    pub fn onto(self, canvas: Canvas) -> Grade<'a> {
        Grade { canvas: Some(canvas), ..self }
    }

    /// The same grade over a window on a larger photograph, which the geometry reads across.
    ///
    /// Takes the blur's scale with it: a window is a piece by definition. A loupe tile is a piece
    /// too and does *not* come through here - it applies no geometry, so `geometry_at` has to stay
    /// the identity over its buffer - which is why [`Grade::within`] is separable.
    pub fn windowed(
        self,
        photograph: crate::px::Size<crate::px::Drawn>,
        origin: crate::px::At<crate::px::Drawn>,
    ) -> Grade<'a> {
        Grade {
            window: Some(Window { photograph, origin }),
            ..self.within(photograph.raw())
        }
    }

    /// The photograph this frame is of, which is its own unless a crop cut the decode down.
    pub fn photograph(&self) -> (usize, usize) {
        self.window.map_or((self.width, self.height), |w| w.photograph.raw())
    }

    /// The same grade with the surround thumb read at this frame's place in the
    /// photograph - the loupe tile's half of [`Grade::windowed`], which it cannot use
    /// because a tile applies no geometry.
    pub fn surrounded(
        self,
        photograph: crate::px::Size<crate::px::Drawn>,
        origin: crate::px::At<crate::px::Drawn>,
    ) -> Grade<'a> {
        Grade { surround_window: Some(Window { photograph, origin }), ..self }
    }

    /// What this grade writes: the photograph, through the geometry.
    ///
    /// **Its own space, not a rectangle of the frame.** A straighten's bounding box can exceed the
    /// frame it was cut from, so a caller sizing a buffer or a dispatch off `width`/`height`
    /// instead of this under-allocates and writes a picture with an unwritten tail.
    pub fn output(&self) -> crate::px::Size<crate::px::Output> {
        let (width, height) = self.photograph();
        crate::hdr::cropped_out(crate::px::Size::exact(width, height), self.geometry)
    }

    /// The same, as the two numbers a dispatch and a buffer size want.
    pub fn output_size(&self) -> (usize, usize) {
        self.output().raw()
    }
}

/// Every slider but the exposure, as `adjust.slang` reads them.
///
/// Its own type rather than ten fields on [`Grade`] because they travel together from the
/// stored document all the way to the uniform, and a caller that has none of them says so
/// once with [`Adjust::none`] rather than ten times.
///
/// The last three are the presence group, which read the blur `detail.slang` builds rather
/// than the pixel alone. They are terms in the same function as the rest - what the blur
/// costs is a pass at upload, not a second grade.
#[derive(Clone, Copy, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Adjust {
    pub contrast: f64,
    pub highlights: f64,
    pub shadows: f64,
    pub whites: f64,
    pub blacks: f64,
    pub vibrance: f64,
    /// `sat_adjust` in the shader: `saturation` there is the camera match's own multiplier.
    pub saturation: f64,
    /// `texture_adjust` in the shader, where a member called `texture` would read as a type.
    pub texture: f64,
    pub clarity: f64,
    pub dehaze: f64,
    /// The illuminant the reader asked for, or None for the one the camera chose.
    ///
    /// None rather than the as-shot numbers because the *document* stores null there, and it
    /// has to: an edit that recorded 5500K would mean a different picture on a frame whose
    /// camera metered 3200, where "as shot" means the same thing on every one.
    pub temperature: Option<f64>,
    pub tint: Option<f64>,
    pub colour_profile: ColourProfile,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColourProfile {
    #[default]
    Matched,
    None,
}

impl Adjust {
    /// The picture as the camera rendered it, which is what an unedited photo asks for.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn colour<'a>(&self, matched: Option<&'a HdrColour>) -> Option<&'a HdrColour> {
        matched.filter(|_| self.colour_profile == ColourProfile::Matched)
    }

    /// Whether any slider reads the neighbourhood, and so whether `detail` has to be built.
    ///
    /// **`adjust.slang`'s `local`, and it has to stay that**: the shader samples the texture only
    /// under this test, and the host builds it only under this test, so a slider added to one and
    /// not the other is either a blur nothing reads or a read of a blur nobody built.
    /// `the_detail_pass_runs_exactly_when_the_shader_reads_it` holds the two together.
    ///
    /// Not just the presence three: `tone_adjusted` weights highlights and shadows by how bright
    /// the region is rather than the pixel, so those read it too.
    pub fn reads_the_neighbourhood(&self) -> bool {
        self.texture != 0.0
            || self.clarity != 0.0
            || self.dehaze != 0.0
            || self.highlights != 0.0
            || self.shadows != 0.0
    }
}

/// The rectangle of the output a tick draws, as the page names it: zoom and pan, in output pixels.
#[derive(Clone, Copy, serde::Deserialize)]
pub struct Region {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `edit.output` in the shader, whose values these must match.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Output {
    /// Rec.2020 at 16 bits of PQ.
    Pq,
    /// sRGB primaries and transfer at 8 bits, in the low byte of each `u32`.
    Srgb,
    /// The rolled frame, before any transfer - what the CPU's grade produced and what every
    /// rendition path already encodes for itself.
    Rolled,
}

/// One frame, uploaded once, ready for as many dispatches as a job has outputs.
///
/// **Everything here is per photo-and-size; only the uniform is per rendition.** The frame
/// itself is the expensive part - 59MB at 3840 and 366MB at native resolution - and a job
/// naming an SDR and an HDR target of one size was uploading it, the lattice, the curves and
/// the matrix once each, then allocating a fresh output and readback pair, for every one of
/// them. What actually differs between two outputs of the same frame is `peak_nits` and
/// `output`, which are two words of a uniform.
/// The pair a balance is solved from, as the key to anything derived from one.
///
/// The reader's half of it: what the frame was shot at is the upload's own and cannot move.
#[derive(Clone, Copy, PartialEq)]
struct Illuminant {
    temperature: Option<f64>,
    tint: Option<f64>,
}

impl Illuminant {
    fn of(grade: &Grade<'_>) -> Self {
        Self { temperature: grade.adjust.temperature, tint: grade.adjust.tint }
    }
}

pub struct Uploaded<'a> {
    gpu: &'a Gpu,
    print_albedo: std::cell::RefCell<Option<(f32, Buffer)>>,
    print_light: std::cell::RefCell<Option<([f32; 4], f32, Buffer)>>,
    printer: std::cell::RefCell<Option<std::sync::Arc<crate::printer_gamut::PrinterGamut>>>,
    print_surface: std::cell::RefCell<print_surface::Cached>,
    peak_revision: std::sync::Arc<std::sync::atomic::AtomicU64>,
    peak_cached: std::cell::RefCell<Option<(u64, Vec<u32>)>>,
    width: usize,
    height: usize,
    /// For the editor this is the `Resident`'s own frame, shared rather than copied.
    samples: Buffer,
    matrix: Buffer,
    peak_out: Buffer,
    histogram: Buffer,
    candidates: Buffer,
    curves: wgpu::TextureView,
    chroma: wgpu::TextureView,
    chroma_luma: wgpu::TextureView,
    chroma_tint: wgpu::TextureView,
    surround: wgpu::TextureView,
    mean: wgpu::TextureView,
    /// The camera's own chroma blur, and the illuminant it was built under.
    ///
    /// **Rebuilt when the reader moves the balance, because it encodes `matched_scene` and the
    /// balance is now upstream of that.** The blend in `colour.slang` replaces a pixel's chroma
    /// with this neighbourhood's, so a texture built at one illuminant and read at another does
    /// not merely age - it puts the old colour back, and the temperature slider does nothing at
    /// all. That is the editor exactly: it uploads once at `Adjust::none()` and grades every tick
    /// off that upload, where a rendition uploads with the edit already in hand and so never sees
    /// it. Measured at 2000K on a daylight frame: the tick came out 3851, 3746, 3916 against the
    /// rendition's 1441, 3749, 27156.
    ///
    /// The texture rides with the view so that replacing the pair drops the generation it
    /// replaces. Kept to one: a temperature drag rebuilds per distinct value, and a list of them
    /// would hold ~5MB a tick until the whole upload went.
    chroma_smoothed: std::cell::RefCell<(Illuminant, Texture, wgpu::TextureView)>,
    pyramid: wgpu::TextureView,
    /// The blur the neighbourhood sliders read, built off this frame at this size.
    ///
    /// **On first need rather than at upload, because an upload outlives the edit it was made
    /// with.** The editor uploads once at `Adjust::none()` and grades every later tick off that
    /// upload (`wasm.rs`), so building this only where the *upload's* adjust reads it hands a
    /// Shadows drag a texture nothing ever wrote. Deferred rather than simply unconditional
    /// because the chain opens with a pass over the whole frame, and the renditions that never
    /// read it are most of what this crate does - 2% of a graded 24MP frame, measured.
    detail: std::cell::OnceCell<wgpu::TextureView>,
    /// One texel, so a bind group keeps its shape where nothing reads the blur.
    detail_absent: wgpu::TextureView,
    /// The uniform every dispatch off this frame reads, and the balance it is solved into.
    ///
    /// Made once and rewritten, because a tick is sixty of these a second. `write_buffer` is
    /// ordered on the queue, so a rewrite lands after the submission that read the last one.
    words: Buffer,
    balance: Buffer,
    /// Where [`Uploaded::encode`] writes and what it maps to read the result, a frame each.
    ///
    /// **On the first encode rather than at upload**, because the editor never encodes at all: it
    /// draws onto a canvas, so a pair allocated here is 722MB at 61MP that no tick ever binds -
    /// and one of them is `MAP_READ`, which is host memory rather than the card's.
    encoded: std::cell::OnceCell<(Buffer, Buffer)>,
    /// The textures the views above are onto, which a `wgpu::TextureView` does not keep alive.
    /// A `RefCell` because the blur and the chroma smoothing are both built behind `&self`, on the
    /// tick that first wants one.
    held: std::cell::RefCell<Vec<Texture>>,
    /// The identity the uniform describes where a frame has no camera match, kept alive
    /// because `Grade::colour` borrows one or the other.
    identity: HdrColour,
    /// What the resources above were built from, so [`Uploaded::encode`] can refuse a grade
    /// that disagrees with them rather than dispatching against the wrong lattice.
    ///
    /// **Owned rather than borrowed**, which is what lets an editor hold one of these across
    /// ticks: the browser's frame stays up for the life of the open, and a borrow would tie it
    /// to whatever stack the match was fitted on. A few kilobytes of curves and lattice, cloned
    /// once per open against a frame of hundreds of megabytes.
    colour: Option<HdrColour>,
}

impl Gpu {
    /// One `encode` dispatch: the graded frame as `u16` counts of PQ.
    ///
    /// The same entry point the editor's readback uses, so a rendition and a tick of the
    /// same photo are the same pixels by construction.
    ///
    /// For one output. A caller with several off one frame wants [`Gpu::upload`], which pays
    /// for the frame once.
    pub fn encode(&self, frame: &[u16], grade: &Grade<'_>) -> Vec<u16> {
        self.upload(frame, grade, &self.scene_peak()).encode(grade)
    }

    /// An unmeasured [`ScenePeak`], for a caller about to upload one photo's frames.
    pub fn scene_peak(&self) -> ScenePeak {
        ScenePeak {
            buffer: self.own_buffer(&wgpu::BufferDescriptor {
                label: Some("peak_out"),
                size: 4 * 4,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            measured: std::cell::Cell::new(false),
            revision: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// What a measurement left in one, in nits.
    ///
    /// The number itself, for a caller that has to hand it to a frame holding a piece of the same
    /// photograph: a loupe tile, and the analysis a job keeps beside the photograph so no later
    /// render measures it again (`crate::photo_analysis`). The renditions of one job never ask -
    /// they pass the buffer along and the CPU stays out of it.
    pub fn read_peak(&self, peak: &ScenePeak) -> f32 {
        pollster::block_on(self.peak_of(peak)).expect("the readback mapped")
    }

    /// [`Self::read_peak`], awaited.
    pub async fn peak_of(&self, peak: &ScenePeak) -> Option<f32> {
        let mut recording = self.record();
        let staging = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("peak readback"),
            size: 4,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(&peak.buffer, 0, &staging, 0, 4);
        recording.submit();
        read_back(self, &staging, |mapped| {
            f32::from_le_bytes([mapped[0], mapped[1], mapped[2], mapped[3]])
        })
        .await
    }

    /// The peak a caller already knows, which nothing will then measure.
    ///
    /// **For a frame that is a piece of a photograph.** The measurement reduces whatever is
    /// uploaded, so a loupe tile measures a crop's top end - and the roll-off compresses into
    /// *that*, which is a magnifier grading its highlights differently from the picture it is
    /// held over. The editor measures the whole frame every tick and hands the number back with
    /// the tile request; `peak.slang` writes nits into word zero and this seeds the same word,
    /// so the two are the same quantity rather than two that agree.
    pub fn given_peak(&self, nits: f32) -> ScenePeak {
        let buffer = self.own_buffer(&wgpu::BufferDescriptor {
            label: Some("peak_out"),
            size: 4 * 4,
            // `COPY_SRC` as the measured one has it, so `read_peak` answers for either kind
            // rather than failing validation on whichever a test happens to hold.
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: true,
        });
        {
            let mut view =
                buffer.slice(..).get_mapped_range_mut().expect("a buffer mapped at creation");
            view.slice(..4).write_iter(nits.to_le_bytes());
        }
        buffer.unmap();
        // Claimed, so `upload` leaves it alone. The words above zero are the measurement's own
        // scratch and nothing but `peak.slang` reads them.
        ScenePeak { buffer, measured: std::cell::Cell::new(true),
            revision: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)) }
    }

    /// The frame itself, written straight into the buffer the GPU will read.
    ///
    /// **Mapped at creation rather than through `create_buffer_init`**, which takes `&[u8]` and
    /// so needed the whole frame re-materialised as bytes first - a second 366MB at 61MP, live
    /// alongside the decode it was copied from and the buffer it was copied into. This writes
    /// the little-endian pairs into the mapping directly, so there is one copy and no Vec.
    ///
    /// Padded to a whole number of words, since the shader indexes `array<u32>`: three `u16` a
    /// pixel means an odd sample count whenever both dimensions are odd. `mapped_at_creation`
    /// hands back zeroed memory, so the tail the `zip` does not reach is already zero.
    fn frame_buffer(&self, frame: &[u16]) -> Buffer {
        let buffer = self.own_buffer(&wgpu::BufferDescriptor {
            label: Some("frame"),
            size: ((frame.len() as u64 * 2) + 3) & !3,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: true,
        });
        {
            let mut view =
                buffer.slice(..).get_mapped_range_mut().expect("a buffer mapped at creation");
            view.slice(..frame.len() * 2).write_iter(frame.iter().flat_map(|v| v.to_le_bytes()));
        }
        buffer.unmap();
        buffer
    }

    /// The frame and everything else a dispatch reads, uploaded once.
    pub fn upload<'a>(
        &'a self,
        frame: &[u16],
        grade: &Grade<'_>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        self.with_frame(self.frame_buffer(frame), grade, peak)
    }

    /// The same resources over a frame that never left the device - the render loop's
    /// spelling, which is what spares the sharpen a trip down and back up.
    ///
    /// Takes a counted handle on the resident's buffer, so the caller keeps the frame for a later
    /// downscale and neither side can free it while the other is drawing from it.
    ///
    /// The grade is read rather than held: an `Uploaded` owns the colour it was built against, so
    /// what it borrows is only the device - which is what lets an editor keep one across ticks
    /// whose grades are built and dropped one at a time.
    pub fn upload_resident<'a>(
        &'a self,
        frame: &crate::resident::Resident,
        grade: &Grade<'_>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        self.with_frame(frame.buffer().clone(), grade, peak)
    }

    fn with_frame<'a>(
        &'a self,
        samples: Buffer,
        grade: &Grade<'_>,
        peak: &ScenePeak,
    ) -> Uploaded<'a> {
        // The larger of what is read and what is written: a straighten's bounding box writes about
        // half again what an uncropped frame reads.
        let (out_width, out_height) = grade.output_size();
        let pixels = (grade.width * grade.height).max(out_width * out_height);
        assert!(
            self.fits(pixels),
            "a {}x{} frame graded to {}x{} needs a {}MiB storage binding and this adapter allows \
             {}MiB - the grade would have to be dispatched in bands, which it is not. Hardware \
             adapters report far more than any sensor needs, so this is a software one: lavapipe \
             binds 128MiB, and SwiftShader (`bun run get:swiftshader`) binds 1GiB",
            grade.width,
            grade.height,
            out_width,
            out_height,
            Self::binding_bytes(pixels) / (1 << 20),
            self.limits().max_storage_buffer_binding_size / (1 << 20),
        );

        let buffer = |contents: &[u8], usage: wgpu::BufferUsages| {
            self.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents,
                usage,
            })
        };
        // The caller's, so every size off one photograph rolls off against one measurement.
        // Only the matched arm reads it (`frame.slang`'s `rolled_off`); the neutral one
        // computes its own source peak from the levels in the uniform.
        let peak_out = peak.buffer.clone();
        let zeroed = |words: u64| {
            self.own_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: words * 4,
                // `COPY_DST` for the clear a second measurement over the same frame needs: both
                // counting entry points add into what is already there.
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let histogram = zeroed(PEAK_BINS);
        // A header and room for every candidate, as the page allocates it. `quantile` reads
        // `candidates[0]` to ask whether anything has been kept, and on the rendition path
        // nothing has: `collect` runs only where a caller asks for the editor's route, and the
        // buffer is a quarter of a megabyte beside a frame of hundreds.
        let candidates = zeroed(4 + PEAK_CANDIDATES * 4);

        let identity = HdrColour::identity();
        let described = grade.colour.unwrap_or(&identity);
        let matrix: Vec<u8> =
            described.matrix.iter().flatten().flat_map(|v| (*v as f32).to_le_bytes()).collect();
        let matrix = buffer(&matrix, wgpu::BufferUsages::STORAGE);

        let (chroma, chroma_luma, chroma_tint) = self.lattice(described);
        let surround = self.surround(described);
        let mean = self.mean_frame(&samples, grade);
        let curves = self.curves(described);
        let pyramid = self.own_texture(&wgpu::TextureDescriptor {
            label: Some("pyramid"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Uint,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        // The blur itself waits for a grade that reads it ([`Uploaded::detail`]). This is the
        // one texel that stands in until then, which the chroma model binds and never reads.
        let (absent_texture, detail_absent) = self.build_detail(
            &samples,
            &uniform(grade, described),
            DetailSize { width: 1, height: 1 },
            false,
        );

        let view = |t: &Texture| t.view();
        let chroma_smoothed = self.chroma_smoothed(
            &samples,
            grade,
            described,
            &ChromaModelInputs {
                matrix: &matrix,
                curves: &view(&curves),
                chroma: &view(&chroma),
                chroma_luma: &view(&chroma_luma),
                chroma_tint: &view(&chroma_tint),
                surround: &view(&surround),
                mean: &view(&mean),
                detail: &detail_absent,
            },
        );
        let uploaded = Uploaded {
            gpu: self,
            print_albedo: std::cell::RefCell::new(None),
            print_light: std::cell::RefCell::new(None),
            printer: std::cell::RefCell::new(None),
            print_surface: std::cell::RefCell::new(print_surface::Cached::default()),
            peak_revision: peak.revision.clone(),
            peak_cached: std::cell::RefCell::new(None),
            width: grade.width,
            height: grade.height,
            samples,
            matrix,
            peak_out,
            histogram,
            candidates,
            curves: view(&curves),
            chroma: view(&chroma),
            chroma_luma: view(&chroma_luma),
            chroma_tint: view(&chroma_tint),
            surround: view(&surround),
            mean: view(&mean),
            chroma_smoothed: std::cell::RefCell::new((
                Illuminant::of(grade),
                chroma_smoothed.clone(),
                view(&chroma_smoothed),
            )),
            pyramid: view(&pyramid),
            detail: std::cell::OnceCell::new(),
            detail_absent,
            words: self.own_buffer(&wgpu::BufferDescriptor {
                label: Some("edit"),
                size: uniform(grade, described).len() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }),
            balance: self.balance_buffer(),
            encoded: std::cell::OnceCell::new(),
            held: std::cell::RefCell::new(vec![
                curves,
                chroma,
                chroma_luma,
                chroma_tint,
                surround,
                mean,
                pyramid,
                absent_texture,
            ]),
            identity,
            colour: grade.colour.cloned(),
        };
        // The largest size is uploaded first, so the one measurement is taken off the frame
        // with the most of the photograph in it.
        if grade.colour.is_some() && peak.claim() {
            uploaded.measure_peak(grade);
        }
        uploaded
    }

    /// The scene's own top end, in nits, off the same two passes the editor measures it with.
    ///
    /// The lattice, split in two: the 2x2 in one volume, and the lightness gain's *deviation from
    /// 1* in another.
    ///
    /// Two volumes because four values fill an `rgba16float` texel and five do not, and the
    /// deviation because half floats spend a fixed relative precision wherever the value
    /// sits: storing 1.02 puts it all on the 1. The 2x2 multiplies chroma differences and
    /// survives that; a gain multiplies luma and does not.
    pub fn lattice(&self, colour: &HdrColour) -> (Texture, Texture, Texture) {
        let identity = hdr_fit::ChromaMap::identity();
        let map = colour.chroma.as_ref().unwrap_or(&identity);
        let shape = map.shape();
        let nodes = map.nodes_flat();
        let count = nodes.len() / hdr_fit::NODE_VALUES;
        let (mut pairs, mut gains, mut tints) = (Vec::new(), Vec::new(), Vec::new());
        for node in 0..count {
            let at = node * hdr_fit::NODE_VALUES;
            for k in 0..4 {
                pairs.extend_from_slice(&half(nodes[at + k] as f32));
            }
            // The second volume carries the two luma-to-chroma terms, the lightness gain's
            // deviation from 1, and the first of the two chroma-to-lightness terms.
            gains.extend_from_slice(&half(nodes[at + 4] as f32));
            gains.extend_from_slice(&half(nodes[at + 5] as f32));
            gains.extend_from_slice(&half(nodes[at + 6] as f32 - 1.0));
            gains.extend_from_slice(&half(nodes[at + 7] as f32));
            // Nine values need a third volume: eight fill two `rgba16float` texels exactly,
            // and the ninth has nowhere else to sit. Three of its four slots are spare, which
            // is the price of the chroma-to-lightness pair - a texel of padding per node
            // against a small saturated object otherwise coming out at its surroundings'
            // lightness.
            tints.extend_from_slice(&half(nodes[at + 8] as f32));
            for _ in 0..3 {
                tints.extend_from_slice(&half(0.0));
            }
        }
        let size = wgpu::Extent3d {
            width: shape.chroma_count as u32,
            height: shape.chroma_count as u32,
            // Level and surround packed into depth, surround-major - `nodes_flat`'s own
            // order - and the shader samples one surround slab at a time, so hardware
            // filtering never crosses the seam between slabs.
            depth_or_array_layers: (shape.level_count * shape.surround_count) as u32,
        };
        (
            self.volume(size, &pairs, "chroma"),
            self.volume(size, &gains, "chroma_luma"),
            self.volume(size, &tints, "chroma_tint"),
        )
    }

    /// The frame's nits at the fit's own footprint (`mean_frame.slang`), where
    /// `matched_nits` reads the lattice. Built by a dispatch over the frame's own buffer
    /// and the grade's own decode table, once per upload.
    ///
    /// One black texel where the grade carries no colour: `matched_nits` is the only
    /// reader and `matched` gates it off, so a neutral upload skips the whole-frame pass.
    fn mean_frame(&self, samples: &Buffer, grade: &Grade<'_>) -> Texture {
        if grade.colour.is_none() {
            return self.black_texel("mean_frame");
        }
        let (block, phase, cells) = mean_grid(grade);
        let size = wgpu::Extent3d { width: cells.0, height: cells.1, depth_or_array_layers: 1 };
        let texture = self.written_texture("mean_frame", size);
        let mut recording = self.record();
        recording.holding(samples);
        recording.holding_texture(&texture);
        // Padded to 16: WGSL binds a uniform struct at its size rounded up, same as
        // `gpu::uniform`.
        let push: Vec<u8> =
            [grade.width as u32, grade.height as u32, block, phase.0, phase.1, 0, 0, 0]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
        let push = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("mean_frame push"),
            contents: &push,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let view = texture.view();
        let group = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("mean_frame"),
            layout: &self.mean_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.mean_pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(size.width.div_ceil(8), size.height.div_ceil(8), 1);
        }
        recording.submit();
        texture
    }

    /// The matched colour over the frame at a texel per `chroma_shrink` pixels, encoded for
    /// display and blurred (`chroma_smooth.slang`), for `matched_nits` to take each pixel's
    /// chroma from. Once per upload beside `mean_frame`: `matched_scene` is the frame and
    /// the fit alone. One black texel where the grade carries no colour.
    fn chroma_smoothed(
        &self,
        samples: &Buffer,
        grade: &Grade<'_>,
        described: &HdrColour,
        bound: &ChromaModelInputs<'_>,
    ) -> Texture {
        if grade.colour.is_none() {
            return self.black_texel("chroma smoothed");
        }
        let (_, cells) = grid_for(grade, chroma_shrink(grade.photograph_long).raw() as u32);
        let size = wgpu::Extent3d { width: cells.0, height: cells.1, depth_or_array_layers: 1 };
        let mut recording = self.record();
        recording.holding(samples);
        let modelled = self.written_texture("chroma modelled", size);
        let across = self.written_texture("chroma blurred across", size);
        let smoothed = self.written_texture("chroma smoothed", size);
        for texture in [&modelled, &across, &smoothed] {
            recording.holding_texture(texture);
        }
        // The model's own words, with the smoothing off: this pass is what it smooths.
        let edits = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("chroma model"),
            contents: &uniform_words_with(grade, described, false)
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect::<Vec<u8>>(),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        // Its own pair rather than the upload's: this runs before there is an `Uploaded` to hold
        // one, and once per illuminant rather than per tick.
        let balance = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("balance"),
            size: BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        self.build_balance(&mut recording, &edits, &balance);
        let unread_texture = self.black_texel("chroma unread");
        recording.holding_texture(&unread_texture);
        let unread = unread_texture.view();
        let model = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("chroma model"),
            layout: &self.chroma_model_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(bound.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(bound.chroma),
                },
                wgpu::BindGroupEntry { binding: 4, resource: bound.matrix.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(bound.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(bound.chroma_tint),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(bound.detail),
                },
                wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(bound.surround),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(bound.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&unread),
                },
                wgpu::BindGroupEntry {
                    binding: 22,
                    resource: wgpu::BindingResource::TextureView(&modelled.view()),
                },
            ],
        });
        let blur = |recording: &mut Recording<'_>, from: &Texture, to: &Texture, horizontal: u32| {
            let push: Vec<u8> = [size.width, size.height, horizontal, 0]
                .iter()
                .flat_map(|v| v.to_le_bytes())
                .collect();
            let push = recording.init(&wgpu::util::BufferInitDescriptor {
                label: Some("chroma blur push"),
                contents: &push,
                usage: wgpu::BufferUsages::UNIFORM,
            });
            self.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("chroma blur"),
                layout: &self.chroma_blur_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 20, resource: push.as_entire_binding() },
                    wgpu::BindGroupEntry {
                        binding: 22,
                        resource: wgpu::BindingResource::TextureView(&to.view()),
                    },
                    wgpu::BindGroupEntry {
                        binding: 23,
                        resource: wgpu::BindingResource::TextureView(&from.view()),
                    },
                ],
            })
        };
        let passes = [
            (&self.chroma_model, model),
            (&self.chroma_blur, blur(&mut recording, &modelled, &across, 1)),
            (&self.chroma_blur, blur(&mut recording, &across, &smoothed, 0)),
        ];
        // A pass each: every one reads the texture the one before it wrote, and a pass is
        // where wgpu puts the barrier for that.
        for (pipeline, group) in &passes {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(size.width.div_ceil(8), size.height.div_ceil(8), 1);
        }
        recording.submit();
        smoothed
    }

    fn black_texel(&self, label: &'static str) -> Texture {
        self.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[0; 8],
        )
    }

    fn written_texture(&self, label: &'static str, size: wgpu::Extent3d) -> Texture {
        self.own_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        })
    }

    /// The surround thumb as a texture the grade samples per pixel, in photograph UV.
    ///
    /// One black texel where the colour carries none, so the bind group keeps its shape;
    /// the shader gates on `has_surround` and never reads it there.
    fn surround(&self, colour: &HdrColour) -> Texture {
        let thumb = &colour.surround;
        let (width, height, data): (usize, usize, Vec<u8>) = match thumb.data.is_empty() {
            true => (1, 1, vec![0, 0]),
            false => (
                thumb.width,
                thumb.height,
                thumb.data.iter().flat_map(|v| half(*v as f32)).collect(),
            ),
        };
        self.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some("surround"),
                size: wgpu::Extent3d {
                    width: width as u32,
                    height: height as u32,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &data,
        )
    }

    fn volume(&self, size: wgpu::Extent3d, data: &[u8], label: &str) -> Texture {
        self.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some(label),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D3,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            data,
        )
    }

    pub fn curves(&self, colour: &HdrColour) -> Texture {
        let data: Vec<u8> = (0..3)
            .flat_map(|c| colour.curves[c].iter().map(|v| (*v as f32).to_le_bytes()))
            .flatten()
            .collect();
        self.own_texture_with_data(
            &wgpu::TextureDescriptor {
                label: Some("curves"),
                size: wgpu::Extent3d {
                    width: colour.curves[0].len() as u32,
                    height: 3,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::R32Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &data,
        )
    }

    /// The reader's temperature and tint, solved into the matrix the grade reads.
    ///
    /// **Recorded ahead of whatever is about to grade, off that dispatch's own uniform.** The
    /// pair moves with the slider where the levels and the lattice do not, so a balance settled
    /// once with the frame is the picture as it was opened rather than as the reader is editing
    /// it - a temperature drag that changes nothing at all, since the editor holds one upload
    /// across every tick.
    ///
    /// The search itself is `white_balance.slang` rather than this file, and that is the point
    /// of the pass - both hosts need the same answer on every frame they grade, and two
    /// Robertson searches disagreeing by a few Kelvin would render as a picture rather than as
    /// an error.
    /// Written into rather than allocated, so a tick can hand the same buffer every frame.
    fn build_balance(&self, recording: &mut Recording<'_>, edits: &Buffer, balance: &Buffer) {
        let group = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("balance"),
            layout: &self.balance_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
            ],
        });
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&self.balance_pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }

    fn balance_buffer(&self) -> Buffer {
        self.own_buffer(&wgpu::BufferDescriptor {
            label: Some("balance"),
            size: BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        })
    }

    /// The neighbourhood the presence sliders read, off the frame that is already up
    /// (`detail.slang`).
    ///
    /// Once per uploaded frame, like the scene peak beside it and for the same reason: it
    /// describes the photograph rather than the rendition, so every output off this frame has
    /// to read the same one. Unconditional, rather than skipped when the three sliders are
    /// zero - it is one read of the frame and a handful of box means over a 512px texture
    /// against a job that spends seconds in the decode and the encoder, and a resource that
    /// sometimes exists is a bind group that sometimes does.
    ///
    /// A pass each rather than one with several dispatches: every one of them reads the texture
    /// the one before it wrote, and a pass is where wgpu puts the barrier for that.
    ///
    /// **`DETAIL_PASSES` in order**, which is where the sequence is stated: the editor's clarity
    /// and the rendition's are the same picture because they are this same walk.
    /// Hands back the texture as well as the view onto it: a `TextureView` keeps nothing alive that
    /// a browser will free, so the caller has to hold the texture for the view to stay good.
    fn build_detail(
        &self,
        samples: &Buffer,
        edits: &[u8],
        size: DetailSize,
        wanted: bool,
    ) -> (Texture, wgpu::TextureView) {
        let mut recording = self.record();
        recording.holding(samples);
        let mut texture = |label: &str, format: wgpu::TextureFormat| {
            recording.texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: size.width,
                    height: size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::STORAGE_BINDING,
                view_formats: &[],
            })
        };
        let half = wgpu::TextureFormat::Rgba16Float;
        let full = wgpu::TextureFormat::Rgba32Float;
        // The frame at working resolution, and what the grade ends up binding.
        let base = texture("detail base", half).view();
        let kept = texture("detail", half);
        let detail = kept.view();
        if !wanted {
            return (kept, detail);
        }
        // The moments and the coefficients. 32 bits because a variance is a difference of two
        // nearly equal averages (`detail.slang`), and ping-ponged because a separable box mean
        // cannot read and write one texture in a pass.
        let moments = texture("detail moments", full).view();
        let spare_moments = texture("detail moments scratch", full).view();

        let edits = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("detail"),
            contents: edits,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let shrink = self.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("detail shrink"),
            layout: &self.detail_shrink_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&base),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.nits_of_code.as_entire_binding(),
                },
            ],
        });
        let pair = |label: &str,
                    layout: &wgpu::BindGroupLayout,
                    from: (u32, &wgpu::TextureView),
                    to: (u32, &wgpu::TextureView)| {
            self.bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: from.0,
                        resource: wgpu::BindingResource::TextureView(from.1),
                    },
                    wgpu::BindGroupEntry {
                        binding: to.0,
                        resource: wgpu::BindingResource::TextureView(to.1),
                    },
                ],
            })
        };
        // The pair the 32-bit passes ping-pong through, swapped after each one, so which
        // texture a pass reads follows from the sequence rather than being written beside it.
        let mut held = &moments;
        let mut spare = &spare_moments;
        let encoder = recording.encoder();
        for name in DETAIL_PASSES {
            let (pipeline, group) = match name {
                "shrink" => (&self.detail_shrink, shrink.clone()),
                "moments_of" => (
                    &self.detail_moments,
                    pair(
                        "detail moments",
                        &self.detail_moments_layout,
                        (2, &base),
                        (16, held),
                    ),
                ),
                "window_mean" => {
                    let group = self.bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("detail mean"),
                        layout: &self.detail_mean_layout,
                        entries: &[
                            wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::TextureView(&base),
                            },
                            wgpu::BindGroupEntry {
                                binding: 15,
                                resource: wgpu::BindingResource::TextureView(held),
                            },
                            wgpu::BindGroupEntry {
                                binding: 16,
                                resource: wgpu::BindingResource::TextureView(spare),
                            },
                        ],
                    });
                    std::mem::swap(&mut held, &mut spare);
                    (&self.detail_window_mean, group)
                }
                "apply_guided" => (
                    &self.detail_apply,
                    self.bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("detail apply"),
                        layout: &self.detail_apply_layout,
                        entries: &[
                            wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::TextureView(&base),
                            },
                            wgpu::BindGroupEntry {
                                binding: 15,
                                resource: wgpu::BindingResource::TextureView(held),
                            },
                            wgpu::BindGroupEntry {
                                binding: 3,
                                resource: wgpu::BindingResource::TextureView(&detail),
                            },
                        ],
                    }),
                ),
                // The fit itself, which is pointwise over the moments and so needs no guide.
                _ => {
                    let group =
                        pair("detail fit", &self.detail_box_layout, (15, held), (16, spare));
                    std::mem::swap(&mut held, &mut spare);
                    (&self.detail_coefficients, group)
                }
            };
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(size.width.div_ceil(8), size.height.div_ceil(8), 1);
        }
        recording.submit();
        (kept, detail)
    }

    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }

    pub fn layout(&self) -> &wgpu::BindGroupLayout {
        &self.layout
    }
}

/// Which of `peak.slang`'s entry points a measurement runs, the histogram and the quantile behind
/// them being the same either way.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PeakRoute {
    /// `measure`: the sampled million, which is what a rendition takes.
    WholeSample,
    /// `remeasure`: the candidates a `Collect` kept, which is what a slider takes.
    KeptCandidates,
    /// `collect`: choosing them, against the threshold a `WholeSample` left.
    Collect,
}

impl PeakRoute {
    /// Both counting entry points add into what is already there, so a second measurement over the
    /// counts the first one left reads a rank twice as deep. `collect` adds into the candidate
    /// header instead, and its own four words go the same way.
    fn cleared(self) -> std::ops::Range<u64> {
        match self {
            PeakRoute::Collect => 0..16,
            _ => 0..PEAK_BINS * 4,
        }
    }

    fn reaches_the_quantile(self) -> bool {
        self != PeakRoute::Collect
    }
}

impl Uploaded<'_> {
    /// The scene's own top end, written into `peak_out` for the dispatches that follow.
    ///
    /// **Off the frame that is already up, sampled the way the editor samples it.** Both hosts
    /// run these two passes, and what they run them *over* has to match: gathering a
    /// proportional scatter of the unwarped, unsharpened base on the CPU and uploading it as a
    /// strip is the same estimator over a different million pixels, so a thin specular one
    /// sampling catches and the other steps over moves `scene_peak` and with it where the
    /// roll-off knee lands. The parity fixtures cannot see that: both degenerate to the plain
    /// maximum at 6144 pixels.
    ///
    /// Reading the uploaded frame is also strictly less work than a strip: no gather,
    /// no second upload, and no readback, since `encode` reads `peak_out` on the GPU rather
    /// than being handed a number.
    ///
    /// Once per upload rather than once per rendition: it is a property of the photograph,
    /// and every output off this frame rolls off against the same one.
    fn measure_peak(&self, grade: &Grade<'_>) {
        self.peak_passes(grade, PeakRoute::WholeSample);
    }

    /// The same measurement the editor's slider takes, off the candidates a `Collect` kept.
    ///
    /// **The editor's route, here so that it can be held against the one a rendition takes.** A
    /// tick cannot re-sweep the frame at every slider position, so `collect` keeps the brightest
    /// of the sampled million once and `remeasure` grades only those again - and the whole claim
    /// that rests on is that the exposure cannot reorder the frame enough to push an uncollected
    /// pixel into the top hundred. That is a claim about arithmetic rather than about a browser,
    /// so it is answered in milliseconds by
    /// `the_kept_candidates_answer_as_the_whole_sample_does` rather than by opening a page.
    ///
    /// Nothing on the rendition path calls this: one exposure, measured once.
    pub fn peak_from_candidates(&self, grade: &Grade<'_>) {
        let words = uniform_words(&Grade { canvas: None, ..*grade }, grade.colour.unwrap_or(&self.identity));
        let revision = self.peak_revision.load(std::sync::atomic::Ordering::Relaxed);
        if self.peak_cached.borrow().as_ref().is_some_and(|cached| cached.0 == revision && cached.1 == words) {
            return;
        }
        self.peak_passes(grade, PeakRoute::KeptCandidates);
        *self.peak_cached.borrow_mut() = Some((self.peak_revision.load(std::sync::atomic::Ordering::Relaxed), words));
    }

    /// The printer a print is laid down by, or none for the scene's own paper white and black.
    pub fn set_printer(&self, printer: Option<std::sync::Arc<crate::printer_gamut::PrinterGamut>>) {
        *self.printer.borrow_mut() = printer;
    }

    pub fn invalidate_print_cache(&self) {
        self.print_surface.borrow_mut().pigment = None;
        *self.peak_cached.borrow_mut() = None;
    }

    /// `collect`, over a histogram and a threshold `measure_peak` has already left.
    pub fn collect_candidates(&self, grade: &Grade<'_>) {
        self.peak_passes(grade, PeakRoute::Collect);
    }

    /// The camera's chroma blur for this grade, rebuilt if the reader has moved the illuminant
    /// since the one in hand was made ([`Uploaded::chroma_smoothed`]).
    ///
    /// Three passes at a sixteenth of the frame, and only on the tick a temperature or tint
    /// actually changes - a drag pays it once per distinct value and a grade that never touches
    /// the pair never pays it at all.
    fn chroma_smoothed_for(&self, grade: &Grade<'_>) -> std::cell::Ref<'_, wgpu::TextureView> {
        let wanted = Illuminant::of(grade);
        if self.chroma_smoothed.borrow().0 != wanted {
            let described = grade.colour.unwrap_or(&self.identity);
            let rebuilt = self.gpu.chroma_smoothed(
                &self.samples,
                grade,
                described,
                &ChromaModelInputs {
                    matrix: &self.matrix,
                    curves: &self.curves,
                    chroma: &self.chroma,
                    chroma_luma: &self.chroma_luma,
                    chroma_tint: &self.chroma_tint,
                    surround: &self.surround,
                    mean: &self.mean,
                    detail: &self.detail_absent,
                },
            );
            // The generation this replaces is destroyed here, which is safe against the draws that
            // read it: those were submitted before this call, and a destroy is scheduled against
            // work in flight rather than taken from under it.
            let view = rebuilt.view();
            *self.chroma_smoothed.borrow_mut() = (wanted, rebuilt, view);
        }
        std::cell::Ref::map(self.chroma_smoothed.borrow(), |held| &held.2)
    }

    /// The blur for this grade, built the first time one asks for it.
    ///
    /// Keyed on nothing, because it is a function of the frame alone: `detail.slang` reads the
    /// size, the reference and the frame, and no slider. So the first grade to want it builds
    /// the one every later grade off this upload reads.
    fn detail_for(&self, grade: &Grade<'_>) -> &wgpu::TextureView {
        if !grade.adjust.reads_the_neighbourhood() {
            return &self.detail_absent;
        }
        self.detail.get_or_init(|| {
            let described = grade.colour.unwrap_or(&self.identity);
            let (texture, view) = self.gpu.build_detail(
                &self.samples,
                &uniform(grade, described),
                detail_within(self.width, self.height, grade.photograph_long.raw()),
                true,
            );
            self.held.borrow_mut().push(texture);
            view
        })
    }

    /// This grade's words in the buffer every dispatch binds, and the balance beside it.
    ///
    /// `write_buffer` rather than a fresh buffer: the write is ordered on the queue, so it lands
    /// after whatever submission read the last set rather than changing it underneath.
    fn written(&self, grade: &Grade<'_>, described: &HdrColour) -> (&Buffer, &Buffer) {
        self.gpu.queue.write_buffer(&self.words, 0, &uniform(grade, described));
        (&self.words, &self.balance)
    }

    fn peak_passes(&self, grade: &Grade<'_>, route: PeakRoute) {
        if route.reaches_the_quantile() {
            self.peak_revision.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        let described = grade.colour.unwrap_or(&self.identity);
        let mut recording = self.gpu.record();
        let (edits, balance) = self.written(grade, described);
        // Ahead of the passes below, which grade through the whole colour transform: a balance
        // written after them puts the roll-off knee at the peak of a colour nobody sees.
        self.gpu.build_balance(&mut recording, edits, balance);
        let smoothed = self.chroma_smoothed_for(grade);
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("peak"),
            layout: &self.gpu.peak_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry { binding: 4, resource: self.matrix.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.histogram.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: self.peak_out.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.gpu.sampler),
                },
                wgpu::BindGroupEntry { binding: 8, resource: self.candidates.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_tint),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.gpu.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(self.detail_for(grade)),
                },
                wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(&self.surround),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&self.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&smoothed),
                },
            ],
        });

        let (_, rows) = sampled_rows(self.width, self.height);
        let over_the_sample = ((self.width as u32).div_ceil(64), rows);
        let cleared = route.cleared();
        let counted =
            if route == PeakRoute::Collect { &self.candidates } else { &self.histogram };
        let encoder = recording.encoder();
        encoder.clear_buffer(counted, cleared.start, Some(cleared.end - cleared.start));
        {
            let mut pass = encoder.begin_compute_pass(&Default::default());
            pass.set_bind_group(0, &group, &[]);
            match route {
                PeakRoute::WholeSample => {
                    pass.set_pipeline(&self.gpu.peak_measure);
                    pass.dispatch_workgroups(over_the_sample.0, over_the_sample.1, 1);
                }
                PeakRoute::KeptCandidates => {
                    pass.set_pipeline(&self.gpu.peak_remeasure);
                    pass.dispatch_workgroups((PEAK_CANDIDATES as u32).div_ceil(64), 1, 1);
                }
                PeakRoute::Collect => {
                    pass.set_pipeline(&self.gpu.peak_collect);
                    pass.dispatch_workgroups(over_the_sample.0, over_the_sample.1, 1);
                }
            }
            if route.reaches_the_quantile() {
                // One workgroup: the search is over bins, not pixels.
                pass.set_pipeline(&self.gpu.peak_quantile);
                pass.dispatch_workgroups(1, 1, 1);
            }
        }
        // Submitted rather than waited on. `encode` reads `peak_out` on the GPU, and wgpu
        // orders one submission against the next, so there is nothing to read back.
        recording.submit();
    }

    /// The frame the last [`encode`](Self::encode) wrote, still on the device, for a measurement
    /// that wants the coded frame without a second upload. None before any encode.
    pub fn encoded_frame(&self) -> Option<&Buffer> {
        self.encoded.get().map(|(counts, _)| counts)
    }

    /// One rendition: a new uniform, a dispatch, a readback. Everything else was paid for
    /// when the frame went up.
    ///
    /// Only `peak_nits` and `output` may differ from the upload's grade. The rest of it was
    /// baked into resources at that point - the frame, the matrix, the lattice, the curves and
    /// the `peak_out` those were measured through - while the *uniform* is rebuilt here from
    /// whatever arrives, so a `grade` disagreeing about the colour would describe textures
    /// that are not bound. Asserted rather than trusted: it is silent, and it shifts every
    /// pixel.
    pub fn encode(&self, grade: &Grade<'_>) -> Vec<u16> {
        pollster::block_on(self.coded(grade)).expect("the readback mapped")
    }

    /// [`Self::encode`], awaited, which is the only spelling a browser can take.
    pub async fn coded(&self, grade: &Grade<'_>) -> Option<Vec<u16>> {
        self.encoded_as(grade, |mapped, samples| crate::resident::samples_of(mapped)[..samples].to_vec())
            .await
    }

    /// The same picture, read back as the eight bits an SDR output actually holds.
    ///
    /// **`frame.slang` writes one buffer whatever the output is**, delivering an SDR rendition as
    /// 8-bit values in the low byte of 16-bit counts - so reading it as counts and converting
    /// afterwards puts the whole picture in memory twice at once, and the wider copy is freed only
    /// once the narrower one is complete. On a 16384-wide canvas that is 446MB beside 223MB. Taken
    /// off the mapping in the shape it is wanted, the sixteen-bit copy is never made.
    ///
    /// Little-endian, as [`crate::resident::samples_of`] says of the same bytes: the low byte of
    /// each count stands first.
    pub fn encode_bytes(&self, grade: &Grade<'_>) -> Vec<u8> {
        pollster::block_on(self.coded_bytes(grade)).expect("the readback mapped")
    }

    /// [`Self::encode_bytes`], awaited.
    pub async fn coded_bytes(&self, grade: &Grade<'_>) -> Option<Vec<u8>> {
        self.encoded_as(grade, |mapped, samples| {
            mapped.iter().step_by(2).take(samples).copied().collect()
        })
        .await
    }

    /// The grade and the transfer in one dispatch, and whatever the caller makes of what comes
    /// back: the mapped readback, and how many samples of it are the picture rather than the
    /// odd pixel's padding.
    async fn encoded_as<T>(
        &self,
        grade: &Grade<'_>,
        take: impl FnOnce(&[u8], usize) -> T,
    ) -> Option<T> {
        assert_eq!(
            (grade.width, grade.height),
            (self.width, self.height),
            "the uniform describes a different frame than the one uploaded",
        );
        assert!(
            match (grade.colour, self.colour.as_ref()) {
                (None, None) => true,
                (Some(a), Some(b)) => a == b,
                _ => false,
            },
            "the lattice and the curves bound here are the ones this frame went up with",
        );
        let described = grade.colour.unwrap_or(&self.identity);
        // Sized for what is *written*, which a geometry can make larger than the frame: a
        // straighten's bounding box is wider than the picture it turns, so an uncropped frame at
        // 45 degrees writes about half again what it reads.
        //
        // The pair is built on the first encode and kept, so a second one asking for a larger
        // output would copy past the end of a readback sized for the first. `output_size` moves
        // with the geometry and the window, neither of which the asserts above cover.
        let wanted = Gpu::binding_bytes(grade.output_size().0 * grade.output_size().1);
        let (counts, readback) = self.encoded.get_or_init(|| {
            let bytes = wanted;
            (
                self.gpu.own_buffer(&wgpu::BufferDescriptor {
                    label: Some("counts"),
                    size: bytes,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                self.gpu.own_buffer(&wgpu::BufferDescriptor {
                    label: Some("readback"),
                    size: bytes,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
            )
        });
        assert!(
            wanted <= readback.size(),
            "this grade writes {wanted} bytes and the pair was built for {} by an earlier encode \
             off the same upload",
            readback.size(),
        );
        let mut recording = self.gpu.record();
        let (edits, balance) = self.written(grade, described);
        self.gpu.build_balance(&mut recording, edits, balance);
        let smoothed = self.chroma_smoothed_for(grade);
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("encode"),
            layout: &self.gpu.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry { binding: 4, resource: self.matrix.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.peak_out.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: counts.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.gpu.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::TextureView(&self.pyramid),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_tint),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.gpu.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(self.detail_for(grade)),
                },
                wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(&self.surround),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&self.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&smoothed),
                },
            ],
        });

        // The output's pixels, not the frame's: the dispatch writes one per pixel of what the crop
        // and the turn produce, and reads the frame wherever the geometry sends it.
        let (out_width, out_height) = grade.output_size();
        let pixels = out_width * out_height;
        let out_bytes = Gpu::binding_bytes(pixels);
        {
            let (x, y) = self.gpu.encode_groups(pixels);
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&self.gpu.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.encoder().copy_buffer_to_buffer(counts, 0, readback, 0, out_bytes);
        recording.submit();

        // Unmapped by `read_back` before the next rendition maps it again; a second `map_async` on
        // a buffer still mapped is a validation error, and `on_uncaptured_error` makes those fatal.
        // The odd pixel's padding dropped by taking only what the frame has.
        read_back(self.gpu, readback, |mapped| take(mapped, pixels * 3)).await
    }

    /// The editor's canvas: `vs` and `fs`, over the frame that is already up.
    ///
    /// **The reader's own view, on this host, so that something other than a browser can say what
    /// it shows.** The draw was the last stage of the picture with no native execution at all - the
    /// one stage a Playwright screenshot was the only way to look at - and `covered`'s averaging,
    /// the level it picks off `edit.max_lod`, and the display transform all live in it.
    ///
    /// The one thing here that is genuinely the client's is the *transform*: a rendition is tagged
    /// Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor absolute
    /// luminance, so `fs` computes what the media path declares (§7.1). That is why the two ends
    /// differ at all, and it is a conversion of the same nits rather than a second grade -
    /// `the_draw_shows_what_the_rendition_ships` inverts it and holds the two together.
    ///
    /// `grade.canvas` is what zoom and pan are; `pyramid` is what a ratio past two reads, and
    /// `max_lod` of zero draws from the frame's buffer whatever the ratio.
    ///
    /// Comes back as `f32` per channel, the target being `rgba16float`, which is what the canvas
    /// itself holds: these are display nits over an SDR white and go past one.
    pub fn draw(&self, grade: &Grade<'_>, pyramid: &crate::base::Pyramid) -> Vec<f32> {
        self.draw_with_print(grade, pyramid, None, false).into_iter()
            .map(|word| half::f16::from_bits(word).to_f32()).collect()
    }

    pub fn draw_print(
        &self,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        scene: &crate::print::Scene,
    ) -> Vec<f32> {
        self.draw_with_print(grade, pyramid, Some(scene), false).into_iter()
            .map(|word| half::f16::from_bits(word).to_f32()).collect()
    }

    pub fn print_pq(
        &self,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        scene: &crate::print::Scene,
    ) -> Vec<u16> {
        self.draw_with_print(grade, pyramid, Some(scene), true)
            .chunks_exact(4)
            .flat_map(|rgba| rgba[..3].iter().copied())
            .collect()
    }

    fn draw_with_print(
        &self,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        print: Option<&crate::print::Scene>,
        pq: bool,
    ) -> Vec<u16> {
        let shown = grade.canvas.expect("a draw needs a canvas to draw onto");
        let (canvas_w, canvas_h) = shown.size.raw();
        let mut recording = self.gpu.record();
        let canvas = recording.texture(&wgpu::TextureDescriptor {
            label: Some("canvas"),
            size: wgpu::Extent3d {
                width: canvas_w as u32,
                height: canvas_h as u32,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: if pq { wgpu::TextureFormat::Rgba16Uint } else { CANVAS_FORMAT },
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let target = canvas.view();

        self.draw_into(&mut recording, grade, pyramid, &target, print, pq);

        let stride = (canvas_w * 8).div_ceil(256) * 256;
        let staged = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("canvas readback"),
            size: (stride * canvas_h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &canvas,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &staged,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride as u32),
                    rows_per_image: Some(canvas_h as u32),
                },
            },
            wgpu::Extent3d {
                width: canvas_w as u32,
                height: canvas_h as u32,
                depth_or_array_layers: 1,
            },
        );
        recording.submit();

        let slice = staged.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.gpu.block_until_done();
        let drawn = {
            let mapped = slice.get_mapped_range().expect("the canvas mapped");
            let mut out = Vec::with_capacity(canvas_w * canvas_h * 4);
            for row in 0..canvas_h {
                let bytes = &mapped[row * stride..];
                for channel in 0..canvas_w * 4 {
                    let at = channel * 2;
                    out.push(u16::from_le_bytes([bytes[at], bytes[at + 1]]));
                }
            }
            out
        };
        staged.unmap();
        drawn
    }

    /// The same draw, recorded onto a view the caller owns.
    ///
    /// **The editor's tick and the pin above are this one pass.** A browser hands it the image it
    /// took off its swapchain and presents it; a test hands it a texture it is about to read back.
    /// Neither knows anything the other does not, which is what stops the picture a reader sees
    /// from drifting from the picture a test measures.
    ///
    /// **One draw per recording.** The uniform and the balance belong to the upload rather than to
    /// the call, so two draws recorded before a submit would both read the second one's grade.
    pub fn draw_into(
        &self,
        recording: &mut Recording<'_>,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        target: &wgpu::TextureView,
        print: Option<&crate::print::Scene>,
        pq: bool,
    ) {
        if let Some(scene) = print.filter(|scene| matches!(scene.presentation, crate::print::Presentation::Surface)) {
            self.draw_print_surface(recording, grade, pyramid, target, scene, pq);
            return;
        }
        self.draw_direct(recording, grade, pyramid, target, print, pq, false);
    }

    fn draw_direct(
        &self,
        recording: &mut Recording<'_>,
        grade: &Grade<'_>,
        pyramid: &crate::base::Pyramid,
        target: &wgpu::TextureView,
        print: Option<&crate::print::Scene>,
        pq: bool,
        pigment: bool,
    ) {
        let display_peak = grade.peak_nits;
        let print_grade;
        let grade = if print.is_some() || pigment {
            print_grade = Grade {
                peak_nits: crate::light::Light::at_diffuse_white(grade.reference_nits),
                intent: print.map_or(grade.intent, |scene| scene.rendering_intent),
                print_blur: print.map_or(grade.print_blur, |scene| scene.ink_blur(grade.output().long())),
                ..*grade
            };
            &print_grade
        } else {
            grade
        };
        let canvas = grade.canvas.map(|mut canvas| {
            if let Some(scene) = print { canvas.region = scene.photo_region(grade.output_size(), canvas.region); }
            canvas
        });
        let view_grade = Grade { canvas, ..*grade };
        let grade = &view_grade;
        let shown = grade.canvas.expect("a draw needs a canvas to draw onto");
        let described = grade.colour.unwrap_or(&self.identity);
        // What this binds belongs to the upload and the pyramid rather than to the recording, so
        // it takes a count on each: a caller that drops either before submitting would otherwise
        // be handing the queue a destroyed resource.
        recording.holding(&self.samples);
        recording.holding_texture(pyramid.texture());
        for texture in self.held.borrow().iter() {
            recording.holding_texture(texture);
        }
        let (edits, balance) = self.written(grade, described);
        self.gpu.build_balance(recording, edits, balance);
        let smoothed = self.chroma_smoothed_for(grade);
        let level = pyramid.view();
        let group = self.gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("draw"),
            layout: &self.gpu.draw_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.samples.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&self.curves),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&self.chroma),
                },
                wgpu::BindGroupEntry { binding: 4, resource: self.matrix.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: self.peak_out.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: wgpu::BindingResource::Sampler(&self.gpu.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 9,
                    resource: wgpu::BindingResource::TextureView(&level),
                },
                wgpu::BindGroupEntry {
                    binding: 10,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_luma),
                },
                wgpu::BindGroupEntry {
                    binding: 11,
                    resource: wgpu::BindingResource::TextureView(&self.chroma_tint),
                },
                wgpu::BindGroupEntry {
                    binding: 12,
                    resource: self.gpu.nits_of_code.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 13,
                    resource: wgpu::BindingResource::TextureView(self.detail_for(grade)),
                },
                wgpu::BindGroupEntry { binding: 14, resource: balance.as_entire_binding() },
                wgpu::BindGroupEntry {
                    binding: 17,
                    resource: wgpu::BindingResource::TextureView(&self.surround),
                },
                wgpu::BindGroupEntry {
                    binding: 19,
                    resource: wgpu::BindingResource::TextureView(&self.mean),
                },
                wgpu::BindGroupEntry {
                    binding: 21,
                    resource: wgpu::BindingResource::TextureView(&smoothed),
                },
            ],
        });

        let (canvas_w, canvas_h) = shown.size.raw();
        // **The ratio picks the pipeline, not a branch inside one**, which is the page's rule and
        // has to be this side's too: the shader reads `FROM_FRAME` as an override, so a host that
        // chose differently would draw from the buffer where the reader draws from a level.
        let ratio = (shown.region.2 / canvas_w as f64).max(shown.region.3 / canvas_h as f64);
        let from_frame = shown.max_lod == 0 || ratio < 2.0;
        let print_group = print.map(|scene| {
            let albedo = self.print_albedo_for(scene.refractive_index as f32);
            recording.holding(&albedo);
            let calibration = self.print_light_for(scene.light_parameters(), scene.light_temperature_kelvin as f32);
            recording.holding(&calibration);
            let (buffer, proof) = self.print_scene_binding(recording, scene, display_peak);
            self.gpu.bind_group(&wgpu::BindGroupDescriptor {
                label: Some("print"),
                layout: &self.gpu.print_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: albedo.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: calibration.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: proof.as_entire_binding() },
                ],
            })
        });

        let mut pass = recording.encoder().begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("draw"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        let flat = print.is_some_and(|scene| matches!(scene.presentation, crate::print::Presentation::Flat));
        pass.set_pipeline(if pigment {
            &self.gpu.print_pigment_pipeline
        } else if flat && !pq {
            &self.gpu.print_flat_pipeline
        } else if print.is_some() && pq {
            &self.gpu.print_pq_pipeline
        } else if print.is_some() {
            &self.gpu.print_pipeline
        } else if from_frame {
            &self.gpu.draw_from_frame
        } else {
            &self.gpu.draw_from_pyramid
        });
        pass.set_bind_group(0, &group, &[]);
        if let Some(group) = print_group.as_ref() {
            pass.set_bind_group(1, group, &[]);
        }
        // One triangle covering the target, as `vs` builds it from the vertex index alone.
        pass.draw(0..3, 0..1);
    }

    fn print_albedo_for(&self, eta: f32) -> Buffer {
        if let Some((cached_eta, buffer)) = self.print_albedo.borrow().as_ref() {
            if *cached_eta == eta { return buffer.clone(); }
        }
        let buffer = self.gpu.print_albedo_table(eta);
        *self.print_albedo.borrow_mut() = Some((eta, buffer.clone()));
        buffer
    }

    /// The print's uniform and the target it is laid down within.
    pub(super) fn print_scene_binding(
        &self, recording: &mut Recording<'_>, scene: &crate::print::Scene, display_peak: crate::light::Light<crate::light::DisplayNits>,
    ) -> (Buffer, Buffer) {
        let target = crate::printer_gamut::target(scene, self.printer.borrow().as_deref());
        let target = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print target"),
            contents: &target.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let parameters = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print"), contents: &scene.uniform(display_peak), usage: wgpu::BufferUsages::UNIFORM,
        });
        (parameters, target)
    }

    fn print_light_for(&self, parameters: [f32; 4], temperature: f32) -> Buffer {
        if let Some((cached_parameters, cached_temperature, buffer)) = self.print_light.borrow().as_ref() {
            if *cached_parameters == parameters && *cached_temperature == temperature { return buffer.clone(); }
        }
        let buffer = self.gpu.print_light_calibration(parameters, temperature);
        *self.print_light.borrow_mut() = Some((parameters, temperature, buffer.clone()));
        buffer
    }
}

/// `struct Edit`'s fields, in the order [`uniform`] writes them.
///
/// Here because the writer below is two dozen pushes into a flat buffer, and nothing about a
/// push says which field it is. Swapping two of them leaves every suite green and grades
/// the picture with one number where another belongs.
///
/// `the_uniform_matches_the_shader_struct` parses the struct out of the `.slang` and holds
/// this against it, so the shader stays the source of truth and this stays honest about it.
#[cfg(test)]
const EDIT_FIELDS: &[&str] = &[
    "width",
    "height",
    "white",
    "source_level",
    "reference",
    "peak",
    "exposure",
    "output",
    "matched",
    "saturation",
    "has_chroma",
    "curve_bins",
    "trust_ceiling",
    "chroma_count",
    "level_count",
    "chroma_low",
    "chroma_scale",
    "chroma_low_by",
    "chroma_scale_by",
    "level_scale",
    "sdr_white",
    "row_stride",
    "peak_samples",
    "region_origin",
    "region_size",
    "canvas_size",
    "max_lod",
    "intent",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "vibrance",
    "sat_adjust",
    "texture_adjust",
    "clarity",
    "dehaze",
    "as_shot_temperature",
    "as_shot_tint",
    "temperature",
    "tint",
    "balance_set",
    "crop_left",
    "crop_top",
    "crop_right",
    "crop_bottom",
    "crop_cos",
    "crop_sin",
    "rotate",
    "output_width",
    "output_height",
    "keystone_0",
    "keystone_1",
    "keystone_2",
    "keystone_3",
    "keystone_4",
    "keystone_5",
    "keystone_6",
    "keystone_7",
    "has_keystone",
    "detail_long",
    "detail_step",
    "photo_width",
    "photo_height",
    "window_left",
    "window_top",
    "surround_count",
    "surround_scale",
    "has_surround",
    "surround_left",
    "surround_top",
    "surround_photo_width",
    "surround_photo_height",
    "has_mean",
    "mean_block",
    "has_smoothed",
    "chroma_shrink",
    "tone_anchor",
    "black_floor",
    "print_blur",
];

/// `struct Edit`, field for field, in the order the shader declares them.
///
/// Flat rather than a builder so it can be read against the struct. The one subtlety is
/// the unnamed word before `region_origin`: WGSL puts a `vec2f` on a multiple of eight and
/// the scalars end on 92, so without it every field after lands short and the binding is
/// rejected four bytes small.
fn uniform(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u8> {
    uniform_words(grade, colour).iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The same words, before they are bytes, so the editor can be handed them.
///
/// **This is the only thing that builds a `Edit`.** A client building its own from the payload -
/// re-deriving `curve_bins` from the curve it was sent, the seven lattice shape fields from the
/// chroma map, `trust_ceiling`, `sdr_white`, and the peak's sampling stride - is twenty-two words
/// of one frame described twice in two languages. The shaders are one implementation; what would
/// be two is the thing that fills them, and a mismatch there is a photograph graded with one
/// number where another belongs, on a path no test crosses.
///
/// So the frame's own words are built here, once, and travel on `edit::PreparedHeader`. What
/// the editor still writes is only what the *reader* owns and this side cannot know: the exposure,
/// the sliders, the region on screen and the canvas showing it.
pub fn uniform_words(grade: &Grade<'_>, colour: &HdrColour) -> Vec<u32> {
    uniform_words_with(grade, colour, true)
}

/// `uniform_words`, saying whether `chroma_smoothed` is there to read: the pass that
/// builds it runs the model without it.
fn uniform_words_with(grade: &Grade<'_>, colour: &HdrColour, smoothed: bool) -> Vec<u32> {
    let shape = colour.chroma.as_ref().map(|m| m.shape());
    let shape = shape.as_ref();
    let mut w: Vec<u32> = Vec::new();
    let f = |w: &mut Vec<u32>, v: f64| w.push((v as f32).to_bits());
    w.push(grade.width as u32);
    w.push(grade.height as u32);
    f(&mut w, grade.white.raw());
    f(&mut w, grade.source_level.raw());
    f(&mut w, grade.reference_nits.raw());
    f(&mut w, grade.peak_nits.raw());
    f(&mut w, grade.exposure.raw());
    w.push(match grade.output {
        Output::Pq => 0,
        Output::Srgb => 1,
        Output::Rolled => 2,
    });
    w.push(u32::from(grade.colour.is_some()));
    f(&mut w, colour.saturation);
    w.push(u32::from(grade.colour.is_some() && colour.chroma.is_some()));
    w.push(colour.curves[0].len() as u32);
    f(&mut w, colour.ceiling);
    w.push(shape.map_or(2, |s| s.chroma_count as u32));
    w.push(shape.map_or(2, |s| s.level_count as u32));
    f(&mut w, shape.map_or(0.0, |s| s.chroma_low[0]));
    f(&mut w, shape.map_or(1.0, |s| s.chroma_scale[0]));
    f(&mut w, shape.map_or(0.0, |s| s.chroma_low[1]));
    f(&mut w, shape.map_or(1.0, |s| s.chroma_scale[1]));
    f(&mut w, shape.map_or(1.0, |s| s.level_scale));
    // sdr_white: BT.2408 reference white, and the divisor an extended-range canvas needs.
    //
    // Measured rather than assumed (`docs/raw-edit-gpu.md` §7.1): swept against a real PQ AVIF
    // of the same pixels, Chrome and Safari both match at 203. It is the *browser's* constant
    // rather than `reference_nits`, which a library is free to move - which is why it is a
    // literal here and not read off the grade, and why it lived on the client until the client
    // stopped building its own uniform.
    f(&mut w, 203.0);
    let (stride, rows) = sampled_rows(grade.width, grade.height);
    w.push(stride); // row_stride
    w.push(grade.width as u32 * rows); // peak_samples
    w.push(0); // the alignment word before `region_origin`
    let shown = grade.canvas.unwrap_or(Canvas {
        region: (0.0, 0.0, 0.0, 0.0),
        size: crate::px::Size::of(crate::px::Span::ZERO, crate::px::Span::ZERO),
        max_lod: 0,
    });
    let (canvas_w, canvas_h) = shown.size.raw();
    for value in [
        shown.region.0,
        shown.region.1,
        shown.region.2,
        shown.region.3,
        canvas_w as f64,
        canvas_h as f64,
    ] {
        f(&mut w, value); // region_origin, region_size, canvas_size
    }
    w.push(shown.max_lod);
    w.push(grade.intent as u32);
    // The reader's sliders, in `struct Edit`'s order. Appended after the scalars there, so
    // nothing above this line moved when they were added.
    f(&mut w, grade.adjust.contrast);
    f(&mut w, grade.adjust.highlights);
    f(&mut w, grade.adjust.shadows);
    f(&mut w, grade.adjust.whites);
    f(&mut w, grade.adjust.blacks);
    f(&mut w, grade.adjust.vibrance);
    f(&mut w, grade.adjust.saturation);
    f(&mut w, grade.adjust.texture);
    f(&mut w, grade.adjust.clarity);
    f(&mut w, grade.adjust.dehaze);
    // The frame's illuminant, then the document's, copied rather than resolved against each
    // other: `white_balance.slang` is where a null half becomes the frame's own, so that rule
    // has one implementation instead of one per host. Zero as-shot means the camera recorded
    // no usable multipliers, and the shader leaves the balance alone.
    f(&mut w, grade.as_shot.map_or(0.0, |s| s.temperature));
    f(&mut w, grade.as_shot.map_or(0.0, |s| s.tint));
    f(&mut w, grade.adjust.temperature.unwrap_or(0.0));
    f(&mut w, grade.adjust.tint.unwrap_or(0.0));
    w.push(
        u32::from(grade.adjust.temperature.is_some())
            | (u32::from(grade.adjust.tint.is_some()) << 1),
    );
    // The reader's crop, straighten and turn, which both hosts apply here - in the same dispatch
    // as the grade, off the whole frame. The editor patches these per tick, since a crop handle
    // must not cost a re-prepare; a rendition fills them from its job and gets the identical
    // mapping rather than a gather that agrees with it.
    let (out_width, out_height) = grade.output_size();
    let [left, top, right, bottom] = grade.geometry.crop;
    let (sin, cos) = grade.geometry.angle_degrees.to_radians().sin_cos();
    for value in [left, top, right, bottom, cos, sin] {
        f(&mut w, value);
    }
    w.push(u32::from(grade.geometry.rotate));
    w.push(out_width as u32);
    w.push(out_height as u32);
    for value in grade.geometry.keystone.unwrap_or_default() {
        f(&mut w, value);
    }
    w.push(u32::from(grade.geometry.keystone.is_some()));
    w.push(detail_long(grade.photograph_long.raw()));
    w.push(detail_step(grade.photograph_long.raw()));
    // The photograph the crop fractions are of, and where this buffer starts in it. The frame's own
    // size and the origin for every caller whose frame *is* the photograph, which is the editor and
    // every rendition that had no crop to decode less of.
    let (photo_width, photo_height) = grade.photograph();
    let origin = grade.window.map_or((0, 0), |w| w.origin.raw());
    w.push(photo_width as u32);
    w.push(photo_height as u32);
    w.push(origin.0 as u32);
    w.push(origin.1 as u32);
    // The surround axis and where to read its thumb. A separate window from `window`,
    // because a loupe tile applies no geometry - `window` must stay `None` there - while
    // the thumb is still the photograph's and has to be read in its UV.
    w.push(shape.map_or(2, |s| s.surround_count as u32));
    f(&mut w, shape.map_or(1.0, |s| s.surround_scale));
    w.push(u32::from(
        grade.colour.is_some() && colour.chroma.is_some() && !colour.surround.data.is_empty(),
    ));
    let surround_window = grade.surround_window.or(grade.window);
    let s_origin = surround_window.map_or((0, 0), |s| s.origin.raw());
    let (s_width, s_height) =
        surround_window.map_or((grade.width, grade.height), |s| s.photograph.raw());
    w.push(s_origin.0 as u32);
    w.push(s_origin.1 as u32);
    w.push(s_width.max(1) as u32);
    w.push(s_height.max(1) as u32);
    // A mean is always built beside a real frame; only the probes, which bind a dummy,
    // clear this in their own uniform builders.
    w.push(1);
    // The block alone: `cell_at` in `colour.slang` reads the cells by index off this and the
    // window's own origin, where an affine onto the texture's UV could not be exact - a window's
    // texture holds fewer cells than the photograph's, so normalising by it and letting the
    // sampler multiply it back rounds differently on the two routes.
    w.push(mean_grid(grade).0);
    // Built beside every matched frame; the pass that builds it, and the probes, clear this
    // in their own copies.
    w.push(u32::from(smoothed && grade.colour.is_some()));
    w.push(chroma_shrink(grade.photograph_long).raw() as u32);
    f(&mut w, colour.anchor);
    f(&mut w, match grade.floor {
        Some(floor) if grade.white.raw() > 0.0 => floor.raw() / grade.white.raw(),
        // The `white > 0` half of that guard is the load-bearing one. Zero here is the unmeasured
        // reading and gives the pair a full photograph's span; dividing by a white of zero would
        // send an infinity instead, which floors the span at a sixteenth of a stop - the opposite
        // answer, on the darkest frame there is.
        _ => 0.0,
    });
    f(&mut w, grade.print_blur.raw());
    // WGSL rounds a uniform struct's size up to a multiple of 16 bytes, and binds it at that
    // size - so a buffer holding exactly the fields is rejected as too small, by however much
    // the last few fields left over. Here it was implicit in the field count until a field was
    // added, and then it was four bytes short.
    // Stated as the rule rather than as a spare word, so the next field cannot break it.
    while w.len() % 4 != 0 {
        w.push(0);
    }
    w
}

/// The mean pass's grid for this frame: the supervision block, the frame's offset inside
/// its photograph-anchored first block, and the cell counts those give the texture.
///
/// The block is exactly one fit-plane pixel of the photograph, in this frame's pixels -
/// `photograph_long` is already in those. Equal to the fit's own footprint on purpose,
/// neither finer nor coarser: the fit models the transform at its plane's pixels, and a
/// mean read at any other width diverges from that model over texture by the tone curve's
/// curvature - measured as a blue deficit on lit skin when this sat at twice the fit's
/// width. Anchored at the photograph's origin so a tile and the whole render average the
/// same pixels into every cell they share; the reader's affine UV (`mean_scale_*`,
/// `mean_offset_*`) is derived from the same numbers, which is what keeps the two honest.
/// The camera match's supervision footprint, in the pixels of a frame whose photograph is
/// `photograph_long` on its long edge.
///
/// A window has to decode this much past what it keeps: the blocks partition the *photograph*, so
/// a cell the kept rectangle only partly covers would be averaged over the pixels inside the
/// window and nothing outside it, where the whole render averages the block. `matched_scene`
/// divides the pixel by that average, so the error would land on the picture rather than staying
/// in a statistic. `tile::grown` adds one of these to its reach, and this is a function so the
/// two cannot drift.
pub(crate) fn mean_block(photograph_long: usize) -> u32 {
    ((2 * photograph_long).div_ceil(hdr_fit::sample_long_edge()) as u32).max(1)
}

fn mean_grid(grade: &Grade<'_>) -> (u32, (u32, u32), (u32, u32)) {
    let block = mean_block(grade.photograph_long.raw());
    let (phase, cells) = grid_for(grade, block);
    (block, phase, cells)
}

/// A grid of `block`-pixel cells partitioning the photograph, as this frame meets it: the
/// frame's offset inside its first cell, and how many cells cover it.
fn grid_for(grade: &Grade<'_>, block: u32) -> ((u32, u32), (u32, u32)) {
    let origin = grade.surround_window.or(grade.window).map_or((0, 0), |w| w.origin.raw());
    let phase = (origin.0 as u32 % block, origin.1 as u32 % block);
    let cells = (
        (grade.width as u32 + phase.0).div_ceil(block),
        (grade.height as u32 + phase.1).div_ceil(block),
    );
    (phase, cells)
}

/// An `f32` as the `f16` bits a texture holds.
fn half(v: f32) -> [u8; 2] {
    half::f16::from_f32(v).to_bits().to_le_bytes()
}

#[cfg(test)]
mod tests {
    use crate::light::{Light, Stops};
    use wgpu::util::DeviceExt;

    /// A `Geometry`, positionally, so a table of cases reads as a table.
    fn geometry(
        crop: [f64; 4],
        angle_degrees: f64,
        rotate: u16,
        keystone: Option<[f64; 8]>,
    ) -> crate::image::Geometry {
        crate::image::Geometry { crop, angle_degrees, rotate, keystone }
    }

    /// The device is opened at the adapter's texture limit rather than WebGPU's default of 8192.
    ///
    /// **A silent failure in the browser.** The viewer reads the limit back to decide whether a
    /// frame can be uploaded as planes, and a native-resolution rendition off a 61MP body is 9504 on
    /// its long edge: under the default, every one fell to the import, which tone maps HDR down.
    #[test]
    fn the_device_is_opened_at_the_adapters_texture_limit() {
        let instance = wgpu::Instance::default();
        let Ok(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("SKIPPED: no adapter answered, so no limits were asked for.");
            return;
        };
        let asked = super::limits_of(&adapter);
        assert_eq!(asked.max_texture_dimension_2d, adapter.limits().max_texture_dimension_2d);
        assert!(asked.max_storage_buffers_per_shader_stage <= super::MOST_STORAGE_BUFFERS);
    }

    /// The host builds `detail` under exactly the test the shader reads it under.
    ///
    /// **Both directions are silent failures.** A slider added to `adjust.slang`'s `local` and not
    /// to [`super::Adjust::reads_the_neighbourhood`] samples a texture nothing wrote, which is a
    /// blur of whatever the allocation held; added here and not there, the frame pays five passes
    /// for a texture no pixel reads. Neither shows as an error, and the second is what this pass
    /// was doing for every unedited photograph before it was gated.
    #[test]
    fn the_detail_pass_runs_exactly_when_the_shader_reads_it() {
        const ADJUST_SLANG: &str = include_str!("../../../slang/adjust.slang");
        let local = ADJUST_SLANG
            .split_once("let local =")
            .and_then(|(_, rest)| rest.split_once(';'))
            .map(|(test, _)| test.to_string())
            .expect("adjust.slang states `local`");
        // The five the shader names, each against a probe that sets only that one.
        let set: [(&str, fn(&mut super::Adjust)); 5] = [
            ("texture_adjust", |a| a.texture = 1.0),
            ("clarity", |a| a.clarity = 1.0),
            ("dehaze", |a| a.dehaze = 1.0),
            ("highlights", |a| a.highlights = 1.0),
            ("shadows", |a| a.shadows = 1.0),
        ];
        for (field, set) in set {
            assert!(
                local.contains(&format!("edit.{field}")),
                "adjust.slang's `local` no longer reads {field}, so the host builds a blur for it \
                 that nothing samples",
            );
            let mut adjust = super::Adjust::none();
            set(&mut adjust);
            assert!(
                adjust.reads_the_neighbourhood(),
                "{field} is in the shader's `local` and not in `reads_the_neighbourhood`, so it \
                 samples a texture the host never built",
            );
        }
        // And nothing else does: a slider the shader does not read must not build the pass.
        let others: [fn(&mut super::Adjust); 5] = [
            |a| a.contrast = 1.0,
            |a| a.whites = 1.0,
            |a| a.blacks = 1.0,
            |a| a.vibrance = 1.0,
            |a| a.saturation = 1.0,
        ];
        for set in others {
            let mut adjust = super::Adjust::none();
            set(&mut adjust);
            assert!(!adjust.reads_the_neighbourhood(), "a slider that reads no neighbourhood");
        }
        assert!(!super::Adjust::none().reads_the_neighbourhood());
    }

    /// The shader's own sizes, against the buffers this host allocates for them.
    ///
    /// **A histogram longer than its buffer is a dropped dispatch, not an error.** WGSL bounds
    /// an out-of-range store rather than failing it, so raising `BINS` in `peak.slang` without
    /// raising [`super::PEAK_BINS`] would silently discard every sample past the eighth
    /// thousand bin while `quantile` still divides by the full count - every rendition's scene
    /// peak low, the roll-off knee in the wrong place, and nothing said anywhere.
    #[test]
    fn the_shader_sizes_match_the_buffers_allocated_for_them() {
        // **The Slang, not what it emitted.** A `static const` is folded into its use sites before
        // emission, so the declaration is not in the generated WGSL to read.
        const PEAK_SLANG: &str = include_str!("../../../slang/peak.slang");
        const DETAIL_SLANG: &str = include_str!("../../../slang/detail.slang");
        let declared = |source: &str, name: &str| -> u64 {
            let at = source
                .find(&format!("static const uint {name} ="))
                .unwrap_or_else(|| panic!("{name} is declared"));
            let line = &source[at..][..source[at..].find(';').expect("it is terminated")];
            let digits: String =
                line.rsplit('=').next().expect("it is assigned").matches(char::is_numeric).collect();
            digits.parse().unwrap_or_else(|_| panic!("{name} reads `{line}`"))
        };
        assert_eq!(
            declared(PEAK_SLANG, "BINS"),
            super::PEAK_BINS,
            "peak.slang's BINS and gpu.rs's PEAK_BINS have drifted",
        );
        // **The one that fails quietly.** A `CANDIDATES` raised in the shader without the buffer
        // is a store past the end, which WGSL clamps rather than faults - so the collect keeps a
        // truncated set, the tick re-measures the peak off it, and the roll-off knee lands low on
        // every matched photograph with nothing anywhere saying why.
        assert_eq!(
            declared(PEAK_SLANG, "CANDIDATES"),
            super::PEAK_CANDIDATES,
            "peak.slang's CANDIDATES and gpu.rs's PEAK_CANDIDATES have drifted",
        );
        // Not a buffer size but the same failure: this one sets how large a share of the
        // picture a blur covers, so a host allocating a different texture blurs at a different
        // scale and the rendition stops matching the editor. Silent - both pictures look like
        // pictures.
        assert_eq!(
            declared(DETAIL_SLANG, "DETAIL_LONG"),
            u64::from(super::DETAIL_LONG),
            "detail.slang's DETAIL_LONG and gpu.rs's have drifted",
        );
        // The reach is what `chroma_smooth_reach` promises a comparison it can stand clear of.
        // The shrink itself is not pinned here and cannot be: it is a share of the photograph
        // rather than a constant, so the host computes it and the shader reads it off the
        // uniform.
        const CHROMA_SLANG: &str = include_str!("../../../slang/chroma_smooth.slang");
        let reach = CHROMA_SLANG
            .split("static const int REACH =")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .and_then(|digits| digits.trim().parse::<u64>().ok())
            .expect("chroma_smooth.slang declares REACH");
        assert_eq!(
            reach,
            u64::from(super::CHROMA_BLUR_REACH),
            "chroma_smooth.slang's REACH and gpu.rs's CHROMA_BLUR_REACH have drifted",
        );
        // `decode` writes one entry per code and guards on the last one, so it carries the
        // count as `65535` - the top code rather than the length.
        let source = include_str!("../../../slang/decode.slang");
        let top: u64 = source
            .split("id.x > ")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .and_then(|digits| digits.trim().parse().ok())
            .expect("decode.slang bounds its entry point");
        assert_eq!(
            top + 1,
            super::PQ_CODES,
            "decode.slang fills {} entries and gpu.rs allocates {}",
            top + 1,
            super::PQ_CODES,
        );
    }

    /// The WGSL of every shader that imports `px`, read here rather than through `gpu.rs`'s own
    /// consts: most of these are built by the module that dispatches them, and this test is about
    /// the emitted text rather than about any pipeline.
    const SHARPEN_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/sharpen.wgsl"));
    const DUST_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/dust.wgsl"));
    const DUST_FIND_WGSL: &str = include_str!(concat!(env!("OUT_DIR"), "/wgsl/dust_find.wgsl"));
    const COMPOSITE_FEATURES_WGSL: &str =
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/composite_features.wgsl"));

    /// `px.slang`'s spaces are a compile-time argument and reach no buffer a host binds.
    ///
    /// **The one way typing the shaders could have cost something.** A `Span` is a struct, and a
    /// struct that reached a uniform or a storage binding would change the layout both hosts agree
    /// on - silently, since the numbers in it are the numbers that were always there. Slang
    /// monomorphises the generic into a local, so what a lane holds is a `u32` in a wrapper the
    /// compiler flattens; this says the wrapper never got into a binding to be flattened wrongly.
    #[test]
    fn the_generic_pixels_cost_nothing() {
        // `_std140_` is what slangc suffixes a struct it is laying out for a binding, so a `Span`
        // inside one of those bodies is exactly the failure. Others are locals and are free.
        //
        // **Every shader that imports `px`, not the two it started with.** The claim is about what
        // the module does to a binding, so a shader left off this list is a shader the claim was
        // never made about - `sharpen`, `dust` and `dust_find` had been importing it unchecked, and
        // `composite_features` joins them the moment its descriptor window becomes a `Share`.
        let each = [
            ("chroma_smooth", super::CHROMA_SMOOTH_WGSL),
            ("detail", super::DETAIL_WGSL),
            ("sharpen", SHARPEN_WGSL),
            ("dust", DUST_WGSL),
            ("dust_find", DUST_FIND_WGSL),
            ("composite_features", COMPOSITE_FEATURES_WGSL),
        ];
        for (name, wgsl) in each {
            for block in wgsl.split("struct ").skip(1).filter(|b| {
                b.split('{').next().is_some_and(|head| head.contains("_std140_"))
            }) {
                let body = block.split('}').next().unwrap_or_default();
                assert!(
                    !body.contains("Span"),
                    "{name}.wgsl binds a struct holding a px Span, so its layout is not the \
                     numbers alone: {body}",
                );
            }
        }
    }

    /// `light.slang`'s domains are the same compile-time argument, and reach no binding either.
    ///
    /// The same hazard as the pixels', on the shaders that carry the grade: `Edit` is written field
    /// for field by `uniform_words` and read back by `the_uniform_matches_the_shader_struct`, so a
    /// `Colour` or a `Light` laid out inside it would be a uniform whose words are not the words
    /// this host wrote - with every number in it still the number it always was.
    #[test]
    fn the_generic_lights_cost_nothing() {
        for (name, wgsl) in [
            ("frame", super::FRAME_WGSL),
            ("peak", super::PEAK_WGSL),
            ("decode", super::DECODE_WGSL),
            ("chroma_smooth", super::CHROMA_SMOOTH_WGSL),
        ] {
            for block in wgsl.split("struct ").skip(1).filter(|b| {
                b.split('{').next().is_some_and(|head| head.contains("_std140_"))
            }) {
                let body = block.split('}').next().unwrap_or_default();
                for wrapper in ["Light", "Colour", "Gain", "Stops"] {
                    assert!(
                        !body.contains(wrapper),
                        "{name}.wgsl binds a struct holding a light {wrapper}, so its layout is \
                         not the numbers alone: {body}",
                    );
                }
            }
        }
    }

    /// The reach `detail_reach` reports against the fractions the shader actually filters with.
    ///
    /// **This one decides how much of a photograph a loupe tile has to decode**, and it is the
    /// shader's arithmetic written out in Rust, which is the arrangement DESIGN 21.1 exists to
    /// distrust. Wrong small and a tile's Clarity is fitted against an edge that is not in the
    /// picture; wrong large and every tile pays for surroundings nothing reads.
    #[test]
    fn the_detail_reach_is_the_shaders_own() {
        const DETAIL_SLANG: &str = include_str!("../../../slang/detail.slang");
        let fraction = |name: &str| -> f64 {
            // A `Share`, so the value is braced: `static const Share NAME = { 1.0 / 64.0 };`.
            let at = DETAIL_SLANG
                .find(&format!("static const Share {name} ="))
                .unwrap_or_else(|| panic!("{name} is declared"));
            let line = &DETAIL_SLANG[at..][..DETAIL_SLANG[at..].find(';').expect("terminated")];
            let (numerator, denominator) = line
                .rsplit('=')
                .next()
                .and_then(|value| value.split_once('/'))
                .unwrap_or_else(|| panic!("{name} reads `{line}`"));
            let number =
                |text: &str| text.trim().trim_matches(['{', '}']).trim().parse::<f64>().expect("a number");
            number(numerator) / number(denominator)
        };
        assert_eq!(fraction("GUIDE_RADIUS"), super::GUIDE_RADIUS, "the window has moved");
        assert_eq!(fraction("FINE_SIGMA"), super::FINE_SIGMA, "the fine reference has moved");
        // And what those come to at the size every photograph larger than the working texture
        // gets, which is the number a tile is grown by.
        assert_eq!(super::detail_reach(super::DETAIL_LONG), 2 * 8 + 2);
    }

    /// `struct Edit` in the shader against the order and the size this host writes.
    ///
    /// Two failures, both silent without this. A field inserted anywhere but the tail
    /// shifts every field after it, so the grade reads the exposure out of `peak` and the
    /// picture is wrong in a way no validation catches. And a field *appended* leaves the
    /// buffer short of the 16-byte multiple WGSL binds the struct at, which wgpu does
    /// catch - but as "bound with size 156 where the shader expects 160", at the dispatch,
    /// which is a long way from the line that added the field.
    ///
    /// The shader is the source of truth: this parses `struct Edit` out of the `.slang` rather
    /// than restating it.
    #[test]
    fn the_uniform_matches_the_shader_struct() {
        let source = include_str!("../../../slang/edit.slang");
        let body = source
            .split_once("public struct Edit {")
            .and_then(|(_, rest)| rest.split_once("};"))
            .map(|(body, _)| body)
            .expect("edit.slang declares struct Edit");

        let declared: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter_map(|line| line.strip_prefix("public "))
            .filter_map(|field| field.strip_suffix(';'))
            .filter_map(|field| field.rsplit(' ').next())
            .collect();

        assert_eq!(
            declared, super::EDIT_FIELDS,
            "struct Edit and gpu.rs's EDIT_FIELDS have drifted",
        );

        // And the buffer the writer produces is the size the binding wants: every field a
        // word, `vec2f` two, the alignment word before the first of those, rounded up to four.
        //
        // The alignment word counted rather than left to the rounding to absorb, which is what
        // it was doing: at 63 named words the round to 64 happened to cover it, so the next field
        // appended made this expect one word fewer than the writer emits.
        let words: usize = super::EDIT_FIELDS
            .iter()
            .map(|name| if name.starts_with("region_") || *name == "canvas_size" { 2 } else { 1 })
            .sum::<usize>()
            + 1;
        let expected = words.div_ceil(4) * 4 * 4;
        let colour = crate::hdr_fit::HdrColour::identity();
        let grade = super::Grade::new(
            1,
            1,
            crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
            Light::exactly(203.0),
            Light::exactly(1000.0),
        );
        assert_eq!(super::uniform(&grade, &colour).len(), expected);
    }

    /// The canvas the reader looks at against the frame the file gets, pixel for pixel.
    ///
    /// **The draw was the last stage of the picture that only a browser could run**, which made
    /// "does the editor show what the export contains" a question for a Playwright screenshot. It
    /// is `vs` and `fs` over the same frame, the same geometry and the same grade as `encode`, so
    /// it is answerable here in milliseconds.
    ///
    /// **Held as a mapping rather than as a difference, which is what makes it exact.** The two
    /// ends genuinely differ at the last step and are meant to: a rendition is tagged Rec.2020 PQ
    /// and handed to a compositor, and a canvas has neither Rec.2020 nor absolute luminance, so
    /// `fs` computes the display transform the media path declares (§7.1). Undoing that here would
    /// put a second copy of the transform in this file, which is the drift the shared shader
    /// exists to prevent. So what is asserted is that one function relates them: every pixel the
    /// rendition gives the same value, the draw gives the same value too. A geometry that differed
    /// by a pixel, a roll-off against a different peak, a lattice read at a different node - each
    /// of those breaks the mapping, and none of them needs the transform written down to catch.
    ///
    /// Blocks rather than a photograph, because `covered` averages four taps a quarter of a pixel
    /// either side of the centre where `coded_at` takes one at it. Inside a block those are the
    /// same value and the comparison is exact; across an edge they are not, and the difference
    /// would be the cubic's own spread rather than anything the two hosts disagree about.
    #[test]
    fn the_draw_shows_what_the_rendition_ships() {
        let Some(gpu) = super::device() else { return };
        let Some(base) = crate::base::device(gpu) else { return };

        // Wide enough that a block has an interior beyond the chroma smoothing's reach from
        // its edges: the match reads a pixel's chroma from its neighbourhood, so only there
        // is a pixel's colour a function of its own value.
        const BLOCK: usize = 64;
        // Off this frame's own long edge, the smoothing's footprint being a share of the
        // photograph rather than a fixed count of pixels.
        let margin = 2 + super::chroma_smooth_reach(crate::px::Span::measured(1024)).raw();
        /// One pixel wide, and away from every block edge: what says the two routes read the same
        /// *place*. A drawn canvas offset by a pixel still agrees about every block interior.
        const SPIKE: usize = 160;
        // Sixteen values over 128 blocks, so each one turns up in eight blocks scattered about the
        // frame rather than once. A value per block would make the map below injective, and an
        // injective map asserts only that a block draws one colour.
        const SHADES: usize = 16;

        let (width, height) = (1024usize, 512usize);
        let mut frame: Vec<u16> = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let block = (y / BLOCK) * (width / BLOCK) + (x / BLOCK);
                let shade = (block * 7 + block / (width / BLOCK)) % SHADES;
                for channel in 0..3 {
                    frame.push(match x == SPIKE {
                        true => 33000,
                        false => ((shade * 1900 + channel * 430) % 31000) as u16,
                    });
                }
            }
        }

        let colour = crate::hdr_fit::HdrColour::identity();
        let shown = super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: crate::px::Size::measured(width, height),
            // Drawn at 1:1, where the frame's own buffer is what a canvas pixel covers.
            max_lod: 0,
        };
        let grade = super::Grade {
            colour: Some(&colour),
            exposure: Stops::measured(0.5),
            output: super::Output::Rolled,
            canvas: Some(shown),
            ..super::Grade::new(
                width,
                height,
                crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let peak = gpu.scene_peak();
        let uploaded = gpu.upload(&frame, &grade, &peak);
        let shipped = uploaded.encode(&grade);
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");
        let drawn = uploaded.draw(&grade, &pyramid);

        let mut mapping: std::collections::HashMap<[u16; 3], [f32; 3]> =
            std::collections::HashMap::new();
        let mut compared = 0usize;
        for y in 0..height {
            for x in 0..width {
                // The smoothing's reach and two pixels more in from every block edge, and as
                // clear of the spike: a cubic reaches one back and two forward, so this is where
                // every tap of both routes is inside one value.
                let inside = |at: usize| at % BLOCK >= margin && at % BLOCK < BLOCK - margin;
                if !inside(x) || !inside(y) || x.abs_diff(SPIKE) <= margin {
                    continue;
                }
                let at = y * width + x;
                let ships = [shipped[at * 3], shipped[at * 3 + 1], shipped[at * 3 + 2]];
                let shows = [drawn[at * 4], drawn[at * 4 + 1], drawn[at * 4 + 2]];
                match mapping.get(&ships) {
                    None => {
                        mapping.insert(ships, shows);
                    }
                    Some(first) => assert_eq!(
                        *first, shows,
                        "the rendition writes {ships:?} at ({x}, {y}) where it wrote it before, \
                         and the draw shows {shows:?} rather than {first:?}",
                    ),
                }
                compared += 1;
            }
        }

        // Thousands of pixels onto sixteen values, so the equality above is a comparison between
        // scattered blocks rather than a key that is only ever written once.
        assert!(compared > 10_000, "only {compared} pixels were inside a block");
        assert_eq!(mapping.len(), SHADES, "the frame did not reach the shades it was built with");
        let lit = mapping.values().filter(|shows| shows.iter().any(|v| *v > 0.01)).count();
        assert!(lit > SHADES / 2, "only {lit} of {SHADES} drawn values were above black");

        // **And the two agree about *where*.** Everything above holds for a canvas offset by a
        // pixel, every tap of both routes being inside one flat block; the spike is one pixel wide,
        // so the column it lands in is the whole of what says `covered`'s footprint starts where
        // `coded_at`'s does. Their last expressions differ - one lays taps out over a region and
        // the other indexes the output - which is exactly where an offset would come from.
        let brightest = |row: usize, of: &dyn Fn(usize) -> f32| {
            (0..width)
                .max_by(|a, b| of(row * width + a).total_cmp(&of(row * width + b)))
                .expect("a row has pixels")
        };
        for row in [3usize, 40, 71, 125] {
            let ships = brightest(row, &|at| f32::from(shipped[at * 3]));
            let shows = brightest(row, &|at| drawn[at * 4]);
            assert_eq!(ships, SPIKE, "the rendition put row {row}'s spike at {ships}");
            assert_eq!(shows, ships, "the draw put row {row}'s spike at {shows}, not {ships}");
        }
    }

    /// The zoomed-out draw reads the pyramid at the level and the place the frame's own draw would.
    ///
    /// **`FROM_FRAME` is false here, and nothing else ever makes it false.** Every other case in
    /// this file draws at 1:1 or with no pyramid at all, so `pyramid_cubic`, the per-tap decode and
    /// the `lod - 1` that turns a draw's level into a texture's were dispatched by nothing. A
    /// transposed index or an off-by-one on the level is invisible at 1:1 and wrong the moment a
    /// reader zooms out, which is the half of the editor nobody is looking at pixel-for-pixel.
    ///
    /// **Held against the *other draw path*, not against a second copy of the arithmetic.** At a
    /// ratio of exactly two the canvas is the frame halved, and `base::pyramid`'s level 0 is the
    /// frame halved, so one canvas pixel covers one texel: what the pyramid path shows for a block
    /// must be what the frame path shows for the same block, since averaging one value gives that
    /// value. `every_pyramid_level_is_a_mean_of_the_four_above_it` already holds the level itself
    /// to the frame, so a disagreement here is the draw's indexing and not the pyramid's contents.
    ///
    /// Blocks, and a frame that is not square with a shade that weighs its two axes differently:
    /// reading the level transposed lands in another block rather than the same value.
    #[test]
    fn the_zoomed_out_draw_reads_the_level_the_frame_would() {
        let Some(gpu) = super::device() else { return };
        let Some(base) = crate::base::device(gpu) else { return };

        // Wide enough that a block has an interior beyond the chroma smoothing's reach from
        // its edges, on the halved canvas too (`the_draw_shows_what_the_rendition_ships`).
        const BLOCK: usize = 128;
        let (width, height) = (1024usize, 512usize);
        let across = width / BLOCK;
        let shade = |bx: usize, by: usize| (bx * 3 + by * 11) % 16;

        let mut frame: Vec<u16> = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let tone = shade(x / BLOCK, y / BLOCK);
                for channel in 0..3 {
                    frame.push(((tone * 1900 + channel * 430) % 31000) as u16);
                }
            }
        }

        let colour = crate::hdr_fit::HdrColour::identity();
        let grade = |canvas: super::Canvas| super::Grade {
            colour: Some(&colour),
            exposure: Stops::measured(0.5),
            output: super::Output::Rolled,
            canvas: Some(canvas),
            ..super::Grade::new(
                width,
                height,
                crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");
        assert!(pyramid.levels > 0, "the frame was too small to build a level to read");

        // The frame's own buffer, at 1:1: `max_lod` of zero is what makes it so whatever the ratio.
        let at_one = grade(super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: crate::px::Size::measured(width, height),
            max_lod: 0,
        });
        // The same region on half the canvas, which is a ratio of two - the point `gpu.rs` stops
        // choosing the frame and starts choosing a level.
        let (canvas_w, canvas_h) = (width / 2, height / 2);
        let zoomed = grade(super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: crate::px::Size::measured(canvas_w, canvas_h),
            max_lod: pyramid.levels,
        });

        let peak = gpu.scene_peak();
        let uploaded = gpu.upload(&frame, &at_one, &peak);
        let close = uploaded.draw(&at_one, &pyramid);
        let far = uploaded.draw(&zoomed, &pyramid);

        // The smoothing's reach and two canvas pixels more in from every block edge, so all four
        // taps, the cubic's own reach and the neighbourhood the chroma is read from stay inside
        // one value at both scales.
        let margin =
            super::chroma_smooth_reach(crate::px::Span::measured(width)).raw().div_ceil(2) + 2;
        let block_on_canvas = BLOCK / 2;
        let mut compared = 0usize;
        for cy in 0..canvas_h {
            for cx in 0..canvas_w {
                let (inx, iny) = (cx % block_on_canvas, cy % block_on_canvas);
                if !(margin..block_on_canvas - margin).contains(&inx)
                    || !(margin..block_on_canvas - margin).contains(&iny)
                {
                    continue;
                }
                let (bx, by) = (cx / block_on_canvas, cy / block_on_canvas);
                let centre = (by * BLOCK + BLOCK / 2) * width + bx * BLOCK + BLOCK / 2;
                let one = &close[centre * 4..centre * 4 + 3];
                let at = cy * canvas_w + cx;
                let two = &far[at * 4..at * 4 + 3];
                for channel in 0..3 {
                    assert!(
                        (one[channel] - two[channel]).abs() < 1e-3,
                        "block ({bx}, {by}) draws {:?} from the frame and {:?} from the level, at \
                         canvas ({cx}, {cy})",
                        one,
                        two,
                    );
                }
                compared += 1;
            }
        }
        assert!(compared > 1_000, "only {compared} canvas pixels were inside a block");

        // And the shades genuinely differ, so the equality above is not every block drawing black.
        let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
        for by in 0..height / BLOCK {
            for bx in 0..across {
                let centre = (by * BLOCK + BLOCK / 2) * width + bx * BLOCK + BLOCK / 2;
                seen.insert(close[centre * 4].to_bits());
            }
        }
        assert!(seen.len() > 8, "the frame drew only {} distinct values", seen.len());
    }

    /// The editor's peak against the rendition's, across the exposure slider's whole range.
    ///
    /// **What `collect` and `remeasure` rest on.** A tick cannot re-sweep the frame at every
    /// slider position, so the brightest of the sampled million are kept once and only those are
    /// graded again - and that is sound only if the exposure cannot reorder the frame enough to
    /// push an uncollected pixel into the top hundred. Where it is not, the editor rolls its
    /// highlights off at a knee the export does not, and the reader is looking at a picture the
    /// file will not contain.
    ///
    /// It is arithmetic, so it is answered here rather than by opening a page. What rests on it is
    /// `wasm::HeldRaw::draw`, which re-measures every tick off the candidates the open collected.
    ///
    /// **A compressive curve, per channel, and it is the whole point of the fixture.**
    /// `HdrColour::identity()` is a straight line, which makes the exposure a global gain: every
    /// pixel scales by the same factor, nothing can reorder, and this would report a perfect
    /// agreement it had not earned. A fitted frame's curves compress highlights, so a bright pixel
    /// gains less than a dim one - the only thing that can move a pixel in or out of the top
    /// hundred - and the shoulder differs per channel because the peak is over the maximum
    /// channel, which three identical curves would make a function of luma alone.
    #[test]
    fn the_kept_candidates_answer_as_the_whole_sample_does() {
        let Some(gpu) = super::device() else { return };

        let mut colour = crate::hdr_fit::HdrColour::identity();
        for (channel, curve) in colour.curves.iter_mut().enumerate() {
            let shoulder = 0.5 + channel as f64 * 0.08;
            let bins = curve.len();
            for (at, value) in curve.iter_mut().enumerate() {
                let x = (at as f64 / (bins - 1) as f64) * crate::hdr_fit::TRUST_CEILING;
                *value = x / (1.0 + x * shoulder) * (1.0 + shoulder);
            }
        }

        // A ramp with a specular tail on it: the quantile is a rank near the top, so a frame
        // whose brightest pixels are all one value is answered the same way by any rule at all.
        //
        // **Coded to land under the trust ceiling**, which is where the curve is a curve.
        // `curves_at` divides a pixel past the ceiling down, samples there and scales back, so
        // above it the transform is homogeneous by construction and the exposure is a gain again -
        // a frame coded to full scale is 49 render units and every one of these ranks is decided
        // in that straight part.
        let (width, height) = (256usize, 192usize);
        let mut frame: Vec<u16> = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let ramp = ((x * 26000) / width) as u16;
                let speck = (x * 7 + y * 13) % 991 == 0;
                for channel in 0..3u16 {
                    frame.push(match speck {
                        true => 34000 - channel * 700,
                        false => ramp.saturating_sub(channel * 300),
                    });
                }
            }
        }

        let at = |exposure: Stops| super::Grade {
            colour: Some(&colour),
            exposure,
            ..super::Grade::new(
                width,
                height,
                crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let peak = gpu.scene_peak();
        // The open: `measure` over the sample, `quantile` for the threshold, then `collect`.
        let uploaded = gpu.upload(&frame, &at(Stops::ZERO), &peak);
        uploaded.collect_candidates(&at(Stops::ZERO));

        let mut worst = 0.0f64;
        let mut sampled: Vec<(f64, f64)> = Vec::new();
        for exposure in [-5.0, -2.0, -0.5, 0.0, 1.0, 2.0, 3.5, 5.0] {
            uploaded.peak_from_candidates(&at(Stops::measured(exposure)));
            let kept = f64::from(gpu.read_peak(&peak));
            uploaded.measure_peak(&at(Stops::measured(exposure)));
            let whole = f64::from(gpu.read_peak(&peak));
            assert!(whole > 0.0, "the whole sample read no peak at all at {exposure} stops");
            worst = worst.max((kept - whole).abs() / whole);
            sampled.push((exposure, whole));
        }

        // **The curve compresses, so the agreement above is one this fixture could have failed.**
        // Under a straight line the peak would be its neutral value times the gain exactly, at
        // every stop, and no pixel could overtake another however far the slider moved.
        let (_, neutral) = sampled[sampled.iter().position(|(ev, _)| *ev == 0.0).expect("0 EV")];
        let (top, lit) = *sampled.last().expect("a brightest exposure");
        // 27.97x against the 32 a gain would give, measured; a straight line read 32.01, so the
        // bar sits between them rather than at either.
        assert!(
            lit < neutral * 2f64.powf(top) * 0.95,
            "a gain of {top} stops took the peak from {neutral:.1} to {lit:.1}, which is the \
             straight line this fixture exists to avoid",
        );

        // **And the histogram's range travels with the exposure**, which is the other thing these
        // eight measurements can say. `bin_of` spans a fixed 28 stops around the *reference*, and
        // getting that wrong fails in two directions, neither of them as an error:
        //
        // - A top fixed at a few times reference saturates, and the peak stops climbing. On screen
        //   that is highlights clipping a couple of stops up the slider.
        // - A range grown with the gain loses the values instead, the curve compressing faster
        //   than the range opens, and the peak falls towards nothing - the picture going dark and
        //   flat at particular slider positions.
        //
        // Rising catches both. Tracking the gain catches the first on its own, and needs a band
        // rather than a number because the curve is allowed to bend it: this fixture's shoulder
        // takes it 12.6% under at +5 stops, where a fitted frame sits near 5% and a saturating
        // histogram reads 35%. So the compression guard above and this one bound it from either
        // side, and the fixture has to sit between them.
        for pair in sampled.windows(2) {
            let ((was, lower), (now, higher)) = (pair[0], pair[1]);
            assert!(
                higher > lower,
                "the peak went {lower:.1} to {higher:.1} from {was} to {now} stops, which is a \
                 histogram losing its values rather than binning them",
            );
        }
        for (ev, whole) in sampled.iter().copied().filter(|(ev, _)| *ev >= 0.0) {
            let gain = 2f64.powf(ev);
            let drift = (whole / neutral / gain - 1.0).abs();
            assert!(
                drift < 0.2,
                "the peak at {ev} stops is {:.2}x neutral against {gain:.0}x, {:.1}% off - which \
                 is the histogram saturating rather than the curve bending",
                whole / neutral,
                drift * 100.0,
            );
        }

        // Measured at zero: the sample is small enough here that every pixel above the threshold
        // fits inside `CANDIDATES`, so the two routes rank the same set and land in the same bin.
        // A tolerance rather than equality because what has to hold is the knee, and the bins are
        // 8192 over 28 stops - a shuffle of one is 0.24% of a value.
        eprintln!(
            "{top} stops took the peak to {:.2}x, not {:.0}x; the candidates differ from the \
             whole sample by {:.4}%",
            lit / neutral,
            2f64.powf(top),
            worst * 100.0,
        );
        assert!(worst < 0.005, "the two peak routes differ by {:.3}%", worst * 100.0);
    }

    /// The exposure does not drag the picture onto the lattice's outermost level.
    ///
    /// **The camera match is a function of the colour the camera rendered**, and the fit only ever
    /// saw the levels that colour had. Exposed first and matched afterwards, a frame lifted four
    /// stops reads the top level node whatever it was - and takes, everywhere, the correction
    /// fitted for the one thing that sat up there, which is a clipping highlight. On a real fit
    /// that is a magenta cast arriving as the slider goes up.
    ///
    /// A lattice that is the identity everywhere but its top level plane, so the only thing that
    /// can tint this grey is having been read at the wrong level.
    #[test]
    fn the_exposure_does_not_move_which_lattice_node_the_match_reads() {
        let Some(gpu) = super::device() else { return };

        let (width, height) = (32usize, 32usize);
        let frame: Vec<u16> = vec![24000; width * height * 3];
        let mut colour = crate::hdr_fit::HdrColour::identity();
        // `NODE_VALUES`: the 2x2 on chroma, then the two luma-to-chroma terms, then lightness. The
        // sixth is what takes a neutral towards blue in proportion to its level, which is the one
        // way a node can tint a grey at all.
        let tints_blue = [1.0, 0.0, 0.0, 1.0, 0.0, 0.4, 1.0, 0.0, 0.0];
        let leaves_it = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let top = crate::hdr_fit::ChromaMap::identity().shape().level_count - 1;
        colour.chroma = Some(crate::hdr_fit::ChromaMap::from_nodes(|_, _, level| {
            match level == top {
                true => tints_blue,
                false => leaves_it,
            }
        }));
        let grade = |exposure| super::Grade {
            colour: Some(&colour),
            exposure,
            output: super::Output::Rolled,
            ..super::Grade::new(
                width,
                height,
                crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let cast = |exposure: f64| {
            let exposure = Stops::measured(exposure);
            let peak = gpu.scene_peak();
            let out = gpu.upload(&frame, &grade(exposure), &peak).encode(&grade(exposure));
            let (r, g, b) = (f64::from(out[0]), f64::from(out[1]), f64::from(out[2]));
            assert!(g > 1000.0, "the grey came out at {r}, {g}, {b} at {} stops", exposure.raw());
            (b - g) / g
        };

        // The lattice this grey reads at rest is the identity, so it leaves as it arrived. Asserted
        // rather than assumed: a grey bright enough to sit on the top plane already would make the
        // comparison below pass on a frame that is tinted at both exposures.
        let rest = cast(0.0);
        assert!(rest.abs() < 0.01, "the unexposed grey is already {:.1}% blue", rest * 100.0);
        let lifted = cast(4.0);
        assert!(
            lifted.abs() < 0.01,
            "four stops took the same grey {:.1}% blue, which is the top level node's tint",
            lifted * 100.0,
        );
    }

    /// The temperature reaches a frame that is already up.
    ///
    /// **The editor holds one upload for the life of an open**, so anything the balance is
    /// settled with there is settled for every tick after it - and a Temperature drag then moves
    /// a slider that changes no pixel, on the one host where that drag exists. Two draws off one
    /// [`Uploaded`], which is the shape a tick has and the shape a rendition never has.
    #[test]
    fn the_balance_follows_the_slider_after_the_frame_is_up() {
        let Some(gpu) = super::device() else { return };
        let Some(base) = crate::base::device(gpu) else { return };

        let (width, height) = (64usize, 64usize);
        let frame: Vec<u16> = (0..width * height * 3).map(|i| ((i * 37) % 30000) as u16).collect();
        let colour = crate::hdr_fit::HdrColour::identity();
        let shown = super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: crate::px::Size::measured(width, height),
            max_lod: 0,
        };
        let grade = |adjust| super::Grade {
            colour: Some(&colour),
            adjust,
            // Without one there is no illuminant to move away from and the shader is right to
            // leave the frame alone, which would make this test pass on a broken balance.
            as_shot: Some(crate::white_balance::AsShot { temperature: 5500.0, tint: 0.0 }),
            output: super::Output::Rolled,
            canvas: Some(shown),
            ..super::Grade::new(
                width,
                height,
                crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };

        let peak = gpu.scene_peak();
        let uploaded = gpu.upload(&frame, &grade(super::Adjust::none()), &peak);
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");

        let unmoved = uploaded.draw(&grade(super::Adjust::none()), &pyramid);
        let warmed = super::Adjust { temperature: Some(3000.0), ..super::Adjust::none() };
        let moved = uploaded.draw(&grade(warmed), &pyramid);

        let apart = unmoved
            .iter()
            .zip(&moved)
            .filter(|(before, after)| (**before - **after).abs() > 1e-3)
            .count();
        assert!(
            apart > unmoved.len() / 4,
            "2500K off the frame's own illuminant moved {apart} of {} drawn components",
            unmoved.len(),
        );
    }

    /// A slider that reads the neighbourhood reaches a frame that is already up.
    ///
    /// **The editor uploads once, at `Adjust::none()`, and grades every tick off that upload**
    /// (`wasm.rs`), where a rendition uploads with the edit it is about to apply. So any resource
    /// an upload builds from the adjust it was handed is a resource the editor never gets: the
    /// reader moves Shadows off zero, the tick samples whatever stands in for the blur, reads a
    /// neighbourhood of zero stops, and weights every zone as though the pixel sat that far above
    /// its surroundings. Silent, and only on the one host nothing else exercises.
    ///
    /// Held against a one-shot `encode` of the same adjust rather than against a number, because
    /// what has to be true is that the editor and a rendition are one implementation.
    #[test]
    fn a_neighbourhood_slider_reaches_a_frame_that_is_already_up() {
        let Some(gpu) = super::device() else { return };
        let Some(base) = crate::base::device(gpu) else { return };

        let (width, height) = (64usize, 64usize);
        // Structured rather than flat: the neighbourhood only differs from the pixel where there
        // is something to average, so a uniform frame would agree however `detail` was built.
        let mut frame: Vec<u16> = (0..width * height * 3)
            .map(|i| {
                let (x, y) = ((i / 3) % width, (i / 3) / width);
                match (x / 8 + y / 8) % 2 == 0 {
                    true => 26000,
                    false => 1200,
                }
            })
            .collect();
        // Coded and anchored as every other caller hands a frame over, so the dark squares grade
        // to counts a lift can be read off rather than to zero.
        let levels = crate::hdr::levels_of(gpu, &frame, width, height, 0.995).expect("levels");
        crate::hdr::code_base(&mut frame, levels.anchored(), Light::exactly(203.0));
        let colour = crate::hdr_fit::HdrColour::identity();
        let shown = super::Canvas {
            region: (0.0, 0.0, width as f64, height as f64),
            size: crate::px::Size::measured(width, height),
            max_lod: 0,
        };
        let grade = |adjust, canvas| super::Grade {
            colour: Some(&colour),
            adjust,
            output: super::Output::Rolled,
            canvas,
            ..super::Grade::new(width, height, levels, Light::exactly(203.0), Light::exactly(1000.0))
        };
        let rest = super::Adjust::none();

        let peak = gpu.scene_peak();
        let held = gpu.upload(&frame, &grade(rest, None), &peak);
        // The open's own sequence (`wasm.rs`): the candidates are kept once, and the knee is
        // re-measured off them every tick, because the peak is read after the sliders.
        held.collect_candidates(&grade(rest, None));
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");

        // **The parity below is symmetric, so it cannot see a blur nobody builds**: stub the
        // texture for every caller and the two hosts agree perfectly on the same wrong picture.
        // This is the asymmetric half - the dark squares of the checker are what Shadows is for,
        // and a neighbourhood read as zero stops puts every one of them far above its zone.
        let at_rest = held.encode(&grade(rest, None));
        let dark_mean = |graded: &[u16]| {
            let (mut total, mut count) = (0.0f64, 0u64);
            for (pixel, sample) in graded.iter().step_by(3).enumerate() {
                if (pixel % width / 8 + pixel / width / 8) % 2 != 0 {
                    total += f64::from(*sample);
                    count += 1;
                }
            }
            total / count as f64
        };

        for (name, adjust) in [
            ("shadows", super::Adjust { shadows: 100.0, ..rest }),
            ("highlights", super::Adjust { highlights: -100.0, ..rest }),
            ("clarity", super::Adjust { clarity: 100.0, ..rest }),
            ("dehaze", super::Adjust { dehaze: 100.0, ..rest }),
        ] {
            held.peak_from_candidates(&grade(adjust, None));
            let ticked = held.encode(&grade(adjust, None));
            let rendered = gpu.encode(&frame, &grade(adjust, None));
            let worst = ticked
                .iter()
                .zip(&rendered)
                .map(|(tick, render)| i64::from(*tick).abs_diff(i64::from(*render)))
                .max()
                .expect("a graded frame");
            // Exactly, not nearly: the same shader over the same frame on the same device, so
            // any difference at all is a resource one host built and the other did not.
            assert_eq!(
                worst, 0,
                "{name} at the end of its range read back {worst} counts apart from a rendition \
                 of the same edit: the tick is grading against a neighbourhood the upload never \
                 built",
            );

            if name == "shadows" {
                let (was, now) = (dark_mean(&at_rest), dark_mean(&ticked));
                assert!(was > 1.0, "the checker's dark squares grade to {was:.0}, so a lift of \
                     them would be unmeasurable and this fixture proves nothing");
                assert!(
                    now > was * 1.2,
                    "shadows at +100 took the checker's dark squares from {was:.0} to {now:.0}: \
                     the zone is being weighted by a neighbourhood of zero stops, which puts \
                     every dark pixel above the range the slider covers",
                );
            }

            // And again through `draw`, which is the entry point a tick actually takes
            // (`wasm.rs` calls `present`, which calls `draw_into`) and a different bind group
            // from the readback above. Against an upload made *with* the slider already set,
            // which is the same photograph opened with the edit already on it.
            let opened = gpu.upload(&frame, &grade(adjust, Some(shown)), &gpu.scene_peak());
            opened.collect_candidates(&grade(adjust, Some(shown)));
            opened.peak_from_candidates(&grade(adjust, Some(shown)));
            let dragged = held.draw(&grade(adjust, Some(shown)), &pyramid);
            let reopened = opened.draw(&grade(adjust, Some(shown)), &pyramid);
            let apart = dragged
                .iter()
                .zip(&reopened)
                .map(|(drag, open)| (drag - open).abs())
                .fold(0.0f32, f32::max);
            assert!(
                apart < 1e-5,
                "{name} drew {apart} apart depending on whether it was set before the open or \
                 dragged after it, which is the same picture either way",
            );
        }
    }

    /// A temperature drag draws what a rendition of the same temperature renders.
    ///
    /// **The editor uploads once at `Adjust::none()` and grades every tick off that upload**
    /// (`wasm.rs`), so anything the upload derives from the balance is a thing the two hosts
    /// disagree about the moment the reader moves it. `chroma_smoothed` is that: it encodes
    /// `matched_scene`, the balance is upstream of `matched_scene`, and the blend in
    /// `colour.slang` *replaces* a pixel's chroma with this neighbourhood's - so a texture built
    /// at one illuminant and read at another puts the old colour back and the slider does nothing
    /// whatever. Measured at 2000K on a daylight frame before the rebuild: the tick came out
    /// 3851, 3746, 3916 against the rendition's 1441, 3749, 27156.
    ///
    /// Not to the byte, which is why this is not folded into
    /// `a_neighbourhood_slider_reaches_a_frame_that_is_already_up`: the knee a tick rolls against
    /// is re-measured off the candidates the open kept rather than off the whole frame, so the two
    /// differ by a fraction of a percent by construction. What is being ruled out is a host that
    /// balances and one that does not.
    #[test]
    fn a_temperature_drag_draws_what_a_rendition_of_it_renders() {
        let Some(gpu) = super::device() else { return };

        let (width, height) = (64usize, 64usize);
        let mut frame: Vec<u16> = (0..width * height * 3)
            .map(|i| {
                // Coloured rather than neutral: a balance moves channels against each other, and
                // a grey frame would agree between the two hosts however wrong both were.
                let (x, y) = ((i / 3) % width, (i / 3) / width);
                let channel = i % 3;
                (6000.0 + 4000.0 * ((x + y * 2 + channel * 7) % 11) as f64) as u16
            })
            .collect();
        let levels = crate::hdr::levels_of(gpu, &frame, width, height, 0.995).expect("levels");
        crate::hdr::code_base(&mut frame, levels.anchored(), Light::exactly(203.0));

        let colour = crate::hdr_fit::HdrColour::identity();
        let grade = |adjust| super::Grade {
            colour: Some(&colour),
            adjust,
            // Without one the balance has no illuminant to move away from and every temperature
            // below is the identity, which would make this pass on a host that ignores the pair.
            as_shot: Some(crate::white_balance::AsShot { temperature: 5500.0, tint: 12.0 }),
            output: super::Output::Rolled,
            ..super::Grade::new(width, height, levels, Light::exactly(203.0), Light::exactly(1000.0))
        };

        let rest = super::Adjust::none();
        let peak = gpu.scene_peak();
        let held = gpu.upload(&frame, &grade(rest), &peak);
        held.collect_candidates(&grade(rest));

        for kelvin in [2000.0, 2800.0, 4000.0, 6500.0, 12000.0] {
            for tint in [-40.0, 0.0, 40.0] {
                let moved = super::Adjust {
                    temperature: Some(kelvin),
                    tint: Some(tint),
                    ..rest
                };
                held.peak_from_candidates(&grade(moved));
                let ticked = held.encode(&grade(moved));
                let rendered = gpu.encode(&frame, &grade(moved));

                let (apart, level) = ticked.iter().zip(&rendered).fold(
                    (0.0f64, 0.0f64),
                    |(apart, level), (tick, render)| {
                        (
                            apart + (f64::from(*tick) - f64::from(*render)).abs(),
                            level + f64::from(*render),
                        )
                    },
                );
                let off = apart / level.max(1.0) * 100.0;
                assert!(
                    off < FAITHFUL,
                    "at {kelvin}K tint {tint} the editor's tick is {off:.2}% from a rendition of \
                     the same balance: one of the two is grading against an illuminant the other \
                     is not",
                );
            }
        }
    }

    #[test]
    fn a_neutral_draw_over_a_matched_upload_is_the_neutral_picture() {
        let Some(gpu) = super::device() else { return };
        let Some(base) = crate::base::device(gpu) else { return };

        let (width, height) = (64usize, 64usize);
        let frame: Vec<u16> = (0..width * height * 3)
            .map(|i| {
                let (x, y) = ((i / 3) % width, (i / 3) / width);
                (6000.0 + 4000.0 * ((x + y * 2 + (i % 3) * 7) % 11) as f64) as u16
            })
            .collect();
        let mut colour = crate::hdr_fit::HdrColour::identity();
        for (channel, curve) in colour.curves.iter_mut().enumerate() {
            let shoulder = 0.5 + channel as f64 * 0.08;
            let bins = curve.len();
            for (at, value) in curve.iter_mut().enumerate() {
                let x = (at as f64 / (bins - 1) as f64) * crate::hdr_fit::TRUST_CEILING;
                *value = x / (1.0 + x * shoulder) * (1.0 + shoulder);
            }
        }
        let grade = |adjust: super::Adjust| super::Grade {
            colour: adjust.colour(Some(&colour)),
            adjust,
            output: super::Output::Rolled,
            canvas: Some(super::Canvas {
                region: (0.0, 0.0, width as f64, height as f64),
                size: crate::px::Size::measured(width, height),
                max_lod: 0,
            }),
            ..super::Grade::new(
                width,
                height,
                crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                Light::exactly(203.0),
                Light::exactly(1000.0),
            )
        };
        let matched = super::Adjust::none();
        let neutral =
            super::Adjust { colour_profile: super::ColourProfile::None, ..super::Adjust::none() };
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");

        let editor = gpu.upload(&frame, &grade(matched), &gpu.scene_peak());
        let rendition = gpu.upload(&frame, &grade(neutral), &gpu.scene_peak());

        let shown = editor.draw(&grade(neutral), &pyramid);
        assert_eq!(shown, rendition.draw(&grade(neutral), &pyramid));
        assert_ne!(shown, editor.draw(&grade(matched), &pyramid), "the match moved nothing");
    }

    /// How far a tick may sit from a rendition of the same balance, as a share of its level.
    ///
    /// Loose, because the knee differs by construction and this is not a parity fixture; tight
    /// enough that a host applying no balance at all cannot pass, which at these temperatures is
    /// tens of percent out.
    const FAITHFUL: f64 = 2.0;

    /// The forward map against the inverse, over the slider's whole range.
    ///
    /// **The one property neither entry point can check alone.** `xy_of` turns a temperature
    /// and a tint into a chromaticity and `as_shot` walks it back, over one locus table but by
    /// different arithmetic - a search against a closed form - so a chromaticity that goes out
    /// has to come back. What would break is quiet: a Lightroom sidecar's 5000K would land on
    /// an illuminant that is not Lightroom's 5000K, and the photograph would simply be the
    /// wrong colour.
    ///
    /// Run through a probe entry point rather than through a rendition, because a matrix that
    /// happens to look plausible is exactly what this is trying not to accept.
    #[test]
    fn the_shader_solves_the_illuminant_this_crate_reads_back() {
        let Some(gpu) = super::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the white balance maps were not compared. \
                 Nothing else checks that the shader and this crate agree about an illuminant.",
            );
            return;
        };
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("probe_xy"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/probe_xy.wgsl")).into(),
            ),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("probe_xy"),
            entries: &[
                super::Binding::Uniform.entry(0),
                super::Binding::Storage { read_only: false }.entry(14),
            ],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("probe_xy"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("probe_xy"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            })),
            module: &module,
            entry_point: Some("probe_xy"),
            compilation_options: Default::default(),
            cache: None,
        });
        let out = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe_xy"),
            size: super::BALANCE_FLOATS * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("probe_xy"),
            size: 8,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let colour = crate::hdr_fit::HdrColour::identity();
        let mut worst_temperature = 0.0f64;
        let mut worst_tint = 0.0f64;
        // The document's whole range, and the tint's, including the ends where the locus table
        // is coarsest and a transcription slip would show first.
        for temperature in [2000.0, 2700.0, 3200.0, 5000.0, 5500.0, 6500.0, 10000.0, 20000.0, 50000.0] {
            for tint in [-150.0, -50.0, 0.0, 25.0, 150.0] {
                let asked = crate::white_balance::AsShot { temperature, tint };
                let grade = super::Grade {
                    adjust: super::Adjust {
                        temperature: Some(temperature),
                        tint: Some(tint),
                        ..super::Adjust::none()
                    },
                    as_shot: Some(asked),
                    ..super::Grade::new(
                        1,
                        1,
                        crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                        Light::exactly(203.0),
                        Light::exactly(1000.0),
                    )
                };
                let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("probe_xy"),
                    contents: &super::uniform(&grade, &colour),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("probe_xy"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                        wgpu::BindGroupEntry { binding: 14, resource: out.as_entire_binding() },
                    ],
                });
                let mut encoder = device.create_command_encoder(&Default::default());
                {
                    let mut pass = encoder.begin_compute_pass(&Default::default());
                    pass.set_pipeline(&pipeline);
                    pass.set_bind_group(0, &group, &[]);
                    pass.dispatch_workgroups(1, 1, 1);
                }
                encoder.copy_buffer_to_buffer(&out, 0, &readback, 0, 8);
                gpu.queue.submit([encoder.finish()]);
                let slice = readback.slice(..);
                slice.map_async(wgpu::MapMode::Read, |_| {});
                device.poll(wgpu::PollType::wait_indefinitely()).expect("the probe finished");
                let (x, y) = {
                    let mapped = slice.get_mapped_range().expect("the readback mapped");
                    let read = |at: usize| {
                        f64::from(f32::from_le_bytes([
                            mapped[at],
                            mapped[at + 1],
                            mapped[at + 2],
                            mapped[at + 3],
                        ]))
                    };
                    (read(0), read(4))
                };
                readback.unmap();

                // The camera that reports the probed chromaticity outright: multipliers of one,
                // and a matrix whose inverse is that chromaticity's tristimulus values. Diagonal
                // rather than the identity with the values as multipliers, because a tint far off
                // the locus puts `Z` negative and a negative multiplier is a decline.
                let (big_x, big_z) = (x / y, (1.0 - x - y) / y);
                let back = pollster::block_on(crate::white_balance::as_shot(
                    gpu,
                    &[1.0, 1.0, 1.0, 0.0],
                    &[
                        [(1.0 / big_x) as f32, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, (1.0 / big_z) as f32],
                        [0.0, 0.0, 0.0],
                    ],
                ))
                .expect("an invertible matrix");
                worst_temperature = worst_temperature
                    .max((back.temperature - temperature).abs() / temperature);
                worst_tint = worst_tint.max((back.tint - tint).abs());
                // Measured at 0.011% and 0.00, which is `f32` in the shader against `f64`
                // here rather than any disagreement about the locus. Bounded well inside what
                // a transcription slip costs - one wrong digit moves a temperature by percent
                // - and well outside what another GPU's rounding can.
                assert!(
                    (back.temperature - temperature).abs() < temperature * 0.005
                        && (back.tint - tint).abs() < 0.5,
                    "the shader put {temperature}K tint {tint} at ({x:.5}, {y:.5}), which this \
                     crate reads back as {:.0}K tint {:.1}",
                    back.temperature,
                    back.tint,
                );
            }
        }
        // Reported even on success: the two maps interpolate the same table differently, so
        // the round trip is close rather than exact, and how close is worth knowing before
        // anybody tightens the bound above.
        eprintln!(
            "white balance round trip: worst {:.3}% on temperature, {worst_tint:.2} on tint",
            worst_temperature * 100.0,
        );
    }

    /// The shader's crop against this crate's, pixel for pixel.
    ///
    /// Both hosts run the shader, so this holds no two renderers together - what it
    /// pins is `geometry.slang` against `image::Plan::at`, which is the mapping Rust needs to work
    /// out what a cropped render has to decode. The two are four lines of arithmetic each and
    /// nothing else compares them.
    ///
    /// Every case moves something the arithmetic could get wrong: a crop off-centre, a
    /// straighten in both directions, each quarter turn, and the two composed.
    #[test]
    fn the_draw_places_a_pixel_where_the_gather_does() {
        let Some(gpu) = super::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the editor's crop was not compared with the \
                 gather's. Nothing else checks that the preview is the picture.",
            );
            return;
        };
        let device = &gpu.device;
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("probe_geometry"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/probe_geometry.wgsl")).into(),
            ),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("probe_geometry"),
            entries: &[
                super::Binding::Uniform.entry(0),
                super::Binding::Storage { read_only: false }.entry(6),
            ],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("probe_geometry"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("probe_geometry"),
                bind_group_layouts: &[Some(&layout)],
                ..Default::default()
            })),
            module: &module,
            entry_point: Some("probe_geometry"),
            compilation_options: Default::default(),
            cache: None,
        });

        let colour = crate::hdr_fit::HdrColour::identity();
        let full = (263usize, 171usize);
        // A real correction, off `keystone.ts` for a pair of leaning uprights: asymmetric in
        // both the projective terms, so a transposed row or a swapped pair shows up.
        const LEANING: [f64; 8] = [
            0.847_222_222_222_222_2,
            0.0,
            0.076_388_888_888_888_9,
            0.0,
            0.847_222_222_222_222_2,
            0.076_388_888_888_888_9,
            -0.083_333_333_333_333_3,
            -0.125,
        ];
        let cases: [crate::image::Geometry; 10] = [
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 0, None),
            geometry([0.13, 0.07, 0.82, 0.91], 0.0, 0, None),
            geometry([0.0, 0.0, 1.0, 1.0], 7.5, 0, None),
            geometry([0.0, 0.0, 1.0, 1.0], -3.25, 0, None),
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 90, None),
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 270, None),
            geometry([0.2, 0.1, 0.75, 0.66], 4.0, 180, None),
            // A crop under a quarter turn, which is the only case where the stride's axes are
            // swapped. The two turns above carry the identity crop, and that is invariant under
            // the swap - so without this one the whole `span` permutation is unpinned.
            geometry([0.2, 0.1, 0.75, 0.66], 4.0, 90, None),
            // The keystone alone, and then under everything else: it is the one step that is
            // not affine, so the order it composes in is visible in the answer and nowhere else.
            geometry([0.0, 0.0, 1.0, 1.0], 0.0, 0, Some(LEANING)),
            geometry([0.15, 0.2, 0.9, 0.8], -6.0, 270, Some(LEANING)),
        ];

        // Each geometry over the whole photograph, and then over a frame that is a *window* on it -
        // which is what a render whose crop let it decode less is handed. The mapping is the
        // photograph's either way and the origin comes off the answer, so the windowed run has to
        // land exactly the unwindowed one shifted, and that is what is asserted below.
        let mut worst = 0.0f64;
        for (geometry, origin) in
            cases.iter().flat_map(|g| [(*g, (0usize, 0usize)), (*g, (37, 23))])
        {
            let out = crate::hdr::cropped_size(full.0, full.1, geometry);
            let pixels = out.0 * out.1;
            let bytes = (pixels * 2 * 4) as u64;
            let probe = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("probe_geometry"),
                size: bytes,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("probe_geometry"),
                size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });

            let windowed = origin != (0, 0);
            let grade = super::Grade {
                photograph_long: crate::px::Span::measured(full.0.max(full.1)),
                geometry,
                window: match windowed {
                    true => Some(super::Window {
                        photograph: crate::px::Size::exact(full.0, full.1),
                        origin: crate::px::At::exact(origin.0, origin.1),
                    }),
                    false => None,
                },
                // The buffer, which for the windowed run is smaller than the photograph. Nothing in
                // the mapping reads it; what it does is stop the identity short-circuit taking a
                // run that has an origin to subtract.
                ..super::Grade::new(
                    full.0 - origin.0,
                    full.1 - origin.1,
                    crate::tone::Levels { white: Light::measured(1.0), peak: Light::measured(1.0), floor: None },
                    Light::exactly(203.0),
                    Light::exactly(1000.0),
                )
            };
            assert_eq!(grade.output_size(), out, "the probe's grid is not what the grade writes");
            let words = super::uniform_words(&grade, &colour);

            let edits = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("probe_geometry"),
                contents: &words.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("probe_geometry"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: edits.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 6, resource: probe.as_entire_binding() },
                ],
            });

            let mut encoder = device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups(pixels.div_ceil(64) as u32, 1, 1);
            }
            encoder.copy_buffer_to_buffer(&probe, 0, &readback, 0, bytes);
            gpu.queue.submit([encoder.finish()]);
            let slice = readback.slice(..);
            slice.map_async(wgpu::MapMode::Read, |_| {});
            device.poll(wgpu::PollType::wait_indefinitely()).expect("the probe finished");
            let got: Vec<f32> = {
                let mapped = slice.get_mapped_range().expect("the readback mapped");
                mapped
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect()
            };
            readback.unmap();

            for y in 0..out.1 {
                for x in 0..out.0 {
                    let whole =
                        crate::image::geometry_at(full, out, geometry, x as f64 + 0.5, y as f64 + 0.5);
                    // The photograph's answer, moved into the buffer. A window changes where the
                    // pixel is *read*, never where the mapping sent it.
                    let want = (whole.0 - origin.0 as f64, whole.1 - origin.1 as f64);
                    let index = (y * out.0 + x) * 2;
                    let off = ((f64::from(got[index]) - want.0).powi(2)
                        + (f64::from(got[index + 1]) - want.1).powi(2))
                    .sqrt();
                    // `max`, not `>`: a comparison against NaN is false, so a shader that
                    // divided by a degenerate span would leave `worst` at zero and pass.
                    assert!(off.is_finite(), "the draw put pixel ({x}, {y}) nowhere");
                    worst = worst.max(off);
                }
            }
        }
        // In frame pixels, and generous only against `f32` against `f64` over coordinates in
        // the hundreds - a real disagreement about the mapping is a pixel or far more, not a
        // thousandth of one.
        assert!(worst < 0.01, "the draw is {worst:.5} pixels from the gather at worst");
    }

    /// The gamut rotations in `primaries.slang` against the matrices this crate derives.
    ///
    /// This is the pattern the rest of the shared numbers use: written out there, pinned here, so
    /// the two cannot drift without a test saying so.
    ///
    /// `R2020_TO_P3` is the one both hosts read - the editor's draw and the viewer's stage - which
    /// is exactly why a wrong digit in it would agree with itself everywhere and show up nowhere.
    #[test]
    fn the_primaries_match_the_host() {
        pinned("R2020_TO_SRGB", crate::hdr_fit::rec2020_to_srgb());
        pinned("SRGB_TO_R2020", crate::hdr_fit::srgb_to_rec2020());
        pinned("R2020_TO_P3", crate::transfer::Primaries::DISPLAY_P3.from_rec2020());
    }

    fn pinned(name: &str, want: [[f64; 3]; 3]) {
        let found = crate::hdr_fit::in_the_shader(name);
        let rows: Vec<String> = (0..3)
            .map(|row| {
                let v: Vec<String> =
                    (0..3).map(|col| format!("{:>10.6}", want[row][col])).collect();
                format!("    {},", v.join(", "))
            })
            .collect();
        let worst = (0..9)
            .map(|i| (found[i / 3][i % 3] - want[i / 3][i % 3]).abs())
            .fold(0.0f64, f64::max);
        assert!(
            worst < 5e-6,
            "{name} is {worst:.6} out of step with the host's. It should read:\n\
             public static const float3x3 {name} = float3x3(\n{}\n);",
            rows.join("\n").trim_end_matches(','),
        );
    }
}
