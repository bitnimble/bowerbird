//! `wgsl_overrides::READS_OVERRIDES` against the shaders as built: a listed entry point reads every
//! override its module declares, so any subset of them can be handed to it, and an unlisted one
//! reads none, so it is handed nothing.

use naga::compact::{compact, KeepUnused};
use rawshim::wgsl_overrides::{reads_overrides, READS_OVERRIDES};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

fn emitted(dir: PathBuf, under: &str) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
        let entry = entry.expect("a staged shader");
        let name = entry.file_name().to_string_lossy().into_owned();
        let at = if under.is_empty() { name.clone() } else { format!("{under}/{name}") };
        if entry.path().is_dir() {
            found.extend(emitted(entry.path(), &at));
        } else if name.ends_with(".wgsl") {
            found.push(at);
        }
    }
    found
}

fn names(module: &naga::Module) -> BTreeSet<String> {
    module.overrides.iter().filter_map(|(_, it)| it.name.clone()).collect()
}

/// The overrides `entry` reaches: the module cut down to that entry point alone, with everything
/// it does not reach compacted away.
fn read_by(module: &naga::Module, entry: usize) -> BTreeSet<String> {
    let mut alone = module.clone();
    alone.entry_points = vec![module.entry_points[entry].clone()];
    compact(&mut alone, KeepUnused::No);
    names(&alone)
}

#[test]
fn only_listed_entry_points_read_overrides() {
    let root = Path::new(env!("OUT_DIR")).join("wgsl");
    let mut shaders = emitted(root.clone(), "");
    shaders.sort();
    let mut found = Vec::new();
    for shader in &shaders {
        let source = std::fs::read_to_string(root.join(shader)).expect("a staged shader");
        let module = naga::front::wgsl::parse_str(&source)
            .unwrap_or_else(|e| panic!("{shader} does not parse: {}", e.emit_to_string(&source)));
        let declared = names(&module);
        for (at, entry) in module.entry_points.iter().enumerate() {
            let read = read_by(&module, at);
            let listed = reads_overrides(shader, &entry.name);
            if listed && read != declared {
                let unread: Vec<_> = declared.difference(&read).collect();
                found.push(format!("  {shader} `{}` is listed but never reads {unread:?}", entry.name));
            }
            if !listed && !read.is_empty() {
                found.push(format!("  {shader} `{}` reads {read:?} but is not listed", entry.name));
            }
        }
    }
    for (shader, entries) in READS_OVERRIDES {
        if !shaders.iter().any(|it| it == shader) {
            found.push(format!("  {shader} is listed but was not emitted ({entries:?})"));
        }
    }
    assert!(found.is_empty(), "READS_OVERRIDES disagrees with the shaders:\n{}", found.join("\n"));
}
