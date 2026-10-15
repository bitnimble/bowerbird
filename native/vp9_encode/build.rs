use std::path::PathBuf;

/// Binds and links the libvpx `get:vpx` built, refusing without it rather than finding another:
/// nothing else is built for `wasm32-wasip1-threads` with the high bit depth this encodes at.
fn main() {
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../rawshim/.vpx");
    let stamp = home.join("bowerbird-pin.json");
    if !stamp.is_file() {
        panic!(
            "{}: no libvpx here. This build links the pinned one:\n\n    bun run get:vpx",
            home.display()
        );
    }
    // A rebuilt tree is a new directory behind the same link, and so a new file here.
    println!("cargo:rerun-if-changed={}", stamp.display());
    println!("cargo:rerun-if-changed=wrapper.h");

    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let sysroot = home.join("sysroot");
    println!(
        "cargo:rustc-link-search=native={}",
        home.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=vpx");
    // By path: the directory beside it holds a libc too, which must not stand in for the one rustc
    // links itself.
    println!(
        "cargo:rustc-link-arg={}",
        sysroot
            .join("lib")
            .join(&target)
            .join("libsetjmp.a")
            .display()
    );

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("--target={target}"))
        .clang_arg(format!("--sysroot={}", sysroot.display()))
        .clang_arg(format!("-isystem{}", home.join("clang-include").display()))
        .clang_arg(format!("-I{}", home.join("include").display()))
        .default_enum_style(bindgen::EnumVariation::NewType {
            is_bitfield: false,
            is_global: false,
        })
        .prepend_enum_name(false)
        // Clang hides every symbol by default for wasm, and bindgen binds no hidden function.
        .clang_arg("-fvisibility=default")
        .allowlist_function("vpx_codec_vp9_cx")
        .allowlist_function("vpx_codec_enc_config_default")
        .allowlist_function("vpx_codec_enc_init_ver")
        .allowlist_function("vpx_codec_control_")
        .allowlist_function("vpx_codec_encode")
        .allowlist_function("vpx_codec_get_cx_data")
        .allowlist_function("vpx_codec_destroy")
        .allowlist_function("vpx_codec_err_to_string")
        .allowlist_function("vpx_img_wrap")
        .allowlist_type("vp8e_enc_control_id")
        .allowlist_var("VPX_ENCODER_ABI_VERSION")
        .allowlist_var("VPX_CODEC_USE_HIGHBITDEPTH")
        .allowlist_var("VPX_DL_REALTIME")
        .allowlist_var("VPX_EFLAG_FORCE_KF")
        .generate()
        .expect("bindgen failed against the pinned libvpx headers");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    bindings
        .write_to_file(out.join("vpx.rs"))
        .expect("the libvpx bindings could not be written");
}
