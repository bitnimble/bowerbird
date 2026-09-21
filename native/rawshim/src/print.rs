use crate::light::{Gain, Illuminance, Light};
use crate::px::{Extent, Millimetre, PrintUnit, Share, Span};

pub(crate) const ALBEDO_VIEWS: u32 = 128;
pub(crate) const ALBEDO_ROUGHNESSES: u32 = 64;
pub(crate) const ALBEDO_BYTES: u64 = (ALBEDO_VIEWS as u64 + 1) * ALBEDO_ROUGHNESSES as u64 * 4;

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    Gloss,
    Satin,
    Matte,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presentation {
    Scene,
    Surface,
}

#[derive(Clone, Copy, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub paper: Paper,
    pub presentation: Presentation,
    pub yaw_degrees: f64,
    pub pitch_degrees: f64,
    pub key_lux: Light<Illuminance>,
    pub light_azimuth_degrees: f64,
    pub light_elevation_degrees: f64,
    pub light_angular_degrees: f64,
    pub fill_lux: Light<Illuminance>,
    pub light_temperature_kelvin: f64,
    pub roughness: f64,
    pub white_reflectance: Gain,
    pub black_reflectance: Gain,
    pub refractive_index: f64,
    #[serde(deserialize_with = "print_lengths")]
    pub light_distance: Share,
    #[serde(deserialize_with = "millimetres")]
    pub paper_long_edge_mm: Extent<Millimetre>,
    pub surface_texture: f64,
}

impl Default for Scene {
    fn default() -> Self {
        Self {
            paper: Paper::Satin,
            presentation: Presentation::Scene,
            yaw_degrees: -12.0,
            pitch_degrees: 8.0,
            key_lux: Light::exactly(1000.0),
            light_azimuth_degrees: 0.0,
            light_elevation_degrees: 75.0,
            light_angular_degrees: 30.0,
            fill_lux: Light::exactly(500.0),
            light_temperature_kelvin: 6500.0,
            roughness: 0.28,
            white_reflectance: Gain::of_ratio(0.9),
            black_reflectance: Gain::of_ratio(0.008),
            refractive_index: 1.5,
            light_distance: Share::of(4, 1),
            paper_long_edge_mm: Extent::exactly(300.0),
            surface_texture: 0.5,
        }
    }
}

impl Scene {
    pub fn parse(json: &str) -> Result<Self, String> {
        let scene: Self = serde_json::from_str(json).map_err(|error| error.to_string())?;
        scene.validate()?;
        Ok(scene)
    }

    pub fn validate(&self) -> Result<(), String> {
        for (name, value, minimum, maximum) in [
            ("yawDegrees", self.yaw_degrees, -180.0, 180.0),
            ("pitchDegrees", self.pitch_degrees, -85.0, 85.0),
            ("keyLux", self.key_lux.raw(), 0.0, 10000.0),
            ("lightAzimuthDegrees", self.light_azimuth_degrees, -180.0, 180.0),
            ("lightElevationDegrees", self.light_elevation_degrees, -85.0, 85.0),
            ("lightAngularDegrees", self.light_angular_degrees, 1.0, 90.0),
            ("fillLux", self.fill_lux.raw(), 0.0, 10000.0),
            ("lightTemperatureKelvin", self.light_temperature_kelvin, 2000.0, 10000.0),
            ("roughness", self.roughness, 0.03, 1.0),
            ("whiteReflectance", self.white_reflectance.raw(), 0.5, 0.99),
            ("blackReflectance", self.black_reflectance.raw(), 0.001, 0.2),
            ("refractiveIndex", self.refractive_index, 1.0, 2.0),
            ("lightDistance", self.light_distance.raw(), 1.0, 20.0),
            ("paperLongEdgeMm", self.paper_long_edge_mm.raw(), 50.0, 1000.0),
            ("surfaceTexture", self.surface_texture, 0.0, 1.0),
        ] {
            if !value.is_finite() || !(minimum..=maximum).contains(&value) {
                return Err(format!("{name} must be between {minimum} and {maximum}"));
            }
        }
        Ok(())
    }

    pub(crate) fn light_parameters(&self) -> [f32; 4] {
        let (yaw_sin, yaw_cos) = self.yaw_degrees.to_radians().sin_cos();
        let (pitch_sin, pitch_cos) = self.pitch_degrees.to_radians().sin_cos();
        let (azimuth_sin, azimuth_cos) = self.light_azimuth_degrees.to_radians().sin_cos();
        let (elevation_sin, elevation_cos) = self.light_elevation_degrees.to_radians().sin_cos();
        let light = [azimuth_sin * elevation_cos, elevation_sin, azimuth_cos * elevation_cos];
        let normal = [yaw_sin, -pitch_sin * yaw_cos, pitch_cos * yaw_cos];
        let facing = if normal[2] < 0.0 { -1.0 } else { 1.0 };
        let tangent = if light[2].abs() < 0.99 { [-light[1], light[0], 0.0] }
            else { [light[2], 0.0, -light[0]] };
        let length = tangent.iter().map(|value| value * value).sum::<f64>().sqrt();
        let tangent = tangent.map(|value| value / length);
        let bitangent = [
            light[1] * tangent[2] - light[2] * tangent[1],
            light[2] * tangent[0] - light[0] * tangent[2],
            light[0] * tangent[1] - light[1] * tangent[0],
        ];
        let component = |axis: [f64; 3]| normal.into_iter().zip(axis).map(|(n, a)| n * a * facing).sum::<f64>() as f32;
        [(self.light_angular_degrees.to_radians() * 0.5).tan() as f32,
            component(tangent), component(bitangent), component(light)]
    }

    pub(crate) fn uniform(&self) -> Vec<u8> {
        let (yaw_sin, yaw_cos) = self.yaw_degrees.to_radians().sin_cos();
        let (pitch_sin, pitch_cos) = self.pitch_degrees.to_radians().sin_cos();
        let (azimuth_sin, azimuth_cos) = self.light_azimuth_degrees.to_radians().sin_cos();
        let (elevation_sin, elevation_cos) = self.light_elevation_degrees.to_radians().sin_cos();
        let distance = self.light_distance.across(Span::<PrintUnit>::exact(2));
        let half_width = Extent::<PrintUnit>::measured(distance.raw() * (self.light_angular_degrees.to_radians() * 0.5).tan());
        let half_paper = Extent::<Millimetre>::measured(self.paper_long_edge_mm.raw() * 0.5);
        [
            yaw_sin, yaw_cos, pitch_sin, pitch_cos,
            azimuth_sin * elevation_cos, elevation_sin, azimuth_cos * elevation_cos, 0.0,
            self.roughness, self.white_reflectance.raw(), self.black_reflectance.raw(),
            self.refractive_index,
            self.key_lux.raw(), self.light_temperature_kelvin, self.fill_lux.raw(),
            if matches!(self.presentation, Presentation::Surface) { 1.0 } else { 0.0 },
            distance.raw(), half_width.raw(), half_paper.raw(), self.surface_texture,
        ].into_iter().flat_map(|word| (word as f32).to_le_bytes()).collect()
    }
}

pub(crate) fn light_uniform(parameters: [f32; 4]) -> Vec<u8> {
    parameters.into_iter().flat_map(f32::to_le_bytes).collect()
}

fn print_lengths<'de, D: serde::Deserializer<'de>>(from: D) -> Result<Share, D::Error> {
    let value = <f64 as serde::Deserialize>::deserialize(from)?;
    Ok(Share::measured(value, 1.0))
}

fn millimetres<'de, D: serde::Deserializer<'de>>(from: D) -> Result<Extent<Millimetre>, D::Error> {
    <f64 as serde::Deserialize>::deserialize(from).map(Extent::measured)
}

#[cfg(test)]
mod geometry_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(scene: &Scene, entry: &str, probes: &[[f32; 8]]) -> Vec<[f32; 8]> {
        let gpu = crate::gpu::device().expect("print requires Vulkan");
        let device = gpu.describing();
        let mut recording = gpu.record();
        let albedo = gpu.print_albedo_table(scene.refractive_index as f32);
        recording.holding(&albedo);
        let calibration = gpu.print_light_calibration(scene.light_parameters());
        recording.holding(&calibration);
        let inputs = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print optical probes"),
            contents: &probes.iter().flatten().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>(),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
            label: Some("print optical scene"), contents: &scene.uniform(), usage: wgpu::BufferUsages::UNIFORM,
        });
        let bytes = probes.len() as u64 * 32;
        let output = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("print optical results"), size: bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false,
        });
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("print optical readback"), size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
        let binding = |index, ty| wgpu::BindGroupLayoutEntry {
            binding: index, visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None }, count: None,
        };
        let probes_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print probes"), entries: &[
                binding(0, wgpu::BufferBindingType::Storage { read_only: true }),
                binding(1, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let scene_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("print scene"), entries: &[
                binding(0, wgpu::BufferBindingType::Uniform),
                binding(1, wgpu::BufferBindingType::Storage { read_only: true }),
                binding(2, wgpu::BufferBindingType::Storage { read_only: true }),
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("print optical checks"),
            source: wgpu::ShaderSource::Wgsl(include_str!(concat!(env!("OUT_DIR"), "/wgsl/print_probe.wgsl")).into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("print optical checks"),
            layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("print optical checks"), bind_group_layouts: &[Some(&probes_layout), Some(&scene_layout)],
                ..Default::default()
            })),
            module: &module, entry_point: Some(entry), compilation_options: Default::default(), cache: None,
        });
        let group = |layout, first: &crate::gpu::Buffer, second: &crate::gpu::Buffer| device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print optical checks"), layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: first.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: second.as_entire_binding() },
            ],
        });
        let probes_group = group(&probes_layout, &inputs, &output);
        let scene_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("print optical scene"), layout: &scene_layout, entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: albedo.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: calibration.as_entire_binding() },
            ],
        });
        {
            let mut pass = recording.encoder().begin_compute_pass(&Default::default());
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &probes_group, &[]);
            pass.set_bind_group(1, &scene_group, &[]);
            pass.dispatch_workgroups(probes.len() as u32, 1, 1);
        }
        recording.encoder().copy_buffer_to_buffer(&output, 0, &readback, 0, bytes);
        recording.submit();
        pollster::block_on(crate::gpu::read_back(gpu, &readback, |bytes| {
            bytes.chunks_exact(32).map(|row| std::array::from_fn(|i| {
                f32::from_le_bytes(row[i * 4..i * 4 + 4].try_into().expect("float"))
            })).collect()
        })).expect("optical results")
    }

    fn calibrated(scene: &Scene) -> [f32; 2] {
        let gpu = crate::gpu::device().expect("print requires Vulkan");
        let calibration = gpu.print_light_calibration(scene.light_parameters());
        let mut recording = gpu.record();
        recording.holding(&calibration);
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("print meter readback"), size: 8,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
        recording.encoder().copy_buffer_to_buffer(&calibration, 0, &readback, 0, 8);
        recording.submit();
        pollster::block_on(crate::gpu::read_back(gpu, &readback, |bytes| {
            std::array::from_fn(|i| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().expect("float")))
        })).expect("print meter")
    }

    #[test]
    fn print_meter_matches_received_light_and_sees_the_visible_back() {
        let scene = Scene {
            yaw_degrees: 0.0, pitch_degrees: 0.0,
            light_azimuth_degrees: 0.0, light_elevation_degrees: 0.0,
            fill_lux: Light::ZERO, refractive_index: 1.0, ..Scene::default()
        };
        for angle in [1.0, 30.0, 90.0] {
            let meter = calibrated(&Scene { light_angular_degrees: angle, ..scene });
            assert!((meter[1] - 1.0).abs() < 1e-6, "aligned {angle}° emitter: {meter:?}");
        }
        let turned = calibrated(&Scene { yaw_degrees: 60.0, ..scene });
        assert!((turned[1] - 0.5).abs() < 1e-6, "oblique illumination: {turned:?}");
        let back = calibrated(&Scene { yaw_degrees: 180.0, ..scene });
        assert!((back[1] - 1.0).abs() < 1e-6, "visible back: {back:?}");
        let behind = calibrated(&Scene { light_azimuth_degrees: 180.0, ..scene });
        assert_eq!(behind[1], 0.0, "light behind paper: {behind:?}");
        for yaw in [0.0, 60.0, 85.0] {
            let scene = Scene { yaw_degrees: yaw, light_angular_degrees: 90.0, ..scene };
            let meter = calibrated(&scene);
            let reflected = probe(&scene, "lighting", &[[0.28, 0.0, 1.0, 32768.0, 0.0, 0.0, 0.0, 0.0]])[0];
            let luminance = reflected.into_iter().zip(crate::hdr_fit::LUMA)
                .map(|(value, weight)| f64::from(value) * weight).sum::<f64>();
            let received = (luminance * std::f64::consts::PI / scene.key_lux.raw()) as f32;
            assert!((received - meter[1]).abs() < 0.0005, "meter differs from rendered light at {yaw}°: {received} vs {meter:?}");
            if yaw == 85.0 {
                assert!(meter[1] > yaw.to_radians().cos() as f32 + 0.02, "finite light crossing horizon: {meter:?}");
            }
        }
    }

    #[test]
    fn print_material_is_reciprocal_and_conserves_white_furnace_energy() {
        let mut probes = Vec::new();
        for roughness in [0.03, 0.08, 0.28, 0.65, 1.0] {
            for cosine in [1.0, 0.5, 0.1, 0.01] {
                probes.push([roughness, cosine, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
            }
        }
        for eta in [1.0, 1.5, 2.0] {
            let scene = Scene { refractive_index: eta, ..Scene::default() };
            let results = probe(&scene, "material", &probes);
            for (input, result) in probes.iter().zip(results) {
                let [roughness, cosine, ..] = *input;
                let specular = if roughness < 0.2 || cosine < 0.1 { result[7] } else { result[0] };
                assert!((specular + result[1] - 1.0).abs() < 0.012,
                    "furnace eta={eta} roughness={roughness} cosine={cosine}: {result:?}");
                assert!(result[2] < 0.0001, "reciprocity: {input:?} {result:?}");
                assert!(result[3] >= 0.0, "negative BRDF: {result:?}");
                assert!((result[5] - result[7]).abs() < 0.012, "albedo table: {input:?} {result:?}");
            }
        }
        let scene = Scene { refractive_index: 1.5, ..Scene::default() };
        let results = probe(&scene, "material", &[
            [0.65, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [0.65, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            [1.0, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        ]);
        for (row, expected) in results.iter().zip([0.03121853129, 0.04947506178, 0.05846998640]) {
            assert!((row[0] - expected).abs() < 0.00003, "GGX reference: {row:?}");
            assert!(row[1].abs() < 1e-7, "black substrate only reflects its interface: {row:?}");
        }
        assert!((results[0][4] - 0.04).abs() < 1e-6);
        assert!((results[1][4] - 0.08918671).abs() < 1e-6);
        assert!((results[0][6] - 0.04488098).abs() < 0.0001);
    }

    #[test]
    fn print_softbox_obeys_solid_angle_falloff_and_sampling_converges() {
        let luminance = |sample: [f32; 8]| sample.into_iter().zip(crate::hdr_fit::LUMA)
            .map(|(value, weight)| f64::from(value) * weight).sum::<f64>();
        let scene = Scene {
            yaw_degrees: 0.0, pitch_degrees: 0.0, light_azimuth_degrees: 0.0,
            light_elevation_degrees: 0.0, light_distance: Share::of(1, 1),
            light_angular_degrees: 2.0 * 0.5_f64.atan().to_degrees(),
            refractive_index: 1.0, fill_lux: Light::ZERO, ..Scene::default()
        };
        let results = probe(&scene, "lighting", &[
            [0.28, 0.0, 1.0, 32768.0, 0.0, 0.0, 0.0, 0.0],
            [0.28, 0.0, 1.0, 32768.0, 1.0, 0.0, 0.0, 0.0],
            [0.28, 0.0, 1.0, 32768.0, 0.0, 0.0, -2.0, 0.0],
        ]);
        assert!((luminance(results[0]) - 1000.0 / std::f64::consts::PI).abs() < 0.05, "centre lux: {results:?}");
        assert!((luminance(results[1]) - 219.74997).abs() < 0.05, "off-axis flux: {results:?}");
        assert!((luminance(results[2]) - 85.36209).abs() < 0.05, "finite distance: {results:?}");
        assert!((results[0][3] - 1.5).abs() < 1e-5, "rectangle solid-angle PDF: {results:?}");
        for angular_degrees in [1.0, 25.0, 60.0, 90.0] {
            let scene = Scene { light_angular_degrees: angular_degrees, ..scene };
            let results = probe(&scene, "lighting", &[[0.28, 0.0, 1.0, 32768.0, 0.0, 0.0, 0.0, 0.0]]);
            assert!((luminance(results[0]) - 1000.0 / std::f64::consts::PI).abs() < 0.05,
                "calibrated {angular_degrees}° softbox: {results:?}");
        }
        for roughness in [0.08, 0.28, 0.65] {
            let scene = Scene { refractive_index: 1.5, ..scene };
            let results = probe(&scene, "lighting", &[
                [roughness, 0.2, 0.5, 128.0, 0.6, 0.2, 0.0, 0.0],
                [roughness, 0.2, 0.5, 32768.0, 0.6, 0.2, 0.0, 0.0],
            ]);
            assert!((results[0][0] / results[1][0] - 1.0).abs() < 0.025,
                "quadrature roughness={roughness}: {results:?}");
            assert!((results[0][5] - scene.roughness as f32).abs() < 1e-6, "unresolved texture must filter away");
        }
    }

    #[test]
    fn print_softbox_has_a_smooth_hdr_radiance_profile() {
        let scene = Scene {
            light_azimuth_degrees: 0.0, light_elevation_degrees: 0.0,
            ..Scene::default()
        };
        let inputs = [0.0, 0.5, 0.9, 1.0, 1.1].map(|x| [x, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        let results = probe(&scene, "emitter", &inputs);
        assert!(results[0][0] > 1000.0, "HDR emitter: {results:?}");
        for (result, expected) in results.iter().zip([1.0, 0.5625, 0.0361, 0.0, 0.0]) {
            assert!((result[0] / results[0][0] - expected).abs() < 1e-6, "radiance profile: {results:?}");
        }
        for result in &results[..3] {
            assert!((result[0] / results[0][0] - result[1]).abs() < 1e-6, "sample and ray-hit profiles: {results:?}");
            assert!(result[2] > 0.0, "emitter PDF: {results:?}");
        }
        assert_eq!(results[4][2], 0.0, "outside emitter PDF: {results:?}");
    }

    #[test]
    fn print_gloss_reflects_more_uniform_fill_at_grazing_angles() {
        let scene = Scene {
            yaw_degrees: 0.0, pitch_degrees: 0.0,
            key_lux: Light::ZERO, fill_lux: Light::exactly(1000.0),
            ..Scene::default()
        };
        let probes = [0.0_f32, 60.0, 85.0].map(|angle|
            [0.08, angle.to_radians().tan(), 0.0, 128.0, 0.0, 0.0, 0.0, 0.0]);
        let reflected = probe(&scene, "lighting", &probes);
        assert!(reflected[1][0] > reflected[0][0] * 2.0, "60° reflection: {reflected:?}");
        assert!(reflected[2][0] > reflected[1][0] * 5.0, "85° reflection: {reflected:?}");
        let matched = Scene { refractive_index: 1.0, ..scene };
        for reflected in probe(&matched, "lighting", &probes) {
            assert_eq!(&reflected[..3], &[0.0, 0.0, 0.0]);
        }
    }

    #[test]
    fn print_settings_reject_nonfinite_and_out_of_range_values() {
        let shader = include_str!("../../../slang/print_material.slang");
        assert!(shader.contains(&format!("ALBEDO_VIEWS = {ALBEDO_VIEWS};")));
        assert!(shader.contains(&format!("ALBEDO_ROUGHNESSES = {ALBEDO_ROUGHNESSES};")));
        assert!(shader.contains("ALBEDO_STRIDE = ALBEDO_VIEWS + 1;"));
        let mut scene = Scene::default();
        assert!(scene.validate().is_ok());
        scene.key_lux = Light::measured(f64::INFINITY);
        assert!(scene.validate().is_err());
        scene = Scene::default();
        scene.roughness = 0.0;
        assert!(scene.validate().is_err());
        scene = Scene::default();
        scene.white_reflectance = Gain::of_ratio(1.5);
        assert!(scene.validate().is_err());
        for scene in [
            Scene { refractive_index: f64::NAN, ..Scene::default() },
            Scene { light_distance: Share::of(21, 1), ..Scene::default() },
            Scene { paper_long_edge_mm: Extent::exactly(0.0), ..Scene::default() },
            Scene { surface_texture: 1.01, ..Scene::default() },
        ] {
            assert!(scene.validate().is_err());
        }
    }

    #[test]
    fn print_stock_thickness_and_grain_have_physical_dimensions() {
        let scene = Scene {
            yaw_degrees: 0.0, pitch_degrees: 0.0,
            key_lux: Light::ZERO, fill_lux: Light::ZERO, ..Scene::default()
        };
        let first = probe(&scene, "lighting", &[[0.28, 0.0, 0.0, 1.0, 0.017, 0.039, 0.0, 0.0]]);
        let scene = Scene { paper_long_edge_mm: Extent::exactly(600.0), ..scene };
        let second = probe(&scene, "lighting", &[[0.28, 0.0, 0.0, 1.0, 0.0085, 0.0195, 0.0, 0.0]]);
        assert!((first[0][4] - second[0][4]).abs() < 1e-6, "grain must remain at the same millimetres");
        assert!((first[0][6] - 0.15).abs() < 0.0001);
        assert!((second[0][6] - 0.15).abs() < 0.0001);
    }

    #[test]
    fn print_is_reflected_hdr_light_with_an_unprinted_back() {
        use crate::gpu::{Adjust, Canvas, Grade, Output};
        use crate::light::Stops;
        use crate::px::{Size, Span};

        let gpu = crate::gpu::device().expect("print requires Vulkan");
        let base = crate::base::device(gpu).expect("the source pyramid");
        let (width, height) = (96, 64);
        let code = (crate::tone::pq(Light::<crate::light::SceneNits>::exactly(80.0)).raw()
            * 65535.0).round() as u16;
        let frame = vec![code; width * height * 3];
        let grade = Grade {
            width,
            height,
            photograph_long: Span::measured(width),
            colour: None,
            white: Light::measured(10000.0),
            source_level: Light::measured(60000.0),
            floor: None,
            reference_nits: Light::exactly(203.0),
            peak_nits: Light::exactly(203.0),
            exposure: Stops::ZERO,
            adjust: Adjust::none(),
            as_shot: None,
            output: Output::Pq,
            geometry: crate::image::Geometry::none(),
            window: None,
            surround_window: None,
            canvas: Some(Canvas {
                region: (0.0, 0.0, width as f64, height as f64),
                size: Size::measured(128, 96),
                max_lod: 6,
            }),
        };
        let peak = gpu.scene_peak();
        let uploaded = gpu.upload(&frame, &grade, &peak);
        let pyramid = crate::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");
        let center = (48 * 128 + 64) * 4;
        let mut scene = Scene {
            yaw_degrees: 0.0,
            pitch_degrees: 0.0,
            light_azimuth_degrees: 0.0,
            light_elevation_degrees: 0.0,
            fill_lux: Light::ZERO,
            roughness: 0.08,
            ..Scene::default()
        };
        let first = uploaded.draw_print(&grade, &pyramid, &scene);
        assert!(first[center] > 1.0, "specular reflection must reach HDR");
        let hdr_grade = Grade { peak_nits: Light::exactly(1000.0), ..grade };
        assert_eq!(first, uploaded.draw_print(&hdr_grade, &pyramid, &scene));
        scene.key_lux = Light::exactly(2000.0);
        let twice = uploaded.draw_print(&grade, &pyramid, &scene);
        let linear = |value: f32| {
            if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
        };
        assert!((linear(twice[center]) / linear(first[center]) - 1.0).abs() < 0.015);
        let mut metered = Scene {
            light_elevation_degrees: 75.0, refractive_index: 1.0,
            key_lux: Light::exactly(1000.0), ..scene
        };
        let facing = uploaded.draw_print(&grade, &pyramid, &metered);
        for pitch in [-37.5, -75.0, 0.0] {
            metered.pitch_degrees = pitch;
            let rotated = uploaded.draw_print(&grade, &pyramid, &metered);
            assert!((linear(rotated[center]) / linear(facing[center]) - 1.0).abs() < 0.015,
                "cached light meter did not follow paper rotation to {pitch}°");
        }
        scene.key_lux = Light::ZERO;
        let dark = uploaded.draw_print(&grade, &pyramid, &scene);
        assert_eq!(&dark[center..center + 3], &[0.0, 0.0, 0.0]);
        scene.key_lux = Light::exactly(1000.0);
        scene.yaw_degrees = 180.0;
        scene.light_azimuth_degrees = 0.0;
        let back = uploaded.draw_print(&grade, &pyramid, &scene);
        let black_frame = vec![0; width * height * 3];
        let black = gpu.upload(&black_frame, &grade, &peak);
        let black_pyramid = crate::base::pyramid(gpu, base, &black_frame, (width, height)).expect("a pyramid");
        assert_eq!(back, black.draw_print(&grade, &black_pyramid, &scene));
        scene.yaw_degrees = 90.0;
        scene.pitch_degrees = 85.0;
        assert!(uploaded.draw_print(&grade, &pyramid, &scene).iter().all(|value| value.is_finite()));
        scene.yaw_degrees = 0.0;
        scene.pitch_degrees = 0.0;
        scene.light_angular_degrees = 1.0;
        scene.roughness = 0.28;
        let satin = black.draw_print(&grade, &black_pyramid, &scene);
        let satin_nits = linear(satin[center]) * scene.key_lux.raw() as f32 / std::f32::consts::PI;
        assert!((450.0..600.0).contains(&satin_nits), "small-light satin: {satin_nits} nits");
        scene.roughness = 0.65;
        let matte = black.draw_print(&grade, &black_pyramid, &scene);
        let matte_nits = linear(matte[center]) * scene.key_lux.raw() as f32 / std::f32::consts::PI;
        assert!((15.0..30.0).contains(&matte_nits), "small-light matte: {matte_nits} nits");

        let size = 512;
        let white = (crate::tone::pq(Light::<crate::light::SceneNits>::exactly(203.0)).raw()
            * 65535.0).round() as u16;
        let middle = (crate::tone::pq(Light::<crate::light::SceneNits>::exactly(101.5)).raw()
            * 65535.0).round() as u16;
        let checker: Vec<u16> = (0..size * size).flat_map(|pixel| {
            [if (pixel / size + pixel % size) % 2 == 0 { 0 } else { white }; 3]
        }).collect();
        let grey = vec![middle; size * size * 3];
        let reduced = Grade { width: size, height: size, photograph_long: Span::measured(size), ..grade };
        scene.key_lux = Light::ZERO;
        scene.fill_lux = Light::exactly(1000.0);
        scene.yaw_degrees = 70.0;
        let pattern = gpu.upload(&checker, &reduced, &peak);
        let pattern_pyramid = crate::base::pyramid(gpu, base, &checker, (size, size)).expect("a pyramid");
        let plain = gpu.upload(&grey, &reduced, &peak);
        let plain_pyramid = crate::base::pyramid(gpu, base, &grey, (size, size)).expect("a pyramid");
        let pattern_drawn = pattern.draw_print(&reduced, &pattern_pyramid, &scene);
        let plain_drawn = plain.draw_print(&reduced, &plain_pyramid, &scene);
        let (at, difference) = pattern_drawn.iter().zip(plain_drawn.iter()).enumerate()
            .map(|(at, (pattern, plain))| (at, (pattern - plain).abs()))
            .max_by(|left, right| left.1.total_cmp(&right.1)).expect("pixels");
        assert!(difference < 0.005, "foreshortened checkerboard aliases by {difference} at {},{}: {} vs {}, center {} vs {}",
            at / 4 % 128, at / 4 / 128, pattern_drawn[at], plain_drawn[at], pattern_drawn[center], plain_drawn[center]);
    }
}
