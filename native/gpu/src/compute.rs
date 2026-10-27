//! A compute kernel over storage buffers, and the shape of a dispatch over a frame.

use crate::Gpu;

/// Invocations per workgroup, and the pair every kernel here is dispatched over.
const LANES: u32 = 64;

/// Workgroups to a row of a two-dimensional dispatch, which `lanes.slang`'s `ROW_GROUPS` is the
/// shader's copy of.
///
/// **Only meaningful because `groups` below dispatches `x` at exactly this whenever `y` exceeds
/// one.** The shaders fold `y` back in by multiplying by this rather than by asking how wide the
/// dispatch actually was, so the two numbers are one number and
/// `the_shaders_split_a_dispatch_where_the_host_does` refuses a build where they drift.
///
/// Narrow, because a row is the least [`crate::Recording::banded`] can submit at once.
pub const ROW_GROUPS: u32 = 1024;

/// Workgroups for `count` invocations, spread over two dimensions.
///
/// **A dispatch dimension stops at 65535**, which one dimension of 64-wide groups reaches at 4.19M
/// invocations - a 61MP frame is fourteen times that, and the driver refuses the whole command
/// buffer rather than clamping. Every kernel here indexes by a linear id, so the second dimension
/// is a carry rather than a shape and `lanes.slang`'s `linear` undoes it.
///
/// Found by wiring the warp into a real render: the tests all ran on synthetic frames of a few
/// hundred pixels a side, where a dispatch is hundreds of groups and this is invisible.
pub fn groups(count: usize) -> (u32, u32) {
    let groups = (count as u32).div_ceil(LANES).max(1);
    // `min`, so a dispatch that fits one row is not padded out to a full one. The shader's fold is
    // still exact there: `y` is 1, so the term it would multiply is zero.
    let across = groups.min(ROW_GROUPS);
    (across, groups.div_ceil(across))
}

/// A compute kernel whose bindings are all buffers, built once per device.
pub struct Kernel {
    pub layout: wgpu::BindGroupLayout,
    pub pipeline: wgpu::ComputePipeline,
}

pub fn kernel(
    gpu: &'static Gpu,
    name: &str,
    wgsl: &str,
    bindings: &[(u32, wgpu::BufferBindingType)],
    constants: &[(&str, f64)],
) -> Kernel {
    let device = gpu.describing();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some(name),
        source: wgpu::ShaderSource::Wgsl(wgsl.into()),
    });
    let layout = kernel_layout(gpu, name, bindings);
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(name),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    Kernel {
        pipeline: device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(name),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some(name),
            compilation_options: wgpu::PipelineCompilationOptions {
                constants,
                ..Default::default()
            },
            cache: None,
        }),
        layout,
    }
}

pub fn kernel_layout(
    gpu: &'static Gpu,
    name: &str,
    bindings: &[(u32, wgpu::BufferBindingType)],
) -> wgpu::BindGroupLayout {
    let entries: Vec<wgpu::BindGroupLayoutEntry> = bindings
        .iter()
        .map(|(binding, ty)| wgpu::BindGroupLayoutEntry {
            binding: *binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: *ty,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        })
        .collect();
    gpu.describing()
        .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some(name),
            entries: &entries,
        })
}

pub const READ: wgpu::BufferBindingType = wgpu::BufferBindingType::Storage { read_only: true };
pub const WRITE: wgpu::BufferBindingType = wgpu::BufferBindingType::Storage { read_only: false };
pub const UNIFORM: wgpu::BufferBindingType = wgpu::BufferBindingType::Uniform;

#[cfg(test)]
mod tests {
    /// Every dispatch a real sensor asks for is one a driver will accept.
    ///
    /// **Nothing else here can see this.** The parity tests run on frames a few hundred pixels a
    /// side, where a dispatch is hundreds of groups in one dimension and the ceiling is four
    /// orders of magnitude away; the warp reached a render before anyone noticed, and the driver
    /// refused the whole command buffer with "must be less or equal to 65535". So the sizes are
    /// asserted against the limit directly rather than against a frame that happens to be small.
    #[test]
    fn a_sensor_sized_dispatch_is_one_a_driver_will_take() {
        // 61MP, and a frame far past any sensor, which nothing bounds now that the open takes
        // whatever the tab hands it.
        for pixels in [24_240_576usize, 60_217_344, 100_000 * 100_000 / 8] {
            for count in [pixels, pixels * 3, pixels.div_ceil(2)] {
                let (x, y) = super::groups(count);
                assert!(x <= 65535 && y <= 65535, "{count} dispatches {x}x{y}");
                let covered = u64::from(x) * u64::from(y) * u64::from(super::LANES);
                assert!(covered >= count as u64, "{count} covered by only {covered}");
            }
        }
        // And a frame small enough to fit one dimension still gets one, so the common case is not
        // paying for a second.
        assert_eq!(super::groups(64 * 100).1, 1);
    }

    /// The row width the shaders fold `y` back in at, against the one the host splits at.
    ///
    /// Two spellings of one number, and the failure they guard is silent: a shader multiplying by
    /// more than the host dispatched reads a later row's samples for every row after the first, so
    /// the picture is assembled out of the wrong pixels and nothing reports it. Asserted as text
    /// because that is the only thing this side can see of the shader.
    #[test]
    fn the_shaders_split_a_dispatch_where_the_host_does() {
        let line = format!(
            "public static const uint ROW_GROUPS = {};",
            super::ROW_GROUPS
        );
        assert!(
            include_str!("../../../slang/lanes.slang").contains(&line),
            "slang/lanes.slang does not say `{line}`",
        );

        // Every dispatch the shaders undo has to be exactly that wide, or one row short of it.
        // Narrower with rows above it and the fold reads past its own row.
        for count in [
            64usize,
            64 * 1024,
            64 * 1025,
            24_240_576,
            60_217_344,
            183_000_000,
        ] {
            let (x, y) = super::groups(count);
            assert!(
                y == 1 || x == super::ROW_GROUPS,
                "{count} dispatches {x}x{y}, and the shaders fold at {}",
                super::ROW_GROUPS,
            );
            assert!(y <= 65535, "{count} dispatches {y} rows");
        }
    }
}
