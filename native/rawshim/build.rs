// Generates the libavif and libjxl bindings from the pinned headers so that field offsets come from
// the same headers the libraries were built from and no offset appears anywhere in the source.
//
// Only a `renditions` build has bindings: the RAWs are rawler's, which is Rust, the lens database
// is `lensdb`, which is Rust, and the display transform is the client's GPU rather than an AVIF
// encoder, so the editor's shells link no C at all.
use std::env;
use std::path::{Path, PathBuf};

fn main() {
    // Every path named here must exist. Cargo cannot stat a missing one, so it treats the script
    // as dirty and re-runs it on every build - which regenerates the bindings, which recompiles the
    // crate, on a tree where nothing changed. `wrapper_client.h` was listed here after it was
    // deleted and cost every native test run two minutes of rebuild.
    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    weights();
    environments();

    // Only a `renditions` build binds anything: rawler reads the RAWs, and libavif and libjxl are
    // the server's alone. An editor build links no C at all.
    if env::var("CARGO_FEATURE_RENDITIONS").is_err() {
        return;
    }
    let include = codecs();
    std::fs::write(
        out.join("bindings.rs"),
        server_bindings(&include).to_string(),
    )
    .expect("write bindings");
}

/// The denoisers' weights, which `src/pmrid.rs` and `src/upscale.rs` embed.
///
/// Named here so that a tree without them fails at the build saying which command fetches them,
/// rather than at an `include_bytes!` pointing at a path nobody has heard of. The same reasoning as
/// the compiler and the codecs: what a photograph looks like is not allowed to depend on which
/// files happen to be beside the binary.
fn weights() {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    for network in [".pmrid", ".upscaler"] {
        for name in ["weights.bin", "weights.json"] {
            let at = crate_dir.join(network).join(name);
            println!("cargo:rerun-if-changed={}", at.display());
            assert!(
                at.exists(),
                "{}: missing. `bun run get:models` fetches the denoisers' weights.",
                at.display(),
            );
        }
    }
}

/// The pinned tree `.environments` links to rather than the link, so every worktree on one pin
/// compiles the same library and a build cache can share it. Left as the link when it is missing,
/// for `print::Environment::bytes` to name the getter.
fn environments() {
    let link = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join(".environments");
    // Newer whenever the link's tree changes: a fresh tree is newly written, and `linkPinned`
    // touches an old one it re-points to. Named only when present: cargo reruns the script on
    // every build for a path it cannot stat.
    let pin = link.join("bowerbird-pin.json");
    if pin.exists() {
        println!("cargo:rerun-if-changed={}", pin.display());
    }
    let tree = link.canonicalize().unwrap_or(link);
    println!("cargo:rustc-env=BOWERBIRD_ENVIRONMENTS={}", tree.display());
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
        // The colour conversion is the one call libavif will not thread for us - its header
        // says `maxThreads` "is ignored for RGB to YUV conversion" - so `encode_avif` bands it
        // by hand. A view onto a row band writes into the parent's planes, which have to exist
        // before the first band starts.
        .allowlist_function("avifImageAllocatePlanes")
        .allowlist_function("avifImageSetViewRect")
        .allowlist_function("avifImageSetMetadataExif")
        .allowlist_type("avifCropRect")
        .allowlist_function("avifEncoderCreate")
        .allowlist_function("avifEncoderDestroy")
        .allowlist_function("avifEncoderWrite")
        .allowlist_function("avifEncoderAddImageGrid")
        .allowlist_function("avifEncoderFinish")
        .allowlist_function("avifEncoderSetCodecSpecificOption")
        .allowlist_function("avifRWDataFree")
        .allowlist_function("avifResultToString")
        .allowlist_var("AVIF_DEFAULT_IMAGE_DIMENSION_LIMIT")
        .allowlist_var("AVIF_DEFAULT_IMAGE_SIZE_LIMIT")
        // The decode half reads renditions back for a JPEG download, which is what libvips
        // was kept for.
        .allowlist_type("avifDecoder")
        .allowlist_function("avifImageCreateEmpty")
        .allowlist_function("avifDecoderCreate")
        .allowlist_function("avifDecoderDestroy")
        .allowlist_function("avifDecoderReadMemory")
        // The container alone, for the EXIF an export carries from the rendition it transcodes.
        .allowlist_function("avifDecoderSetIOMemory")
        .allowlist_function("avifDecoderParse")
        .allowlist_function("avifImageYUVToRGB")
        // The gain map beside a picture, which is a second image and the terms that apply it.
        // Stable since 1.2 (`libavif` below is what makes sure this is that).
        .allowlist_type("avifGainMap")
        .allowlist_type("avifImageContentTypeFlag")
        .allowlist_type("avifSignedFraction")
        .allowlist_type("avifUnsignedFraction")
        // And writing one (§10.5). The map itself is libavif's arithmetic rather than ours:
        // handed a base and an alternate it derives the per-pixel ratio and the metadata that
        // states how to undo it, which is the half of ISO 21496-1 worth not reimplementing.
        .allowlist_type("avifDiagnostics")
        .allowlist_function("avifGainMapCreate")
        .allowlist_function("avifGainMapDestroy")
        .allowlist_function("avifRGBImageComputeGainMap")
        .allowlist_function("avifRGBImageAllocatePixels")
        .allowlist_function("avifRGBImageFreePixels")
}

fn server_bindings(include: &Path) -> bindgen::Bindings {
    let builder = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("-I{}", include.display()))
        // A C enum is `int` under MSVC and `unsigned` elsewhere, so a bare constant that
        // type-checks against a `uint32_t` here fails only on Windows. As a newtype, it fails here.
        .default_enum_style(bindgen::EnumVariation::NewType {
            is_bitfield: false,
            is_global: false,
        })
        .prepend_enum_name(false);
    turbojpeg_functions(jxl_functions(avif_functions(builder)))
        .generate()
        .expect("bindgen failed against the pinned libavif, libjxl and libjpeg-turbo headers")
}

/// libjpeg-turbo, which only the grid tile's decode reads through (`jpeg::decode_tile`).
fn turbojpeg_functions(builder: bindgen::Builder) -> bindgen::Builder {
    builder
        .allowlist_function("tj3InitVersion")
        .allowlist_function("tj3Destroy")
        .allowlist_function("tj3GetErrorStr")
        .allowlist_function("tj3Get")
        .allowlist_function("tj3DecompressHeader")
        .allowlist_function("tj3SetScalingFactor")
        .allowlist_function("tj3Decompress8")
        .allowlist_type("TJINIT")
        .allowlist_type("TJPARAM")
        .allowlist_type("TJPF")
        .allowlist_type("TJCS")
        .allowlist_var("TURBOJPEG_VERSION_NUMBER")
}

/// libavif and libjxl, and the six libraries under them, from the tree `get:codecs` built, linked
/// statically; returns the directory their headers are in.
///
/// The link itself is the getter's to work out, from the tree's own `pkgconf`, and this only passes
/// it on: which libraries, in what order, and which are the platform's rather than the tree's -
/// the C++ runtime libjxl and highway need among them, which libjxl's `.pc` names for whichever
/// toolchain built it.
///
/// Refused rather than fallen back to, naming the command that fixes it: the distributions'
/// libavif is too old to read a gain map, and a silent fall-back is a feature quietly absent from
/// a build that looks complete.
fn codecs() -> PathBuf {
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let host = std::env::var("HOST").expect("cargo sets HOST");
    let (name, getter) = if target == host {
        (".codecs".to_string(), "bun run get:codecs".to_string())
    } else {
        (
            format!(".codecs-{target}"),
            format!("bun run get:codecs --target {target}"),
        )
    };
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    let link = home.join("link.txt");
    let lines = std::fs::read_to_string(&link).unwrap_or_else(|_| {
        panic!(
            "{}: no codecs here. This build links the pinned ones:\n\n    {getter}",
            home.display()
        )
    });
    // A rebuilt tree is a new directory behind the same link, and so a new file here.
    println!("cargo:rerun-if-changed={}", link.display());

    let mut include = None;
    for line in lines.lines() {
        match line.split_once(' ') {
            Some(("include", at)) => include = Some(home.join(at)),
            Some(("search", at)) => {
                println!("cargo:rustc-link-search=native={}", home.join(at).display())
            }
            Some(("static", library)) => println!("cargo:rustc-link-lib=static={library}"),
            Some(("dylib", library)) => println!("cargo:rustc-link-lib={library}"),
            _ => panic!(
                "{}: `{line}` is not a line `get:codecs` writes",
                link.display()
            ),
        }
    }
    include.unwrap_or_else(|| panic!("{}: names no include directory", link.display()))
}

/// JPEG XL, which only an export writes.
fn jxl_functions(builder: bindgen::Builder) -> bindgen::Builder {
    builder
        .allowlist_function("JxlEncoder.*")
        .allowlist_function("JxlThreadParallelRunner.*")
        .allowlist_type("JxlEncoderStatus")
        .allowlist_type("JxlBasicInfo")
        .allowlist_type("JxlPixelFormat")
        .allowlist_type("JxlColorEncoding")
}
