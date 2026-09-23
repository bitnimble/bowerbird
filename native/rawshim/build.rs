// Compiles the shaders, and generates the libavif and libjxl bindings from the pinned headers so
// that field offsets come from the same headers the libraries were built from and no offset
// appears anywhere in the source.
//
// Only a `renditions` build has bindings: the RAWs are rawler's, which is Rust, the lens database
// is `lensdb`, which is Rust, and the display transform is the client's GPU rather than an AVIF
// encoder, so the editor's shells link no C at all.
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // Every path named here must exist. Cargo cannot stat a missing one, so it treats the script
    // as dirty and re-runs it on every build - which regenerates the bindings, which recompiles the
    // crate, on a tree where nothing changed. `wrapper_client.h` was listed here after it was
    // deleted and cost every native test run two minutes of rebuild.
    println!("cargo:rerun-if-changed=wrapper.h");
    println!("cargo:rerun-if-env-changed=LIBCLANG_PATH");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    shaders(&out);
    weights();

    // Only a `renditions` build binds anything: rawler reads the RAWs, and libavif and libjxl are
    // the server's alone. An editor build links no C at all.
    if env::var("CARGO_FEATURE_RENDITIONS").is_err() {
        return;
    }
    codec_search_path();
    std::fs::write(out.join("bindings.rs"), server_bindings().to_string()).expect("write bindings");
}

/// PMRID's published weights, which `src/pmrid.rs` embeds.
///
/// Named here so that a tree without them fails at the build saying which command fetches them,
/// rather than at an `include_bytes!` pointing at a path nobody has heard of. The same reasoning as
/// the compiler and the codecs: what a photograph looks like is not allowed to depend on which
/// files happen to be beside the binary.
fn weights() {
    let home = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join(".pmrid");
    for name in ["weights.bin", "weights.json"] {
        let at = home.join(name);
        println!("cargo:rerun-if-changed={}", at.display());
        assert!(
            at.exists(),
            "{}: missing. `bun run get:pmrid` unpacks the denoiser's published weights.",
            at.display(),
        );
    }
}

/// Every shader the crate reads, compiled into `$OUT_DIR/wgsl` under the name it is asked for.
///
/// One directory and one extension, so `include_str!` and the tests that read a shader at runtime
/// name a file rather than a compiler.
fn shaders(out: &Path) {
    // **Every file, not the directory holding them.** Cargo stats what it is given, and a
    // directory's mtime does not move when a file inside it is edited - only when one is created,
    // renamed or removed. Naming the directory alone therefore watches for shaders appearing and
    // disappearing and not for any of them *changing*, so an edit to a `.slang` leaves cargo
    // reporting the crate fresh and the previous WGSL compiled into the binary. That is a shader
    // nobody asked for behind a build that looks current: every measurement taken against it is
    // of the code as it was, and it agrees with itself, so nothing about the run looks wrong.
    // The directory is named as well, for the appearing and disappearing.
    println!("cargo:rerun-if-changed=../../slang");
    for (from, _) in gather(Path::new("../../slang")) {
        println!("cargo:rerun-if-changed={}", from.display());
    }

    // **The compiler is an input too.** Emitting any `rerun-if-changed` turns off cargo's default
    // watch-the-whole-package, so without these a `slangc` swapped underneath - by
    // `BOWERBIRD_REFETCH_SLANGC`, or by pointing the variable elsewhere - leaves the previous
    // compiler's output in `OUT_DIR` and cargo reports the crate fresh. That is a shader nobody
    // asked for compiled into a binary that looks current, which is the one failure this file
    // cannot be allowed to have.
    //
    // Named only where it resolves to a real file, which is what `slangc` searches `PATH` for:
    // cargo cannot stat a path that is not there, so it calls the script dirty and reruns it on
    // every build - the two-minute rebuild the header describes, arrived at from the other side.
    println!("cargo:rerun-if-env-changed=BOWERBIRD_SLANGC");
    let slangc = slangc();
    if slangc.exists() {
        println!("cargo:rerun-if-changed={}", slangc.display());
    }

    // **Emptied first, so what is here is what `slang/` says and nothing else.** `OUT_DIR` outlives
    // a build, so a shader that was renamed or deleted stays behind - and `wgsl_call_shapes` walks
    // this directory, so a stale file is a module it tries to parse that no host builds.
    //
    // A missing directory is the first build and nothing else; any other failure leaves exactly the
    // stale file this is here to remove, so it is refused rather than shrugged off.
    let staged = out.join("wgsl");
    if let Err(e) = std::fs::remove_dir_all(&staged) {
        assert!(
            e.kind() == std::io::ErrorKind::NotFound,
            "{}: {e}\nThe staged shaders could not be cleared, so a renamed or deleted one would \
             survive into this build.",
            staged.display(),
        );
    }
    std::fs::create_dir_all(staged.join("galosh")).expect("create the staged shader directory");
    std::fs::create_dir_all(out.join("spirv")).expect("create the staged shader directory");

    for (from, to) in gather(Path::new("../../slang")) {
        // A file declaring itself a module is one another file imports, not a stage of its own.
        // Compiling it alone would emit a module with no entry point, which is a shader nothing can
        // dispatch and a file no host asks for.
        let source = std::fs::read_to_string(&from)
            .unwrap_or_else(|e| panic!("{}: {e}", from.display()));
        if source.lines().any(|line| line.starts_with("module ")) {
            continue;
        }
        // `slang/spirv` is what WGSL cannot say - today the cooperative matrices a tensor core is
        // reached through, which no browser exposes - so it compiles for Vulkan alone and a host
        // that wants it holds a device of its own.
        match to.strip_prefix("spirv/") {
            Some(name) => {
                compile(&slangc, &from, &out.join("spirv").join(name.replace(".slang", ".spv")))
            }
            None => compile(&slangc, &from, &staged.join(to.replace(".slang", ".wgsl"))),
        }
    }
}

/// The pinned compiler, the one an environment names, or whatever is on `PATH`.
///
/// `PATH` is searched here rather than left to the shell so that the answer is a path this script
/// can watch and report. The bare name at the end is the one that does not exist, and it is kept
/// only so the failure names what it looked for.
fn slangc() -> PathBuf {
    let binary = if cfg!(windows) { "slangc.exe" } else { "slangc" };
    env::var("BOWERBIRD_SLANGC")
        .map(PathBuf::from)
        .ok()
        .filter(|it| it.exists())
        .or_else(|| Some(PathBuf::from(".slangc/bin").join(binary)).filter(|it| it.exists()))
        .or_else(|| {
            env::split_paths(&env::var_os("PATH")?).map(|at| at.join(binary)).find(|it| it.exists())
        })
        .unwrap_or_else(|| PathBuf::from(binary))
}

/// Shader files under `root`, each with the path it keeps relative to it.
fn gather(root: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return found };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            for (nested, under) in gather(&path) {
                found.push((nested, format!("{name}/{under}")));
            }
        } else if name.ends_with(".slang") {
            found.push((path, name));
        }
    }
    found
}

/// One Slang module to the WGSL both hosts read.
///
/// Refused rather than skipped when the compiler is missing: a build that quietly left a stage out
/// would fail at the first tick with a missing entry point, which names neither the shader nor the
/// reason.
fn compile(slangc: &Path, from: &Path, to: &Path) {
    let spirv = to.extension().is_some_and(|it| it == "spv");
    let mut command = Command::new(slangc);
    command.arg(from).arg("-target").arg(if spirv { "spirv" } else { "wgsl" });
    if spirv {
        command.arg("-capability").arg("spvCooperativeMatrixKHR");
    }
    let run = command.arg("-o").arg(to).output();
    let run = run.unwrap_or_else(|e| {
        panic!(
            "{}: {e}\nThe Slang compiler is the shaders' toolchain. `bun run get:slangc` fetches \
             the pinned build, or put one on PATH.",
            slangc.display(),
        )
    });
    if !run.status.success() {
        panic!(
            "{} did not compile:\n{}{}",
            from.display(),
            String::from_utf8_lossy(&run.stdout),
            String::from_utf8_lossy(&run.stderr),
        );
    }
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
        .allowlist_type("avifCropRect")
        .allowlist_type("avifPlanesFlag")
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

fn server_bindings() -> bindgen::Bindings {
    // The library avifenc is a thin wrapper around. Linking it means the still's
    // encode stops being two child processes with the whole frame passed between
    // them, and becomes a pointer.
    let avif = libavif();
    let jxl = libjxl();

    let mut builder = bindgen::Builder::default().header("wrapper.h");
    for home in [avif, Some(jxl)].into_iter().flatten() {
        builder = builder.clang_arg(format!("-I{}/include", home.display()));
    }
    jxl_functions(avif_functions(builder))
        .generate()
        .expect("bindgen failed against the pinned libavif and libjxl headers")
}

/// The libavif this build links, which is the pinned one and not the distribution's.
///
/// **The gain map API is why.** It arrived in 1.1 behind a compile flag and settled in 1.2; Ubuntu
/// 24.04 ships 1.0.4 and Debian trixie 1.1.1 with the flag off, so a build against either has no
/// gain map symbols at all - and an AVIF that carries one would decode to its standard-range base
/// on one machine and its full range on another, which is a photograph whose brightness depends on
/// where it was read.
///
/// Refused rather than fallen back to, naming the command that fixes it, for `slangc`'s reason: a
/// silent fall-back is a feature quietly absent from a build that looks complete.
fn libavif() -> Option<PathBuf> {
    println!("cargo:rerun-if-env-changed=BOWERBIRD_LIBAVIF");
    let home = env::var("BOWERBIRD_LIBAVIF")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".libavif"));
    assert!(
        home.join("include/avif/avif.h").exists(),
        "{}: no libavif here.\nThe distribution's is too old to read a gain map, so this build \
         wants the pinned one:\n\n    bun run get:libavif\n\nOr point BOWERBIRD_LIBAVIF at a \
         libavif 1.2 or newer.",
        home.display(),
    );
    // `avif.rs` asks for sharpyuv's chroma solver on every 4:2:0 encode, and a libavif built
    // without it compiles a stub that answers `NOT_IMPLEMENTED` - so a tree from before the flag
    // was asked for builds and links, and then fails every grid tile in a library. The `.pc` names
    // it when the flag took.
    let pc = home.join("lib/pkgconfig/libavif.pc");
    let describes = std::fs::read_to_string(&pc).unwrap_or_default();
    assert!(
        describes.contains("libsharpyuv"),
        "{}: this libavif was built without sharpyuv, and every 4:2:0 encode would fail.\n\n    \
         BOWERBIRD_REBUILD_LIBAVIF=1 bun run get:libavif",
        home.display(),
    );
    // The library itself, not only its header: a rebuilt libavif is a different archive under an
    // unchanged `avif.h`, and without this the crate links yesterday's copy.
    println!("cargo:rerun-if-changed={}", pc.display());
    println!("cargo:rerun-if-changed={}", archive(&home, "avif").display());
    // Static, so nothing has to find this directory again at run time. The codecs underneath it
    // are the system's and stay dynamic, which is what keeps the encoder the one the bench and the
    // fixtures were recorded against.
    println!("cargo:rustc-link-search=native={}/lib", home.display());
    println!("cargo:rustc-link-lib=static=avif");
    for module in ["aom", "dav1d", "libsharpyuv"] {
        link_shared(module);
    }
    println!("cargo:rerun-if-changed={}/include/avif/avif.h", home.display());
    Some(home)
}

/// The libjxl this build links, which is the pinned one for `libavif`'s reason above.
///
/// The distributions ship 0.7, whose encoder predates the API settling in 0.10 and whose defaults
/// produce a visibly different file from the same request - and an export is bytes a reader keeps,
/// so which machine wrote them must not be visible in them.
fn libjxl() -> PathBuf {
    println!("cargo:rerun-if-env-changed=BOWERBIRD_LIBJXL");
    let home = env::var("BOWERBIRD_LIBJXL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".libjxl"));
    assert!(
        home.join("include/jxl/encode.h").exists(),
        "{}: no libjxl here.\nThe distribution's predates the encoder settling, so this build \
         wants the pinned one:\n\n    bun run get:libjxl\n\nOr point BOWERBIRD_LIBJXL at a libjxl \
         0.10 or newer.",
        home.display(),
    );
    println!("cargo:rustc-link-search=native={}/lib", home.display());
    for part in ["jxl", "jxl_threads", "jxl_cms"] {
        println!("cargo:rustc-link-lib=static={part}");
    }
    for module in ["libhwy", "libbrotlienc", "libbrotlidec", "libbrotlicommon", "lcms2"] {
        link_shared(module);
    }
    // libjxl is C++, so whichever standard library the toolchain that built it carries comes with
    // it, and the three targets here do not agree. Apple's clang is libc++ and ships no linkable
    // libstdc++ at all, so asking for one there is a missing-library error rather than a slower
    // path; MSVC's C++ runtime is the linker's own and naming any is an error.
    match (target_os().as_str(), env::var("CARGO_CFG_TARGET_ENV").as_deref()) {
        (_, Ok("msvc")) => {}
        ("macos" | "ios", _) => println!("cargo:rustc-link-lib=c++"),
        _ => println!("cargo:rustc-link-lib=stdc++"),
    }
    println!("cargo:rerun-if-changed={}/include/jxl/encode.h", home.display());
    // The archive too, for the reason libavif's is watched: a rebuilt library under an unchanged
    // header is a link nothing would otherwise redo.
    println!("cargo:rerun-if-changed={}", archive(&home, "jxl").display());
    home
}

/// One package on the link line, under the name that package's own `.pc` gives it.
///
/// **A library's file is named by the platform and its package by the project, and on MSVC the
/// two part ways.** libwebp prefixes every archive with `lib` there to match what its old nmake
/// build produced, so the sharpyuv libavif wants is `libsharpyuv.lib` against `libsharpyuv.so`
/// everywhere else - and `-l sharpyuv` names a file that exists on one of them. The `.pc`
/// carries the same prefix, so asking is the whole of the fix and it costs nothing to ask for
/// the five that were already right.
///
/// No fallback to a name written here: that is the guess this replaces, and a guess that fires
/// silently is how a Windows link came to ask for `sharpyuv.lib` with a correct `.pc` beside it.
fn link_shared(module: &str) {
    let answer = pkg_config(&["--libs-only-l", module]).unwrap_or_else(|| {
        panic!(
            "neither pkg-config nor pkgconf knows {module}, so there is no name to link it by. \
             Install its development package, or add the directory holding {module}.pc to \
             PKG_CONFIG_PATH."
        )
    });
    for name in answer.split_whitespace().filter_map(|it| it.strip_prefix("-l")) {
        println!("cargo:rustc-link-lib={name}");
    }
}

/// `pkg-config`'s answer, from whichever of its two names is installed.
///
/// vcpkg and MSYS2 ship it only as `pkgconf`, so a Windows build that asks for `pkg-config`
/// alone gets no answer at all - `scripts/pinned.ts` tries both for the same reason.
fn pkg_config(args: &[&str]) -> Option<String> {
    ["pkg-config", "pkgconf"].into_iter().find_map(|tool| {
        let done = Command::new(tool).args(args).output().ok()?;
        done.status.success().then(|| String::from_utf8_lossy(&done.stdout).into_owned())
    })
}

/// Where the six libraries under libavif and libjxl are, on a target whose linker does not
/// already know.
///
/// Only Linux's puts them somewhere it already searches. Homebrew's prefix is not in Apple's
/// default, so a macOS link fails with `ld: library 'aom' not found` after everything else
/// succeeded, and vcpkg's tree is in nobody's, where the same failure reads `LNK1104: cannot open
/// file 'aom.lib'`.
fn codec_search_path() {
    vcpkg_search_path();
    for name in ["aom", "dav1d", "libsharpyuv", "libhwy", "libbrotlienc", "lcms2"] {
        let answer = pkg_config(&["--libs-only-L", name]).unwrap_or_default();
        for directory in answer.split_whitespace().filter_map(|it| it.strip_prefix("-L")) {
            println!("cargo:rustc-link-search=native={directory}");
        }
    }
}

/// The same, for the one tree no `pkg-config` on the machine knows how to find.
///
/// Read from vcpkg's own variables rather than one of ours, so the CI step that installs the
/// ports is the only place the triplet is written down.
fn vcpkg_search_path() {
    println!("cargo:rerun-if-env-changed=VCPKG_INSTALLATION_ROOT");
    println!("cargo:rerun-if-env-changed=VCPKG_TARGET_TRIPLET");
    let (Ok(root), Ok(triplet)) =
        (env::var("VCPKG_INSTALLATION_ROOT"), env::var("VCPKG_TARGET_TRIPLET"))
    else {
        return;
    };
    let lib = PathBuf::from(root).join("installed").join(triplet).join("lib");
    assert!(
        lib.is_dir(),
        "{}: VCPKG_TARGET_TRIPLET names a triplet with no installed tree, so the codecs under \
         libavif and libjxl would not be found at the link.",
        lib.display(),
    );
    println!("cargo:rustc-link-search=native={}", lib.display());
}

fn target_os() -> String {
    env::var("CARGO_CFG_TARGET_OS").unwrap_or_default()
}

/// A static library as the target's linker names it on disk.
///
/// Named rather than spelled `lib<name>.a` inline, which is what MSVC does not call it - and a
/// `rerun-if-changed` on a path that does not exist is a build script cargo re-runs on every
/// build, regenerating the bindings and recompiling the crate on a tree where nothing changed.
fn archive(home: &Path, name: &str) -> PathBuf {
    match env::var("CARGO_CFG_TARGET_ENV").as_deref() {
        Ok("msvc") => home.join(format!("lib/{name}.lib")),
        _ => home.join(format!("lib/lib{name}.a")),
    }
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

