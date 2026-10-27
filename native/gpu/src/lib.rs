//! The device: opened once, replaced after a loss, and the only way anything allocates on it.
//!
//! **The device is process-wide and built once.** Adapter enumeration and shader
//! compilation are tens of milliseconds; a rendition job that paid them per photo would
//! spend more there than on the grade. Held behind a `OnceLock` rather than passed down
//! through every caller, because the alternative is threading a device through
//! `job::run` -> `hdr::graded` -> `tone` for a resource there is exactly one of.

#![deny(unsafe_code)]
#![deny(unfulfilled_lint_expectations)]
#![deny(unsafe_op_in_unsafe_fn)]

pub mod compute;
pub mod dispatch;

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
    /// takes only its own (`pmrid`'s cooperative matrices, SPIR-V on Vulkan and MSL on
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
    device: dispatch::Device,
    pub queue: Queue,
    /// Whether each pass is timed, which is what sizes [`Recording::banded`]'s bands.
    timestamps: bool,
    costs: std::sync::Arc<dispatch::Costs>,
    /// [`dispatch::LOSSES`] when this device opened: past it, this device is gone.
    #[cfg(not(target_arch = "wasm32"))]
    opened_after: u64,
    /// Kept because a surface is asked of the instance rather than of the device, and the
    /// editor's canvas or a TV's window arrives long after the device is opened
    /// ([`Stage::attach`], [`surface_stage::SurfaceStage::attach`]).
    #[cfg_attr(not(any(target_arch = "wasm32", target_os = "android")), allow(dead_code))]
    instance: wgpu::Instance,
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    wgpu_adapter: wgpu::Adapter,
    id: u64,
    built: std::sync::Mutex<std::collections::HashMap<usize, &'static std::sync::OnceLock<Box<Built>>>>,
}

#[cfg(not(target_arch = "wasm32"))]
static GPU: std::sync::Mutex<Opened> = std::sync::Mutex::new(Opened::Unasked);

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Copy)]
enum Opened {
    Unasked,
    Open(&'static Gpu),
    /// Lost, and not yet replaced: devices were lost faster than [`LOSSES_TOLERATED`] allows, or
    /// the driver did not answer while it reset. Asked again on the next call.
    Lost(&'static Gpu),
    /// No adapter answered.
    Refused,
}

/// Devices lost within [`LOSS_WINDOW`] past which no other is opened: Windows stops the whole
/// machine (bug check 0x117) at the sixth GPU hang within a minute.
#[cfg(not(target_arch = "wasm32"))]
const LOSSES_TOLERATED: usize = 3;

#[cfg(not(target_arch = "wasm32"))]
const LOSS_WINDOW: std::time::Duration = std::time::Duration::from_secs(10 * 60);

#[cfg(not(target_arch = "wasm32"))]
static REOPENED: std::sync::Mutex<Vec<trace::clock::Mark>> = std::sync::Mutex::new(Vec::new());

/// The device, or None where no adapter of any kind answered.
///
/// None is a refusal, not a fallback. There is no CPU grade to drop to - a second
/// implementation is the drift DESIGN 21.1 guards against - so `job::run` returns an error
/// naming the missing driver and the photo goes unrendered rather than rendered differently.
/// An `Option` rather than a panic so the refusal is the caller's to word.
///
/// A device lost since it opened is replaced here, so the next call after a loss runs on a new one.
#[cfg(not(target_arch = "wasm32"))]
pub fn device() -> Option<&'static Gpu> {
    let mut opened = GPU.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *opened = match *opened {
        Opened::Open(gpu) | Opened::Lost(gpu) if gpu.lost() => reopened(gpu),
        Opened::Unasked => Gpu::new().map_or(Opened::Refused, |gpu| {
            Opened::Open(Box::leak(Box::new(gpu)))
        }),
        held => held,
    };
    let Opened::Open(open) = *opened else {
        return None;
    };
    #[cfg(target_os = "linux")]
    leave::through_exit();
    Some(open)
}

/// The device opened in place of `lost`, unless too many have been lost lately.
///
/// Leaked like the first: a call still running holds the lost one.
#[cfg(not(target_arch = "wasm32"))]
fn reopened(lost: &'static Gpu) -> Opened {
    let mut reopened = REOPENED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    reopened.retain(|at| at.elapsed() < LOSS_WINDOW);
    if reopened.len() >= LOSSES_TOLERATED {
        trace::warn("rawshim gpu: the device was lost too often; no other is opened yet");
        return Opened::Lost(lost);
    }
    let Some(mut next) = Gpu::new() else {
        return Opened::Lost(lost);
    };
    reopened.push(trace::clock::Mark::now());
    lost.succeeded_by(&mut next);
    Opened::Open(Box::leak(Box::new(next)))
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

/// The most storage buffers one shader stage binds: what Firefox on a Mac offers a page, one fewer
/// than Chrome and Safari there, where Windows, Linux and Android mostly offer sixteen. Every host
/// asks for no more, so a kernel that binds a tenth is refused on the machine it was written on
/// rather than on a Mac.
pub const MOST_STORAGE_BUFFERS: u32 = 9;

/// What this device asks for beyond the base, where the adapter has it and nothing where it does
/// not.
///
/// Asked for rather than required: a shader that wants `f16` says so with `enable f16`, and one
/// that does not is unaffected either way, so requesting it can only add. A device that refuses is
/// a device with no adapter, which is a different failure entirely.
///
/// Timestamps size [`Recording::banded`]'s bands; without them a band stays its first size.
///
/// The other three are one thing: PMRID's 1x1 convolutions on the matrix units (`pmrid`).
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
            | wgpu::Features::IMMEDIATES
            | wgpu::Features::TIMESTAMP_QUERY)
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
///
/// A page whose device is lost reloads rather than being handed another: wgpu's unwraps trap
/// mid-call on a lost device, which can leave this instance's state half written.
#[cfg(target_arch = "wasm32")]
pub async fn page_device() -> Option<&'static Gpu> {
    if let Some(open) = PAGE.with(std::cell::Cell::get) {
        return Some(open);
    }
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::BROWSER_WEBGPU,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .ok()?;
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
        trace::warn(&said);
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
    let open: &'static Gpu = Box::leak(Box::new(Gpu::build(adapter, instance, device, queue)));
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
        trace::warn(
            "rawshim: the device did not map a buffer for reading; the stage that asked declines",
        );
        return None;
    };
    let out = take(&buffer.slice(..).get_mapped_range().ok()?);
    buffer.unmap();
    Some(out)
}

/// A mappable buffer's contents as words.
pub async fn read_words(gpu: &Gpu, staging: &wgpu::Buffer) -> Option<Vec<u32>> {
    read_back(gpu, staging, bytemuck::pod_collect_to_vec).await
}

/// The first `count` floats of a storage buffer, copied out through a readback of their own.
pub async fn read_floats(gpu: &'static Gpu, buffer: &Buffer, count: usize) -> Option<Vec<f32>> {
    let bytes = (count * 4) as u64;
    let mut recording = gpu.record();
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("float readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording.copy_buffer_to_buffer(buffer, 0, &readback, 0, bytes);
    recording.submit();
    read_back(gpu, &readback, bytemuck::pod_collect_to_vec).await
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
pub struct Describing<'a>(&'a dispatch::Device);

impl Describing<'_> {
    pub fn create_banded_pipeline(
        &self,
        label: &str,
        module: &wgpu::ShaderModule,
        groups: &[&wgpu::BindGroupLayout],
        entry_point: &str,
        constants: &[(&str, f64)],
    ) -> dispatch::Banded {
        self.0
            .create_banded_pipeline(label, module, groups, entry_point, constants)
    }

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
    /// say (`pmrid`'s cooperative matrices).
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

    pub fn create_bind_group(&self, descriptor: &wgpu::BindGroupDescriptor<'_>) -> wgpu::BindGroup {
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

const SUBMISSIONS_KEPT: usize = 8;

/// The device's queue, remembering where its last few submissions were made: a lost device names
/// no pass, and a submission hanging the GPU loses it.
pub struct Queue {
    queue: wgpu::Queue,
    recent: std::sync::Mutex<Submissions>,
}

type Submissions = std::collections::VecDeque<dispatch::Site>;

impl std::ops::Deref for Queue {
    type Target = wgpu::Queue;

    fn deref(&self) -> &wgpu::Queue {
        &self.queue
    }
}

impl Queue {
    fn new(queue: wgpu::Queue) -> Self {
        Self {
            queue,
            recent: Default::default(),
        }
    }

    fn submit_from<I: IntoIterator<Item = wgpu::CommandBuffer>>(
        &self,
        at: dispatch::Site,
        buffers: I,
    ) -> wgpu::SubmissionIndex {
        let mut recent = self.recent();
        if recent.len() == SUBMISSIONS_KEPT {
            recent.pop_front();
        }
        recent.push_back(at);
        drop(recent);
        self.queue.submit(buffers)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn recent_sites(&self) -> std::collections::HashSet<dispatch::Site> {
        self.recent().iter().copied().collect()
    }

    /// Oldest first, as `file:line`.
    pub fn recent_submissions(&self) -> Vec<String> {
        self.recent()
            .iter()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .collect()
    }

    fn recent(&self) -> std::sync::MutexGuard<'_, Submissions> {
        self.recent
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// A run of submissions and everything allocated to feed them.
///
/// A plane cannot be freed while unsubmitted work reads it - there is no way to submit but through
/// the recording that holds it - and cannot outlive the recording either, so an early return frees
/// what it abandoned.
pub struct Recording<'a> {
    gpu: &'a Gpu,
    encoder: dispatch::Encoder<'a>,
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

    /// One dispatch, in a submission of its own with everything recorded before it.
    #[track_caller]
    pub fn dispatch(
        &mut self,
        [x, y, z]: [u32; 3],
        because: dispatch::Whole,
        set: impl FnOnce(&mut dispatch::Pass<'_>),
    ) {
        let at = std::panic::Location::caller();
        self.encoder
            .dispatch(at, dispatch::Kind::Whole(because), set, |pass| {
                pass.dispatch_workgroups(x, y, z)
            });
    }

    /// One dispatch whose workgroup count the device wrote into `counts` at `offset`.
    #[track_caller]
    pub fn dispatch_indirect(
        &mut self,
        counts: &wgpu::Buffer,
        offset: u64,
        set: impl FnOnce(&mut dispatch::Pass<'_>),
    ) {
        let at = std::panic::Location::caller();
        self.encoder.dispatch(at, dispatch::Kind::Indirect, set, |pass| {
            pass.dispatch_workgroups_indirect(counts, offset)
        });
    }

    /// One dispatch of `pipeline` run as bands of its `y` rows of workgroups, each a submission of
    /// its own, and each sized to what this device took for the last band of that pipeline
    /// dispatched from the same place.
    #[track_caller]
    pub fn banded(
        &mut self,
        pipeline: &dispatch::Banded,
        [x, y, z]: [u32; 3],
        mut set: impl FnMut(&mut dispatch::BandedPass<'_, '_>),
    ) {
        if x * z == 0 {
            return;
        }
        let kernel: dispatch::Kernel = (std::panic::Location::caller(), pipeline.name.clone());
        let pressed = self.gpu.device.vram_pressed();
        let mut running = std::collections::VecDeque::new();
        let mut first_row = 0;
        while first_row < y {
            #[cfg(not(target_arch = "wasm32"))]
            self.settle_bands(&kernel, &mut running);
            let rows = self
                .gpu
                .costs
                .band_rows(&kernel, x * z, y - first_row, pressed);
            let uniform = self.init(&wgpu::util::BufferInitDescriptor {
                label: Some("band"),
                contents: bytemuck::cast_slice(&[first_row, rows, 0, 0]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let band = self.gpu.device.band_group(&uniform);
            let device = &self.gpu.device;
            running.extend(self.encoder.dispatch(
                kernel.0,
                dispatch::Kind::Band {
                    kernel: kernel.clone(),
                    workgroups: x * rows * z,
                },
                |pass| pass.banded(device, pipeline, &band, &mut set),
                |pass| pass.dispatch_workgroups(x, rows, z),
            ));
            first_row += rows;
        }
    }

    /// Waits on `running`, the bands submitted before, until the next can be sized from a timed
    /// one: the kernel's first band, and all but [`dispatch::BANDS_RUNNING`] after it, which is how
    /// a slowdown arriving mid-dispatch shrinks the bands that follow it.
    #[cfg(not(target_arch = "wasm32"))]
    fn settle_bands(
        &self,
        kernel: &dispatch::Kernel,
        running: &mut std::collections::VecDeque<wgpu::SubmissionIndex>,
    ) {
        if !self.gpu.timestamps {
            return;
        }
        while running.len() >= dispatch::BANDS_RUNNING
            || (!running.is_empty() && !self.gpu.costs.measured(kernel))
        {
            let Some(oldest) = running.pop_front() else {
                return;
            };
            // A lost device answers with an error, which the next call notices through `lost`.
            self.gpu
                .device
                .poll(wgpu::PollType::Wait {
                    submission_index: Some(oldest),
                    timeout: None,
                })
                .ok();
        }
    }

    /// One render pass, in a submission of its own with everything recorded before it.
    #[track_caller]
    pub fn draw(
        &mut self,
        descriptor: &wgpu::RenderPassDescriptor<'_>,
        draw: impl FnOnce(&mut wgpu::RenderPass<'_>),
    ) {
        self.encoder
            .draw(std::panic::Location::caller(), descriptor, draw);
    }

    pub fn copy_buffer_to_buffer(
        &mut self,
        source: &wgpu::Buffer,
        source_offset: u64,
        destination: &wgpu::Buffer,
        destination_offset: u64,
        size: impl Into<Option<u64>>,
    ) {
        self.encoder.copy_buffer_to_buffer(
            source,
            source_offset,
            destination,
            destination_offset,
            size,
        );
    }

    pub fn clear_buffer(&mut self, buffer: &wgpu::Buffer, offset: u64, size: Option<u64>) {
        self.encoder.clear_buffer(buffer, offset, size);
    }

    pub fn copy_texture_to_buffer(
        &mut self,
        source: wgpu::TexelCopyTextureInfo<'_>,
        destination: wgpu::TexelCopyBufferInfo<'_>,
        size: wgpu::Extent3d,
    ) {
        self.encoder
            .copy_texture_to_buffer(source, destination, size);
    }

    /// Everything recorded so far, handed to the queue.
    ///
    /// A second one may be recorded after it: the resources stay until this whole value drops, so
    /// a stage that has to read a measurement back before recording the rest of itself does not
    /// need a second pool for the second half.
    #[track_caller]
    pub fn submit(&mut self) {
        self.encoder.submit(std::panic::Location::caller());
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
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| signal(result.is_ok()));
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
    fn pair() -> (
        impl std::future::Future<Output = bool>,
        impl FnOnce(bool) + Send + 'static,
    ) {
        let state = std::sync::Arc::new(std::sync::Mutex::new(Signal {
            answer: None,
            waker: None,
        }));
        let wrote = state.clone();
        let signal = move |answer: bool| {
            let mut wrote = wrote
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            wrote.answer = Some(answer);
            if let Some(waker) = wrote.waker.take() {
                waker.wake();
            }
        };
        let waited = std::future::poll_fn(move |context| {
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
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
    /// Distinct for every device this process opens, so a resource cached against one is never
    /// handed to another.
    pub fn id(&self) -> u64 {
        self.id
    }

    #[cfg(any(target_arch = "wasm32", target_os = "android"))]
    pub fn instance(&self) -> &wgpu::Instance {
        &self.instance
    }

    #[cfg(target_os = "android")]
    pub fn surface_capabilities(&self, surface: &wgpu::Surface<'_>) -> wgpu::SurfaceCapabilities {
        surface.get_capabilities(&self.wgpu_adapter)
    }

    #[cfg(any(target_arch = "wasm32", target_os = "android"))]
    pub fn configure(&self, surface: &wgpu::Surface<'_>, configuration: &wgpu::SurfaceConfiguration) {
        self.device.configure(surface, configuration);
    }

    /// The cell the cache at `cache` fills on this device. The lock is not held while it fills,
    /// since one stage's build asks for another's.
    fn built_for(&self, cache: usize) -> &'static std::sync::OnceLock<Box<Built>> {
        let mut built = self.built.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Leaked like the device, which a call still running may hold.
        built
            .entry(cache)
            .or_insert_with(|| Box::leak(Box::default()))
    }
}

/// A stage's pipelines, built on a device's first use of them and held by that device, so a
/// device opened after a loss builds its own.
// Sized, so every cache's static has an address of its own: the address is the key.
pub struct Cache<T> {
    _sized: u8,
    holds: std::marker::PhantomData<fn() -> T>,
}

impl<T: wgpu::WasmNotSendSync + 'static> Cache<T> {
    pub const fn new() -> Self {
        Cache {
            _sized: 0,
            holds: std::marker::PhantomData,
        }
    }

    pub fn get(&'static self, gpu: &Gpu, build: impl FnOnce() -> T) -> &'static T {
        gpu.built_for(std::ptr::from_ref(self).addr())
            .get_or_init(|| Box::new(build()))
            .downcast_ref()
            .expect("a cache holds one type")
    }
}

/// What a [`Cache`] holds, which a browser's device cannot share across threads and has none to.
#[cfg(not(target_arch = "wasm32"))]
type Built = dyn std::any::Any + Send + Sync;
#[cfg(target_arch = "wasm32")]
type Built = dyn std::any::Any;

impl Gpu {
    /// Cuts the bands dispatched from `at`, as `file:line`, smaller: a device was lost after a
    /// submission from there.
    pub fn split_bands(&self, at: &str) {
        self.costs.split_named(at);
    }

    /// Whether a device has been lost since this one opened, which leaves this one unusable.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn lost(&self) -> bool {
        dispatch::LOSSES.load(std::sync::atomic::Ordering::Relaxed) > self.opened_after
    }

    /// Hands what this lost device learned to the one opened in its place, with the bands of every
    /// site it recently submitted from cut smaller.
    #[cfg(not(target_arch = "wasm32"))]
    fn succeeded_by(&self, next: &mut Gpu) {
        // Every site, not the last: the device runs behind the submissions, so the one that hung
        // may be several back.
        for at in self.queue.recent_sites() {
            trace::warn(&format!(
                "rawshim gpu: the device was lost after a submission from {}:{}",
                at.file(),
                at.line()
            ));
            self.costs.split(at);
        }
        next.costs = self.costs.clone();
    }

    /// A run of submissions, and the pool everything they read is allocated from.
    pub fn record(&self) -> Recording<'_> {
        Recording {
            gpu: self,
            encoder: dispatch::Encoder::new(self),
            held: Vec::new(),
        }
    }

    /// A buffer whose life is its own rather than a submission's: a frame, a mosaic, a pyramid.
    pub fn own_buffer(&self, descriptor: &wgpu::BufferDescriptor<'_>) -> Buffer {
        let mapped = descriptor
            .usage
            .intersects(wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::MAP_WRITE);
        let usage = match mapped {
            true => descriptor.usage,
            // Callers clear and copy into unmapped buffers without asking for this.
            false => descriptor.usage | wgpu::BufferUsages::COPY_DST,
        };
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: descriptor.label,
            size: descriptor.size,
            usage,
            mapped_at_creation: descriptor.mapped_at_creation,
        });
        Buffer(counted(buffer, descriptor.size))
    }

    pub fn own_buffer_init(&self, descriptor: &wgpu::util::BufferInitDescriptor<'_>) -> Buffer {
        let buffer = self.device.create_buffer_init(descriptor);
        let bytes = buffer.size();
        Buffer(counted(buffer, bytes))
    }

    pub fn own_texture(&self, descriptor: &wgpu::TextureDescriptor<'_>) -> Texture {
        Texture(counted(
            self.device.create_texture(descriptor),
            texture_bytes(descriptor),
        ))
    }

    pub fn own_texture_with_data(
        &self,
        descriptor: &wgpu::TextureDescriptor<'_>,
        order: wgpu::util::TextureDataOrder,
        data: &[u8],
    ) -> Texture {
        Texture(counted(
            self.device
                .create_texture_with_data(&self.queue, descriptor, order, data),
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
        self.device.webgpu_device()
    }

    pub fn nudge(&self) {
        self.device.poll(wgpu::PollType::Poll).ok();
    }

    /// Native only in practice: a browser cannot block for a map, which is why [`read_back`] exists
    /// in the shape it does.
    pub fn block_until_done(&self) {
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("the dispatch finished");
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
                format!(
                    "{} ({:?}, {:?}) via {}",
                    i.name, i.device_type, i.backend, i.driver
                )
            };
            if let Some(found) = offered
                .iter()
                .find(|a| described(a).to_lowercase().contains(&want))
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
            let found = offered
                .into_iter()
                .find(|a| a.get_info().name.contains("SwiftShader"));
            if found.is_none() {
                trace::warn(
                    "rawshim gpu: no hardware adapter and no SwiftShader; `bun run get:swiftshader` \
                     fetches it, and VK_ADD_DRIVER_FILES=native/rawshim/.swiftshader/vk_swiftshader_icd.json \
                     points Vulkan at it",
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
                trace::info(&format!(
                    "rawshim gpu offered: {} ({:?}, {:?}) via {}",
                    info.name, info.device_type, info.backend, info.driver,
                ));
            }
            let info = adapter.get_info();
            trace::info(&format!(
                "rawshim gpu: {} ({:?}, {:?}) via {}",
                info.name, info.device_type, info.backend, info.driver,
            ));
        }

        // The adapter's own limits, not `downlevel_defaults`. Those are WebGPU's portable
        // floor and cap a storage binding at 128MB, which a real frame is nowhere near
        // fitting: the frame and `counts` are six bytes a pixel each, so 144MB at 24MP and
        // 366MB at 61MP. The browser lives with that floor because it has to; a native
        // process has no reason to ask for less than the hardware offers, and asking for
        // less turns every full-size rendition into a validation failure.
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
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
        .inspect_err(|refused| trace::warn(&format!("rawshim gpu: no device: {refused}")))
        .ok()?;
        // A validation error here is a bug in the shader or in what is bound to it, and
        // both are ours. Left to the default handler it would print and continue, and the
        // frame would come back wrong rather than not at all.
        device.on_uncaptured_error(std::sync::Arc::new(|error| panic!("rawshim gpu: {error}")));

        Some(Gpu::build(adapter, instance, device, queue))
    }

    /// Everything a `Gpu` is once a device exists, which is all of it bar asking for one.
    ///
    /// Split out so that the browser's request - async, and on a backend that enumerates nothing -
    /// opens the *same* device as the server's rather than a second kind.
    fn build(
        wgpu_adapter: wgpu::Adapter,
        instance: wgpu::Instance,
        device: wgpu::Device,
        queue: wgpu::Queue,
    ) -> Gpu {
        let device = dispatch::Device::new(device);
        // Before the callback, so a loss during the build below counts against this device.
        #[cfg(not(target_arch = "wasm32"))]
        let opened_after = dispatch::LOSSES.load(std::sync::atomic::Ordering::Relaxed);
        #[cfg(not(target_arch = "wasm32"))]
        device.count_loss();
        let info = wgpu_adapter.get_info();
        let adapter = format!("{} ({:?}, {:?})", info.name, info.backend, info.device_type);
        // Thirty-two apiece is 128 workgroups for a four-channel reduction, a couple per core on
        // the discrete parts this is for and still far more than a narrow one is short of.
        let reduction_slices = match info.device_type {
            wgpu::DeviceType::DiscreteGpu => 32,
            _ => 1,
        };
        Gpu {
            adapter,
            wgpu_adapter,
            backend: info.backend,
            reduction_slices,
            timestamps: device.features().contains(wgpu::Features::TIMESTAMP_QUERY),
            costs: Default::default(),
            #[cfg(not(target_arch = "wasm32"))]
            opened_after,
            queue: Queue::new(queue),
            device,
            instance,
            id: {
                static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            },
            built: Default::default(),
        }
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
        if !trace::clock::watched() {
            return;
        }
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
    }

    /// The largest buffer this device can both create and bind whole, in bytes.
    pub fn most_bound(&self) -> u64 {
        let limits = self.device.limits();
        u64::from(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_cache_builds_once_per_device() {
        static FIRST: super::Cache<u64> = super::Cache::new();
        static SECOND: super::Cache<u64> = super::Cache::new();
        let gpus: [&'static super::Gpu; 2] =
            std::array::from_fn(|_| &*Box::leak(Box::new(super::Gpu::new().expect("a GPU adapter"))));
        let mut builds = 0;
        let mut on = |cache: &'static super::Cache<u64>, gpu: usize| {
            *cache.get(gpus[gpu], || {
                builds += 1;
                gpu as u64 * 10
            })
        };
        assert_eq!(
            [on(&FIRST, 0), on(&FIRST, 0), on(&FIRST, 1), on(&SECOND, 1)],
            [0, 0, 10, 10]
        );
        assert_eq!(builds, 3);
    }

    #[test]
    fn the_queue_remembers_where_its_last_submissions_were_made() {
        let gpu = super::Gpu::new().expect("a GPU adapter");
        for _ in 0..super::SUBMISSIONS_KEPT {
            gpu.queue.submit_from(std::panic::Location::caller(), []);
        }
        let mut recording = gpu.record();
        let buffer = recording.buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        recording.clear_buffer(&buffer, 0, None);
        let line = line!() + 1;
        recording.submit();
        let recent = gpu.queue.recent_submissions();
        assert_eq!(recent.len(), super::SUBMISSIONS_KEPT);
        assert_eq!(recent.last(), Some(&format!("{}:{line}", file!())));
    }

    /// The device is opened at the adapter's texture limit rather than WebGPU's default of 8192.
    ///
    /// **A silent failure in the browser.** The viewer reads the limit back to decide whether a
    /// frame can be uploaded as planes, and a native-resolution rendition off a 61MP body is 9504 on
    /// its long edge: under the default, every one fell to the import, which tone maps HDR down.
    #[test]
    fn the_device_is_opened_at_the_adapters_texture_limit() {
        let instance = wgpu::Instance::default();
        let Ok(adapter) =
            pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        else {
            eprintln!("SKIPPED: no adapter answered, so no limits were asked for.");
            return;
        };
        let asked = super::limits_of(&adapter);
        assert_eq!(
            asked.max_texture_dimension_2d,
            adapter.limits().max_texture_dimension_2d
        );
        assert!(asked.max_storage_buffers_per_shader_stage <= super::MOST_STORAGE_BUFFERS);
    }
}
