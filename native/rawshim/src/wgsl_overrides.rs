//! Which entry points read their module's pipeline-overridable constants.
//!
//! WebKit refuses a pipeline handed a constant its entry point never reads, where the spec says to
//! ignore it: a compute pipeline fails as `Compute library failed creation` and names nothing
//! (docs/raw-edit-gpu.md §6.1). So a module's constants go only to the entry points listed here,
//! and `tests/wgsl_overrides.rs` holds this table to what the compiled WGSL actually reads.

/// Per emitted shader, the entry points that read every override the module declares.
pub const READS_OVERRIDES: &[(&str, &[&str])] = &[
    ("assemble.wgsl", &["assemble_rec2020", "assemble_halved", "assemble_thirded"]),
    ("correspond.wgsl", &["correspond"]),
    ("frame.wgsl", &["fs"]),
    ("galosh/lpixel_lh_den_fused.wgsl", &["lpixel_lh_den_fused"]),
    ("galosh/pass12.wgsl", &["pass12"]),
    ("lslcd.wgsl", &["modulate_h", "assemble"]),
    ("rcd.wgsl", &["seed", "green_at_chroma", "chroma_at_chroma", "chroma_at_greens", "assemble"]),
];

pub fn reads_overrides(shader: &str, entry: &str) -> bool {
    READS_OVERRIDES
        .iter()
        .any(|(listed, entries)| *listed == shader && entries.contains(&entry))
}

/// `constants` where `entry` reads them, and none where it does not.
pub fn for_entry<'a>(shader: &str, entry: &str, constants: &'a [(&'a str, f64)]) -> &'a [(&'a str, f64)] {
    if reads_overrides(shader, entry) { constants } else { &[] }
}
