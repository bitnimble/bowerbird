use std::env;
use std::path::PathBuf;

fn main() {
    let link = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../rawshim/.environments");
    // Newer whenever the link's tree changes: a fresh tree is newly written, and `linkPinned`
    // touches an old one it re-points to. Named only when present: cargo reruns the script on
    // every build for a path it cannot stat.
    let pin = link.join("bowerbird-pin.json");
    if pin.exists() {
        println!("cargo:rerun-if-changed={}", pin.display());
    }
    // The pinned tree, not the link, so worktrees on one pin share a build cache. The link when
    // missing, for `print::Environment::bytes` to name the getter.
    let tree = link.canonicalize().unwrap_or(link);
    println!("cargo:rustc-env=BOWERBIRD_ENVIRONMENTS={}", tree.display());
}
