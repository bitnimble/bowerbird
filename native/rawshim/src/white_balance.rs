//! The illuminant a photograph was balanced for, and the vocabulary the reader edits it in.
//!
//! **The arithmetic is the shader's, both ways round.** A temperature and a tint into a matrix
//! happens on every tick and in every rendition; the camera's multipliers into a temperature and
//! a tint happens once, at the decode. Both walk the same 31 isotherms, so both are
//! `white_balance.slang` and what is here is the dispatch that asks for the second one - a second
//! copy of that table is the divergence DESIGN 21.1 is about, and it would be invisible, since two
//! Robertson searches disagreeing by a few Kelvin renders as a picture rather than as an error.
//!
//! **Camera Raw's numbers, not a scale of our own.** `crs:Temperature` and `crs:Tint` are what
//! a Lightroom sidecar carries and what `EditDocSchema` stores, so a photograph imported from
//! one has to mean here what it meant there. That is why this is Adobe's method - the DNG
//! SDK's `dng_temperature`, which is Robertson's isotherm search over the Planckian locus -
//! rather than one of the closed-form CCT approximations, which agree with it near daylight
//! and drift by hundreds of Kelvin at the ends of the slider.

/// The illuminant, as the reader's two sliders.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsShot {
    /// Correlated colour temperature in Kelvin. Higher is a *bluer* illuminant, which renders
    /// as a warmer picture - the processor divides more blue out of the scene.
    pub temperature: f64,
    /// Distance off the Planckian locus, positive towards magenta, on Adobe's scale.
    pub tint: f64,
}

/// The illuminant the camera balanced for, from what the decoder read out of the file.
///
/// None where the file recorded no usable multipliers, where the camera matrix will not invert,
/// or where what they resolve to is not a chromaticity at all - in which case there is no
/// baseline and the sliders stay closed.
///
/// A device that declines the readback answers None as well, and it is *not* the same answer: the
/// file has an illuminant and this run failed to read it, and what the caller stores is kept for
/// the life of the photograph. It says so on the way out rather than passing for a lens cap.
pub async fn as_shot(
    gpu: &'static crate::gpu::Gpu,
    cam_mul: &[f32; 4],
    cam_xyz: &[[f32; 3]; 4],
) -> Option<AsShot> {
    let mut words = [0f32; 16];
    words[..4].copy_from_slice(cam_mul);
    for (row, values) in cam_xyz.iter().enumerate() {
        words[4 + row * 3..7 + row * 3].copy_from_slice(values);
    }

    // **One answer a file, kept.** This is a pure function of the sixteen numbers below, and it is
    // asked once at open and again on every region decode the loupe pans through - where it would
    // otherwise be the only thing in that path that waits on the device to map a buffer. One
    // entry is the whole hit rate: a loupe reads tiles of one photograph.
    if let Ok(last) = LAST.lock() {
        if let Some((asked, answer)) = last.as_ref() {
            if asked == &words {
                return *answer;
            }
        }
    }

    let solver = device(gpu);
    let mut recording = gpu.record();
    let asked = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("as shot"),
        contents: &words.iter().flat_map(|word| word.to_le_bytes()).collect::<Vec<u8>>(),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let solved = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("as shot"),
        size: SOLVED * 4,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = recording.buffer(&wgpu::BufferDescriptor {
        label: Some("as shot"),
        size: SOLVED * 4,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("as shot"),
        layout: &solver.layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 14, resource: solved.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 18, resource: asked.as_entire_binding() },
        ],
    });
    {
        let mut pass = recording.encoder().begin_compute_pass(&Default::default());
        pass.set_pipeline(&solver.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    recording.encoder().copy_buffer_to_buffer(&solved, 0, &readback, 0, SOLVED * 4);
    recording.submit();

    let read = crate::gpu::read_back(gpu, &readback, |mapped| {
        let word = |at: usize| {
            f32::from_le_bytes([mapped[at], mapped[at + 1], mapped[at + 2], mapped[at + 3]])
        };
        [word(0), word(4), word(8)]
    })
    .await;
    let Some(read) = read else {
        // Not kept: a device that declined once may answer the next ask, and the alternative is
        // one transient failure costing the photograph its baseline for as long as the process
        // lives.
        eprintln!("rawshim: the illuminant was not read back, so this photograph keeps none");
        return None;
    };
    let answer = match read[2] > 0.0 {
        true => Some(AsShot { temperature: f64::from(read[0]), tint: f64::from(read[1]) }),
        false => None,
    };
    if let Ok(mut last) = LAST.lock() {
        *last = Some((words, answer));
    }
    answer
}

/// The last illuminant solved, against the numbers that asked for it.
static LAST: std::sync::Mutex<Option<([f32; 16], Option<AsShot>)>> = std::sync::Mutex::new(None);

/// The temperature, the tint, and whether the file had an illuminant at all.
const SOLVED: u64 = 3;

struct Solver {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::ComputePipeline,
}

/// Infallible, as `condition::device` is: this kernel asks for nothing beyond two storage
/// buffers, and a shader that would not build is a panic through `on_uncaptured_error`.
fn device(gpu: &'static crate::gpu::Gpu) -> &'static Solver {
    static BUILT: std::sync::OnceLock<Solver> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let device = gpu.describing();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("as shot"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!(concat!(env!("OUT_DIR"), "/wgsl/white_balance.wgsl")).into(),
            ),
        });
        let storage = |binding: u32, read_only: bool| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("as shot"),
            entries: &[storage(14, false), storage(18, true)],
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("as shot"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("as shot"),
                bind_group_layouts: &[Some(&layout)],
                immediate_size: 0,
            })),
            module: &module,
            entry_point: Some("as_shot"),
            compilation_options: Default::default(),
            cache: None,
        });
        Solver { layout, pipeline }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chromaticity through the whole path, as the camera that reports XYZ outright would have
    /// recorded it: the multipliers that neutralise the illuminant, and the identity for a matrix.
    fn illuminant(gpu: &'static crate::gpu::Gpu, x: f64, y: f64) -> AsShot {
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]];
        let xyz = [x / y, 1.0, (1.0 - x - y) / y];
        let mul = [(1.0 / xyz[0]) as f32, (1.0 / xyz[1]) as f32, (1.0 / xyz[2]) as f32, 0.0];
        pollster::block_on(as_shot(gpu, &mul, &identity)).expect("an invertible matrix")
    }

    /// The two illuminants everyone knows the answer for.
    ///
    /// This is the transcription check. The table is 124 numbers copied out of a C file, and a
    /// digit wrong in the middle of it would move one stretch of the slider and nothing else -
    /// which is exactly the kind of thing that reaches a photograph rather than a test. D65 and
    /// D50 sit at opposite ends of the range a photographer actually uses, and both are off the
    /// locus by a known amount, so they check the tint arm too.
    #[test]
    fn the_standard_illuminants_land_where_they_are_named() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so the locus was not read. Nothing else checks \
                 that a named illuminant lands on the Kelvin it is named for.",
            );
            return;
        };
        let d65 = illuminant(gpu, 0.3127, 0.3290);
        assert!(
            (d65.temperature - 6500.0).abs() < 100.0,
            "D65 came out at {:.0}K, tint {:.0}",
            d65.temperature,
            d65.tint,
        );
        // D65 is a daylight illuminant rather than a black body, so it sits a little off the
        // locus. Adobe reads it at about +10; what matters is the sign and the scale.
        assert!(d65.tint.abs() < 25.0, "D65's tint came out at {:.0}", d65.tint);

        let d50 = illuminant(gpu, 0.34567, 0.35850);
        assert!(
            (d50.temperature - 5000.0).abs() < 100.0,
            "D50 came out at {:.0}K, tint {:.0}",
            d50.temperature,
            d50.tint,
        );
        assert!(d50.tint.abs() < 25.0, "D50's tint came out at {:.0}", d50.tint);
    }

    /// Warmer light reads as a lower number, which is the direction the whole slider hangs on.
    #[test]
    fn a_warmer_illuminant_reads_as_fewer_kelvin() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no adapter answered, so the slider's direction was not checked.");
            return;
        };
        // Tungsten, roughly, against overcast daylight.
        let tungsten = illuminant(gpu, 0.4476, 0.4074);
        let overcast = illuminant(gpu, 0.2848, 0.2932);
        assert!(
            tungsten.temperature < 3500.0 && overcast.temperature > 8000.0,
            "tungsten {:.0}K, overcast {:.0}K",
            tungsten.temperature,
            overcast.temperature,
        );
    }

    /// A camera whose matrix is the identity is reporting XYZ, so its multipliers are the
    /// illuminant outright and the answer is checkable by hand.
    #[test]
    fn the_camera_neutral_becomes_the_illuminant_that_produced_it() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so a camera's multipliers were not solved into \
                 the illuminant that produced them.",
            );
            return;
        };
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]];
        // D65 as XYZ at Y=1, then the multipliers that would neutralise it.
        let (x, y) = (0.3127, 0.3290);
        let xyz = [x / y, 1.0, (1.0 - x - y) / y];
        let mul = [(1.0 / xyz[0]) as f32, 1.0, (1.0 / xyz[2]) as f32, 0.0];
        let found =
            pollster::block_on(as_shot(gpu, &mul, &identity)).expect("an invertible matrix");
        assert!(
            (found.temperature - 6500.0).abs() < 100.0,
            "came out at {:.0}K",
            found.temperature,
        );
    }

    /// A file with nothing usable in it declines rather than inventing a baseline.
    #[test]
    fn a_file_with_no_multipliers_has_no_illuminant() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!(
                "SKIPPED: no adapter answered, so a file with no illuminant was not refused.",
            );
            return;
        };
        let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 0.0]];
        assert!(pollster::block_on(as_shot(gpu, &[0.0, 1.0, 1.0, 0.0], &identity)).is_none());
        assert!(pollster::block_on(as_shot(gpu, &[2.0, 1.0, 1.5, 0.0], &[[0.0; 3]; 4])).is_none());
    }

    /// The three cone matrices against what they are supposed to be.
    ///
    /// **They are literals, and a literal is a copy of something.** `XYZ_TO_CONE` is Bradford,
    /// which the test states; `R2020_TO_CONE` is Bradford times the Rec.2020 primaries, and those
    /// primaries live at `hdr_fit::REC2020_TO_XYZ` and are pinned by `the_primaries_match_the_host`
    /// separately - so without this the primaries could move on the host, that test would fail
    /// loudly, and this one would go on quietly using the old ones. `CONE_TO_R2020` is written out
    /// as an inverse and nothing else checks that it inverts anything.
    ///
    /// A digit wrong anywhere here bends every white balance by a little, in every photograph, and
    /// nothing else in the suite would report it: the illuminant tests above all run through
    /// `XYZ_TO_CONE` alone.
    #[test]
    fn the_cone_matrices_are_what_they_are_derived_from() {
        // Bradford's sharpened cone response, as published; the shader's own `XYZ_TO_CONE`.
        const BRADFORD: [[f64; 3]; 3] = [
            [0.8951, 0.2664, -0.1614],
            [-0.7502, 1.7135, 0.0367],
            [0.0389, -0.0685, 1.0296],
        ];
        let worst = |a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]| {
            (0..9).map(|i| (a[i / 3][i % 3] - b[i / 3][i % 3]).abs()).fold(0.0f64, f64::max)
        };

        let xyz_to_cone = crate::hdr_fit::in_the_shader("XYZ_TO_CONE");
        assert!(
            worst(&xyz_to_cone, &BRADFORD) < 5e-7,
            "XYZ_TO_CONE is not Bradford: {xyz_to_cone:?}",
        );

        let want = crate::hdr_fit::multiply(&BRADFORD, &crate::hdr_fit::REC2020_TO_XYZ);
        let found = crate::hdr_fit::in_the_shader("R2020_TO_CONE");
        // The literals are rounded to six places, so they cannot agree closer than half of one -
        // and they do agree to about 3.5e-7, so anything looser than this would pass a matrix
        // with a digit wrong in its last place.
        assert!(
            worst(&found, &want) < 1e-6,
            "R2020_TO_CONE is {:.6} out of step with Bradford times the Rec.2020 primaries. It \
             should read:\n{}",
            worst(&found, &want),
            (0..3)
                .map(|row| format!(
                    "    {},",
                    (0..3).map(|col| format!("{:>10.6}", want[row][col])).collect::<Vec<_>>().join(", ")
                ))
                .collect::<Vec<_>>()
                .join("\n"),
        );

        let back = crate::hdr_fit::in_the_shader("CONE_TO_R2020");
        let identity = crate::hdr_fit::multiply(&back, &found);
        let want_identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        // The shader's own comment budgets a millionth for the round trip; hold it to that.
        assert!(
            worst(&identity, &want_identity) < 2e-6,
            "CONE_TO_R2020 does not invert R2020_TO_CONE: {identity:?}",
        );
    }
}
