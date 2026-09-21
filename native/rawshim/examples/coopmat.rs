//! PMRID's 1x1 convolutions on the tensor cores, against what the WGSL pass costs for the same
//! layers.
//!
//! ```text
//! coopmat [tiles]
//! ```
//!
//! A measurement, not a stage. Two thirds of what the prototype spends is its pointwise
//! convolutions, and each of those is already a matrix multiply over the arena: the weights are
//! `[out][in]` row-major, an activation plane is `[in]` rows of `pixels`, and the output is the
//! same shape. What that costs on a GPU's matrix units rather than its lanes is the question a
//! tensor core exists to answer, and WGSL cannot ask it - `OpCooperativeMatrixMulAddKHR` has no
//! spelling there - so this opens a Vulkan device of its own, with `VK_KHR_cooperative_matrix`
//! enabled, and dispatches `slang/spirv/pmrid_coop.slang` over the layers the network actually has.
//!
//! **What it does not do.** It does not denoise a photograph: the matrices hold whatever was
//! uploaded, and the question is the rate. The correctness it does check is that the multiply is a
//! multiply, against a host reference on one small layer, which is what makes the rate mean
//! anything.
//!
//! The layer list is the network's own, `pmrid::pointwise`, so nothing here can drift from what a
//! rendition runs.

use ash::vk;

/// The fragment an Ampere subgroup multiplies, and what `pmrid_coop.slang` is written for.
const FRAG: u32 = 16;
/// Every shape the shader was compiled in, as `(entry point, rows a subgroup, columns a subgroup,
/// subgroups a workgroup, depth steps read before any is multiplied)` in fragments - the shader's
/// `TALL`, `SPAN`, `GANGS` and `DEEP`.
///
/// Which is fastest is a measurement, so all of them are timed and the table is what to add a row
/// to when there is another shape worth asking about.
const SHAPES: [(&std::ffi::CStr, u32, u32, u32, u32); 123] = [
    (c"half_1x4x4", 1, 4, 4, 1),
    (c"half_1x2x4", 1, 2, 4, 1),
    (c"half_1x8x4", 1, 8, 4, 1),
    (c"half_2x4x4", 2, 4, 4, 1),
    (c"half_1x4x2", 1, 4, 2, 1),
    (c"half_1x4x8", 1, 4, 8, 1),
    (c"half_1x1x4", 1, 1, 4, 1),
    (c"half_1x1x2", 1, 1, 2, 1),
    (c"half_1x2x2", 1, 2, 2, 1),
    (c"half_1x2x8", 1, 2, 8, 1),
    (c"half_1x1x1", 1, 1, 1, 1),
    (c"half_1x2x1", 1, 2, 1, 1),
    (c"half_1x4x1", 1, 4, 1, 1),
    (c"half_2x2x1", 2, 2, 1, 1),
    (c"half_2x2x1_2", 2, 2, 1, 2),
    (c"half_1x2x1_2", 1, 2, 1, 2),
    (c"half_1x2x1_4", 1, 2, 1, 4),
    (c"half_1x1x1_2", 1, 1, 1, 2),
    (c"wide_1x4x4", 1, 4, 4, 1),
    (c"wide_1x2x4", 1, 2, 4, 1),
    (c"wide_1x8x4", 1, 8, 4, 1),
    (c"wide_2x4x4", 2, 4, 4, 1),
    (c"wide_1x4x2", 1, 4, 2, 1),
    (c"wide_1x4x8", 1, 4, 8, 1),
    (c"wide_1x1x4", 1, 1, 4, 1),
    (c"wide_1x1x2", 1, 1, 2, 1),
    (c"wide_1x2x2", 1, 2, 2, 1),
    (c"wide_1x2x8", 1, 2, 8, 1),
    (c"wide_1x1x1", 1, 1, 1, 1),
    (c"wide_1x2x1", 1, 2, 1, 1),
    (c"wide_1x4x1", 1, 4, 1, 1),
    (c"wide_2x2x1", 2, 2, 1, 1),
    (c"wide_2x2x1_2", 2, 2, 1, 2),
    (c"wide_2x4x1", 2, 4, 1, 1),
    (c"wide_1x2x1_2", 1, 2, 1, 2),
    (c"wide_1x2x1_4", 1, 2, 1, 4),
    (c"wide_1x1x1_2", 1, 1, 1, 2),
    // The staged shapes, whose subgroups are a `down` by `across` grid: their rows are
    // `down * tall` fragments and their columns `across * span`, which is what the tuple below
    // carries so that the dispatch arithmetic stays the same for both kinds.
    (c"halfs_1x1x2x2_2", 2, 2, 1, 2),
    (c"halfs_1x1x2x4_2", 2, 4, 1, 2),
    (c"halfs_1x2x2x2_2", 2, 4, 1, 2),
    (c"halfs_1x1x2x2_1", 2, 2, 1, 1),
    (c"halfs_1x1x4x2_2", 4, 2, 1, 2),
    (c"halfs_1x1x4x4_2", 4, 4, 1, 2),
    (c"wides_1x1x2x2_2", 2, 2, 1, 2),
    (c"wides_1x1x2x4_2", 2, 4, 1, 2),
    (c"wides_1x2x2x2_2", 2, 4, 1, 2),
    (c"wides_1x1x2x2_1", 2, 2, 1, 1),
    (c"wides_1x1x4x2_2", 4, 2, 1, 2),
    (c"wides_1x1x4x4_2", 4, 4, 1, 2),
    // The two ends of the roofline, dispatched over the same grid as `wide_1x2x1`: the multiplies
    // without the memory, and the memory without the multiplies.
    // The blocked shapes: the same tiles over matrices held a fragment at a time, so that a
    // fragment load is contiguous rather than sixteen rows of a wide plane.
    (c"wideb_1x2x1_1", 1, 2, 1, 1),
    (c"wideb_1x2x1_2", 1, 2, 1, 2),
    (c"wideb_2x2x1_2", 2, 2, 1, 2),
    (c"wideb_1x4x1_2", 1, 4, 1, 2),
    (c"wideb_2x2x1_4", 2, 2, 1, 4),
    (c"wideb_2x2x1_1", 2, 2, 1, 1),
    (c"wideb_2x4x1_2", 2, 4, 1, 2),
    (c"wideb_1x2x2_2", 1, 4, 1, 2),
    (c"wideb_1x1x1_2", 1, 1, 1, 2),
    (c"wideb_4x2x1_2", 4, 2, 1, 2),
    (c"wideb_4x4x1_2", 4, 4, 1, 2),
    (c"wideb_2x4x1_1", 2, 4, 1, 1),
    (c"halfb_1x2x1_2", 1, 2, 1, 2),
    (c"halfb_2x2x1_2", 2, 2, 1, 2),
    (c"halfb_2x2x1_4", 2, 2, 1, 4),
    (c"halfb_2x4x1_2", 2, 4, 1, 2),
    (c"halfb_4x4x1_2", 4, 4, 1, 2),
    (c"halfb_4x2x1_2", 4, 2, 1, 2),
    // The split shapes: the same tiles, with each step of the depth accumulated apart so that they
    // are independent chains rather than one.
    (c"widep_1x2x1_2", 1, 2, 1, 2),
    (c"widep_1x2x1_4", 1, 2, 1, 4),
    (c"widep_2x2x1_2", 2, 2, 1, 2),
    (c"widep_1x1x1_2", 1, 1, 1, 2),
    (c"widep_1x1x1_4", 1, 1, 1, 4),
    (c"halfp_1x2x1_2", 1, 2, 1, 2),
    (c"halfp_1x2x1_4", 1, 2, 1, 4),
    (c"bound_wide_math", 1, 2, 1, 1),
    (c"bound_wide_math4", 1, 2, 1, 1),
    (c"bound_wide_math8", 1, 2, 1, 1),
    (c"bound_half_math", 1, 2, 1, 1),
    // The pipelined shapes: blocked, and reading a step of the depth ahead of the one they are
    // multiplying.
    (c"widef_1x2x1", 1, 2, 1, 1),
    (c"widef_2x2x1", 2, 2, 1, 1),
    (c"widef_2x4x1", 2, 4, 1, 1),
    (c"widef_1x4x1", 1, 4, 1, 1),
    (c"widef_2x2x1_2", 2, 2, 1, 2),
    (c"halff_2x2x1", 2, 2, 1, 1),
    (c"halff_2x4x1", 2, 4, 1, 1),
    (c"halff_1x2x1", 1, 2, 1, 1),
    (c"halff_4x2x1", 4, 2, 1, 1),
    (c"halff_2x2x1_2", 2, 2, 1, 2),
    (c"halff_1x2x1_2", 1, 2, 1, 2),
    (c"halff_2x4x1_2", 2, 4, 1, 2),
    (c"halff_2x2x2", 2, 2, 2, 1),
    (c"halff_1x1x1", 1, 1, 1, 1),
    (c"halff_1x4x1", 1, 4, 1, 1),
    (c"halff_1x2x2", 1, 2, 2, 1),
    (c"halff_1x2x4", 1, 2, 4, 1),
    (c"halff_1x2x8", 1, 2, 8, 1),
    (c"halff_1x2x16", 1, 2, 16, 1),
    (c"halff_1x4x2", 1, 4, 2, 1),
    (c"halff_1x4x4", 1, 4, 4, 1),
    (c"halff_1x4x8", 1, 4, 8, 1),
    (c"halff_1x8x2", 1, 8, 2, 1),
    (c"halff_2x2x4", 2, 2, 4, 1),
    (c"halff_2x2x1_4", 2, 2, 1, 4),
    (c"halff_2x2x2_2", 2, 2, 2, 2),
    (c"halff_4x2x1_2", 4, 2, 1, 2),
    (c"halff_2x4x2_2", 2, 4, 2, 2),
    (c"halff_4x4x1_2", 4, 4, 1, 2),
    (c"halff_2x2x4_2", 2, 2, 4, 2),
    (c"halff_2x2x8_2", 2, 2, 8, 2),
    (c"halff_2x2x2_4", 2, 2, 2, 4),
    (c"halff_4x2x2_2", 4, 2, 2, 2),
    (c"halff_1x2x2_2", 1, 2, 2, 2),
    (c"widef_2x2x2_2", 2, 2, 2, 2),
    (c"halfd_2x2x2_2", 2, 2, 2, 2),
    (c"halfd_2x2x4_2", 2, 2, 4, 2),
    (c"halfd_1x2x2_2", 1, 2, 2, 2),
    (c"halfd_2x2x2", 2, 2, 2, 1),
    (c"halfd_1x2x4", 1, 2, 4, 1),
    (c"halfu_1x2x2_2", 1, 2, 2, 2),
    (c"halfu_1x2x2_4", 1, 2, 2, 4),
    (c"halfu_2x2x1_2", 2, 2, 1, 2),
    (c"bound_load", 1, 2, 1, 1),
    (c"bound_blocked_load", 1, 2, 1, 1),
];

/// The sensor tile the network runs over, as `examples/pmrid.rs` measures it, and the frame that
/// is cut into.
const SENSOR_TILE: usize = 1024;
const TILES_IN_A_FRAME: usize = 70;

/// One layer as a multiply: `rows` by `columns` accumulated over `depth`, which is out channels by
/// pixels over in channels.
#[derive(Clone, Copy)]
struct Multiply {
    rows: u32,
    columns: u32,
    depth: u32,
    weights_at: u32,
}

impl Multiply {
    fn macs(&self) -> u64 {
        u64::from(self.rows) * u64::from(self.columns) * u64::from(self.depth)
    }

    /// What an arm of this shape reads to compute this layer, in bytes.
    ///
    /// A workgroup covering `rows` by `columns` of the output reads `rows` by the depth of the
    /// weights and the depth by `columns` of the picture, and there are
    /// `(rows_of_the_layer / rows) * (columns_of_the_layer / columns)` of them - so a narrow tile
    /// reads the same activation plane over and over, and this is how many times.
    fn read(&self, arm: &Arm) -> u64 {
        let (rows, columns, depth) =
            (u64::from(self.rows), u64::from(self.columns), u64::from(self.depth));
        let tiles = (rows / u64::from(arm.rows)) * (columns / u64::from(arm.columns));
        let weights = u64::from(arm.rows) * depth;
        let samples = depth * u64::from(arm.columns);
        tiles * (weights + samples) * 2
    }

    /// Whether an arm of this shape covers the layer exactly, its depth steps included.
    ///
    /// A cooperative load does not bound-check, so an arm whose tile overhangs the matrix is not
    /// run at all rather than run over the edge.
    fn fits(&self, arm: &Arm) -> bool {
        self.rows % arm.rows == 0 && self.columns % arm.columns == 0 && self.depth % arm.depth == 0
    }
}

/// What the shader's push constants are, in the order it declares them.
///
/// The tail is what `stage` and `finish` need and a multiply does not, and it is pushed anyway: the
/// range a pipeline layout declares has to cover the block, whichever entry point is about to read
/// it.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Pushed {
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
    after: u32,
}

/// Every 1x1 convolution of the network, in the order it runs, for one sensor tile.
///
/// **Only the pointwise ones.** The depthwise convolutions and the upsample are not matrix
/// multiplies of this shape, and the two 3x3 dense layers at the full plane are a hundredth of the
/// work; what this measures is the two thirds that is.
fn multiplies(packed: usize) -> Vec<Multiply> {
    rawshim::pmrid::pointwise(packed)
        .into_iter()
        .map(|layer| {
            // The depth loop steps a fragment at a time whatever shape the arm is, so a layer whose
            // in-channels are not a multiple of that would have its last load reach past the row it
            // is reading - a wrong answer rather than a slow one. This network's pointwise layers
            // are all sixteen channels or more, and the check is here so that stops being a thing
            // to remember.
            assert!(
                layer.depth % FRAG as usize == 0,
                "a {}-channel input does not divide into fragments",
                layer.depth,
            );
            Multiply {
                rows: layer.rows as u32,
                columns: layer.columns as u32,
                depth: layer.depth as u32,
                weights_at: layer.weights_at as u32,
            }
        })
        .collect()
}

struct Gpu {
    _entry: ash::Entry,
    instance: ash::Instance,
    /// Whether the device multiplies `f16` into an `f32` accumulator, which the `wide` arms are and
    /// a device is allowed not to offer.
    accumulates_wide: bool,
    device: ash::Device,
    queue: vk::Queue,
    family: u32,
    memory: vk::PhysicalDeviceMemoryProperties,
    tick: f32,
}

/// A device with cooperative matrices on, which is a different device from the one wgpu opens.
///
/// **Every feature here is load-bearing and the device is refused without it.** A cooperative
/// matrix is defined in terms of the Vulkan memory model, its operands here are 16-bit, and the
/// arithmetic is 16-bit - so `vulkanMemoryModel`, `storageBuffer16BitAccess` and `shaderFloat16`
/// are not tuning.
fn device() -> Gpu {
    let entry = unsafe { ash::Entry::load() }.expect("a Vulkan loader");
    let application = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_3);
    let instance = unsafe {
        entry.create_instance(&vk::InstanceCreateInfo::default().application_info(&application), None)
    }
    .expect("a Vulkan instance");

    let matrices = ash::khr::cooperative_matrix::Instance::new(&entry, &instance);
    let physical = unsafe { instance.enumerate_physical_devices() }
        .expect("physical devices")
        .into_iter()
        .find(|it| {
            let named = unsafe { instance.enumerate_device_extension_properties(*it) };
            named.is_ok_and(|extensions| {
                extensions.iter().any(|extension| {
                    extension.extension_name_as_c_str() == Ok(ash::khr::cooperative_matrix::NAME)
                })
            })
        })
        .expect("a device with VK_KHR_cooperative_matrix");

    let described = unsafe { instance.get_physical_device_properties(physical) };
    let named = described.device_name_as_c_str().unwrap_or_default().to_string_lossy();
    eprintln!("{named}, {:?}", described.device_type);

    // Which cooperative-matrix extensions the driver has at all, since the shapes below are only
    // the ones the core KHR extension offers: a larger fragment than 16x16x16 would come from
    // `VK_NV_cooperative_matrix2`, whose dimensions are the device's to choose.
    for extension in unsafe { instance.enumerate_device_extension_properties(physical) }
        .expect("the device extensions")
    {
        let name = extension.extension_name_as_c_str().unwrap_or_default().to_string_lossy();
        if name.contains("cooperative") {
            eprintln!("  {name} v{}", extension.spec_version);
        }
    }

    // A configuration is what the hardware will multiply: a shape, the types of the three matrices,
    // and the scope the lanes cooperate over. The shader is written for one of them, so its absence
    // is a refusal rather than a slower path.
    let offered = unsafe { matrices.get_physical_device_cooperative_matrix_properties(physical) }
        .expect("the cooperative matrix configurations");
    for shape in &offered {
        if shape.scope == vk::ScopeKHR::SUBGROUP {
            eprintln!(
                "  {}x{}x{} {:?}*{:?}+{:?} -> {:?}",
                shape.m_size,
                shape.n_size,
                shape.k_size,
                shape.a_type,
                shape.b_type,
                shape.c_type,
                shape.result_type,
            );
        }
    }
    let wanted = |c: vk::ComponentTypeKHR| {
        offered.iter().any(|shape| {
            shape.scope == vk::ScopeKHR::SUBGROUP
                && shape.m_size == FRAG
                && shape.n_size == FRAG
                && shape.k_size == FRAG
                && shape.a_type == vk::ComponentTypeKHR::FLOAT16
                && shape.b_type == vk::ComponentTypeKHR::FLOAT16
                && shape.c_type == c
                && shape.result_type == c
        })
    };
    assert!(wanted(vk::ComponentTypeKHR::FLOAT16), "no 16x16x16 f16 configuration on this device");
    let accumulates_wide = wanted(vk::ComponentTypeKHR::FLOAT32);

    let families = unsafe { instance.get_physical_device_queue_family_properties(physical) };
    let family = families
        .iter()
        .position(|it| it.queue_flags.contains(vk::QueueFlags::COMPUTE))
        .expect("a compute queue") as u32;

    let priorities = [1.0f32];
    let queues =
        [vk::DeviceQueueCreateInfo::default().queue_family_index(family).queue_priorities(&priorities)];
    let extensions = [ash::khr::cooperative_matrix::NAME.as_ptr()];
    let mut coop = vk::PhysicalDeviceCooperativeMatrixFeaturesKHR::default().cooperative_matrix(true);
    let mut eleven = vk::PhysicalDeviceVulkan11Features::default().storage_buffer16_bit_access(true);
    let mut twelve = vk::PhysicalDeviceVulkan12Features::default()
        .shader_float16(true)
        .vulkan_memory_model(true)
        .vulkan_memory_model_device_scope(true);
    let mut features = vk::PhysicalDeviceFeatures2::default()
        .push_next(&mut coop)
        .push_next(&mut eleven)
        .push_next(&mut twelve);
    let device = unsafe {
        instance.create_device(
            physical,
            &vk::DeviceCreateInfo::default()
                .queue_create_infos(&queues)
                .enabled_extension_names(&extensions)
                .push_next(&mut features),
            None,
        )
    }
    .expect("a device with cooperative matrices");
    if !accumulates_wide {
        eprintln!("  (no f32 accumulator here, so only the half arms are built)");
    }

    let queue = unsafe { device.get_device_queue(family, 0) };
    let memory = unsafe { instance.get_physical_device_memory_properties(physical) };
    Gpu {
        _entry: entry,
        instance,
        accumulates_wide,
        device,
        queue,
        family,
        memory,
        tick: described.limits.timestamp_period,
    }
}

struct Held {
    buffer: vk::Buffer,
    memory: vk::DeviceMemory,
    bytes: u64,
}

impl Gpu {
    /// A buffer the shader reads at full speed, filled and read back through [`Gpu::staging`].
    ///
    /// **Device-local, and the distinction is the whole measurement.** A host-visible allocation
    /// that is not also device-local is system memory behind the bus, and a multiply fed from there
    /// measures PCIe. What is *not* asked for here is a mappable window onto that memory: the one a
    /// card exposes is 256MB unless the machine has resizable BAR turned on, which is less than a
    /// batch of tiles needs, and a copy at startup costs nothing the timestamps can see.
    fn hold(&self, bytes: u64) -> Held {
        self.allocate(
            bytes,
            vk::BufferUsageFlags::STORAGE_BUFFER
                | vk::BufferUsageFlags::TRANSFER_SRC
                | vk::BufferUsageFlags::TRANSFER_DST,
            vk::MemoryPropertyFlags::DEVICE_LOCAL,
        )
    }

    /// A buffer the host writes and reads, and the device only copies to and from.
    fn staging(&self, bytes: u64) -> Held {
        self.allocate(
            bytes,
            vk::BufferUsageFlags::TRANSFER_SRC | vk::BufferUsageFlags::TRANSFER_DST,
            vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
        )
    }

    fn allocate(
        &self,
        bytes: u64,
        usage: vk::BufferUsageFlags,
        asked: vk::MemoryPropertyFlags,
    ) -> Held {
        let buffer = unsafe {
            self.device.create_buffer(
                &vk::BufferCreateInfo::default()
                    .size(bytes)
                    .usage(usage)
                    .sharing_mode(vk::SharingMode::EXCLUSIVE),
                None,
            )
        }
        .expect("a buffer");
        let wants = unsafe { self.device.get_buffer_memory_requirements(buffer) };
        let kind = (0..self.memory.memory_type_count)
            .find(|at| {
                wants.memory_type_bits & (1 << at) != 0
                    && self.memory.memory_types[*at as usize].property_flags.contains(asked)
            })
            .expect("a memory type");
        let memory = unsafe {
            self.device.allocate_memory(
                &vk::MemoryAllocateInfo::default().allocation_size(wants.size).memory_type_index(kind),
                None,
            )
        }
        .expect("device memory");
        unsafe { self.device.bind_buffer_memory(buffer, memory, 0) }.expect("bound");
        Held { buffer, memory, bytes }
    }

    fn fill(&self, held: &Held, values: &[u16]) {
        assert!(values.len() * 2 <= held.bytes as usize, "the fill is larger than the buffer");
        let bytes = (values.len() * 2) as u64;
        let staged = self.staging(bytes);
        let mapped =
            unsafe { self.device.map_memory(staged.memory, 0, bytes, vk::MemoryMapFlags::empty()) }
                .expect("mapped");
        unsafe {
            std::ptr::copy_nonoverlapping(values.as_ptr(), mapped.cast::<u16>(), values.len());
            self.device.unmap_memory(staged.memory);
        }
        self.copy(&staged, held, bytes);
        self.drop_held(&staged);
    }

    fn read(&self, held: &Held, count: usize) -> Vec<u16> {
        assert!(count * 2 <= held.bytes as usize, "the read is larger than the buffer");
        let bytes = (count * 2) as u64;
        let staged = self.staging(bytes);
        self.copy(held, &staged, bytes);
        let mapped =
            unsafe { self.device.map_memory(staged.memory, 0, bytes, vk::MemoryMapFlags::empty()) }
                .expect("mapped");
        let mut out = vec![0u16; count];
        unsafe {
            std::ptr::copy_nonoverlapping(mapped.cast::<u16>(), out.as_mut_ptr(), count);
            self.device.unmap_memory(staged.memory);
        }
        self.drop_held(&staged);
        out
    }

    /// One copy, submitted and waited on, which is every transfer this example makes.
    fn copy(&self, from: &Held, to: &Held, bytes: u64) {
        let device = &self.device;
        unsafe {
            let pool = device
                .create_command_pool(
                    &vk::CommandPoolCreateInfo::default()
                        .queue_family_index(self.family)
                        .flags(vk::CommandPoolCreateFlags::TRANSIENT),
                    None,
                )
                .expect("a command pool");
            let buffer = device
                .allocate_command_buffers(
                    &vk::CommandBufferAllocateInfo::default()
                        .command_pool(pool)
                        .level(vk::CommandBufferLevel::PRIMARY)
                        .command_buffer_count(1),
                )
                .expect("a command buffer")[0];
            device
                .begin_command_buffer(
                    buffer,
                    &vk::CommandBufferBeginInfo::default()
                        .flags(vk::CommandBufferUsageFlags::ONE_TIME_SUBMIT),
                )
                .expect("begin");
            device.cmd_copy_buffer(
                buffer,
                from.buffer,
                to.buffer,
                &[vk::BufferCopy::default().size(bytes)],
            );
            device.end_command_buffer(buffer).expect("end");
            device
                .queue_submit(
                    self.queue,
                    &[vk::SubmitInfo::default().command_buffers(&[buffer])],
                    vk::Fence::null(),
                )
                .expect("submitted");
            device.queue_wait_idle(self.queue).expect("idle");
            device.destroy_command_pool(pool, None);
        }
    }

    fn drop_held(&self, held: &Held) {
        unsafe {
            self.device.destroy_buffer(held.buffer, None);
            self.device.free_memory(held.memory, None);
        }
    }
}

fn main() {
    let tiles: usize = std::env::args()
        .nth(1)
        .map_or(TILES_IN_A_FRAME, |it| it.parse().expect("a tile count"));
    // Tiles to a dispatch. A layer's columns are pixels and its weights are the same for every tile,
    // so `batch` tiles are one multiply of a matrix `batch` times as wide - which is the only thing
    // that moves the dispatch floor the run reports at the end, and that floor is a sixth of what the
    // fastest shape costs. What it costs in return is the activations of `batch` tiles resident at
    // once, which is the reason the default is one.
    let batch: usize = std::env::args().nth(2).map_or(1, |it| it.parse().expect("a batch size"));
    assert!(tiles % batch == 0, "{tiles} tiles do not divide into batches of {batch}");

    let packed = SENSOR_TILE / 2;
    let layers = multiplies(packed);
    let dispatched: Vec<Multiply> =
        layers.iter().map(|it| Multiply { columns: it.columns * batch as u32, ..*it }).collect();
    let groups = tiles / batch;
    let macs: u64 = layers.iter().map(Multiply::macs).sum();
    eprintln!(
        "{} pointwise layers over a {packed}x{packed} plane: {:.2} GMAC a tile, {:.1} GMAC over {tiles} in {groups} dispatches each",
        layers.len(),
        macs as f64 / 1e9,
        (macs * tiles as u64) as f64 / 1e9,
    );

    let gpu = device();

    // One region for the weights and two for the pictures: every layer reads the first and writes
    // the second, at offset zero, rather than following a chain through an arena. What that changes
    // is which addresses are touched, not how many - each layer still reads `depth * columns` and
    // writes `rows * columns` of a region sized to the largest of them - and the question here is
    // the rate. It does mean the answer is arithmetic over whatever is in the buffer, which is what
    // [`correct`] is for.
    let weights_halves: usize =
        layers.iter().map(|it| (it.rows as usize) * (it.depth as usize)).sum();
    let widest: usize = dispatched
        .iter()
        .map(|it| (it.columns as usize) * (it.rows.max(it.depth) as usize))
        .max()
        .expect("a layer");

    let weights = gpu.hold((weights_halves * 2) as u64);
    let ping = gpu.hold((widest * 2) as u64);
    let pong = gpu.hold((widest * 2) as u64);
    let wide = gpu.hold((widest * 4) as u64);

    // Anything but zero, and small enough that a `half` accumulation over 512 terms stays finite.
    let noise = |seed: usize| half::f16::from_f32(((seed % 17) as f32 - 8.0) / 64.0).to_bits();
    gpu.fill(&weights, &(0..weights_halves).map(noise).collect::<Vec<_>>());
    gpu.fill(&ping, &(0..widest).map(|at| noise(at + 5)).collect::<Vec<_>>());
    gpu.fill(&pong, &(0..widest).map(|at| noise(at + 11)).collect::<Vec<_>>());

    // `wide` twice: the last binding is the biases the network's own dispatch reads, which nothing
    // measured here touches, and a descriptor set still has to cover it.
    let run = Run::new(&gpu, &[&weights, &ping, &pong, &wide, &wide]);

    correct(&gpu, &run, &weights, &ping, &pong);

    for arm in &run.arms {
        // A shape that cannot take every layer is run with the fastest shape of its own accumulator
        // behind it, which is what lets a deeper step be measured at all: the sixteen-channel layers
        // divide by nothing deeper than one fragment. It has to be the fastest one rather than the
        // simplest, because eight of the 43 layers fall back and a slow shape behind them is most
        // of what the row would then report.
        let behind = run
            .arms
            .iter()
            .find(|it| it.name == match arm.name.contains("wide") {
                true => "widef_1x2x1",
                false => "halff_1x2x1",
            })
            .expect("a shape every layer divides by");
        let tried = [arm, behind];
        if layers.iter().any(|it| !tried.iter().any(|arm| it.fits(arm))) {
            eprintln!("{}: not every layer divides by this tile", arm.name);
            continue;
        }
        // **The best of several passes, and one before the clock starts.** A device that has been
        // idle is at its resting clocks, and the first pass measured ten milliseconds slower than
        // every one after it - which is the same run, reported as a difference.
        run.time(&gpu, &tried, &dispatched, groups);
        let spent = (0..3)
            .map(|_| run.time(&gpu, &tried, &dispatched, groups))
            .fold(f64::INFINITY, f64::min);
        let fell_back = layers.iter().filter(|it| !it.fits(arm)).count();
        // The arms that hoist their loads out of the depth loop read three fragments however deep
        // the layer is, so the formula below - which counts a fragment a step, as every other arm
        // does - would report traffic they never ask for.
        let reads_per_step = !arm.name.contains("math");
        let read: u64 = layers
            .iter()
            .map(|it| it.read(if it.fits(arm) { arm } else { behind }))
            .sum::<u64>()
            * tiles as u64;
        eprintln!(
            "{}: {spent:.1}ms over {tiles} tiles, {:.1} TFLOP/s{}{}",
            arm.name,
            (macs * tiles as u64 * 2) as f64 / (spent / 1e3) / 1e12,
            match reads_per_step {
                true => format!(", {:.0} GB/s asked for", read as f64 / (spent / 1e3) / 1e9),
                false => String::new(),
            },
            match fell_back {
                0 => String::new(),
                some => format!(" ({some} layers on the shape behind it)"),
            },
        );
    }

    // What the network costs when nothing makes it pick one shape for all of it, which is what a
    // host dispatching these layers would do: every layer timed alone against every shape it divides
    // by, and the fastest kept. The rows above are each one shape over the whole network, so a shape
    // that suits the deep layers and not the shallow ones is reported at its worst here and at its
    // best below. A minimum over a hundred noisy timings flatters itself, so read this as the floor
    // of what choosing per layer is worth rather than as what it is worth.
    let picked: Vec<(&str, f64)> = dispatched
        .iter()
        .map(|layer| {
            let alone = std::slice::from_ref(layer);
            run.arms
                .iter()
                .filter(|arm| !arm.name.starts_with("bound") && layer.fits(arm))
                .map(|arm| {
                    run.time(&gpu, &[arm], alone, groups);
                    let spent = (0..3)
                        .map(|_| run.time(&gpu, &[arm], alone, groups))
                        .fold(f64::INFINITY, f64::min);
                    (arm.name, spent)
                })
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .expect("a shape that fits")
        })
        .collect();
    let mut shapes: Vec<&str> = picked.iter().map(|it| it.0).collect();
    shapes.sort_unstable();
    shapes.dedup();
    eprintln!(
        "the fastest shape for each layer: {:.1}ms over {tiles} tiles, {:.1} TFLOP/s, {} shapes ({})",
        picked.iter().map(|it| it.1).sum::<f64>(),
        (macs * tiles as u64 * 2) as f64 / (picked.iter().map(|it| it.1).sum::<f64>() / 1e3) / 1e12,
        shapes.len(),
        shapes.join(", "),
    );

    // What the same run costs with the multiplies taken out of it: one workgroup a layer, so the
    // dispatches and the barriers between them are all that is left. A layer of this network is a
    // few hundred microseconds of device, and there are 43 of them a tile.
    let smallest = run.arms.iter().find(|it| it.name == "wide_1x1x1").expect("the smallest arm");
    let empty: Vec<Multiply> = (0..layers.len())
        .map(|_| Multiply { rows: FRAG, columns: FRAG, depth: FRAG, weights_at: 0 })
        .collect();
    run.time(&gpu, &[smallest], &empty, groups);
    let floor =
        (0..3).map(|_| run.time(&gpu, &[smallest], &empty, groups)).fold(f64::INFINITY, f64::min);
    eprintln!("{} dispatches with no work in them: {floor:.1}ms", layers.len() * groups);

    run.shut(&gpu);
    for held in [&weights, &ping, &pong, &wide] {
        gpu.drop_held(held);
    }
    unsafe {
        gpu.device.destroy_device(None);
        gpu.instance.destroy_instance(None);
    }
}

/// One shape of the multiply: the shader entry point, and what one workgroup of it covers.
struct Arm {
    name: &'static str,
    pipeline: vk::Pipeline,
    rows: u32,
    columns: u32,
    depth: u32,
}

struct Run {
    layout: vk::DescriptorSetLayout,
    pipeline_layout: vk::PipelineLayout,
    module: vk::ShaderModule,
    arms: Vec<Arm>,
    pool: vk::DescriptorPool,
    set: vk::DescriptorSet,
    commands: vk::CommandPool,
    buffer: vk::CommandBuffer,
    queries: vk::QueryPool,
}

impl Run {
    fn new(gpu: &Gpu, held: &[&Held]) -> Run {
        let device = &gpu.device;
        let bindings: Vec<_> = (0..held.len() as u32)
            .map(|at| {
                vk::DescriptorSetLayoutBinding::default()
                    .binding(at)
                    .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                    .descriptor_count(1)
                    .stage_flags(vk::ShaderStageFlags::COMPUTE)
            })
            .collect();
        let layout = unsafe {
            device.create_descriptor_set_layout(
                &vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings),
                None,
            )
        }
        .expect("a descriptor layout");

        let pushes = [vk::PushConstantRange::default()
            .stage_flags(vk::ShaderStageFlags::COMPUTE)
            .offset(0)
            .size(std::mem::size_of::<Pushed>() as u32)];
        let layouts = [layout];
        let pipeline_layout = unsafe {
            device.create_pipeline_layout(
                &vk::PipelineLayoutCreateInfo::default()
                    .set_layouts(&layouts)
                    .push_constant_ranges(&pushes),
                None,
            )
        }
        .expect("a pipeline layout");

        let spirv = include_bytes!(concat!(env!("OUT_DIR"), "/spirv/pmrid_coop.spv"));
        let words = ash::util::read_spv(&mut std::io::Cursor::new(&spirv[..])).expect("the SPIR-V");
        let module = unsafe {
            device.create_shader_module(&vk::ShaderModuleCreateInfo::default().code(&words), None)
        }
        .expect("the shader module");

        // A pipeline is only built for a shape the device will run: asking for an `f32` accumulator
        // where there is no such configuration is a pipeline that fails to compile, or worse, one
        // that dispatches something undefined.
        let shapes: Vec<_> = SHAPES
            .iter()
            .filter(|(name, ..)| {
                gpu.accumulates_wide || !name.to_string_lossy().contains("wide")
            })
            .collect();
        let entry_points: Vec<_> = shapes
            .iter()
            .map(|(name, ..)| {
                vk::PipelineShaderStageCreateInfo::default()
                    .stage(vk::ShaderStageFlags::COMPUTE)
                    .module(module)
                    .name(name)
            })
            .collect();
        let asked: Vec<_> = entry_points
            .iter()
            .map(|stage| {
                vk::ComputePipelineCreateInfo::default().layout(pipeline_layout).stage(*stage)
            })
            .collect();
        let built =
            unsafe { device.create_compute_pipelines(vk::PipelineCache::null(), &asked, None) }
                .expect("the pipelines");
        let arms = shapes
            .iter()
            .zip(&built)
            .map(|((name, tall, span, gangs, deep), pipeline)| {
                // A `d` shape puts its subgroups on rows, so a workgroup of it is that much taller
                // rather than that much wider.
                let name = name.to_str().expect("a name");
                let down = name.starts_with("halfd") || name.starts_with("wided");
                Arm {
                    name,
                    pipeline: *pipeline,
                    rows: tall * FRAG * if down { *gangs } else { 1 },
                    columns: span * FRAG * if down { 1 } else { *gangs },
                    depth: deep * FRAG,
                }
            })
            .collect();

        let sizes = [vk::DescriptorPoolSize::default()
            .ty(vk::DescriptorType::STORAGE_BUFFER)
            .descriptor_count(held.len() as u32)];
        let pool = unsafe {
            device.create_descriptor_pool(
                &vk::DescriptorPoolCreateInfo::default().max_sets(1).pool_sizes(&sizes),
                None,
            )
        }
        .expect("a descriptor pool");
        let set = unsafe {
            device.allocate_descriptor_sets(
                &vk::DescriptorSetAllocateInfo::default().descriptor_pool(pool).set_layouts(&layouts),
            )
        }
        .expect("a descriptor set")[0];

        let regions: Vec<_> = held
            .iter()
            .map(|it| [vk::DescriptorBufferInfo::default().buffer(it.buffer).range(vk::WHOLE_SIZE)])
            .collect();
        let writes: Vec<_> = regions
            .iter()
            .enumerate()
            .map(|(at, region)| {
                vk::WriteDescriptorSet::default()
                    .dst_set(set)
                    .dst_binding(at as u32)
                    .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
                    .buffer_info(region)
            })
            .collect();
        unsafe { device.update_descriptor_sets(&writes, &[]) };

        let commands = unsafe {
            device.create_command_pool(
                &vk::CommandPoolCreateInfo::default()
                    .queue_family_index(gpu.family)
                    .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER),
                None,
            )
        }
        .expect("a command pool");
        let buffer = unsafe {
            device.allocate_command_buffers(
                &vk::CommandBufferAllocateInfo::default()
                    .command_pool(commands)
                    .level(vk::CommandBufferLevel::PRIMARY)
                    .command_buffer_count(1),
            )
        }
        .expect("a command buffer")[0];
        let queries = unsafe {
            device.create_query_pool(
                &vk::QueryPoolCreateInfo::default()
                    .query_type(vk::QueryType::TIMESTAMP)
                    .query_count(2),
                None,
            )
        }
        .expect("a query pool");

        Run {
            layout,
            pipeline_layout,
            module,
            arms,
            pool,
            set,
            commands,
            buffer,
            queries,
        }
    }

    /// Records the layers `tiles` times over and reports what the device spent, in milliseconds.
    ///
    /// The timestamps are the device's own, so the host's recording is not in the number - which is
    /// the same thing `examples/pmrid.rs` reports and what makes the two comparable.
    fn time(&self, gpu: &Gpu, arms: &[&Arm], layers: &[Multiply], tiles: usize) -> f64 {
        let device = &gpu.device;
        unsafe {
            device.reset_command_buffer(self.buffer, vk::CommandBufferResetFlags::empty()).expect("reset");
            device
                .begin_command_buffer(self.buffer, &vk::CommandBufferBeginInfo::default())
                .expect("begin");
            device.cmd_reset_query_pool(self.buffer, self.queries, 0, 2);
            device.cmd_write_timestamp(
                self.buffer,
                vk::PipelineStageFlags::TOP_OF_PIPE,
                self.queries,
                0,
            );
            device.cmd_bind_descriptor_sets(
                self.buffer,
                vk::PipelineBindPoint::COMPUTE,
                self.pipeline_layout,
                0,
                &[self.set],
                &[],
            );
            for _ in 0..tiles {
                for layer in layers {
                    let pushed = Pushed {
                        rows: layer.rows,
                        columns: layer.columns,
                        depth: layer.depth,
                        weights_at: layer.weights_at,
                        ..Pushed::default()
                    };
                    device.cmd_push_constants(
                        self.buffer,
                        self.pipeline_layout,
                        vk::ShaderStageFlags::COMPUTE,
                        0,
                        std::slice::from_raw_parts(
                            std::ptr::addr_of!(pushed).cast::<u8>(),
                            std::mem::size_of::<Pushed>(),
                        ),
                    );
                    // The first shape the layer divides by. A shape that reads several steps of the
                    // depth at once cannot take a sixteen-channel layer, and this network has
                    // those, so the shallow shape behind it is what they run.
                    let arm = arms.iter().find(|it| layer.fits(it)).expect("a shape that fits");
                    device.cmd_bind_pipeline(
                        self.buffer,
                        vk::PipelineBindPoint::COMPUTE,
                        arm.pipeline,
                    );
                    device.cmd_dispatch(
                        self.buffer,
                        layer.columns / arm.columns,
                        layer.rows / arm.rows,
                        1,
                    );
                    let barrier = [vk::MemoryBarrier::default()
                        .src_access_mask(vk::AccessFlags::SHADER_WRITE)
                        .dst_access_mask(vk::AccessFlags::SHADER_READ)];
                    device.cmd_pipeline_barrier(
                        self.buffer,
                        vk::PipelineStageFlags::COMPUTE_SHADER,
                        vk::PipelineStageFlags::COMPUTE_SHADER,
                        vk::DependencyFlags::empty(),
                        &barrier,
                        &[],
                        &[],
                    );
                }
            }
            device.cmd_write_timestamp(
                self.buffer,
                vk::PipelineStageFlags::BOTTOM_OF_PIPE,
                self.queries,
                1,
            );
            device.end_command_buffer(self.buffer).expect("end");

            let buffers = [self.buffer];
            let submit = [vk::SubmitInfo::default().command_buffers(&buffers)];
            device.queue_submit(gpu.queue, &submit, vk::Fence::null()).expect("submitted");
            device.queue_wait_idle(gpu.queue).expect("finished");

            let mut stamps = [0u64; 2];
            device
                .get_query_pool_results(
                    self.queries,
                    0,
                    &mut stamps,
                    vk::QueryResultFlags::TYPE_64 | vk::QueryResultFlags::WAIT,
                )
                .expect("the timestamps");
            (stamps[1] - stamps[0]) as f64 * f64::from(gpu.tick) / 1e6
        }
    }

    fn shut(&self, gpu: &Gpu) {
        let device = &gpu.device;
        unsafe {
            device.destroy_query_pool(self.queries, None);
            device.destroy_command_pool(self.commands, None);
            device.destroy_descriptor_pool(self.pool, None);
            for arm in &self.arms {
                device.destroy_pipeline(arm.pipeline, None);
            }
            device.destroy_shader_module(self.module, None);
            device.destroy_pipeline_layout(self.pipeline_layout, None);
            device.destroy_descriptor_set_layout(self.layout, None);
        }
    }
}

/// One small layer against a host multiply, so that the rate below is a rate for the right answer.
///
/// Both layouts are checked, because the blocked arms are only faster if they are also right: they
/// read and write the same matrices a fragment at a time, and an index wrong by a fragment is a
/// multiply of the wrong things at exactly the same speed.
fn correct(gpu: &Gpu, run: &Run, weights: &Held, ping: &Held, pong: &Held) {
    for (name, blocked) in [
        ("half_1x4x4", false),
        ("halfb_1x2x1_2", true),
        ("halff_1x2x2", true),
        ("halff_2x2x1_2", true),
        ("halfu_1x2x2_2", true),
        ("halfd_2x2x2_2", true),
    ]
    {
        let arm = run.arms.iter().find(|it| it.name == name).expect("the reference arm");
        let (rows, columns, depth) = (arm.rows.max(FRAG), arm.columns.max(FRAG), 64u32);
        let layer = Multiply { rows, columns, depth, weights_at: 0 };
        run.time(gpu, &[arm], &[layer], 1);

        let a = gpu.read(weights, (rows * depth) as usize);
        let b = gpu.read(ping, (depth * columns) as usize);
        let c = gpu.read(pong, (rows * columns) as usize);
        // Where `(row, column)` of a `columns`-wide matrix sits in whichever layout this arm reads.
        let at = |row: u32, column: u32, wide: u32| match blocked {
            true => {
                let fragment = (row / FRAG) * (wide / FRAG) + column / FRAG;
                (fragment * FRAG * FRAG + (row % FRAG) * FRAG + column % FRAG) as usize
            }
            false => (row * wide + column) as usize,
        };

        let mut worst = 0.0f32;
        for row in 0..rows {
            for column in 0..columns {
                let mut sum = 0.0f32;
                for k in 0..depth {
                    sum += half::f16::from_bits(a[at(row, k, depth)]).to_f32()
                        * half::f16::from_bits(b[at(k, column, columns)]).to_f32();
                }
                let got = half::f16::from_bits(c[at(row, column, columns)]).to_f32();
                worst = worst.max((got - sum).abs());
            }
        }
        assert!(worst < 0.01, "{name} disagrees with the host by {worst}");
        eprintln!("{name} agrees with a host reference to {worst:.2e}");
    }
}
