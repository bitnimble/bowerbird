// Generates the LibRaw bindings from the installed headers at build time.
//
// This is the point of the whole exercise: field offsets come from the same
// headers the runtime library was built from, so `params.half_size` resolves the
// way a C compiler resolves it and no offset appears anywhere in the source.
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rustc-link-lib=raw");
    println!("cargo:rustc-link-lib=lensfun");
    // The library avifenc is a thin wrapper around. Linking it means the still's
    // encode stops being two child processes with the whole frame passed between
    // them, and becomes a pointer.
    println!("cargo:rustc-link-lib=avif");
    println!("cargo:rerun-if-changed=wrapper.h");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
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
        .allowlist_type("libraw_data_t")
        .allowlist_type("libraw_processed_image_t")
        .allowlist_function("libraw_init")
        .allowlist_function("libraw_open_file")
        .allowlist_function("libraw_unpack")
        .allowlist_function("libraw_adjust_sizes_info_only")
        .allowlist_function("libraw_unpack_thumb")
        .allowlist_function("libraw_dcraw_make_mem_thumb")
        .allowlist_function("libraw_dcraw_process")
        .allowlist_function("libraw_dcraw_make_mem_image")
        .allowlist_function("libraw_dcraw_clear_mem")
        .allowlist_function("libraw_recycle")
        .allowlist_function("libraw_close")
        .allowlist_type("avifImage")
        .allowlist_type("avifRGBImage")
        .allowlist_type("avifEncoder")
        .allowlist_function("avifImageCreate")
        .allowlist_function("avifImageDestroy")
        .allowlist_function("avifRGBImageSetDefaults")
        .allowlist_function("avifImageRGBToYUV")
        .allowlist_function("avifEncoderCreate")
        .allowlist_function("avifEncoderDestroy")
        .allowlist_function("avifEncoderWrite")
        .allowlist_function("avifRWDataFree")
        .allowlist_function("avifResultToString")
        .layout_tests(false)
        .generate()
        .expect("bindgen failed against the installed LibRaw headers");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    bindings.write_to_file(out.join("libraw.rs")).expect("write bindings");
}
