//! A PQ still's light as a platform shows a PQ video's, on the device (`slang/pq_rematch.slang`).

use crate::gpu::Gpu;
use crate::gpu::dispatch::Whole;
use crate::sdr_match::SdrMatch;

const SAMPLES_PER_WORD: usize = 2;

fn kernel(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "rematch_pq",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/pq_rematch.wgsl")),
            &[(0, crate::hdr_fit::WRITE), (1, crate::hdr_fit::UNIFORM)],
            &[],
        )
    })
}

/// `samples`, sixteen-bit full-range PQ codes of a still, as the codes `matching` shows it at.
pub async fn rematched(gpu: &'static Gpu, samples: &[u16], matching: SdrMatch) -> Option<Vec<u16>> {
    let words = samples.len().div_ceil(SAMPLES_PER_WORD) as u32;
    let (across, down) = crate::base::groups(words as usize);

    let mut recording = gpu.record();
    let codes = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pq rematch codes"),
        contents: bytemuck::cast_slice(samples),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });
    let [white, reads_sdr_as_power] = matching.words();
    let params: Vec<u8> = [
        words,
        0,
        (crate::gpu::CANVAS_WHITE_NITS as f32).to_bits(),
        white,
        reads_sdr_as_power,
        0,
        0,
        0,
    ]
    .into_iter()
    .flat_map(u32::to_le_bytes)
    .collect();
    let params = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pq rematch params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bytes = u64::from(words) * 4;
    let read = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pq rematch read"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let built = kernel(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pq rematch"),
        layout: &built.layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: codes.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: params.as_entire_binding(),
            },
        ],
    });
    recording.dispatch([across, down, 1], Whole::Measured, |pass| {
        pass.set_pipeline(&built.pipeline);
        pass.set_bind_group(0, &group, &[]);
    });
    recording.copy_buffer_to_buffer(&codes, 0, &read, 0, bytes);
    recording.submit();
    let mut out = crate::gpu::read_back(gpu, &read, |mapped| {
        bytemuck::pod_collect_to_vec::<u8, u16>(mapped)
    })
    .await?;
    out.truncate(samples.len());
    Some(out)
}

#[cfg(test)]
mod tests {
    use crate::sdr_match::SdrMatch;
    use units::light::{DisplayNits, Light};

    /// Each code moves to the one `tone::pq` gives `SdrMatch::of_still` of its light, odd lengths
    /// included, through shadows the macOS match bends and highlights it only scales.
    #[test]
    fn a_rematched_code_is_its_light_as_the_platform_shows_it() {
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let samples: Vec<u16> = (0..1001).map(|at| (at * 65) as u16).collect();
        let matching = SdrMatch::MacVideo;
        let got = pollster::block_on(super::rematched(gpu, &samples, matching))
            .expect("the readback mapped");
        assert_eq!(got.len(), samples.len());
        for (&code, &moved) in samples.iter().zip(&got) {
            let still =
                crate::tone::pq_inv::<DisplayNits>(Light::exactly(f64::from(code) / 65535.0));
            let want = crate::tone::pq(matching.of_still(still)).raw() * 65535.0;
            assert!(
                (f64::from(moved) - want).abs() <= 2.0,
                "code {code} moved to {moved}, wanted {want:.1}"
            );
        }
    }
}
