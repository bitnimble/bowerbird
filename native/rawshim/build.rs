// Generates the LibRaw bindings from the installed headers at build time.
//
// This is the point of the whole exercise: field offsets come from the same
// headers the runtime library was built from, so `params.half_size` resolves the
// way a C compiler resolves it and no offset appears anywhere in the source.
//
// **Two shapes, chosen by the `renditions` feature.** With it, the crate binds LibRaw,
// lensfun and libavif and links all three: that is the server, which builds renditions.
// Without it, LibRaw alone - which is everything the editor's open needs, since
// `edit::prepare` reads the lens spline the camera recorded in the RAW itself rather than
// lensfun's database, and the display transform is the client's GPU rather than an AVIF
// encoder. That is what lets the desktop and mobile shells link one C library instead of
// four, and lensfun is the one with no prebuilt Android build anywhere.
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
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let path = out.join("bindings.rs");
    let source = match env::var("CARGO_FEATURE_RENDITIONS").is_ok() {
        true => server_bindings().to_string(),
        false => String::new(),
    };
    std::fs::write(&path, source).expect("write bindings");
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
        .expect("bindgen failed against the installed LibRaw headers")
}

