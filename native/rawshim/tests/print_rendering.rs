use rawshim::gpu::{Canvas, Grade, Intent, Output};
use rawshim::hdr_fit::HdrColour;
use rawshim::light::{DisplayNits, Gain, Light, SceneNits};
use rawshim::print::{Paper, Presentation, Scene};
use rawshim::px::Size;

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
        key_lux: Light::exactly(5000.0),
        ..Scene::default()
    }.lit_from(-32.0, 25.0, 4.0);
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
        let mut facing: Option<f64> = None;
        for pitch in [0.0, -37.5, -75.0] {
            let scene = Scene {
                yaw_degrees: 0.0,
                pitch_degrees: pitch,
                fill_lux: Light::exactly(fill),
                refractive_index: 1.0,
                surface_texture: 0.0,
                ..Scene::default()
            }.lit_from(0.0, 75.0, 4.0);
            let white = luminance(draw([1.0; 3], scene)).raw();
            match facing {
                // The camera meters the room it is shown, once, against a sheet hung facing the
                // reader. A sheet turned in the hand is not a reason to re-expose it, so its
                // brightness has to *move* with the pose - the ceiling and the floor carry
                // different amounts and a turn trades one for the other. Re-metering would pin the
                // sheet and move everything that did not turn, the background included, instead.
                None => assert!((white - scene.white_reflectance.raw() * 203.0).abs() < 5.0,
                    "diffuse white is not metered at fill {fill}: {white} nits"),
                Some(square) => assert!((white - square).abs() > 5.0 && white < 1000.0,
                    "the pose did not move the sheet's light: {white} nits against {square}"),
            }
            facing.get_or_insert(white);
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
            light_angular_degrees: size,
            fill_lux: Light::ZERO,
            roughness,
            surface_texture: 0.0,
            ..Scene::default()
        }.lit_from(0.0, 75.0, 4.0);
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
        // Square on, where the metering is: a turned sheet gathers a different amount of the room
        // and these are a claim about reflectance rather than about pose.
        yaw_degrees: 0.0,
        pitch_degrees: 0.0,
        ..Scene::default()
    };
    let (white, black) = (scene.white_reflectance.raw(), scene.black_reflectance.raw());
    for input in [0.0, 0.18, 1.0] {
        let expected = (black + (white - black) * input) * 203.0;
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
    // A lamp in an unlit room is not a lamp in a void: what it throws past the print comes back
    // off the floor, which is the whole of the light a sheet turned away from it then has.
    scene.key_lux = Light::exactly(1000.0);
    let lamp_only = luminance(sample([0.5; 3], scene, [0, 0])).raw();
    assert!(lamp_only > 1.0 && lamp_only < 30.0, "the lamp lit no room at all: {lamp_only} nits");
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
    // so what is left between them is the room, whose floor is half its ceiling.
    let ceiling = luminance(draw([0.0; 3], Scene { yaw_degrees: 0.0, pitch_degrees: -45.0, ..scene })).raw();
    let floor = luminance(draw([0.0; 3], Scene { yaw_degrees: 0.0, pitch_degrees: 45.0, ..scene })).raw();
    assert!(ceiling > floor * 1.6, "the sheen is a wash rather than a reflection: {floor} vs {ceiling}");
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

/// The reader has a body, and it hangs below the eye rather than around it.
///
/// Tilting a sheet the same angle either way sends its reflection the same angle above the reader
/// or below them, onto the same wall at elevations that mirror each other - so what separates the
/// two is the torso and legs standing in one of them. A silhouette that is only a head would
/// brighten both alike.
#[test]
fn the_reader_is_a_body_hanging_below_the_eye_rather_than_a_head_around_it() {
    let scene = Scene {
        yaw_degrees: 0.0, pitch_degrees: 0.0, key_lux: Light::ZERO,
        fill_lux: Light::exactly(500.0), roughness: 0.08, surface_texture: 0.0,
        black_reflectance: Gain::of_ratio(0.001), ..Scene::default()
    };
    let above = luminance(draw([0.0; 3], Scene { pitch_degrees: -9.0, ..scene })).raw();
    let below = luminance(draw([0.0; 3], Scene { pitch_degrees: 9.0, ..scene })).raw();
    assert!(above > below * 1.25,
        "the silhouette is as tall as it is wide: {above} over the reader, {below} down them");
}

/// A lamp lights the room it is in, and the room lights the print.
#[test]
fn a_lamp_in_an_unlit_room_still_reaches_a_sheet_turned_away_from_it() {
    let scene = Scene {
        yaw_degrees: 0.0, key_lux: Light::exactly(1000.0), fill_lux: Light::ZERO,
        refractive_index: 1.0, surface_texture: 0.0, ..Scene::default()
    }.lit_from(0.0, 75.0, 4.0);
    let towards = luminance(draw([1.0; 3], Scene { pitch_degrees: -60.0, ..scene })).raw();
    let away = luminance(draw([1.0; 3], Scene { pitch_degrees: 30.0, ..scene })).raw();
    assert!(away > towards * 0.05,
        "a sheet turned from the lamp went black: {away} against {towards} nits towards it");
    assert!(away < towards * 0.4,
        "the room's bounce stood in for the lamp: {away} against {towards} nits");
    // Turned further it faces the floor, which is where a lamp's spill lands and comes back from.
    let floorward = luminance(draw([1.0; 3], Scene { pitch_degrees: 60.0, ..scene })).raw();
    assert!(floorward > away, "the floor carried nothing: {floorward} against {away} nits");
}

/// Light caught between the pane and the sheet is returned to the sheet, and a bright sheet keeps
/// more of it than a dark one.
///
/// The series is `1/(1 - R·rho)`, so a print under glass answers its own reflectance faster than
/// linearly: the gap between a white sheet and a dark one opens up behind the pane, where an
/// unframed pair of the same two reflectances stands in the ratio of the reflectances alone.
#[test]
fn a_pane_hands_back_what_it_catches_from_the_sheet_beneath_it() {
    let scene = Scene {
        yaw_degrees: 0.0, pitch_degrees: -25.0, key_lux: Light::exactly(1000.0), fill_lux: Light::ZERO,
        roughness: 0.15, surface_texture: 0.0, black_reflectance: Gain::of_ratio(0.2),
        white_reflectance: Gain::of_ratio(0.9), ..Scene::default()
    };
    let contrast = |framed| {
        let scene = Scene { framed, ..scene };
        luminance(draw([1.0; 3], scene)).raw() / luminance(draw([0.0; 3], scene)).raw()
    };
    let (bare, framed) = (contrast(false), contrast(true));
    assert!(framed > bare * 1.04,
        "the pane returned nothing to the sheet: {bare} bare against {framed} framed");
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

/// The coating decides a paper's black as much as the ink does: gloss keeps the deepest, in the flat
/// proof as in a room, and matte the shallowest.
#[test]
fn gloss_holds_the_deepest_black_and_matte_the_shallowest() {
    let square = Scene { yaw_degrees: 0.0, pitch_degrees: 0.0, ..Scene::default() };
    for scene in [Scene { presentation: Presentation::Flat, ..Scene::default() }, square] {
        let [gloss, satin, matte] = [Paper::Gloss, Paper::Satin, Paper::Matte]
            .map(|paper| luminance(draw([0.0; 3], scene.on(paper))).raw());
        assert!(gloss < satin && satin < matte, "blacks out of order: {gloss} gloss, {satin} satin, {matte} matte nits");
    }
}

/// A matte coating's lobe takes in most of the room, so turning the sheet towards a window lifts its
/// black by the window's share of the room rather than by the window.
#[test]
fn a_matte_sheet_turned_to_a_window_does_not_mirror_it() {
    let black = |yaw_degrees: f64| {
        let scene = Scene { key_lux: Light::ZERO, yaw_degrees, pitch_degrees: 0.0, ..Scene::default() }.on(Paper::Matte);
        luminance(draw([0.0; 3], scene)).raw()
    };
    let (facing, turned) = (black(0.0), black(40.0));
    assert!(turned < 2.0 * facing, "the window reached a matte sheet as a mirror: {facing} facing, {turned} turned nits");
}

fn lit_evenly(rendering_intent: Intent) -> Scene {
    Scene {
        key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), refractive_index: 1.0, yaw_degrees: 0.0, pitch_degrees: 0.0,
        rendering_intent, black_point_compensation: false,
        ..Scene::default()
    }
}

/// Perceptual rolls a saturated highlight under white and keeps its colour; relative clips it at
/// the paper, where only white is left.
#[test]
fn perceptual_keeps_a_highlights_colour_that_relative_clips() {
    let colour = HdrColour::identity();
    let purity = [Intent::Perceptual, Intent::RelativeColorimetric].map(|intent| {
        let drawn = matched([6.0, 1.2, 0.4], lit_evenly(intent), &colour).map(|light| light.raw());
        drawn.into_iter().fold(f64::MAX, f64::min) / drawn.into_iter().fold(0.0f64, f64::max)
    });
    assert!(purity[1] > purity[0] + 0.2, "the intents failed to separate on a saturated highlight: {purity:?}");
}

/// A colour the paper can hold is laid down exactly by a colorimetric intent: its share of white is
/// its share of the paper's white.
#[test]
fn a_colorimetric_intent_leaves_what_the_paper_holds() {
    let colour = HdrColour::identity();
    let scene = lit_evenly(Intent::RelativeColorimetric);
    let white = luminance(matched([1.0; 3], scene, &colour)).raw();
    let held = [0.5, 0.35, 0.3];
    let drawn = luminance(matched(held, scene, &colour)).raw();
    let expected = white * luminance(held.map(|value| Light::measured(value * 203.0))).raw() / 203.0;
    assert!((drawn / expected - 1.0).abs() < 0.02, "relative moved a colour the paper holds: {drawn} against {expected} nits");
}

/// The 1.3x-white probe lies above the knee. Perceptual compresses it beneath a 4x-white patch;
/// relative preserves its level until the paper clips it.
#[test]
fn the_intents_differ_under_a_blown_highlight() {
    let colour = HdrColour::identity();
    let blown = |column: usize| if column < 6 { [4.0; 3] } else { [1.3; 3] };
    let [perceptual, relative] = [Intent::Perceptual, Intent::RelativeColorimetric]
        .map(|intent| luminance(sample_as(&blown, lit_evenly(intent), [16, 16], Some(&colour))).raw());
    assert!(relative / perceptual > 1.05, "the intents drew the same picture: {perceptual} against {relative} nits");
}

/// The paper and the ink under a light that puts a perfect white at diffuse white, and nothing of
/// the lamp or the room: white paper reads at its own reflectance, black ink at its.
#[test]
fn a_flat_print_is_the_paper_under_diffuse_white() {
    let nits = |source: f64, key_lux: f64| {
        let scene = Scene { presentation: Presentation::Flat, key_lux: Light::exactly(key_lux), ..Scene::default() };
        let drawn = drawn_as(&|_| [source; 3], Shown::Print(scene), 32, 1.0, None);
        linear(drawn[(16 * 32 + 16) * 4 + 1]) * 203.0
    };
    let (white, black) = (nits(1.0, 1000.0), nits(0.0, 1000.0));
    let paper = Scene::default();
    assert!((white / (paper.white_reflectance.raw() * 203.0) - 1.0).abs() < 0.01, "paper white read {white} nits");
    assert!((black / (paper.black_reflectance.raw() * 203.0) - 1.0).abs() < 0.05, "black ink read {black} nits");
    assert_eq!(white, nits(1.0, 8000.0), "the lamp reached a flat print");
}

/// A printer profile decides the paper and the ink in place of the scene's white and black, and a
/// colour is laid down as a share of that paper.
#[test]
fn a_printer_profile_lays_down_its_own_paper() {
    let icc = ideal_printer(0.5);
    let printer = std::sync::Arc::new(rawshim::printer_gamut::PrinterGamut::new(&icc).expect("a printer profile"));
    let nits = |source: f64| {
        let scene = Scene { presentation: Presentation::Flat, rendering_intent: Intent::RelativeColorimetric, ..Scene::default() };
        let drawn = drawn_as(&|_| [source; 3], Shown::Printed(scene, printer.clone()), 32, 1.0, None);
        linear(drawn[(16 * 32 + 16) * 4 + 1]) * 203.0
    };
    let white = nits(1.0);
    assert!((white / (0.5 * 203.0) - 1.0).abs() < 0.02, "the profile's paper read {white} nits");
    assert!(nits(0.0) < 0.5, "an ideal printer's black is black");
    let grey = nits(0.3);
    assert!((grey / white - 0.3).abs() < 0.01, "a grey left its share of the paper: {grey} against {white} nits");
}

/// A printer reproducing linear Rec.2020 exactly, on a neutral paper reflecting `white`.
fn ideal_printer(white: f64) -> Vec<u8> {
    let mut profile = moxcms::ColorProfile::new_bt2020();
    let linear = moxcms::ToneReprCurve::Lut(Vec::new());
    profile.red_trc = Some(linear.clone());
    profile.green_trc = Some(linear.clone());
    profile.blue_trc = Some(linear);
    profile.profile_class = moxcms::ProfileClass::OutputDevice;
    profile.media_white_point = Some(moxcms::Xyzd { x: 0.9642 * white, y: white, z: 0.8249 * white });
    profile.encode().expect("an encodable profile")
}

/// The intents the print offers are the sRGB proof's too, against the file's white.
#[test]
fn an_srgb_proof_reaches_its_gamut_by_the_intent_chosen() {
    let blown = |column: usize| if column < 6 { [4.0; 3] } else { [1.3; 3] };
    let read = |intent| linear(drawn_as(&blown, Shown::Srgb(intent), 32, 4.0, None)[(16 * 32 + 16) * 4 + 1]);
    let [perceptual, relative] = [Intent::Perceptual, Intent::RelativeColorimetric].map(read);
    assert!(relative / perceptual > 1.05, "relative proofed as perceptual: {relative} against {perceptual}");
}

const P3_LUMA: [f64; 3] = [0.22897456, 0.69173852, 0.07928691];

fn luminance(color: [Light<DisplayNits>; 3]) -> Light<DisplayNits> {
    Light::measured(color.into_iter().zip(P3_LUMA).map(|(value, weight)| value.raw() * weight).sum())
}

fn draw(source: [f64; 3], scene: Scene) -> [Light<DisplayNits>; 3] {
    sample(source, scene, [16, 16])
}

fn sample(source: [f64; 3], scene: Scene, pixel_at: [usize; 2]) -> [Light<DisplayNits>; 3] {
    sample_as(&|_| source, scene, pixel_at, None)
}

fn matched(source: [f64; 3], scene: Scene, colour: &HdrColour) -> [Light<DisplayNits>; 3] {
    sample_as(&|_| source, scene, [16, 16], Some(colour))
}

fn sample_as(
    source: &dyn Fn(usize) -> [f64; 3],
    scene: Scene,
    pixel_at: [usize; 2],
    colour: Option<&HdrColour>,
) -> [Light<DisplayNits>; 3] {
    let size = 32;
    let drawn = drawn_as(source, Shown::Print(scene), size, 1.0, colour);
    let at = (pixel_at[1] * size + pixel_at[0]) * 4;
    std::array::from_fn(|channel| Light::measured(linear(drawn[at + channel]) * 203.0))
}

/// A canvas value decoded from its extended sRGB, in shares of SDR white.
fn linear(coded: f32) -> f64 {
    let coded = f64::from(coded);
    if coded.abs() <= 0.04045 { coded / 12.92 } else { coded.signum() * ((coded.abs() + 0.055) / 1.055).powf(2.4) }
}

enum Shown {
    Print(Scene),
    /// A print laid down by a printer profile's printer.
    Printed(Scene, std::sync::Arc<rawshim::printer_gamut::PrinterGamut>),
    /// An sRGB soft proof, brought inside the file's gamut by the intent given.
    Srgb(Intent),
}

/// A square photograph drawn onto a canvas of the same size. `source` is its colour at a column, in
/// shares of 203 nits, and `over_white` how far its top end sits over diffuse white.
fn drawn_as(
    source: &dyn Fn(usize) -> [f64; 3],
    shown: Shown,
    size: usize,
    over_white: f64,
    colour: Option<&HdrColour>,
) -> Vec<f32> {
    let gpu = rawshim::gpu::device().expect("print requires Vulkan");
    let base = rawshim::base::device(gpu).expect("source pyramid");
    let (output, peak_nits, intent) = match shown {
        Shown::Print(_) | Shown::Printed(..) => (Output::Pq, Light::exactly(1000.0), Intent::Perceptual),
        Shown::Srgb(intent) => (Output::Srgb, Light::exactly(203.0), intent),
    };
    let grade = Grade {
        colour,
        output,
        intent,
        canvas: Some(Canvas { region: (0.0, 0.0, size as f64, size as f64),
            size: Size::measured(size, size), max_lod: 5 }),
        ..Grade::new(
            size,
            size,
            rawshim::tone::Levels { white: Light::measured(10000.0), peak: Light::measured(10000.0 * over_white), floor: None },
            Light::exactly(203.0),
            peak_nits,
        )
    };
    let coded = |colour: [f64; 3]| rawshim::hdr_fit::srgb_to_rec2020().map(|row| {
        let value = row.into_iter().zip(colour).map(|(weight, value)| weight * value).sum::<f64>();
        (rawshim::tone::pq(Light::<SceneNits>::exactly(value * 203.0)).raw() * 65535.0).round() as u16
    });
    let frame: Vec<u16> = (0..size * size).flat_map(|at| coded(source(at % size))).collect();
    let pyramid = rawshim::base::pyramid(gpu, base, &frame, (size, size)).expect("source pyramid");
    let peak = gpu.scene_peak();
    let uploaded = gpu.upload(&frame, &grade, &peak);
    match shown {
        Shown::Print(scene) => uploaded.draw_print(&grade, &pyramid, &scene),
        Shown::Printed(scene, printer) => {
            uploaded.set_printer(Some(printer));
            uploaded.draw_print(&grade, &pyramid, &scene)
        }
        Shown::Srgb(_) => uploaded.draw(&grade, &pyramid),
    }
}
