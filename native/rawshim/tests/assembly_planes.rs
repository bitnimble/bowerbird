//! Needs `--features fixtures`: it decodes a real RAW.
#![cfg(feature = "fixtures")]
mod support;

use rawshim::assembly_planes::{ANALYSIS_LONG, analysis_planes};
use rawshim::composite_tile::SourceFile;
use rawshim::composition::{Composition, LensSpec, SourceSpec, from_axis_angle, normalise};
use rawshim::snapshot::{Frame, Snapshot};
use support::*;

/// The recipe that places one fixture on a canvas its own size, and the path it is rendered from.
///
/// The two are separate because a `SourceFile` borrows its path, so a pair holding both would
/// borrow from itself.
fn one_source_recipe(name: &str) -> (Composition, String) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures")
        .join(name);
    assert!(
        path.is_file(),
        "{} is missing. These fixtures are Git LFS objects; run `git lfs pull`.",
        path.display(),
    );
    let path = path.to_str().expect("a printable path").to_string();
    let header = rawshim::header::read_path(&path).expect("the fixture's header");
    let size = [header.width as usize, header.height as usize];
    (Composition::of_one(size, LensSpec::none()), path)
}

/// The plane is a demosaic in the recipe's geometry with nothing else.
#[test]
fn the_plane_is_the_prepared_source_and_nothing_more() {
    let Some(rig) = rig() else { return };
    let (spec, path) = one_source_recipe("DSC02981.ARW");
    let sources = [SourceFile {
        path: &path,
        analysis: None,
    }];
    let planes = pollster::block_on(analysis_planes(&spec, &sources)).unwrap();
    assert_eq!(planes.len(), 1);
    let codes = codes_of(&rig, &planes[0].rgb);
    assert!(codes.iter().any(|&c| c > 255), "PQ, not eight bits");
    assert!(
        planes[0].noise.alpha > 0.0,
        "the decode fitted a noise model"
    );
    let long = planes[0].rgb.width.max(planes[0].rgb.height);
    assert_eq!(long, ANALYSIS_LONG.min(spec.canvas[0].max(spec.canvas[1])));
}

/// A stage that crept back in would show here: the plane is compared against a committed snapshot
/// of a 128x128 crop, and a sharpen or a denoise moves more than it allows.
#[test]
fn the_plane_matches_its_snapshot() {
    let Some(_rig) = rig() else { return };
    let (spec, path) = one_source_recipe("DSC02981.ARW");
    let sources = [SourceFile {
        path: &path,
        analysis: None,
    }];
    let planes = pollster::block_on(analysis_planes(&spec, &sources)).unwrap();
    let crop = rawshim::px::Rect::<rawshim::px::Analysis>::exact(1400, 900, 128, 128);
    // Measured against radv: 5 codes at worst, nothing on average.
    let tolerance = rawshim::snapshot::Tolerance {
        worst: 64,
        mean: 0.1,
    };
    Snapshot::crops(Frame::Coded(&planes[0].rgb), &[crop])
        .check("assembly/plane-DSC02981", tolerance);
}

/// The three things a caller indexes these by: the reference is first however late it sits in the
/// recipe, `source` is the recipe's index rather than the position, and a source the canvas cannot
/// reach is absent rather than empty.
#[test]
fn the_planes_are_reference_first_and_carry_their_recipe_index() {
    let Some(_rig) = rig() else { return };
    let (mut spec, path) = one_source_recipe("DSC02981.ARW");
    let one = spec.sources[0].clone();
    spec.sources = vec![
        one.clone(),
        one.clone(),
        SourceSpec {
            // Turned to face the other way, so every ray of the canvas is behind it.
            rotation: normalise(from_axis_angle([0.0, std::f64::consts::PI, 0.0])),
            ..one
        },
    ];
    spec.reference = 1;
    let sources = [
        SourceFile {
            path: &path,
            analysis: None,
        },
        SourceFile {
            path: &path,
            analysis: None,
        },
        SourceFile {
            path: &path,
            analysis: None,
        },
    ];
    let planes = pollster::block_on(analysis_planes(&spec, &sources)).unwrap();
    let order: Vec<usize> = planes.iter().map(|p| p.source).collect();
    assert_eq!(
        order,
        vec![1, 0],
        "the reference is measured and handed back first"
    );
}
