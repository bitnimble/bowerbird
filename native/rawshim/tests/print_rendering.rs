use rawshim::gpu::{Adjust, Canvas, Grade, Output, Tonemap};
use rawshim::hdr_fit::HdrColour;
use rawshim::image::Geometry;
use rawshim::light::{DisplayNits, Gain, Light, SceneNits, Stops};
use rawshim::print::{Presentation, Scene};
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
                None => assert!((white - 182.7).abs() < 5.0,
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
    let purity = operators.map(|tonemap| {
        let drawn = matched([6.0, 1.2, 0.4], paper(tonemap), &colour).map(|light| light.raw());
        drawn.into_iter().fold(f64::MAX, f64::min) / drawn.into_iter().fold(0.0f64, f64::max)
    });
    // Far enough apart to be a choice rather than a rounding: a squared bleach put filmic within
    // a percent of neutral, which is a dropdown nobody can see the effect of.
    assert!(purity[2] > purity[1] + 0.05 && purity[1] > purity[0] + 0.05,
        "the operators failed to separate on a saturated highlight: {purity:?}");
}

/// Neutral and channel leave alone whatever paper can already hold; a stock reshapes the whole
/// range around grey, which is what makes it a choice on a photograph with no saturated highlight
/// in it - and that is most photographs.
#[test]
fn a_film_stock_reshapes_the_range_the_other_operators_hold() {
    let colour = HdrColour::identity();
    let level = |tonemap, share: f64| {
        let scene = Scene {
            key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), refractive_index: 1.0, tonemap,
            ..Scene::default()
        };
        luminance(matched([share; 3], scene, &colour)).raw()
    };
    for share in [0.05, 0.18, 0.5] {
        let (neutral, channel) = (level(Tonemap::Neutral, share), level(Tonemap::Channel, share));
        assert!((channel - neutral).abs() < 0.5, "channel moved a grey of {share}: {neutral} to {channel}");
    }
    let against = |share| level(Tonemap::Filmic, share) / level(Tonemap::Neutral, share);
    let (shadow, grey, upper) = (against(0.05), against(0.18), against(0.5));
    assert!((grey - 1.0).abs() < 0.03, "the stock moved its own pivot: {grey}");
    assert!(shadow < 0.85, "the stock has no toe: {shadow}");
    assert!(upper > 1.08, "the stock adds no contrast above grey: {upper}");
}

/// A blown highlight is neutral - every channel clipped alike - so an operator that only decides
/// how a highlight's *colour* is compressed is the same picture as its neighbours on the very
/// photograph a reader picks to compare them. What they have to disagree about is the tones just
/// under the blown patch, which each one gives a different share of the paper.
#[test]
fn every_operator_differs_on_a_photograph_whose_highlights_are_blown() {
    let colour = HdrColour::identity();
    let read = |tonemap| {
        let scene = Scene {
            key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), refractive_index: 1.0, tonemap,
            ..Scene::default()
        };
        let blown = |column: usize| if column < 6 { [4.0; 3] } else { [0.8; 3] };
        luminance(sample_as(&blown, scene, [16, 16], Some(&colour))).raw()
    };
    let [neutral, filmic, channel] = [Tonemap::Neutral, Tonemap::Filmic, Tonemap::Channel].map(read);
    for (name, a, b) in [("neutral/filmic", neutral, filmic), ("neutral/channel", neutral, channel),
        ("filmic/channel", filmic, channel)] {
        assert!((a / b - 1.0).abs() > 0.05, "{name} drew the same picture: {a} against {b} nits");
    }
}

/// A sky two stops over white, textured by a third of a stop: a curve over the frame spends almost
/// nothing on it, where lowering the region first leaves the texture room to show.
#[test]
fn the_regional_operator_keeps_the_texture_inside_a_bright_region() {
    let size = 1024;
    let sky = |column: usize| if (column / 4) % 2 == 0 { [3.0; 3] } else { [3.0 * 2f64.powf(-0.3); 3] };
    let texture = |tonemap| {
        let scene = Scene {
            key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), refractive_index: 1.0, tonemap,
            ..Scene::default()
        };
        let drawn = drawn_as(&sky, Shown::Print(scene), size, 4.0, None);
        let row = size / 2;
        let lumas: Vec<f64> = (size / 2 - 32..size / 2 + 32).map(|column| {
            let at = (row * size + column) * 4;
            (0..3).map(|channel| linear(drawn[at + channel]) * P3_LUMA[channel]).sum()
        }).collect();
        let (low, high) = lumas.iter().fold((f64::MAX, 0.0f64), |(low, high), &luma| (low.min(luma), high.max(luma)));
        (high / low).log2()
    };
    let (neutral, regional) = (texture(Tonemap::Neutral), texture(Tonemap::Local));
    assert!(regional > 0.06 && regional > 4.0 * neutral,
        "the texture was not kept: {regional} stops by region against {neutral} neutral");
}

/// Only what is bright is dodged: a grey reads as the neutral curve draws it.
#[test]
fn the_regional_operator_leaves_the_midtones_alone() {
    let level = |tonemap| {
        let scene = Scene {
            key_lux: Light::ZERO, fill_lux: Light::exactly(500.0), refractive_index: 1.0, tonemap,
            ..Scene::default()
        };
        let drawn = drawn_as(&|_| [0.18; 3], Shown::Print(scene), 32, 4.0, None);
        linear(drawn[(16 * 32 + 16) * 4 + 1])
    };
    let (neutral, regional) = (level(Tonemap::Neutral), level(Tonemap::Local));
    assert!((regional / neutral - 1.0).abs() < 0.02, "a grey moved: {neutral} to {regional}");
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
    assert!((white / (0.9 * 203.0) - 1.0).abs() < 0.01, "paper white read {white} nits");
    assert!((black / (0.008 * 203.0) - 1.0).abs() < 0.05, "black ink read {black} nits");
    assert_eq!(white, nits(1.0, 8000.0), "the lamp reached a flat print");
}

/// The operator the print offers is the sRGB proof's too, fitted under diffuse white: the tones
/// under a blown patch differ between them, and the neutral one is the rendition's own.
#[test]
fn an_srgb_proof_fits_its_highlights_with_the_operator_chosen() {
    let blown = |column: usize| if column < 6 { [4.0; 3] } else { [0.8; 3] };
    let read = |tone| linear(drawn_as(&blown, Shown::Srgb(tone), 32, 4.0, None)[(16 * 32 + 16) * 4 + 1]);
    let [neutral, filmic, channel] = [Tonemap::Neutral, Tonemap::Filmic, Tonemap::Channel].map(read);
    assert!((filmic / neutral - 1.0).abs() > 0.05, "filmic proofed as neutral: {filmic} against {neutral}");
    assert!((channel / neutral - 1.0).abs() > 0.05, "per channel proofed as neutral: {channel} against {neutral}");
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
    /// An sRGB soft proof, its highlights fitted by the operator given.
    Srgb(Tonemap),
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
    let (output, peak_nits, print_tone) = match shown {
        Shown::Print(_) => (Output::Pq, Light::exactly(1000.0), Tonemap::Neutral),
        Shown::Srgb(tone) => (Output::Srgb, Light::exactly(203.0), tone),
    };
    let grade = Grade {
        width: size, height: size, photograph_long: Span::measured(size), colour,
        white: Light::measured(10000.0), source_level: Light::measured(10000.0 * over_white), floor: None,
        reference_nits: Light::exactly(203.0), peak_nits,
        exposure: Stops::ZERO, adjust: Adjust::none(), as_shot: None, output,
        print_tone,
        geometry: Geometry::none(), window: None, surround_window: None,
        canvas: Some(Canvas { region: (0.0, 0.0, size as f64, size as f64),
            size: Size::measured(size, size), max_lod: 5 }),
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
        Shown::Srgb(_) => uploaded.draw(&grade, &pyramid),
    }
}
