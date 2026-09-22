use rawshim::gpu::{Adjust, Canvas, Grade, Output, Tonemap};
use rawshim::hdr_fit::HdrColour;
use rawshim::image::Geometry;
use rawshim::light::{DisplayNits, Gain, Light, SceneNits, Stops};
use rawshim::print::Scene;
use rawshim::px::{Size, Span};

#[test]
fn warm_highlight_detail_survives_diffuse_light_and_glare() {
    let diffuse = Scene {
        key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0),
        refractive_index: 1.0,
        ..Scene::default()
    };
    let glare = Scene {
        yaw_degrees: -15.0,
        pitch_degrees: -12.0,
        light_azimuth_degrees: -32.0,
        light_elevation_degrees: 25.0,
        key_lux: Light::exactly(5000.0),
        ..Scene::default()
    };
    let measured = [("diffuse", diffuse), ("glare", glare)].map(|(name, scene)| {
        let dimmer = luminance(draw([1.05, 0.75, 0.5], scene));
        let brighter = luminance(draw([1.10, 0.75, 0.5], scene));
        (name, dimmer.raw(), brighter.raw())
    });
    for (name, dimmer, brighter) in measured {
        assert!(brighter - dimmer > 0.5, "{name} erased warm highlight detail: {measured:?}");
    }
    assert!(measured[1].2 > 203.0, "the detail must survive HDR glare");
}

#[test]
fn camera_meters_diffuse_paper_without_spending_highlight_headroom() {
    let mut hue: Option<[f64; 2]> = None;
    for fill in [0.0, 500.0] {
        for pitch in [-37.5, 0.0, -75.0] {
            let scene = Scene {
                yaw_degrees: 0.0,
                pitch_degrees: pitch,
                light_azimuth_degrees: 0.0,
                light_elevation_degrees: 75.0,
                fill_lux: Light::exactly(fill),
                refractive_index: 1.0,
                surface_texture: 0.0,
                ..Scene::default()
            };
            let white = luminance(draw([1.0; 3], scene)).raw();
            assert!((white - 182.7).abs() < 5.0,
                "diffuse white overexposed at pitch {pitch}, fill {fill}: {white} nits");
            let dark = luminance(draw([0.4, 0.28, 0.14], scene)).raw();
            let bright = draw([0.8, 0.56, 0.28], scene);
            let bright_luma = luminance(bright).raw();
            assert!(bright_luma < white - 30.0 && bright_luma - dark > 40.0,
                "warm detail lost headroom or contrast: {dark}, {bright_luma}, white {white}");
            let black = draw([0.0; 3], scene);
            let color: [f64; 3] = std::array::from_fn(|channel| bright[channel].raw() - black[channel].raw());
            let ratios = [color[0] / color[1], color[2] / color[1]];
            if let Some(reference) = hue {
                assert!((ratios[0] - reference[0]).abs() < 0.01 && (ratios[1] - reference[1]).abs() < 0.01,
                    "paper rotation changed the photograph's hue: {reference:?} vs {ratios:?}");
            } else {
                hue = Some(ratios);
            }
        }
    }
}

#[test]
fn coating_reflections_keep_hdr_headroom_after_camera_adaptation() {
    for (name, roughness, size) in [("gloss", 0.08, 30.0), ("satin", 0.28, 10.0)] {
        let scene = Scene {
            yaw_degrees: 0.0,
            pitch_degrees: -37.5,
            light_azimuth_degrees: 0.0,
            light_elevation_degrees: 75.0,
            light_angular_degrees: size,
            fill_lux: Light::ZERO,
            roughness,
            surface_texture: 0.0,
            ..Scene::default()
        };
        let white = luminance(draw([1.0; 3], scene)).raw();
        assert!(white > 500.0, "{name} reflection lost HDR headroom: {white} nits");
    }
}

#[test]
fn paper_gamut_preserves_neutrals_and_bounds_reflectance() {
    let scene = Scene {
        key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0),
        refractive_index: 1.0,
        ..Scene::default()
    };
    for (input, expected) in [(0.0, 1.624), (0.18, 34.21768), (1.0, 182.7)] {
        let output = luminance(draw([input; 3], scene));
        assert!((output.raw() - expected).abs() < 0.5,
            "neutral {input} changed its reflected brightness: {} vs {expected} nits", output.raw());
    }
    for input in [[1.5, 0.02, 0.3], [0.0, 0.8, -0.05], [1.10, 0.75, 0.5]] {
        let output = draw(input, scene);
        let white = draw([1.0; 3], scene);
        let black = draw([0.0; 3], scene);
        for (channel, component) in output.into_iter().enumerate() {
            assert!(component.raw().is_finite() && component.raw() >= black[channel].raw() - 0.003
                && component.raw() <= white[channel].raw() + 0.003,
                "unbounded paper reflectance for {input:?}: {}", component.raw());
        }
    }
}

#[test]
fn ambient_light_sets_the_background_and_camera_adapts_to_bright_rooms() {
    let mut scene = Scene { key_lux: Light::ZERO, fill_lux: Light::ZERO, ..Scene::default() };
    assert_eq!(sample([0.5; 3], scene, [0, 0]).map(|light| light.raw()), [0.0; 3]);
    scene.key_lux = Light::exactly(1000.0);
    assert_eq!(sample([0.5; 3], scene, [0, 0]).map(|light| light.raw()), [0.0; 3]);
    scene.key_lux = Light::ZERO;
    scene.fill_lux = Light::exactly(500.0);
    let room = luminance(draw([0.5; 3], scene)).raw();
    let background = luminance(sample([0.5; 3], scene, [0, 0])).raw();
    scene.fill_lux = Light::exactly(5000.0);
    let bright = luminance(draw([0.5; 3], scene)).raw();
    assert!((0.95..1.15).contains(&(bright / room)), "exposure failed to adapt: {room} vs {bright}");
    assert!((luminance(sample([0.5; 3], scene, [0, 0])).raw() - background).abs() < 0.2);
    let dark_detail = luminance(draw([0.4; 3], scene)).raw();
    let light_detail = luminance(draw([0.6; 3], scene)).raw();
    assert!(light_detail - dark_detail > 20.0, "bright room lost photo contrast");
}

#[test]
fn light_temperature_changes_colour_without_changing_illuminance() {
    let mut scene = Scene { key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), ..Scene::default() };
    scene.light_temperature_kelvin = 2700.0;
    let warm = draw([0.5; 3], scene);
    scene.light_temperature_kelvin = 9000.0;
    let cool = draw([0.5; 3], scene);
    assert!(warm[0].raw() / warm[2].raw() > 2.0);
    assert!(cool[0].raw() / cool[2].raw() < 1.0);
    assert!((luminance(warm).raw() / luminance(cool).raw() - 1.0).abs() < 0.01);
}

/// A sheen is a reflection of the room, so it follows what the sheet is turned towards.
#[test]
fn ambient_only_gloss_mirrors_the_room_rather_than_washing_the_sheet() {
    let mut scene = Scene {
        yaw_degrees: 0.0, pitch_degrees: 0.0, key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0), roughness: 0.08, surface_texture: 0.0,
        ..Scene::default()
    };
    // Off the deepest black the paper has, where what is read is the reflection and not the pigment.
    let face = luminance(draw([0.0; 3], scene)).raw();
    scene.yaw_degrees = 85.0;
    let grazing = luminance(draw([0.0; 3], scene)).raw();
    assert!(grazing > face * 3.0, "the grazing wall went missing: {face} vs {grazing}");
    // Half the angle to the ceiling and half the angle to the floor: the same Fresnel either way,
    // so what is left between them is the room - halved again by the camera metering the room it
    // is shown, which is the same adaptation the key light is metered through.
    let ceiling = luminance(draw([0.0; 3], Scene { yaw_degrees: 0.0, pitch_degrees: -45.0, ..scene })).raw();
    let floor = luminance(draw([0.0; 3], Scene { yaw_degrees: 0.0, pitch_degrees: 45.0, ..scene })).raw();
    assert!(ceiling > floor * 2.0, "the sheen is a wash rather than a reflection: {floor} vs {ceiling}");
}

/// A print faced square on mirrors the reader, who is darker than the wall behind them.
#[test]
fn a_sheet_faced_square_on_reflects_the_reader_rather_than_the_room() {
    let scene = Scene {
        yaw_degrees: 0.0, pitch_degrees: 0.0, key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0), roughness: 0.08, surface_texture: 0.0,
        // Off the pigment, so what is read is the reflection alone.
        black_reflectance: Gain::of_ratio(0.001), ..Scene::default()
    };
    // Twice the yaw in the mirror, so twenty degrees turns the reflection forty off the reader and
    // leaves it on the same wall at the same elevation: what differs between the two is the body.
    let facing = luminance(draw([0.0; 3], scene)).raw();
    let past = luminance(draw([0.0; 3], Scene { yaw_degrees: 20.0, ..scene })).raw();
    assert!(past > facing * 1.3, "the reader casts no silhouette: {facing} facing, {past} past them");
}

/// The blacks a room leaves a print, which is what an ambient of uniform radiance takes away.
#[test]
fn a_lit_room_leaves_a_gloss_black_where_a_print_keeps_it() {
    let scene = Scene {
        yaw_degrees: 0.0, pitch_degrees: 0.0, key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0), roughness: 0.08, surface_texture: 0.0,
        ..Scene::default()
    };
    let black = luminance(draw([0.0; 3], scene)).raw();
    let white = luminance(draw([1.0; 3], scene)).raw();
    // Most of what is left is the paper's own black rather than the room's reflection, which is
    // the point: an ambient of uniform radiance leaves this at 24 to one.
    assert!(white / black > 55.0, "the room washed the print out: {black} against {white} nits");
}

#[test]
fn the_tone_operators_trade_saturation_for_highlight_detail() {
    let colour = HdrColour::identity();
    let paper = |tonemap| Scene {
        key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0),
        refractive_index: 1.0,
        tonemap,
        ..Scene::default()
    };
    let operators = [Tonemap::Neutral, Tonemap::Filmic, Tonemap::Channel];
    let neutrals = operators.map(|tonemap| luminance(matched([0.5; 3], paper(tonemap), &colour)).raw());
    assert!(neutrals.iter().all(|level| (level - neutrals[0]).abs() < 0.5),
        "the operators moved a neutral the paper can already hold: {neutrals:?}");
    let purity = operators.map(|tonemap| {
        let drawn = matched([6.0, 1.2, 0.4], paper(tonemap), &colour).map(|light| light.raw());
        drawn.into_iter().fold(f64::MAX, f64::min) / drawn.into_iter().fold(0.0f64, f64::max)
    });
    assert!(purity[2] > purity[1] + 0.02 && purity[1] > purity[0] + 0.02,
        "the operators failed to separate on a saturated highlight: {purity:?}");
}

fn luminance(color: [Light<DisplayNits>; 3]) -> Light<DisplayNits> {
    const P3_LUMA: [f64; 3] = [0.22897456, 0.69173852, 0.07928691];
    Light::measured(color.into_iter().zip(P3_LUMA).map(|(value, weight)| value.raw() * weight).sum())
}

fn draw(source: [f64; 3], scene: Scene) -> [Light<DisplayNits>; 3] {
    sample(source, scene, [16, 16])
}

fn sample(source: [f64; 3], scene: Scene, pixel_at: [usize; 2]) -> [Light<DisplayNits>; 3] {
    sample_as(source, scene, pixel_at, None)
}

fn matched(source: [f64; 3], scene: Scene, colour: &HdrColour) -> [Light<DisplayNits>; 3] {
    sample_as(source, scene, [16, 16], Some(colour))
}

fn sample_as(
    source: [f64; 3],
    scene: Scene,
    pixel_at: [usize; 2],
    colour: Option<&HdrColour>,
) -> [Light<DisplayNits>; 3] {
    let gpu = rawshim::gpu::device().expect("print requires Vulkan");
    let base = rawshim::base::device(gpu).expect("source pyramid");
    let size = 32;
    let grade = Grade {
        width: size, height: size, photograph_long: Span::measured(size), colour,
        white: Light::measured(10000.0), source_level: Light::measured(10000.0), floor: None,
        reference_nits: Light::exactly(203.0), peak_nits: Light::exactly(1000.0),
        exposure: Stops::ZERO, adjust: Adjust::none(), as_shot: None, output: Output::Pq,
        print_tone: Tonemap::Neutral,
        geometry: Geometry::none(), window: None, surround_window: None,
        canvas: Some(Canvas { region: (0.0, 0.0, size as f64, size as f64),
            size: Size::measured(size, size), max_lod: 5 }),
    };
    let pixel = rawshim::hdr_fit::srgb_to_rec2020().map(|row| {
        let value = row.into_iter().zip(source).map(|(weight, value)| weight * value).sum::<f64>();
        (rawshim::tone::pq(Light::<SceneNits>::exactly(value * 203.0)).raw() * 65535.0).round() as u16
    });
    let frame = pixel.repeat(size * size);
    let pyramid = rawshim::base::pyramid(gpu, base, &frame, (size, size)).expect("source pyramid");
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(&frame, &grade, &peak);
    let drawn = uploaded.draw_print(&grade, &pyramid, &scene);
    let at = (pixel_at[1] * size + pixel_at[0]) * 4;
    std::array::from_fn(|channel| {
        let coded = f64::from(drawn[at + channel]);
        let linear = if coded.abs() <= 0.04045 { coded / 12.92 }
            else { coded.signum() * ((coded.abs() + 0.055) / 1.055).powf(2.4) };
        Light::measured(linear * 203.0)
    })
}
