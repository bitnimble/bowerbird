// Compiles every shader under `slang/` and names each one in `$OUT_DIR/shaders.rs`.
//
// The names carry `OUT_DIR` as `env!` rather than as the path it resolves to, so the generated file
// is the same text in every checkout and a build cache shared between worktrees keys it once.
use std::env;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let compiles = shaders(&out);
    std::fs::write(out.join("shaders.rs"), named(&compiles)).expect("write shaders.rs");
}

/// Every shader the workspace reads, compiled into `$OUT_DIR/wgsl` under the name it is asked for.
fn shaders(out: &Path) -> Vec<Compile> {
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
    // every build, recompiling every shader and everything that reads one.
    println!("cargo:rerun-if-env-changed=BOWERBIRD_SLANGC");
    let slangc = slangc();
    if slangc.exists() {
        println!("cargo:rerun-if-changed={}", slangc.display());
    }

    // **Emptied first, so what is here is what `slang/` says and nothing else.** `OUT_DIR` outlives
    // a build, so a shader that was renamed or deleted would stay behind as a module `shaders.rs`
    // names and no host builds.
    //
    // A missing directory is the first build and nothing else; any other failure leaves exactly the
    // stale file this is here to remove, so it is refused rather than shrugged off.
    for staged in [out.join("wgsl"), out.join("passthrough")] {
        if let Err(e) = std::fs::remove_dir_all(&staged) {
            assert!(
                e.kind() == std::io::ErrorKind::NotFound,
                "{}: {e}\nThe staged shaders could not be cleared, so a renamed or deleted one \
                 would survive into this build.",
                staged.display(),
            );
        }
    }
    std::fs::create_dir_all(out.join("wgsl").join("galosh"))
        .expect("create the staged shader directory");
    std::fs::create_dir_all(out.join("passthrough")).expect("create the staged shader directory");

    let target = |key: &str| env::var(format!("CARGO_CFG_TARGET_{key}")).unwrap_or_default();
    let has_vulkan = target("ARCH") != "wasm32";
    let has_metal = target("VENDOR") == "apple";
    let mut compiles = Vec::new();
    for (from, to) in gather(Path::new("../../slang")) {
        // A file declaring itself a module is one another file imports, not a stage of its own.
        // Compiling it alone would emit a module with no entry point, which is a shader nothing can
        // dispatch and a file no host asks for.
        let source =
            std::fs::read_to_string(&from).unwrap_or_else(|e| panic!("{}: {e}", from.display()));
        if source.lines().any(|line| line.starts_with("module ")) {
            continue;
        }
        // `slang/passthrough` is what WGSL cannot say - today the cooperative matrices a matrix
        // unit is reached through, which no browser exposes - so it is handed to the driver in the
        // driver's own language: SPIR-V for every native target, MSL for the Apple ones wgpu has a
        // Metal backend on, and which of those a machine takes is the adapter's answer
        // (`pmrid::passthrough`).
        //
        // **The fragment differs, and the shader takes it as a define.** A Vulkan cooperative
        // matrix is 16x16 on the parts this was measured on; Metal's `simdgroup_matrix` is 8x8 and
        // nothing else, and slangc refuses any other size by name rather than emitting something
        // slower.
        match to.strip_prefix("passthrough/") {
            Some(name) => {
                let at =
                    |extension: &str| format!("passthrough/{}", name.replace(".slang", extension));
                if has_vulkan {
                    compiles.push(Compile {
                        from: from.clone(),
                        to: at(".spv"),
                        entry_points: Vec::new(),
                        defines: &[],
                    });
                }
                if has_metal {
                    compiles.push(Compile {
                        entry_points: dispatched(&source),
                        from,
                        to: at(".metal"),
                        defines: &["-DFRAGMENT=8"],
                    });
                }
            }
            None => {
                let to = format!("wgsl/{}", to.replace(".slang", ".wgsl"));
                // A shader that leaves its arena's type to the build is compiled holding it in
                // `half` as well, for the host whose matrix units read that arena in place.
                if source.lines().any(|line| line == "#ifndef STORED") {
                    compiles.push(Compile {
                        from: from.clone(),
                        to: to.replace(".wgsl", "_half.wgsl"),
                        entry_points: Vec::new(),
                        defines: &["-DSTORED=half"],
                    });
                }
                compiles.push(Compile {
                    from,
                    to,
                    entry_points: Vec::new(),
                    defines: &[],
                });
            }
        }
    }
    compiles.sort_by(|a, b| a.to.cmp(&b.to));

    let next = AtomicUsize::new(0);
    let jobs = env::var("NUM_JOBS")
        .ok()
        .and_then(|it| it.parse().ok())
        .unwrap_or(1);
    std::thread::scope(|scope| {
        for _ in 0..jobs {
            scope.spawn(|| {
                while let Some(it) = compiles.get(next.fetch_add(1, Ordering::Relaxed)) {
                    compile(
                        &slangc,
                        &it.from,
                        &out.join(&it.to),
                        &it.entry_points,
                        it.defines,
                    );
                }
            });
        }
    });
    compiles
}

struct Compile {
    from: PathBuf,
    /// Relative to `OUT_DIR`, with `/`.
    to: String,
    entry_points: Vec<String>,
    defines: &'static [&'static str],
}

/// `shaders.rs`: a `Module` constant per WGSL file, in a module per directory, `ALL` listing them,
/// and the passthrough kernels as their bytes or text.
fn named(compiles: &[Compile]) -> String {
    let include = |macro_name: &str, to: &str| {
        format!("{macro_name}!(concat!(env!(\"OUT_DIR\"), \"/{to}\"))")
    };
    let constant = |to: &str| {
        let file = to.rsplit('/').next().expect("a file name");
        file.replace('.', "_").to_ascii_uppercase()
    };
    let mut top = String::new();
    let mut galosh = String::new();
    let mut passthrough = String::new();
    let mut all = String::new();
    for it in compiles {
        if let Some(path) = it.to.strip_prefix("wgsl/") {
            let name = constant(path).trim_end_matches("_WGSL").to_string();
            let into = match path.starts_with("galosh/") {
                true => &mut galosh,
                false => &mut top,
            };
            writeln!(
                into,
                "pub const {name}: Module = Module {{ path: {path:?}, source: {} }};",
                include("include_str", &it.to)
            )
            .unwrap();
            let named = match path.starts_with("galosh/") {
                true => format!("galosh::{name}"),
                false => name,
            };
            writeln!(all, "    {named},").unwrap();
        } else {
            let (kind, macro_name) = match it.to.ends_with(".spv") {
                true => ("&[u8]", "include_bytes"),
                false => ("&str", "include_str"),
            };
            writeln!(
                passthrough,
                "    pub const {}: {kind} = {};",
                constant(&it.to),
                include(macro_name, &it.to)
            )
            .unwrap();
        }
    }
    let galosh = galosh
        .lines()
        .map(|line| format!("    {}\n", line.replace("Module", "super::Module")))
        .collect::<String>();
    format!(
        "{top}\npub mod galosh {{\n{galosh}}}\n\npub mod passthrough {{\n{passthrough}}}\n\n\
         pub const ALL: &[Module] = &[\n{all}];\n"
    )
}

/// The pinned compiler, the one an environment names, or whatever is on `PATH`.
///
/// `PATH` is searched here rather than left to the shell so that the answer is a path this script
/// can watch and report. The bare name at the end is the one that does not exist, and it is kept
/// only so the failure names what it looked for.
fn slangc() -> PathBuf {
    let binary = if cfg!(windows) {
        "slangc.exe"
    } else {
        "slangc"
    };
    env::var("BOWERBIRD_SLANGC")
        .map(PathBuf::from)
        .ok()
        .filter(|it| it.exists())
        .or_else(|| Some(Path::new("../rawshim/.slangc").join(binary)).filter(|it| it.exists()))
        .or_else(|| {
            env::split_paths(&env::var_os("PATH")?)
                .map(|at| at.join(binary))
                .find(|it| it.exists())
        })
        .unwrap_or_else(|| PathBuf::from(binary))
}

/// Shader files under `root`, each with the path it keeps relative to it.
fn gather(root: &Path) -> Vec<(PathBuf, String)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return found;
    };
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

/// The entry points a rendition dispatches: the `separable_<rows>`, `pointwise_<rows>` and
/// `upsample_<rows>` each `DISPATCHED(<rows>)` line of the shader declares.
///
/// Only these reach the Metal artefact. Metal compiles a library from the source it is handed when
/// the device opens, so the sweep's fifty other shapes would be fifty kernels compiled on the way
/// to the six that run.
fn dispatched(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|line| line.strip_prefix("DISPATCHED(")?.strip_suffix(')'))
        .flat_map(|rows| {
            ["separable", "pointwise", "upsample"].map(|kernel| format!("{kernel}_{rows}"))
        })
        .collect()
}

/// One Slang module to the WGSL both hosts read, or to what a driver is handed as it stands.
///
/// Refused rather than skipped when the compiler is missing: a build that quietly left a stage out
/// would fail at the first tick with a missing entry point, which names neither the shader nor the
/// reason.
fn compile(slangc: &Path, from: &Path, to: &Path, entry_points: &[String], defines: &[&str]) {
    let mut command = Command::new(slangc);
    match to.extension().and_then(|it| it.to_str()) {
        Some("spv") => {
            command
                .arg("-target")
                .arg("spirv")
                .arg("-capability")
                .arg("spvCooperativeMatrixKHR");
        }
        Some("metal") => {
            command.arg("-target").arg("metal");
        }
        _ => {
            command.arg("-target").arg("wgsl");
        }
    }
    command.args(defines);
    for entry in entry_points {
        command
            .arg("-entry")
            .arg(entry)
            .arg("-stage")
            .arg("compute");
    }
    let run = command.arg(from).arg("-o").arg(to).output();
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
    if to.extension().and_then(|it| it.to_str()) == Some("wgsl") {
        refuse_multiplies_by_three(from, to);
    }
}

/// Every integer times three in a stage, which `slang/times.slang` says no shader may hold: no
/// desktop adapter miscomputes one, so nothing but this would notice.
fn refuse_multiplies_by_three(from: &Path, wgsl: &Path) {
    let source =
        std::fs::read_to_string(wgsl).unwrap_or_else(|e| panic!("{}: {e}", wgsl.display()));
    let offenders: Vec<String> = source
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let packed: String = line.chars().filter(|c| !c.is_whitespace()).collect();
            ["*u32(3)", "*i32(3)", "u32(3)*", "i32(3)*"]
                .iter()
                .any(|spelled| packed.contains(spelled))
        })
        .map(|(at, line)| format!("  line {}: {}", at + 1, line.trim()))
        .collect();
    assert!(
        offenders.is_empty(),
        "{} multiplies an integer by three, which Adreno truncates past 2^24. A place or count in a \
         plane is `wide * 3` with a `px.slang` `Wide`, anything else `times(x, 3)` \
         (`slang/times.slang`):\n{}",
        from.display(),
        offenders.join("\n"),
    );
}
