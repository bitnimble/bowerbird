// Generates the LibRaw bindings from the installed headers at build time.
//
// This is the point of the whole exercise: field offsets come from the same
// headers the runtime library was built from, so `params.half_size` resolves the
// way a C compiler resolves it and no offset appears anywhere in the source.
//
// **Two targets now.** The server build binds LibRaw, lensfun and libavif against the
// system headers and links the system libraries. The wasm build (`--target
// wasm32-unknown-unknown`) binds LibRaw alone, against the source tree
// `native/toolchain/build_libraw_wasm.sh` fetched, and links the static archive that
// script produced - so the browser runs this decode rather than a second one written to
// avoid it. lensfun, libavif and libvips are not on the client path at all: they are
// geometry, encoding and resizing, none of which a live editor does.
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-changed=wrapper_client.h");
    // Which libclang bindgen loads decides whether the wasm bindings come out with
    // functions in them, so a change to it has to invalidate the cache.
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");

    let wasm = env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32");
    let source = match wasm {
        true => client_source(),
        false => server_bindings().to_string(),
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
    // libclang reports no calling convention for wasm32 targets, and bindgen skips any
    // function whose ABI it cannot name - silently, so the bindings come out full of
    // types with not one `extern "C"` block in them. Naming it here is what puts the
    // functions back.
    builder
        .allowlist_type("libraw_data_t")
        .allowlist_type("libraw_processed_image_t")
        .allowlist_function("libraw_init")
        .allowlist_function("libraw_open_file")
        // The browser has no filesystem, so the client opens the RAW as bytes. Bound on
        // both targets rather than gated: one binding surface is easier to reason about
        // than two, and an unused extern costs nothing.
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

fn server_bindings() -> bindgen::Bindings {
    println!("cargo:rustc-link-lib=raw");
    println!("cargo:rustc-link-lib=lensfun");
    // The library avifenc is a thin wrapper around. Linking it means the still's
    // encode stops being two child processes with the whole frame passed between
    // them, and becomes a pointer.
    println!("cargo:rustc-link-lib=avif");

    libraw_functions(bindgen::Builder::default().header("wrapper.h"))
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
        .generate()
        .expect("bindgen failed against the installed LibRaw headers")
}

/// The wasm bindings: struct layouts from one bindgen run, function signatures from
/// another.
///
/// **Two runs because bindgen emits no functions at all for a wasm target here.**
///
/// Measured rather than looked up, and deliberately not attributed to a ticket - the
/// obvious candidates (rust-bindgen#1681, #1941) are respectively long closed and about
/// emscripten, so whatever this is, it is not those. The experiment is a header
/// containing one line, `int probe(int);`, with only the target changed: `pub fn probe`
/// under x86_64, an empty 55-byte file under wasm32. Holds across bindgen 0.69 and 0.72,
/// libclang 18 and 22, and with `override_abi(Abi::C, ".*")` set.
///
/// Types come through either way, so the failure surfaces only as "cannot find function
/// libraw_init" at every call site, with nothing in the build log. Worth re-testing on a
/// newer toolchain: if a plain wasm32 run starts emitting functions, this whole split
/// collapses back to one call.
///
/// Splitting it is sound because the two halves need different things. A struct's layout
/// is target-specific - pointer width and alignment decide every offset - so it has to
/// come from the wasm32 run. A function's *Rust signature* is not: `*mut libraw_data_t`,
/// `c_int` and `usize` spell the same either way, and the ABI is C on both. So the host
/// run supplies the `extern "C"` blocks and nothing else.
fn client_source() -> String {
    let layouts = client_bindings().to_string();
    let host = host_signatures().to_string();

    let externs: String = host
        .split("unsafe extern \"C\" {")
        .skip(1)
        .map(|block| match block.find("\n}") {
            Some(end) => format!("unsafe extern \"C\" {{{}\n}}\n", &block[..end]),
            None => String::new(),
        })
        .collect();

    assert!(
        externs.contains("pub fn libraw_init"),
        "the host bindgen run produced no libraw_init to lift signatures from",
    );
    format!("{layouts}\n{externs}")
}

/// The same headers read as the host reads them, purely for the `extern "C"` blocks.
///
/// No sysroot and no target override: this is the configuration the server build uses,
/// which is the one known to emit functions at all.
fn host_signatures() -> bindgen::Bindings {
    // Named explicitly: bindgen defaults the target to cargo's `TARGET`, which is wasm32
    // here - the very thing this run exists to avoid - and a wasm target carries no
    // default include path, so it cannot even find libraw.h.
    let host = env::var("HOST").expect("HOST");
    libraw_functions(bindgen::Builder::default().header("wrapper_client.h"))
        .clang_args(["-x", "c"])
        .clang_arg(format!("--target={host}"))
        .generate()
        .expect("bindgen failed to read the installed LibRaw headers on the host")
}

fn client_bindings() -> bindgen::Bindings {
    let toolchain = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("../toolchain")
        .canonicalize()
        .expect("native/toolchain is missing - run native/toolchain/build_libraw_wasm.sh");
    let source = toolchain.join("LibRaw-0.21.2");
    let sysroot = toolchain.join("wasi-sdk-33.0-x86_64-linux/share/wasi-sysroot");
    let archive = toolchain.join("wasm");

    for needed in [&source, &sysroot, &archive.join("libraw.a")] {
        assert!(needed.exists(), "{} is missing - run native/toolchain/build_libraw_wasm.sh", needed.display());
    }

    println!("cargo:rustc-link-search=native={}", archive.display());
    // `eh`, not `noeh`: LibRaw signals its errors by throwing, so the archive is built
    // with `-fwasm-exceptions` and needs the matching C++ runtime.
    let libs = sysroot.join("lib/wasm32-wasip1");
    println!("cargo:rustc-link-search=native={}", libs.join("eh").display());
    println!("cargo:rustc-link-search=native={}", libs.display());
    println!("cargo:rustc-link-lib=static=raw");
    println!("cargo:rustc-link-lib=static=c++");
    println!("cargo:rustc-link-lib=static=c++abi");
    // `_Unwind_CallPersonality` and the landing-pad context, which the throw sites in
    // LibRaw's decoders reference.
    println!("cargo:rustc-link-lib=static=unwind");
    // LibRaw is C++ and reaches for std::vector, memcpy and malloc. wasi-libc supplies
    // them; `lib.rs` routes Rust's allocations through the same malloc so there is one
    // heap in the linear memory rather than two fighting over it.
    println!("cargo:rustc-link-lib=static=c");

    // **wasi-libc's headers, reached through wasi-sdk's own resource directory.**
    //
    // The libc is musl - wasi-libc is a fork of it with the syscalls swapped for WASI -
    // which is what makes this viable at all: glibc's headers cannot be read under a
    // 32-bit wasm target, because `gnu/stubs.h` demands a `gnu/stubs-32.h` that no
    // 64-bit install ships. musl has no such split.
    //
    // `-resource-dir` rather than `-I`, and wasi-sdk's rather than the host libclang's.
    // Both mistakes fail the same way and neither says so: the builtin `stdint.h` is a
    // stub that `#include_next`s the real one, so a wrong resource directory leaves
    // `uint8_t` undefined inside libraw_types.h. That is an ordinary error rather than a
    // fatal one, so clang recovers, emits every struct, and silently discards every
    // declaration after it - producing bindings full of types and no functions, which
    // compile and then fail at each call site with "cannot find function libraw_init".
    // The assertion in `main` is there to turn that into a build failure.
    let _ = &source;
    libraw_functions(
        bindgen::Builder::default()
            .header("wrapper_client.h")
            // C, not C++, and not by preference: `libraw_datastream.h` includes <fstream>
            // unconditionally, and wasi's libc++ ships no <fstream> because there is no
            // filesystem to stream to. Under C that header is behind `#ifdef __cplusplus`
            // and never reached.
            .clang_args(["-x", "c"])
            .clang_arg("--target=wasm32-wasip1")
            .clang_arg(format!("--sysroot={}", sysroot.display()))
            .clang_arg(format!(
                "-resource-dir={}",
                toolchain.join("wasi-sdk-33.0-x86_64-linux/lib/clang/22").display()
            ))
            // A directory holding only a `libraw/` symlink to the installed public
            // headers. `-I/usr/include` would find LibRaw and then drag glibc in beside
            // the sysroot that is meant to be replacing it.
            .clang_arg(format!("-I{}", toolchain.join("include").display())),
    )
    .generate()
    .expect("bindgen failed against the installed LibRaw headers for wasm32")
}
