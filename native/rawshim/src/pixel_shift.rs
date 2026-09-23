//! A sensor-shift burst merged on the photosite lattice, in place of a demosaic (`pixel_shift.slang`).

/// Where each frame of a 4-shot burst's photosites landed against the first's, in sensor rows and
/// columns, by the frame's place in the burst.
pub const SHIFTS: [(i32, i32); 4] = [(0, 0), (1, 0), (1, -1), (0, -1)];

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    width: u32,
    height: u32,
    dy: i32,
    dx: i32,
    colours: [u32; 4],
}

#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

fn kernel(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "scatter",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift.wgsl")),
            &[(0, UNIFORM), (1, READ), (2, WRITE)],
            &[],
        )
    })
}

/// An empty plane of three `f32` a site, which [`scatter`] adds a burst's frames into and
/// `demosaic::assemble_into` reads as it reads RCD's.
pub fn plane(gpu: &crate::gpu::Gpu, width: usize, height: usize) -> crate::gpu::Buffer {
    gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("pixel shift rgb"),
        contents: &vec![0u8; (width * height * 3).max(1) * 4],
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    })
}

/// One frame's photosites, each added into the channel its filter names at the site `shift` moved
/// it to. Bayer only, which is every body that shoots one.
pub fn scatter(
    gpu: &'static crate::gpu::Gpu,
    mosaic: &crate::condition::Mosaic,
    cfa: &crate::cfa::Cfa,
    shift: (i32, i32),
    rgb: &crate::gpu::Buffer,
) -> Option<()> {
    if !cfa.is_bayer() {
        return None;
    }
    let kernel = kernel(gpu);
    let params = Params {
        width: mosaic.width as u32,
        height: mosaic.height as u32,
        dy: shift.0,
        dx: shift.1,
        colours: [
            u32::from(cfa.colour_at(0, 0)),
            u32::from(cfa.colour_at(0, 1)),
            u32::from(cfa.colour_at(1, 0)),
            u32::from(cfa.colour_at(1, 1)),
        ],
    };
    let mut recording = gpu.record();
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pixel shift params"),
        contents: bytemuck::bytes_of(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    recording.holding(&mosaic.buffer);
    recording.holding(rgb);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pixel shift"),
        layout: &kernel.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: mosaic.buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: rgb.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(
            (mosaic.width as u32).div_ceil(8),
            (mosaic.height as u32).div_ceil(8),
            1,
        );
    }
    recording.submit();
    Some(())
}

#[cfg(test)]
mod tests {
    /// Four frames of one scene, each read through the mosaic a photosite along, merge back to the
    /// scene in every channel - no interpolation, so exactly.
    #[test]
    fn a_four_shot_burst_reconstructs_every_channel() {
        let Some(gpu) = crate::gpu::device() else { return };
        let (w, h) = (24usize, 16usize);
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        // Distinct per site and per channel, so a shift off by one lands on a different value.
        let scene = |r: i64, c: i64, channel: usize| -> f32 {
            (r * 97 + c * 13 + channel as i64 * 5) as f32 / 4096.0
        };
        let rgb = super::plane(gpu, w, h);
        for (dy, dx) in super::SHIFTS {
            // Frame s's photosite q saw the scene at q + shift.
            let mosaic: Vec<f32> = (0..h)
                .flat_map(|r| {
                    (0..w).map(move |c| {
                        let colour = usize::from(cfa.colour_at(r, c));
                        scene(r as i64 + i64::from(dy), c as i64 + i64::from(dx), colour)
                    })
                })
                .collect();
            let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, w, h);
            super::scatter(gpu, &uploaded, &cfa, (dy, dx), &rgb).expect("a Bayer frame scatters");
        }
        let bytes = (w * h * 3 * 4) as u64;
        let mut recording = gpu.record();
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pixel shift readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(&rgb, 0, &readback, 0, bytes);
        recording.submit();
        let got: Vec<f32> = pollster::block_on(crate::gpu::read_back(gpu, &readback, |mapped| {
            bytemuck::cast_slice::<u8, f32>(mapped).to_vec()
        }))
        .expect("the plane reads back");
        // The edge rows and columns take a photosite a period away, which is not the scene there.
        for r in 1..h - 1 {
            for c in 1..w - 1 {
                for channel in 0..3 {
                    let want = scene(r as i64, c as i64, channel);
                    let at = got[(r * w + c) * 3 + channel];
                    assert!(
                        (at - want).abs() < 1e-6,
                        "site {r},{c} channel {channel} is {at} against {want}"
                    );
                }
            }
        }
    }
}
