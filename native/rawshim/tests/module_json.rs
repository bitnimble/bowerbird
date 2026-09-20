//! What a tick carries, read by the host that receives it.
//!
//! **Three structs cross this boundary as JSON and their field names are written twice** - once as
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
}

fn sample() -> Sample {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/tables/module-json.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).expect("the page's tick is what this host reads")
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
    assert_eq!(adjust.vibrance, -66.0);
    assert_eq!(adjust.saturation, 77.0);
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
