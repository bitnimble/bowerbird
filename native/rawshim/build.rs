// Generates the LibRaw bindings from the installed headers at build time.
//
// This is the point of the whole exercise: field offsets come from the same
// headers the runtime library was built from, so `params.half_size` resolves the
// way a C compiler resolves it and no offset appears anywhere in the source.
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rustc-link-lib=raw");
    println!("cargo:rerun-if-changed=wrapper.h");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
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
        .layout_tests(false)
        .generate()
        .expect("bindgen failed against the installed LibRaw headers");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    bindings.write_to_file(out.join("libraw.rs")).expect("write bindings");
}
