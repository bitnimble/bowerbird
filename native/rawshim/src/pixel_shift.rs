//! A sensor-shift burst merged on the photosite lattice, in place of a demosaic (`pixel_shift.slang`),
//! and the reference's own demosaic where the scene moved between its frames
//! (`pixel_shift_settle.slang`).

/// Where each frame of a 4-shot burst's photosites landed against the first's, in sensor rows and
/// columns, by the frame's place in the burst.
pub const SHIFTS: [(i32, i32); 4] = [(0, 0), (1, 0), (1, -1), (0, -1)];

/// Which way each frame's greens count towards a site's disagreement. Every site's two greens come
/// from frames 1 and 3 or from 2 and 4 of [`SHIFTS`], so one of each sign.
const GREEN_SIGNS: [f32; 4] = [1.0, 1.0, -1.0, -1.0];

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ScatterParams {
    width: u32,
    height: u32,
    dy: i32,
    dx: i32,
    colours: [u32; 4],
    green_sign: f32,
    pad: [f32; 3],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct SettleParams {
    width: u32,
    height: u32,
    left: u32,
    top: u32,
    region_width: u32,
    region_height: u32,
    alpha: f32,
    sigma_sq: f32,
}

#[cfg(test)]
pub(crate) fn scatter_block() -> usize {
    std::mem::size_of::<ScatterParams>()
}

#[cfg(test)]
pub(crate) fn settle_block() -> usize {
    std::mem::size_of::<SettleParams>()
}

fn scattering(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "scatter",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift.wgsl")),
            &[(0, UNIFORM), (1, READ), (2, WRITE), (3, WRITE)],
            &[],
        )
    })
}

fn settling(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "settle",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/pixel_shift_settle.wgsl")),
            &[(0, UNIFORM), (1, READ), (2, READ), (3, WRITE)],
            &[],
        )
    })
}

/// A region's burst as it is merged: three `f32` a site in RCD's layout, and beside them how far
/// the site's two greens disagree.
pub struct Merged {
    rgb: crate::gpu::Buffer,
    disagreement: crate::gpu::Buffer,
    width: usize,
    height: usize,
}

impl Merged {
    pub fn over(gpu: &crate::gpu::Gpu, width: usize, height: usize) -> Merged {
        let zeroed = |label, floats: usize| {
            gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(label),
                contents: &vec![0u8; floats.max(1) * 4],
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            })
        };
        Merged {
            rgb: zeroed("pixel shift rgb", width * height * 3),
            disagreement: zeroed("pixel shift disagreement", width * height),
            width,
            height,
        }
    }

    /// Whether this frame's region is the one being merged.
    pub fn fits(&self, mosaic: &crate::condition::Mosaic) -> bool {
        (mosaic.width, mosaic.height) == (self.width, self.height)
    }

    /// The burst's `frame`th, each photosite added into the channel its filter names at the site
    /// [`SHIFTS`] moved it to. Bayer only, which is every body that shoots one.
    pub fn scatter(
        &self,
        gpu: &'static crate::gpu::Gpu,
        mosaic: &crate::condition::Mosaic,
        cfa: &crate::cfa::Cfa,
        frame: usize,
    ) -> Option<()> {
        let (dy, dx) = *SHIFTS.get(frame)?;
        if !cfa.is_bayer() || !self.fits(mosaic) {
            return None;
        }
        let kernel = scattering(gpu);
        let params = ScatterParams {
            width: self.width as u32,
            height: self.height as u32,
            dy,
            dx,
            colours: [
                u32::from(cfa.colour_at(0, 0)),
                u32::from(cfa.colour_at(0, 1)),
                u32::from(cfa.colour_at(1, 0)),
                u32::from(cfa.colour_at(1, 1)),
            ],
            green_sign: GREEN_SIGNS[frame],
            pad: [0.0; 3],
        };
        let mut recording = gpu.record();
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("pixel shift params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        recording.holding(&mosaic.buffer);
        recording.holding(&self.rgb);
        recording.holding(&self.disagreement);
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pixel shift"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: mosaic.buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.rgb.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.disagreement.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&kernel.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups((self.width as u32).div_ceil(8), (self.height as u32).div_ceil(8), 1);
        }
        recording.submit();
        Some(())
    }

    /// Records, over `rgb` - the reference's RCD plane for `window` of this region, as
    /// `(left, top, width, height)` - the merge wherever the frames agree, leaving the reference's own
    /// demosaic where they do not. With no `noise` only the registration tolerance judges them.
    pub fn settle(
        &self,
        gpu: &'static crate::gpu::Gpu,
        recording: &mut crate::gpu::Recording<'static>,
        rgb: &crate::gpu::Buffer,
        window: (usize, usize, usize, usize),
        noise: Option<crate::galosh::NoiseModel>,
    ) {
        let (left, top, width, height) = window;
        let kernel = settling(gpu);
        let params = SettleParams {
            width: width as u32,
            height: height as u32,
            left: left as u32,
            top: top as u32,
            region_width: self.width as u32,
            region_height: self.height as u32,
            alpha: noise.map_or(0.0, |model| model.alpha),
            sigma_sq: noise.map_or(0.0, |model| model.sigma_sq),
        };
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("pixel shift settle params"),
            contents: bytemuck::bytes_of(&params),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        recording.holding(&self.rgb);
        recording.holding(&self.disagreement);
        let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pixel shift settle"),
            layout: &kernel.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.rgb.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.disagreement.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: rgb.as_entire_binding() },
            ],
        });
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&kernel.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((width as u32).div_ceil(8), (height as u32).div_ceil(8), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::Merged;

    const W: usize = 24;
    const H: usize = 16;

    /// Distinct per site and per channel, so a shift off by one lands on a different value.
    fn scene(r: i64, c: i64, channel: usize) -> f32 {
        0.1 + (r * 97 + c * 13 + channel as i64 * 5) as f32 / 8192.0
    }

    /// A burst of `scene`, frame by frame, as the sensor would have read it.
    fn burst(gpu: &'static crate::gpu::Gpu, cfa: &crate::cfa::Cfa, frame_scene: impl Fn(usize, i64, i64, usize) -> f32) -> Merged {
        let merged = Merged::over(gpu, W, H);
        for (frame, (dy, dx)) in super::SHIFTS.into_iter().enumerate() {
            // Frame s's photosite q saw the scene at q + shift.
            let mosaic: Vec<f32> = (0..H)
                .flat_map(|r| {
                    let frame_scene = &frame_scene;
                    (0..W).map(move |c| {
                        let colour = usize::from(cfa.colour_at(r, c));
                        frame_scene(frame, r as i64 + i64::from(dy), c as i64 + i64::from(dx), colour)
                    })
                })
                .collect();
            let uploaded = crate::condition::Mosaic::upload(gpu, &mosaic, W, H);
            merged.scatter(gpu, &uploaded, cfa, frame).expect("a Bayer frame scatters");
        }
        merged
    }

    fn floats(gpu: &'static crate::gpu::Gpu, buffer: &crate::gpu::Buffer, count: usize) -> Vec<f32> {
        let bytes = (count * 4) as u64;
        let mut recording = gpu.record();
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("pixel shift readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(buffer, 0, &readback, 0, bytes);
        recording.submit();
        pollster::block_on(crate::gpu::read_back(gpu, &readback, |mapped| {
            bytemuck::cast_slice::<u8, f32>(mapped).to_vec()
        }))
        .expect("the plane reads back")
    }

    /// Four frames of one still scene, each read a photosite along, merge back to the scene in every
    /// channel - no interpolation, so exactly - and their greens agree everywhere.
    #[test]
    fn a_still_burst_reconstructs_every_channel_and_agrees() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        let merged = burst(gpu, &cfa, |_, r, c, channel| scene(r, c, channel));
        let rgb = floats(gpu, &merged.rgb, W * H * 3);
        let disagreement = floats(gpu, &merged.disagreement, W * H);
        // The edge rows and columns take a photosite a period away, which is not the scene there.
        for r in 1..H - 1 {
            for c in 1..W - 1 {
                for channel in 0..3 {
                    let want = scene(r as i64, c as i64, channel);
                    let at = rgb[(r * W + c) * 3 + channel];
                    assert!((at - want).abs() < 1e-6, "site {r},{c} channel {channel} is {at} against {want}");
                }
                let off = disagreement[r * W + c];
                assert!(off.abs() < 1e-6, "site {r},{c}'s greens disagree by {off} over a still scene");
            }
        }
    }

    /// A patch that moved between frames takes the reference's own demosaic there, and the still
    /// rest of the picture keeps the merge.
    #[test]
    fn where_the_scene_moved_the_reference_stands_in() {
        let Some(gpu) = crate::gpu::device() else { return };
        let cfa = crate::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap();
        // Bright in the last two frames only, over a patch in the middle.
        let moving = |r: i64, c: i64| (6..10).contains(&r) && (10..14).contains(&c);
        let merged = burst(gpu, &cfa, |frame, r, c, channel| match frame >= 2 && moving(r, c) {
            true => 0.9,
            false => scene(r, c, channel),
        });
        // What the reference's demosaic says, as a plane of its own for the settle to fall back to.
        let reference = vec![-1.0f32; W * H * 3];
        let rcd = gpu.own_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("reference plane"),
            contents: bytemuck::cast_slice(&reference),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        });
        let mut recording = gpu.record();
        merged.settle(gpu, &mut recording, &rcd, (0, 0, W, H), None);
        recording.submit();
        let settled = floats(gpu, &rcd, W * H * 3);
        let green = |r: usize, c: usize| settled[(r * W + c) * 3 + 1];
        assert_eq!(green(8, 12), -1.0, "the moved patch kept the merge");
        // Clear of the patch and of the edge rows, whose photosites wrap a period round.
        let still = green(12, 4);
        assert!((still - scene(12, 4, 1)).abs() < 1e-6, "a still site far from it fell back: {still}");
    }
}
