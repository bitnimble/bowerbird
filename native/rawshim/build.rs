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
    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-changed=wrapper_client.h");
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");

    let source = match env::var("CARGO_FEATURE_RENDITIONS").is_ok() {
        true => server_bindings().to_string(),
        false => editor_bindings().to_string(),
    };

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let path = out.join("libraw.rs");
    std::fs::write(&path, source).expect("write bindings");

    // Bindings with types but no functions compile, and then fail at every call site with
    // "cannot find function libraw_init". libclang will do exactly that - silently, with
    // no diagnostic - if anything upstream of the declarations upsets it, so the only
    // reliable check is to look at what came out.
    let written = std::fs::read_to_string(&path).expect("read back the bindings");
    assert!(
        written.contains("pub fn libraw_init"),
        "bindgen wrote {} bytes to {} and none of them declare libraw_init - the header \
         parsed but its prototypes did not survive",
        written.len(),
        path.display(),
    );
}

fn libraw_functions(builder: bindgen::Builder) -> bindgen::Builder {
    builder
        .allowlist_type("libraw_data_t")
        .allowlist_type("libraw_processed_image_t")
        .allowlist_function("libraw_init")
        .allowlist_function("libraw_open_file")
        // Not the server's alone: the desktop and mobile shells fetch the RAW from the
        // library over the network and open it from memory, which is the whole of
        // `edit::prepare_bytes` and so the whole of their editor.
        .allowlist_function("libraw_open_buffer")
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
    println!("cargo:rustc-link-lib=raw");
    println!("cargo:rustc-link-lib=lensfun");
    // The library avifenc is a thin wrapper around. Linking it means the still's
    // encode stops being two child processes with the whole frame passed between
    // them, and becomes a pointer.
    println!("cargo:rustc-link-lib=avif");

    avif_functions(libraw_functions(bindgen::Builder::default().header("wrapper.h")))
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

/// LibRaw alone, for a build without the `renditions` feature.
///
/// Same headers and the same allowlist as the server's, minus lensfun and libavif -
/// `wrapper_client.h` includes only libraw.h, so nothing else can leak in through a
/// transitive include.
fn editor_bindings() -> bindgen::Bindings {
    // Where a cross build put LibRaw, emitted here rather than passed as rustflags: the
    // Android build sets `CARGO_TARGET_<triple>_RUSTFLAGS` for its own linker arguments
    // and overwrites anything already there, where a build script's directives are merged.
    // The same reason `static` is a knob - an APK ships no Termux prefix to resolve a
    // `.so` against, so the archive has to go in the binary.
    println!("cargo:rerun-if-env-changed=RAWSHIM_LIBRAW_DIR");
    println!("cargo:rerun-if-env-changed=RAWSHIM_LIBRAW_STATIC");
    if let Ok(dir) = env::var("RAWSHIM_LIBRAW_DIR") {
        println!("cargo:rustc-link-search=native={dir}");
    }
    if !env::var("RAWSHIM_LIBRAW_STATIC").is_ok() {
        println!("cargo:rustc-link-lib=raw");
    } else {
        println!("cargo:rustc-link-lib=static=raw");

        // What the archive leaves undefined, which is not the same on the two targets that
        // ask for it. Termux builds LibRaw `--disable-jpeg --disable-lcms`, so `-lraw` alone
        // resolves; MacPorts builds it with both, leaving 17 `_jpeg_*` and `_cms*` symbols
        // that only the matching archives answer. Nothing references `_jas_*` on either,
        // despite `pkg-config --static` listing jasper, so it is not linked.
        //
        // And LibRaw is C++, which a static archive brings none of the runtime for: the NDK
        // ships that as a shared `libc++_shared.so` an APK carries, where macOS has it as a
        // system library.
        let target = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        if target == "macos" || target == "ios" {
            println!("cargo:rustc-link-lib=static=jpeg");
            println!("cargo:rustc-link-lib=static=lcms2");
            println!("cargo:rustc-link-lib=static=z");
            println!("cargo:rustc-link-lib=c++");
        } else {
            println!("cargo:rustc-link-lib=c++_shared");
        }
    }

    libraw_functions(bindgen::Builder::default().header("wrapper_client.h"))
        .clang_args(["-x", "c"])
        .generate()
        .expect("bindgen failed against the installed LibRaw headers")
}
