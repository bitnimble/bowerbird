use std::env;
use std::path::PathBuf;

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
