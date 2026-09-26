//! What a tick carries, read by the host that receives it.
//!
//! **Four structs cross this boundary as JSON and their field names are written twice** - once as
//! `serde` attributes here, once as an interface in `web/src/features/raw_edit/edits.ts`. Nothing
//! else holds the two together: a renamed field compiles on both sides, passes every unit test,
//! and fails at the first tick with `missing field`, which is a black stage and a `failed` panel.
//! That has happened - the page kept sending the flattened `cropLeft`/`cropTop` shape its own
//! uniform writer had used after `image::Geometry` became what reads it.
//!
//! So one committed sample, deserialised here and rebuilt there
//! (`web/src/features/raw_edit/tests/module_json.test.ts`). Values are distinct and off zero
//! throughout, so a pair exchanged between two fields of the same type fails rather than passing
//! on symmetry.

use serde::Deserialize;

#[derive(Deserialize)]
struct Sample {
    region: rawshim::gpu::Region,
    adjust: rawshim::gpu::Adjust,
    geometry: rawshim::image::Geometry,
    print: rawshim::print::Scene,
}

fn sample() -> Sample {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/tables/module-json.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("the page's tick is what this host reads")
}

#[test]
fn an_unknown_tone_curve_kind_is_refused() {
    let curve = r#"{"kind":"linearSrgb","points":[[0,0],[1,1]]}"#;
    assert!(serde_json::from_str::<rawshim::gpu::ToneCurve>(curve).is_err());
}

#[test]
fn invalid_curve_points_are_refused_at_the_json_boundary() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/tables/module-json.json");
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for points in [
        vec![[0.5, 0.1], [0.4, 0.9]],
        vec![[0.5, 0.1], [0.5, 0.9]],
        (0..17).map(|i| [i as f64 / 16.0; 2]).collect(),
        vec![[0.0, 0.0], [1.0, 1.1]],
    ] {
        let mut adjust = fixture["adjust"].clone();
        adjust["toneCurve"]["points"] = serde_json::to_value(points).unwrap();
        assert!(serde_json::from_value::<rawshim::gpu::Adjust>(adjust).is_err());
    }
}

#[test]
fn a_tick_names_its_region_the_way_this_host_reads_it() {
    let region = sample().region;
    assert_eq!((region.x, region.y), (12.5, 34.25));
    assert_eq!((region.width, region.height), (640.0, 480.0));
}

#[test]
fn a_tick_names_every_slider_the_way_this_host_reads_it() {
    let adjust = sample().adjust;
    assert_eq!(adjust.contrast, 11.0);
    assert_eq!(adjust.highlights, -22.0);
    assert_eq!(adjust.shadows, 33.0);
    assert_eq!(adjust.whites, -44.0);
    assert_eq!(adjust.blacks, 55.0);
    assert_eq!(adjust.tone_curve, Some(rawshim::gpu::ToneCurve::PchipCbrt3 {
        points: vec![[0.0, 0.04], [0.35, 0.3], [0.7, 0.78], [1.0, 1.0]],
    }));
    assert_eq!(adjust.vibrance, -66.0);
    assert_eq!(adjust.saturation, Some(77.0));
    assert_eq!(adjust.texture, -88.0);
    assert_eq!(adjust.clarity, 99.0);
    assert_eq!(adjust.dehaze, -12.5);
    // Half a pair, which is the case a stand-in for absence would read as a colour cast.
    assert_eq!(adjust.temperature, Some(4800.0));
    assert_eq!(adjust.tint, None);
    // Off the default, which a dropped field would quietly read as.
    assert_eq!(adjust.colour_profile, rawshim::gpu::ColourProfile::None);
}

#[test]
fn a_tick_names_the_geometry_the_way_this_host_reads_it() {
    let geometry = sample().geometry;
    // Left, top, right, bottom - the order the gather indexes them in, so a transposed pair is a
    // crop taken out of the wrong side of the picture.
    assert_eq!(geometry.crop, [0.1, 0.2, 0.8, 0.9]);
    assert_eq!(geometry.angle_degrees, 6.5);
    assert_eq!(geometry.rotate, 90);
    assert_eq!(
        geometry.keystone,
        Some([1.01, 0.02, -0.03, 0.04, 1.05, -0.06, 0.07, -0.08]),
    );
}

#[test]
fn a_tick_names_its_print_scene_the_way_this_host_reads_it() {
    let scene = sample().print;
    scene.validate().expect("a valid print scene");
    assert!(matches!(scene.paper, rawshim::print::Paper::Satin));
    assert_eq!(scene.rendering_intent, rawshim::gpu::Intent::RelativeColorimetric);
    assert!(!scene.black_point_compensation);
    assert!(matches!(scene.ink, rawshim::print::Ink::Pigment));
    assert_eq!(scene.print_resolution_ppi, 300.0);
    assert!((scene.ink_spread.raw() - 0.045).abs() < 1e-12);
    assert!(matches!(scene.presentation, rawshim::print::Presentation::Scene));
    assert!(scene.framed);
    assert_eq!(scene.yaw_degrees, -12.0);
    assert_eq!(scene.pitch_degrees, 8.0);
    assert_eq!(scene.key_lux.raw(), 1000.0);
    assert_eq!(
        (scene.light_across.raw(), scene.light_height.raw(), scene.light_forward.raw()),
        (-0.6, 3.9, 1.7),
    );
    assert_eq!(scene.light_angular_degrees, 1.0);
    assert_eq!(scene.fill_lux.raw(), 500.0);
    assert_eq!(scene.light_temperature_kelvin, 6500.0);
    assert_eq!(scene.roughness, 0.28);
    assert_eq!(scene.white_reflectance.raw(), 0.95);
    assert_eq!(scene.black_reflectance.raw(), 0.0042);
    assert_eq!(scene.refractive_index, 1.25);
    assert_eq!(scene.paper_long_edge_mm.raw(), 300.0);
    assert_eq!(scene.surface_texture, 0.025);
    assert_eq!((scene.zoom, scene.pan_x, scene.pan_y), (2.5, -0.125, 0.25));
}

#[test]
fn a_print_scene_without_framing_is_unframed() {
    let mut sample: serde_json::Value = serde_json::from_str(include_str!("../../../test/fixtures/tables/module-json.json"))
        .expect("the shared module sample");
    let print = sample["print"].as_object_mut().expect("the print scene");
    print.remove("framed");
    let scene = rawshim::print::Scene::parse(&sample["print"].to_string()).expect("an unframed scene");
    assert!(!scene.framed);
}
