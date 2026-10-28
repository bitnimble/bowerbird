//! Which entry points read their module's pipeline-overridable constants.
//!
//! WebKit refuses a pipeline handed a constant its entry point never reads, where the spec says to
//! ignore it: a compute pipeline fails as `Compute library failed creation` and names nothing
//! (docs/raw-edit-gpu.md §6.1). So a module's constants go only to the entry points listed here,
//! and `tests/overrides.rs` holds this table to what the compiled WGSL actually reads.

/// Per emitted shader, the entry points that read every override the module declares.
pub const READS_OVERRIDES: &[(&str, &[&str])] = &[
    (
        "assemble.wgsl",
        &[
            "assemble_rec2020",
            "assemble_blown",
            "assemble_halved",
            "assemble_thirded",
        ],
    ),
    ("correspond.wgsl", &["correspond", "correspond_lanes"]),
    ("frame.wgsl", &["fs"]),
    ("galosh/pyr_pack.wgsl", &["pyr_pack"]),
    ("galosh/pyr_shrink.wgsl", &["pyr_shrink"]),
    ("highlight_field.wgsl", &["field_seed"]),
    ("lslcd.wgsl", &["modulate_h", "assemble"]),
    ("stage.wgsl", &["planar", "planar_masked", "finished"]),
    (
        "rcd.wgsl",
        &[
            "seed",
            "green_at_chroma",
            "chroma_at_chroma",
            "chroma_at_greens",
            "assemble",
        ],
    ),
];

pub fn reads_overrides(shader: &str, entry: &str) -> bool {
    READS_OVERRIDES
        .iter()
        .any(|(listed, entries)| *listed == shader && entries.contains(&entry))
}
