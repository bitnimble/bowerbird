//! Which recipe a render was handed, read off the one field the TypeScript union already carries.
//!
//! The server stops stripping `kind` before a recipe crosses, and this is what reads it. Tagged
//! rather than tried in turn: an assembly is a composition plus its tiles, so an untagged enum
//! would read a plain panorama as an assembly the day any tile field gained a `#[serde(default)]`.

use rawshim::composite_job::CompositeRecipe;

fn tagged(name: &str, kind: &str) -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures")
        .join(name);
    let mut value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture"))
            .expect("it parses");
    value["kind"] = serde_json::Value::String(kind.into());
    value
}

#[test]
fn a_panorama_recipe_is_read_as_the_panorama_arm() {
    let recipe: CompositeRecipe =
        serde_json::from_value(tagged("panorama-recipe.json", "panorama"))
            .expect("a tagged panorama parses");
    assert!(matches!(recipe, CompositeRecipe::Panorama(_)));
}

#[test]
fn an_assembly_recipe_is_read_as_the_assembly_arm_with_its_tiles_intact() {
    let recipe: CompositeRecipe =
        serde_json::from_value(tagged("assembly-recipe.json", "assembly"))
            .expect("a tagged assembly parses");
    match recipe {
        CompositeRecipe::Assembly(assembly) => assert_eq!(assembly.tiles.len(), 2),
        CompositeRecipe::Panorama(_) => panic!("an assembly recipe must not read as a panorama"),
    }
}

/// The tag decides, not the shape: an assembly's fields on a recipe calling itself a panorama are
/// read as a panorama's geometry and its tiles are dropped, which is what stops the two arms being
/// told apart by whichever happens to parse first.
#[test]
fn the_tag_decides_which_arm_and_not_the_fields() {
    let recipe: CompositeRecipe =
        serde_json::from_value(tagged("assembly-recipe.json", "panorama")).expect("it parses");
    assert!(matches!(recipe, CompositeRecipe::Panorama(_)));
}

/// What lets `base`'s levels-and-colour half stay written against `&Composition` whichever arm it
/// was handed.
#[test]
fn composition_answers_the_shared_geometry_of_either_arm() {
    for (name, kind) in [
        ("panorama-recipe.json", "panorama"),
        ("assembly-recipe.json", "assembly"),
    ] {
        let recipe: CompositeRecipe =
            serde_json::from_value(tagged(name, kind)).expect("it parses");
        assert_eq!(recipe.composition().sources.len(), 2, "{name}");
    }
}

/// A recipe with no tag at all is refused rather than guessed at.
#[test]
fn an_untagged_recipe_is_refused() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/panorama-recipe.json");
    let text = std::fs::read_to_string(path).expect("the fixture");
    assert!(serde_json::from_str::<CompositeRecipe>(&text).is_err());
}
