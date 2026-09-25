//! The seam field (§3.5): what each frame's light and colour are over every shrunk cell.
//!
//! Three passes of `assembly_levels.slang`, and the canvas itself never comes back off the device:
//! only the cell grid does.

use crate::assembly_planes::Plane;
use crate::assembly_seam::{SHRINK, SeamField, shrunk_size};
use crate::base::Base;
use crate::gpu::{self, Gpu};

/// The most frames one assembly may hold, which is what bounds the shader's per-frame arrays.
pub const MOST_SOURCES: usize = 12;

/// `Params` in `assembly_levels.slang`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    size: [u32; 2],
    sources: u32,
    slot: u32,
    shrink: u32,
    pad: [u32; 3],
}

/// The block's size, for `wgsl_layout.rs` to hold against the shader's own.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

fn built(gpu: &'static Gpu, entry: &str) -> crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    crate::hdr_fit::kernel(
        gpu,
        entry,
        include_str!(concat!(env!("OUT_DIR"), "/wgsl/assembly_levels.wgsl")),
        &[
            (0, UNIFORM),
            (1, READ),
            (2, WRITE),
            (3, WRITE),
            (4, READ),
            (5, READ),
            (6, WRITE),
            (7, WRITE),
        ],
        &[],
    )
}

fn stacking(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_stack"))
}

fn tinting(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_tint"))
}

fn levelling(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| built(gpu, "assembly_level"))
}

/// Room for a pass to write, with nothing in it: every one of these is written whole before it is
/// read, `clipped` included - `assembly_stack` assigns the first frame's bit rather than folding
/// it in.
fn storage(gpu: &'static Gpu, words: usize, label: &str) -> gpu::Buffer {
    gpu.own_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: ((words * 4).max(4)) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

/// The field over `planes`, all at `size` and coded PQ, in the order they arrived.
///
/// `stepped` is called between the stack and the cell passes, which is where a cancel is seen.
pub async fn seam_field<E>(
    gpu: &'static Gpu,
    base: &'static Base,
    planes: &[Plane],
    size: (usize, usize),
    stepped: impl Fn() -> Result<(), E>,
) -> Result<SeamField, E> {
    assert!(
        planes.len() <= MOST_SOURCES,
        "the host refuses more than {MOST_SOURCES} sources before this",
    );
    let sources = planes.len();
    let pixels = size.0 * size.1;
    let shrunk = shrunk_size(size);
    let cells = shrunk.0 * shrunk.1;

    let stacked = storage(gpu, pixels * sources, "assembly stacked");
    let clipped = storage(gpu, pixels, "assembly clipped");
    let tint = storage(gpu, cells * sources * 2, "assembly tint");
    let level = storage(gpu, cells * (sources + 1), "assembly level");
    let noise: Vec<f32> = planes.iter().flat_map(noise_in_plane_units).collect();
    let noise = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("assembly noise"),
        contents: bytemuck::cast_slice(&noise),
        usage: wgpu::BufferUsages::STORAGE,
    });

    let over = |kernel: &crate::hdr_fit::Kernel, frame: &gpu::Buffer, slot: usize, count: usize| {
        let mut recording = gpu.record();
        let params = Params {
            size: [size.0 as u32, size.1 as u32],
            sources: sources as u32,
            slot: slot as u32,
            shrink: SHRINK as u32,
            pad: [0; 3],
        };
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("assembly levels params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        for held in [frame, &stacked, &clipped, &tint, &level] {
            recording.holding(held);
        }
        fn bound(binding: u32, buffer: &gpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding,
                resource: buffer.as_entire_binding(),
            }
        }
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("assembly levels"),
            layout: &kernel.layout,
            entries: &[
                bound(0, &uniform),
                bound(1, frame),
                bound(2, &stacked),
                bound(3, &clipped),
                bound(4, &noise),
                bound(5, base.light_of_code()),
                bound(6, &tint),
                bound(7, &level),
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            let (x, y) = crate::base::groups(count);
            pass.dispatch_workgroups(x, y, 1);
        }
        recording.submit();
    };

    for (slot, plane) in planes.iter().enumerate() {
        over(stacking(gpu), plane.rgb.buffer(), slot, pixels);
        over(tinting(gpu), plane.rgb.buffer(), slot, cells);
    }
    stepped()?;
    over(levelling(gpu), planes[0].rgb.buffer(), 0, cells);
    Ok(SeamField {
        level: read_words::<f32>(gpu, &level, cells * (sources + 1)).await,
        tint: read_words::<f32>(gpu, &tint, cells * sources * 2).await,
        sources,
    })
}

/// [`Plane::noise`] where the tint's floor is taken: a variance in the plane's own light, per
/// pixel of the plane, whose luma is averaged over `independent_samples` photosites.
fn noise_in_plane_units(plane: &Plane) -> [f32; 2] {
    let averaged = f64::from(plane.independent_samples).max(1.0);
    // `assembly_levels.slang`'s `assembly_tint` weighs the same three channels the same way.
    crate::base::luma_noise_in_light(plane.noise, plane.full_scale_light, plane.wb_gains)
        .map(|term| (term / averaged) as f32)
}

/// A buffer's words, on the host. `COPY_SRC`, since a storage buffer cannot be mapped.
async fn read_words<T: bytemuck::Pod>(
    gpu: &'static Gpu,
    buffer: &gpu::Buffer,
    count: usize,
) -> Vec<T> {
    let bytes = (count * std::mem::size_of::<T>()) as u64;
    let mut recording = gpu.record();
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("assembly readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    recording
        .encoder()
        .copy_buffer_to_buffer(buffer, 0, &readback, 0, bytes);
    recording.submit();
    gpu::read_back(gpu, &readback, |mapped| {
        bytemuck::cast_slice::<u8, T>(mapped).to_vec()
    })
    .await
    .expect("an assembly readback")
}

#[cfg(test)]
mod tests {
    /// The shader's per-frame arrays are fixed, so a host that admitted more sources than they hold
    /// would read every frame past the last as zero light - and the server refuses past its own.
    #[test]
    fn the_shader_and_the_server_admit_as_many_sources_as_the_host() {
        let most = super::MOST_SOURCES;
        let line = format!("static const uint MOST_SOURCES = {most};");
        assert!(
            include_str!("../../../slang/assembly_levels.slang").contains(&line),
            "assembly_levels.slang does not say `{line}`"
        );
        let line = format!("export const MOST_SOURCES = {most};");
        assert!(
            include_str!("../../../src/schemas/assembly.ts").contains(&line),
            "the schema does not say `{line}`"
        );
    }

    /// The shader writes the sentinel and the host reads it back as "not reached": if one moves,
    /// every uncovered cell reads as a level of -1e30 stops.
    #[test]
    fn the_sentinel_the_shader_writes_is_the_one_the_host_reads() {
        let line = format!(
            "static const float NOT_REACHED = {:e};",
            crate::assembly_seam::NOT_REACHED
        );
        assert!(
            include_str!("../../../slang/assembly_levels.slang").contains(&line),
            "assembly_levels.slang does not say `{line}`"
        );
    }
}
