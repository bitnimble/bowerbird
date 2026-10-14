//! A PQ picture's light under one gain, on the device (`slang/pq_rescale.slang`).

use crate::gpu::Gpu;
use crate::light::Gain;

const SAMPLES_PER_WORD: usize = 2;
const LANES: u32 = 64;
const MOST_GROUPS: u32 = 65535;

fn kernel(gpu: &'static Gpu) -> &'static crate::hdr_fit::Kernel {
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "rescale_pq",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/pq_rescale.wgsl")),
            &[(0, crate::hdr_fit::WRITE), (1, crate::hdr_fit::UNIFORM)],
            &[],
        )
    })
}

/// `samples`, sixteen-bit full-range PQ codes, as the light they code times `gain`.
pub async fn rescaled(gpu: &'static Gpu, samples: &[u16], gain: Gain) -> Option<Vec<u16>> {
    let mut packed = samples.to_vec();
    packed.resize(
        samples.len().div_ceil(SAMPLES_PER_WORD) * SAMPLES_PER_WORD,
        0,
    );
    let words = (packed.len() / SAMPLES_PER_WORD) as u32;
    let groups = words.div_ceil(LANES).max(1);
    let across = groups.min(MOST_GROUPS);
    let down = groups.div_ceil(across);

    let mut recording = gpu.record();
    let codes = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pq rescale codes"),
        contents: bytemuck::cast_slice(&packed),
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
    });
    let params: Vec<u8> = [words, across * LANES, (gain.raw() as f32).to_bits(), 0]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
    let params = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("pq rescale params"),
        contents: &params,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bytes = u64::from(words) * 4;
    let read = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("pq rescale read"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let built = kernel(gpu);
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("pq rescale"),
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
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&built.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(across, down, 1);
    }
    recording
        .encoder()
        .copy_buffer_to_buffer(&codes, 0, &read, 0, bytes);
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
    use crate::light::{DisplayNits, Gain, Light};

    /// Each code moves to the one `tone::pq` gives its light under the gain, odd lengths included.
    #[test]
    fn a_rescaled_code_is_its_light_times_the_gain() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered.");
            return;
        };
        let samples: Vec<u16> = (0..1001).map(|at| (at * 65) as u16).collect();
        let gain = 100.0 / 203.0;
        let got = pollster::block_on(super::rescaled(gpu, &samples, Gain::of_ratio(gain)))
            .expect("the readback mapped");
        assert_eq!(got.len(), samples.len());
        for (&code, &moved) in samples.iter().zip(&got) {
            let nits =
                crate::tone::pq_inv::<DisplayNits>(Light::exactly(f64::from(code) / 65535.0)).raw();
            let want = crate::tone::pq(Light::<DisplayNits>::exactly(nits * gain)).raw() * 65535.0;
            assert!(
                (f64::from(moved) - want).abs() <= 2.0,
                "code {code} moved to {moved}, wanted {want:.1}"
            );
        }
    }
}
