// Generates the lensfun and libavif bindings from the installed headers at build time, so that
// field offsets come from the same headers the runtime libraries were built from and no offset
// appears anywhere in the source.
//
// Only a `renditions` build has any: the RAWs are rawler's, which is Rust, and the display
// transform is the client's GPU rather than an AVIF encoder, so the editor's shells link no C at
// all. lensfun is the one with no prebuilt Android build anywhere, and that is what this buys.
use std::env;
use std::path::PathBuf;

fn main() {
    // Every path named here must exist. Cargo cannot stat a missing one, so it treats the script
    // as dirty and re-runs it on every build - which regenerates the bindings, which recompiles the
    // crate, on a tree where nothing changed. `wrapper_client.h` was listed here after it was
    // deleted and cost every native test run two minutes of rebuild.
    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");

    // Only a `renditions` build binds anything now: rawler reads the RAWs, and lensfun and
    // libavif are the server's alone. An editor build links no C at all.
    if env::var("CARGO_FEATURE_RENDITIONS").is_err() {
        return;
    }
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(out.join("bindings.rs"), server_bindings().to_string()).expect("write bindings");
}

/// AVIF, encode and decode, which only a `renditions` build binds.
///
/// It was split out when the editor encoded its own frames and needed the encode half on its
/// own; the editor draws to a canvas now and asks for neither, so the split has one caller
/// left and the whole surface goes to it.
fn avif_functions(builder: bindgen::Builder) -> bindgen::Builder {
    builder
        .allowlist_type("avifImage")
        .allowlist_type("avifRGBImage")
        .allowlist_type("avifEncoder")
        // Every call's return type. Named rather than left to come through a struct
        // field, which is how the server run happened to get it.
        .allowlist_type("avifResult")
        .allowlist_function("avifImageCreate")
        .allowlist_function("avifImageDestroy")
        .allowlist_function("avifRGBImageSetDefaults")
        .allowlist_function("avifImageRGBToYUV")
        .allowlist_function("avifEncoderCreate")
        .allowlist_function("avifEncoderDestroy")
        .allowlist_function("avifEncoderWrite")
        .allowlist_function("avifRWDataFree")
        .allowlist_function("avifResultToString")
        // The decode half reads renditions back for a JPEG download, which is what libvips
        // was kept for.
        .allowlist_type("avifDecoder")
        .allowlist_function("avifImageCreateEmpty")
        .allowlist_function("avifDecoderCreate")
        .allowlist_function("avifDecoderDestroy")
        .allowlist_function("avifDecoderReadMemory")
        .allowlist_function("avifImageYUVToRGB")
}

fn server_bindings() -> bindgen::Bindings {
    println!("cargo:rustc-link-lib=lensfun");
    // The library avifenc is a thin wrapper around. Linking it means the still's
    // encode stops being two child processes with the whole frame passed between
    // them, and becomes a pointer.
    println!("cargo:rustc-link-lib=avif");

    avif_functions(bindgen::Builder::default().header("wrapper.h"))
        // lensfun.h is one header for two languages: under C++ its types are classes
        // with methods, which bindgen renders as an unusable second surface beside
        // the `lf_*` functions. The C half is the flat structs this crate binds.
        .clang_args(["-x", "c"])
        .allowlist_type("lfLens")
        .allowlist_type("lfCamera")
        .allowlist_type("lfDatabase")
        .allowlist_type("lfModifier")
        .allowlist_function("lf_db_.*")
        .allowlist_function("lf_modifier_.*")
        .allowlist_function("lf_free")
        .allowlist_var("LF_SEARCH_LOOSE")
        .allowlist_var("LF_MODIFY_DISTORTION")
        .generate()
        .expect("bindgen failed against the installed lensfun and libavif headers")
}

