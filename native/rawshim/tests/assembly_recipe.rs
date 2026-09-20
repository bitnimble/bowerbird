//! What an assembly's recipe carries, held against the schema that stores it.
//!
//! The same boundary `panorama_recipe.rs` guards, for the recipe that adds the tiles: the shape is
//! written twice, once as `serde` attributes on `assembly::Assembly` and once as
//! `AssemblyRecipeSchema`, and zod strips what it does not declare - so a field one side adds and
//! the other does not know is gone by the time the recipe is stored, with nothing raised.
//!
//! One sample, written by hand rather than round-tripped from our own output, which would pass even
//! if both sides were wrong in the same way. `src/schemas/tests/assembly_recipe.test.ts` parses the
//! same file and asserts its half.

use rawshim::assembly::{Assembly, Takes};

fn fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/assembly-recipe.json")
}

fn sample() -> Assembly {
    let text = std::fs::read_to_string(fixture()).expect("the fixture");
    serde_json::from_str(&text).expect("the server's shape parses")
}

#[test]
fn the_servers_shape_parses_and_nothing_is_missing() {
    let a = sample();
    assert_eq!(a.spec.sources.len(), 2);
    assert!(
        (a.spec.radians_per_pixel - 0.000_192_5).abs() < 1e-12,
        "the flattened geometry arrived"
    );
    assert_eq!(a.spec.crop, [0.013, 0.077, 0.988, 0.945]);
    assert_eq!(a.vertices.len(), 6);
    assert_eq!(a.tiles, vec![vec![0, 1, 2, 3], vec![1, 4, 5, 2]]);
    assert_eq!(a.pick, vec![1, 0]);
    assert_eq!(a.takes, vec![Takes::Ground, Takes::Subject]);
    assert_eq!(a.base, 0);
    assert_eq!(a.feather, 0.025);
    let seams = a.seams.as_ref().expect("the fixture's seams");
    assert_eq!((seams.pick.clone(), seams.base), (vec![1, 0], 0));
    assert_eq!(seams.takes, vec![Takes::Ground, Takes::Subject]);
    assert_eq!(seams.vertices.len(), 7);
    assert_eq!(seams.tiles, vec![vec![0, 1, 2, 3], vec![4, 5, 6]]);
    assert_eq!(seams.source, vec![1, 1]);
    assert_eq!(seams.zone, vec![0, 0]);
    assert_eq!(seams.corridor, vec![0.031, 0.0125]);
    assert_eq!(
        seams.warp,
        vec![
            [1.002, 0.013, -0.004, 0.998, 2.5, -1.25],
            [1.0, -0.009, 0.006, 1.0, -3.0, 0.5]
        ],
    );
    assert_eq!(seams.exposure, vec![1.043, 0.972]);
    // Compared with a tolerance, the field being `f32` on the way in and `f64` on the way out:
    // 1.002 is not a number either has exactly, and what this pins is which piece was read rather
    // than the last bit of one.
    let drawing = a
        .rendered()
        .expect("seams solved for the recipe's own picks");
    let close = |got: [f64; 6], want: [f64; 6]| {
        assert!(
            got.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-6),
            "read {got:?} where the fixture names {want:?}",
        );
    };
    close(
        drawing.warp_of(0),
        [1.002, 0.013, -0.004, 0.998, 2.5, -1.25],
    );
    close(drawing.warp_of(1), [1.0, -0.009, 0.006, 1.0, -3.0, 0.5]);
    assert_eq!(drawing.gain[1].raw() as f32, 0.972);
}

/// The direction a hand-written fixture does not otherwise pin: a field this side adds as an
/// `Option<T>` - the shape the dropped `crop` had - parses the unchanged fixture happily, so both
/// suites stay green while zod strips it. Hence the fixture's own keys are this struct's keys.
///
/// Keys rather than values: the fixture's `100` is a `u64` where the `f32` vertex serialises as
/// `100.0`, so whole-`Value` equality would fail on a file that is correct.
#[test]
fn the_fixture_names_every_field_this_host_writes() {
    let keys = |v: &serde_json::Value| -> Vec<String> {
        let mut names: Vec<String> = v.as_object().expect("an object").keys().cloned().collect();
        names.sort();
        names
    };
    let written = serde_json::to_value(sample()).expect("the sample serialises");
    let committed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture()).expect("the fixture"))
            .expect("the fixture is JSON");
    assert_eq!(
        keys(&committed),
        keys(&written),
        "the fixture and this host name different fields"
    );
}

/// The page shows a recipe that names no feather at `DEFAULT_FEATHER`, and the render has to draw it
/// at the same.
#[test]
fn a_recipe_naming_no_feather_reads_as_the_one_the_page_assumes() {
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(fixture()).expect("the fixture"))
            .expect("the fixture is JSON");
    value.as_object_mut().expect("an object").remove("feather");
    let read: Assembly = serde_json::from_value(value).expect("a recipe");

    let schema = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/schemas/assembly.ts"),
    )
    .expect("the schema");
    let page: f32 = schema
        .lines()
        .find_map(|line| line.strip_prefix("export const DEFAULT_FEATHER = "))
        .and_then(|rest| rest.trim_end_matches(';').parse().ok())
        .expect("the schema's DEFAULT_FEATHER");
    assert_eq!(read.feather, page);
    assert_eq!(read.feather, rawshim::assembly_weight::FEATHER.raw() as f32);
}

#[test]
fn sources_used_is_the_base_then_every_pick() {
    let mut a = sample();
    (a.pick, a.base, a.seams) = (vec![2, 0], 1, None);
    a.spec.sources.push(a.spec.sources[0].clone());
    assert_eq!(
        a.rendered().expect("the tiles").sources_used(),
        vec![1, 0, 2]
    );
}
