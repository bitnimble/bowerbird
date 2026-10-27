//! A dispatch is a submission of its own, and one that follows the picture's size runs as bands of
//! rows sized from how long this device took for the last ones.
//!
//! Windows resets a device whose submission runs past 2s (TDR). A card whose buffers Windows has
//! moved to system memory runs a 61MP dispatch twenty times slower than it did a moment before, so
//! no fixed split is safe: a band is sized to [`BAND_MS`], far enough under the limit to survive
//! that slowdown arriving between one band and the next.

use std::panic::Location;

/// What a band is sized to take.
pub const BAND_MS: f64 = 50.0;

/// A dispatch run whole past this is reported, with where it was made.
pub const WHOLE_MS: f64 = 100.0;

/// A band's workgroups before this device has timed one of that kernel at that site. Natively the
/// rest of the dispatch waits for that one's timing; a browser cannot wait, so every band until a
/// timing lands is this size.
#[cfg(not(target_arch = "wasm32"))]
const FIRST_BAND_WORKGROUPS: u32 = 512;
#[cfg(target_arch = "wasm32")]
const FIRST_BAND_WORKGROUPS: u32 = 2048;

const MOST_BAND_WORKGROUPS: u32 = 32768;

/// How much of a slow band's cost a faster one sheds: a slowdown is taken at once, a recovery
/// over several bands.
const RECOVERY: f64 = 0.8;

/// Bands of one dispatch let run at once natively: one running and one queued behind it, so the
/// device never idles waiting on the host.
#[cfg(not(target_arch = "wasm32"))]
pub(super) const BANDS_RUNNING: usize = 2;

/// The share of the memory budget past which bands are cut [`PRESSED_SPLIT`] times smaller:
/// Windows moves buffers past the budget to system memory, slowing dispatches twentyfold.
#[cfg(not(target_arch = "wasm32"))]
const VRAM_PRESSED: f64 = 0.85;

const PRESSED_SPLIT: u32 = 4;

/// Devices this process has lost, which is how a call learns the one it ran on went.
#[cfg(not(target_arch = "wasm32"))]
pub static LOSSES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// How many times smaller a site's bands get each time the device is lost while it runs.
const SPLIT_ON_LOSS: u32 = 8;

/// The bind group a banded shader finds its band in: `slang/band.slang`'s `vk::binding(0, 3)`.
pub const BAND_GROUP: u32 = 3;

/// The device, less `create_command_encoder`: only [`Encoder`] makes command encoders, so no
/// dispatch reaches the queue but through it.
pub struct Device(wgpu::Device, Bands);

pub(super) struct Bands {
    layout: wgpu::BindGroupLayout,
    /// Fills the groups between a banded pipeline's own and [`BAND_GROUP`]: a null layout there
    /// is newer WebGPU than every browser takes.
    unused_layout: wgpu::BindGroupLayout,
    unused: wgpu::BindGroup,
}

impl Device {
    pub(super) fn new(device: wgpu::Device) -> Self {
        let unused_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("unused"),
            entries: &[],
        });
        let unused = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("unused"),
            layout: &unused_layout,
            entries: &[],
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("band"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::COMPUTE,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        Self(
            device,
            Bands {
                layout,
                unused_layout,
                unused,
            },
        )
    }

    /// `entry_point` of a shader that places its workgroups by `slang/band.slang`'s `band`, with
    /// its own bindings in `groups`, from group zero up to [`BAND_GROUP`].
    pub fn create_banded_pipeline(
        &self,
        label: &str,
        module: &wgpu::ShaderModule,
        groups: &[&wgpu::BindGroupLayout],
        entry_point: &str,
        constants: &[(&str, f64)],
    ) -> Banded {
        assert!(
            groups.len() <= BAND_GROUP as usize,
            "{label} binds group {BAND_GROUP}, where its band goes"
        );
        let mut layouts = [Some(&self.1.unused_layout); BAND_GROUP as usize + 1];
        for (slot, group) in layouts.iter_mut().zip(groups) {
            *slot = Some(*group);
        }
        layouts[BAND_GROUP as usize] = Some(&self.1.layout);
        let layout = self
            .0
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(label),
                bind_group_layouts: &layouts,
                ..Default::default()
            });
        Banded {
            pipeline: self
                .0
                .create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: Some(label),
                    layout: Some(&layout),
                    module,
                    entry_point: Some(entry_point),
                    compilation_options: wgpu::PipelineCompilationOptions {
                        constants,
                        ..Default::default()
                    },
                    cache: None,
                }),
            name: label.into(),
            groups: groups.len() as u32,
        }
    }

    pub(super) fn band_group(&self, uniform: &wgpu::Buffer) -> wgpu::BindGroup {
        self.0.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("band"),
            layout: &self.1.layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        })
    }

    pub fn create_shader_module(
        &self,
        desc: wgpu::ShaderModuleDescriptor<'_>,
    ) -> wgpu::ShaderModule {
        self.0.create_shader_module(desc)
    }

    /// # Safety
    ///
    /// As [`wgpu::Device::create_shader_module_passthrough`].
    #[expect(unsafe_code)]
    pub unsafe fn create_shader_module_passthrough(
        &self,
        desc: wgpu::ShaderModuleDescriptorPassthrough<'_>,
    ) -> wgpu::ShaderModule {
        // SAFETY: the caller's.
        unsafe { self.0.create_shader_module_passthrough(desc) }
    }

    pub fn create_bind_group_layout(
        &self,
        desc: &wgpu::BindGroupLayoutDescriptor<'_>,
    ) -> wgpu::BindGroupLayout {
        self.0.create_bind_group_layout(desc)
    }

    pub fn create_pipeline_layout(
        &self,
        desc: &wgpu::PipelineLayoutDescriptor<'_>,
    ) -> wgpu::PipelineLayout {
        self.0.create_pipeline_layout(desc)
    }

    pub fn create_compute_pipeline(
        &self,
        desc: &wgpu::ComputePipelineDescriptor<'_>,
    ) -> wgpu::ComputePipeline {
        self.0.create_compute_pipeline(desc)
    }

    pub fn create_render_pipeline(
        &self,
        desc: &wgpu::RenderPipelineDescriptor<'_>,
    ) -> wgpu::RenderPipeline {
        self.0.create_render_pipeline(desc)
    }

    pub fn create_bind_group(&self, desc: &wgpu::BindGroupDescriptor<'_>) -> wgpu::BindGroup {
        self.0.create_bind_group(desc)
    }

    pub fn create_buffer(&self, desc: &wgpu::BufferDescriptor<'_>) -> wgpu::Buffer {
        self.0.create_buffer(desc)
    }

    pub fn create_buffer_init(&self, desc: &wgpu::util::BufferInitDescriptor<'_>) -> wgpu::Buffer {
        wgpu::util::DeviceExt::create_buffer_init(&self.0, desc)
    }

    pub fn create_texture(&self, desc: &wgpu::TextureDescriptor<'_>) -> wgpu::Texture {
        self.0.create_texture(desc)
    }

    pub fn create_texture_with_data(
        &self,
        queue: &wgpu::Queue,
        desc: &wgpu::TextureDescriptor<'_>,
        order: wgpu::util::TextureDataOrder,
        data: &[u8],
    ) -> wgpu::Texture {
        wgpu::util::DeviceExt::create_texture_with_data(&self.0, queue, desc, order, data)
    }

    pub fn create_sampler(&self, desc: &wgpu::SamplerDescriptor<'_>) -> wgpu::Sampler {
        self.0.create_sampler(desc)
    }

    pub fn poll(&self, poll_type: wgpu::PollType) -> Result<wgpu::PollStatus, wgpu::PollError> {
        self.0.poll(poll_type)
    }

    pub fn on_uncaptured_error(&self, handler: std::sync::Arc<dyn wgpu::UncapturedErrorHandler>) {
        self.0.on_uncaptured_error(handler);
    }

    /// Counts this device's loss in [`LOSSES`], unless it was destroyed on purpose.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn count_loss(&self) {
        self.0.set_device_lost_callback(|reason, _| {
            if reason != wgpu::DeviceLostReason::Destroyed {
                LOSSES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }

    pub fn limits(&self) -> wgpu::Limits {
        self.0.limits()
    }

    /// Whether this process holds past [`VRAM_PRESSED`] of its video memory budget, where Vulkan
    /// says (`VK_EXT_memory_budget`). On Windows that budget is the one WDDM demotes past.
    #[cfg(not(target_arch = "wasm32"))]
    #[expect(unsafe_code)]
    pub(super) fn vram_pressed(&self) -> bool {
        use ash::vk;
        // SAFETY: the handles are only read, and only while `hal` keeps the device alive.
        let Some(hal) = (unsafe { self.0.as_hal::<wgpu::hal::api::Vulkan>() }) else {
            return false;
        };
        // wgpu leaves the extension off on radv, whose budget it does not trust.
        if !hal
            .enabled_device_extensions()
            .contains(&ash::ext::memory_budget::NAME)
        {
            return false;
        }
        let mut budget = vk::PhysicalDeviceMemoryBudgetPropertiesEXT::default();
        let mut properties = vk::PhysicalDeviceMemoryProperties2::default().push_next(&mut budget);
        // SAFETY: the physical device is the one `hal` was opened on, and `properties` chains
        // only the budget, which the enabled extension defines.
        unsafe {
            hal.shared_instance()
                .raw_instance()
                .get_physical_device_memory_properties2(hal.raw_physical_device(), &mut properties);
        }
        let memory = properties.memory_properties;
        // The largest, which is where the planes are: a discrete card's second device-local heap
        // is its 256MB host-visible window, holding uploads, and runs past its budget harmlessly.
        let Some(heap) = (0..memory.memory_heap_count as usize)
            .filter(|&heap| {
                memory.memory_heaps[heap]
                    .flags
                    .contains(vk::MemoryHeapFlags::DEVICE_LOCAL)
            })
            .max_by_key(|&heap| memory.memory_heaps[heap].size)
        else {
            return false;
        };
        budget.heap_usage[heap] as f64 > budget.heap_budget[heap] as f64 * VRAM_PRESSED
    }

    #[cfg(target_arch = "wasm32")]
    pub(super) fn vram_pressed(&self) -> bool {
        false
    }

    #[cfg(target_arch = "wasm32")]
    pub fn webgpu_device(&self) -> Option<wasm_bindgen::JsValue> {
        self.0.as_webgpu().map(|device| device.clone().into())
    }

    pub fn features(&self) -> wgpu::Features {
        self.0.features()
    }

    pub fn configure(&self, surface: &wgpu::Surface<'_>, config: &wgpu::SurfaceConfiguration) {
        surface.configure(&self.0, config);
    }
}

/// The only command encoder: each compute pass it opens holds one dispatch and is submitted on
/// its own, timed where the device has timestamps.
pub(super) struct Encoder<'a> {
    gpu: &'a super::Gpu,
    raw: Option<wgpu::CommandEncoder>,
}

impl<'a> Encoder<'a> {
    pub(super) fn new(gpu: &'a super::Gpu) -> Self {
        Self { gpu, raw: None }
    }

    pub(super) fn dispatch(
        &mut self,
        at: Site,
        kind: Kind,
        set: impl FnOnce(&mut Pass<'_>),
        dispatch: impl FnOnce(&mut wgpu::ComputePass<'_>),
    ) -> Option<wgpu::SubmissionIndex> {
        let stamp = self.gpu.timestamps.then(|| Stamp::new(self.gpu));
        let raw = self.raw();
        {
            let mut pass = Pass(raw.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: None,
                timestamp_writes: stamp.as_ref().map(Stamp::writes),
            }));
            set(&mut pass);
            dispatch(&mut pass.0);
        }
        if let Some(stamp) = &stamp {
            stamp.ended(raw);
        }
        let submitted = self.submit(at);
        if let Some(stamp) = stamp {
            stamp.read(self.gpu, Timed { at, kind });
        }
        submitted
    }

    /// One render pass, submitted on its own.
    pub(super) fn draw(
        &mut self,
        at: Site,
        descriptor: &wgpu::RenderPassDescriptor<'_>,
        draw: impl FnOnce(&mut wgpu::RenderPass<'_>),
    ) {
        draw(&mut self.raw().begin_render_pass(descriptor));
        self.submit(at);
    }

    pub(super) fn copy_buffer_to_buffer(
        &mut self,
        source: &wgpu::Buffer,
        source_offset: u64,
        destination: &wgpu::Buffer,
        destination_offset: u64,
        size: impl Into<Option<u64>>,
    ) {
        self.raw().copy_buffer_to_buffer(
            source,
            source_offset,
            destination,
            destination_offset,
            size,
        );
    }

    pub(super) fn clear_buffer(&mut self, buffer: &wgpu::Buffer, offset: u64, size: Option<u64>) {
        self.raw().clear_buffer(buffer, offset, size);
    }

    pub(super) fn copy_texture_to_buffer(
        &mut self,
        source: wgpu::TexelCopyTextureInfo<'_>,
        destination: wgpu::TexelCopyBufferInfo<'_>,
        size: wgpu::Extent3d,
    ) {
        self.raw().copy_texture_to_buffer(source, destination, size);
    }

    pub(super) fn submit(&mut self, at: Site) -> Option<wgpu::SubmissionIndex> {
        let raw = self.raw.take()?;
        Some(self.gpu.queue.submit_from(at, [raw.finish()]))
    }

    fn raw(&mut self) -> &mut wgpu::CommandEncoder {
        self.raw.get_or_insert_with(|| {
            self.gpu
                .device
                .0
                .create_command_encoder(&Default::default())
        })
    }
}

/// Why a dispatch runs as one submission, which [`super::Recording::dispatch`] asks of each.
#[derive(Clone, Copy, Debug)]
pub enum Whole {
    /// Its size does not follow the picture's.
    Fixed,
    /// It follows the picture's size, and runs inside [`WHOLE_MS`] at 61MP on the slowest adapter
    /// measured. Timed, and reported when it does not.
    Measured,
}

/// One dispatch's pass. It has no dispatch of its own: [`super::Recording`] makes the one each
/// pass holds.
pub struct Pass<'a>(wgpu::ComputePass<'a>);

impl Pass<'_> {
    pub fn set_pipeline(&mut self, pipeline: &wgpu::ComputePipeline) {
        self.0.set_pipeline(pipeline);
    }

    pub fn set_bind_group(&mut self, index: u32, group: &wgpu::BindGroup, offsets: &[u32]) {
        self.0.set_bind_group(index, group, offsets);
    }

    pub fn set_immediates(&mut self, offset: u32, data: &[u8]) {
        self.0.set_immediates(offset, data);
    }

    pub(super) fn banded(
        &mut self,
        device: &Device,
        pipeline: &Banded,
        band: &wgpu::BindGroup,
        set: impl FnOnce(&mut BandedPass<'_, '_>),
    ) {
        self.0.set_pipeline(&pipeline.pipeline);
        set(&mut BandedPass(self));
        for unused in pipeline.groups..BAND_GROUP {
            self.0.set_bind_group(unused, &device.1.unused, &[]);
        }
        self.0.set_bind_group(BAND_GROUP, band, &[]);
    }
}

/// A pipeline [`super::Recording::banded`] runs, and nothing else does: run whole, its shader would
/// read no band, and a band of a pipeline that does not place itself by one would write the first
/// rows over again.
pub struct Banded {
    pipeline: wgpu::ComputePipeline,
    pub(super) name: std::sync::Arc<str>,
    /// How many of the groups below [`BAND_GROUP`] are its own.
    groups: u32,
}

/// One band's pass, whose pipeline [`super::Recording::banded`] has set.
pub struct BandedPass<'p, 'a>(&'p mut Pass<'a>);

impl BandedPass<'_, '_> {
    pub fn set_bind_group(&mut self, index: u32, group: &wgpu::BindGroup, offsets: &[u32]) {
        self.0.set_bind_group(index, group, offsets);
    }
}

/// What each banded kernel's workgroups have cost on this adapter, kept across the devices opened
/// on it.
#[derive(Default)]
pub(super) struct Costs {
    /// Milliseconds a workgroup, by where a kernel was dispatched from and which kernel it was.
    per_workgroup: std::sync::Mutex<std::collections::HashMap<Kernel, f64>>,
    /// How many times smaller than timing alone says a site's bands are cut, for each device lost
    /// while it ran.
    splits: std::sync::Mutex<std::collections::HashMap<Site, u32>>,
    /// Splits a page carries over from a worker that lost its device, by `file:line`, for the
    /// sites this one has yet to reach.
    named: std::sync::Mutex<std::collections::HashMap<String, u32>>,
}

pub(super) type Site = &'static Location<'static>;

pub(super) type Kernel = (Site, std::sync::Arc<str>);

impl Costs {
    pub(super) fn band_rows(&self, kernel: &Kernel, across: u32, left: u32, pressed: bool) -> u32 {
        let across = across.max(1);
        let workgroups = match locked(&self.per_workgroup).get(kernel) {
            Some(per_workgroup) => (BAND_MS / per_workgroup) as u32,
            None => FIRST_BAND_WORKGROUPS,
        };
        let rows = workgroups.min(MOST_BAND_WORKGROUPS) / across;
        let pressure = if pressed { PRESSED_SPLIT } else { 1 };
        (rows / self.split_of(kernel.0) / pressure).clamp(1, left)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn measured(&self, kernel: &Kernel) -> bool {
        locked(&self.per_workgroup).contains_key(kernel)
    }

    /// Cuts `at`'s bands smaller, the device having been lost while it ran.
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn split(&self, at: Site) {
        let split = self.split_of(at).saturating_mul(SPLIT_ON_LOSS);
        locked(&self.splits).insert(at, split);
    }

    /// [`Self::split`] by `file:line`, for a site this device has not reached yet.
    pub fn split_named(&self, at: &str) {
        let mut named = locked(&self.named);
        let split = named.entry(at.to_string()).or_insert(1);
        *split = split.saturating_mul(SPLIT_ON_LOSS);
    }

    fn learn(&self, kernel: &Kernel, per_workgroup: f64) {
        // A pass shorter than the timer's resolution reads as zero.
        let per_workgroup = per_workgroup.max(BAND_MS / f64::from(MOST_BAND_WORKGROUPS));
        locked(&self.per_workgroup)
            .entry(kernel.clone())
            .and_modify(|held| *held = per_workgroup.max(*held * RECOVERY))
            .or_insert(per_workgroup);
    }

    fn split_of(&self, at: Site) -> u32 {
        *locked(&self.splits).entry(at).or_insert_with(|| {
            locked(&self.named)
                .get(&format!("{}:{}", at.file(), at.line()))
                .copied()
                .unwrap_or(1)
        })
    }
}

fn locked<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One pass's two timestamps and where they are read back.
pub(super) struct Stamp {
    set: wgpu::QuerySet,
    resolved: super::Buffer,
    read: super::Buffer,
}

pub(super) struct Timed {
    pub(super) at: Site,
    pub(super) kind: Kind,
}

pub(super) enum Kind {
    Band { kernel: Kernel, workgroups: u32 },
    Whole(Whole),
    Indirect,
}

impl Stamp {
    fn new(gpu: &super::Gpu) -> Self {
        let buffer = |label, usage| {
            gpu.own_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: 16,
                usage,
                mapped_at_creation: false,
            })
        };
        Self {
            set: gpu.device.0.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("dispatch stamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 2,
            }),
            resolved: buffer(
                "dispatch stamps resolved",
                wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            ),
            read: buffer(
                "dispatch stamps read",
                wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            ),
        }
    }

    fn writes(&self) -> wgpu::ComputePassTimestampWrites<'_> {
        wgpu::ComputePassTimestampWrites {
            query_set: &self.set,
            beginning_of_pass_write_index: Some(0),
            end_of_pass_write_index: Some(1),
        }
    }

    fn ended(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.resolve_query_set(&self.set, 0..2, &self.resolved, 0);
        encoder.copy_buffer_to_buffer(&self.resolved, 0, &self.read, 0, 16);
    }

    /// Reads the stamps back once the submission holding them finishes, teaching the device's
    /// costs what a band cost and reporting a whole dispatch past [`WHOLE_MS`].
    fn read(self, gpu: &super::Gpu, timed: Timed) {
        let costs = gpu.costs.clone();
        let period_ns = gpu.queue.get_timestamp_period();
        let read = self.read.clone();
        read.slice(..16)
            .map_async(wgpu::MapMode::Read, move |result| {
                if result.is_err() {
                    return;
                }
                let ms = {
                    let Ok(mapped) = self.read.slice(..16).get_mapped_range() else {
                        return;
                    };
                    let tick = |at: usize| {
                        u64::from_le_bytes(mapped[at..at + 8].try_into().expect("8 bytes"))
                    };
                    tick(8).saturating_sub(tick(0)) as f64 * f64::from(period_ns) / 1e6
                };
                taken(&costs, &timed, ms);
            });
    }
}

fn taken(costs: &Costs, timed: &Timed, ms: f64) {
    let at = timed.at;
    match &timed.kind {
        Kind::Band { kernel, workgroups } => costs.learn(kernel, ms / f64::from(*workgroups)),
        Kind::Whole(because) if ms > WHOLE_MS => crate::warn(&format!(
            "rawshim gpu: a dispatch run whole ({because:?}) took {ms:.0}ms: {}:{}",
            at.file(),
            at.line()
        )),
        Kind::Indirect if ms > WHOLE_MS => crate::warn(&format!(
            "rawshim gpu: an indirect dispatch took {ms:.0}ms: {}:{}",
            at.file(),
            at.line()
        )),
        Kind::Whole(_) | Kind::Indirect => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_band_takes_what_its_workgroups_cost_and_shrinks_when_a_device_is_lost() {
        let costs = Costs::default();
        let at = Location::caller();
        let apply: Kernel = (at, "apply".into());
        let luma: Kernel = (at, "luma".into());
        let instant: Kernel = (at, "instant".into());
        assert!(!costs.measured(&apply));
        assert_eq!(
            costs.band_rows(&apply, 64, 100, false),
            FIRST_BAND_WORKGROUPS / 64
        );

        costs.learn(&apply, 1.0 / 128.0);
        assert!(costs.measured(&apply));
        assert_eq!(costs.band_rows(&apply, 640, 100, false), 10);
        // Learned on a small picture, a band of a wider one takes as many workgroups, not rows.
        assert_eq!(costs.band_rows(&apply, 1280, 100, false), 5);
        // Faster workgroups are taken slowly: the held cost sheds a fifth, not seven eighths.
        costs.learn(&apply, 1.0 / 1024.0);
        assert_eq!(costs.band_rows(&apply, 640, 100, false), 12);
        assert_eq!(costs.band_rows(&apply, 640, 7, false), 7);
        assert_eq!(costs.band_rows(&apply, 640, 100, true), 12 / PRESSED_SPLIT);

        costs.learn(&luma, 0.0001);
        assert_eq!(
            costs.band_rows(&luma, 640, 100, false),
            MOST_BAND_WORKGROUPS / 640
        );
        assert_eq!(costs.band_rows(&apply, 640, 100, false), 12);
        // A pass under the timer's resolution reads as zero, and is as fast as a band is allowed.
        costs.learn(&instant, 0.0);
        assert_eq!(
            costs.band_rows(&instant, 640, 100, false),
            MOST_BAND_WORKGROUPS / 640
        );

        costs.split(at);
        assert_eq!(costs.band_rows(&apply, 640, 100, false), 1);
        assert_eq!(
            costs.band_rows(&luma, 640, 100, false),
            MOST_BAND_WORKGROUPS / 640 / SPLIT_ON_LOSS
        );

        let unreached = Location::caller();
        costs.split_named(&format!("{}:{}", unreached.file(), unreached.line()));
        assert_eq!(
            costs.band_rows(&(unreached, "apply".into()), 64, 100, false),
            FIRST_BAND_WORKGROUPS / 64 / SPLIT_ON_LOSS
        );
    }

    #[test]
    fn the_band_binds_where_the_shaders_read_it() {
        let source = include_str!("../../../../slang/band.slang");
        let binding = format!("[[vk::binding(0, {BAND_GROUP})]]");
        assert!(
            source.contains(&binding),
            "band.slang does not say `{binding}`"
        );
    }
}
