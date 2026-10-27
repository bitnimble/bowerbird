use std::env;
use std::path::PathBuf;

/// The denoisers' weights, which `src/pmrid.rs` and `src/upscale.rs` embed from rawshim's pinned
/// links, where every getter puts its tree.
///
/// Named here so that a tree without them fails at the build saying which command fetches them,
/// rather than at an `include_bytes!` pointing at a path nobody has heard of. The same reasoning as
/// the compiler and the codecs: what a photograph looks like is not allowed to depend on which
/// files happen to be beside the binary.
fn main() {
    let rawshim = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../rawshim");
    for network in [".pmrid", ".upscaler"] {
        for name in ["weights.bin", "weights.json"] {
            let at = rawshim.join(network).join(name);
            println!("cargo:rerun-if-changed={}", at.display());
            assert!(
                at.exists(),
                "{}: missing. `bun run get:models` fetches the denoisers' weights.",
                at.display(),
            );
        }
    }
}
