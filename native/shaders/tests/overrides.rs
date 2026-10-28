//! `overrides::READS_OVERRIDES` against the shaders as built: a listed entry point reads every
//! override its module declares, so any subset of them can be handed to it, and an unlisted one
//! reads none, so it is handed nothing.

use naga::compact::{KeepUnused, compact};
use shaders::overrides::{READS_OVERRIDES, reads_overrides};
use std::collections::BTreeSet;

fn names(module: &naga::Module) -> BTreeSet<String> {
    module
        .overrides
        .iter()
        .filter_map(|(_, it)| it.name.clone())
        .collect()
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
    let mut found = Vec::new();
    for shader in shaders::ALL {
        let (path, source) = (shader.path, shader.source);
        let module = naga::front::wgsl::parse_str(source)
            .unwrap_or_else(|e| panic!("{path} does not parse: {}", e.emit_to_string(source)));
        let declared = names(&module);
        for (at, entry) in module.entry_points.iter().enumerate() {
            let read = read_by(&module, at);
            let listed = reads_overrides(path, &entry.name);
            if listed && read != declared {
                let unread: Vec<_> = declared.difference(&read).collect();
                found.push(format!(
                    "  {path} `{}` is listed but never reads {unread:?}",
                    entry.name
                ));
            }
            if !listed && !read.is_empty() {
                found.push(format!(
                    "  {path} `{}` reads {read:?} but is not listed",
                    entry.name
                ));
            }
        }
    }
    for (path, entries) in READS_OVERRIDES {
        if !shaders::ALL.iter().any(|it| it.path == *path) {
            found.push(format!(
                "  {path} is listed but was not emitted ({entries:?})"
            ));
        }
    }
    assert!(
        found.is_empty(),
        "READS_OVERRIDES disagrees with the shaders:\n{}",
        found.join("\n")
    );
}
