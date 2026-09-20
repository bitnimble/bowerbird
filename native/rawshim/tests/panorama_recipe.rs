//! What a panorama's recipe carries, held against the schema that stores it.
//!
//! **The recipe crosses as JSON and its shape is written twice** - once as `serde` attributes on
//! `composition::Composition`, once as `CompositionSchema` in `src/schemas/stacks.ts`, which is what
//! the merge parses the align's answer with before storing it.
//!
//! And zod *strips* what it does not declare, so this boundary fails more quietly than the tick's
//! does: a field the native side adds and the schema does not know is simply not there afterwards,
//! with nothing raised. That has happened - the crop the align works out to trim a hand-held pan's
//! empty corners was dropped on the way in, so the recipe stored named no crop, the renditions
//! rendered the whole canvas, and the grid laid the tile out at the shape of a picture nobody was
//! going to see. Every test on both sides passed.
//!
//! So one sample, written here and read by `src/schemas/tests/panorama_recipe.test.ts`, which
//! parses it and asserts nothing came back missing. Values are distinct and off zero throughout,
//! so a pair exchanged between two fields of the same type fails rather than passing on symmetry.
//!
//! ```text
//! BOWERBIRD_WRITE_FIXTURES=1 bun run scripts/cargo.ts test --manifest-path native/rawshim/Cargo.toml --test panorama_recipe
//! ```

use rawshim::composition::{Composition, LensSpec, Projection, SourceSpec, VERSION};

fn fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/panorama-recipe.json")
}

/// A recipe with every field set to something a reader can tell from its neighbours.
fn sample() -> Composition {
    let source = |photo_id: &str, focal: f64, gain: f64, rotation: [f64; 4]| SourceSpec {
        photo_id: photo_id.to_string(),
        size: [6000, 4000],
        rotation,
        focal,
        lens: LensSpec {
            distortion: Some(vec![0.0, -0.004, -0.011, -0.021, -0.034]),
            crop: 1.03,
            falloff: Some((0.21, -0.07)),
            tca: None,
        },
        gain,
        // Never serialised and never a panorama's: §3.7a is an assembly's per-piece correction, and
        // this fixture is what holds the *stored* shape against the server's.
        warp: rawshim::composition::no_warp(),
    };
    Composition {
        version: VERSION,
        sources: vec![
            source(
                "photo00000000001",
                5200.5,
                1.0,
                [0.999_8, 0.011, -0.017, 0.003],
            ),
            source(
                "photo00000000002",
                5200.5,
                1.21,
                [0.996_2, -0.021, 0.084, -0.006],
            ),
        ],
        projection: Projection::Cylindrical,
        canvas: [14845, 7069],
        centre: [7412.5, 3510.25],
        radians_per_pixel: 0.000_192_5,
        // Distinct on all four edges, so a rotation of the tuple fails rather than passing.
        crop: [0.013, 0.077, 0.988, 0.945],
        reference: 1,
        seam_rms_px: Some(1.75),
    }
}

/// The sample is what this host writes, and what the schema on the other side is held to.
#[test]
fn a_recipe_is_written_the_way_the_catalogue_stores_it() {
    let built = format!(
        "{}\n",
        serde_json::to_string_pretty(&sample()).expect("a recipe")
    );
    let path = fixture();
    if std::env::var("BOWERBIRD_WRITE_FIXTURES").is_ok_and(|v| v == "1") {
        std::fs::write(&path, &built).expect("writing the recipe");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}. BOWERBIRD_WRITE_FIXTURES=1 writes it",
            path.display()
        )
    });
    assert_eq!(committed, built, "the shape of a recipe has moved");
}

/// And it reads back as itself, so the fixture is a recipe rather than a shape that only serialises.
#[test]
fn the_committed_recipe_is_one_this_host_can_read() {
    let text = std::fs::read_to_string(fixture()).expect("the committed recipe");
    let read: Composition = serde_json::from_str(&text).expect("a recipe this host reads");
    assert_eq!(read.crop, sample().crop);
    assert_eq!(read.canvas, sample().canvas);
    assert_eq!(read.sources.len(), 2);
    assert_eq!(read.sources[1].gain, 1.21);
}
