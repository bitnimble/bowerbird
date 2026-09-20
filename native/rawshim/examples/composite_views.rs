//! The synthetic views a panorama is composed out of, written where a library can index them.
//!
//! ```text
//! composite_views <dir>
//! ```
//!
//! Six views of one world, swept across 220 degrees and half overlapping - what a person shooting
//! a pan on a normal lens actually does (`composite_scene::wide_rig`). PNGs, so a library indexes them
//! without a RAW decoder and a composite of them needs no camera match: the recipe is stated in
//! the corrected geometry a finished picture is already in.
//!
//! **The wide sweep rather than the two-row rig**, because what opens these in a browser is the
//! editor: a canvas under 4096 has one prepared level and nothing for a reader to zoom into, and
//! this one has a rung below its first. The same scene either way, so a panorama on screen and a
//! panorama under test are looking at the same world.
//!
//! This is what `scripts/dev-panorama.ts` fills a library with.

fn main() {
    let mut args = std::env::args().skip(1);
    let directory = args.next().expect("composite_views <dir>");
    let at = std::path::PathBuf::from(&directory);
    let written = rawshim::composite_scene::views(&at, &rawshim::composite_scene::wide_rig());
    for path in &written {
        println!("{path}");
    }
    eprintln!(
        "{} views of {}x{} in {directory}",
        written.len(),
        rawshim::composite_scene::WIDE,
        rawshim::composite_scene::TALL,
    );
}
