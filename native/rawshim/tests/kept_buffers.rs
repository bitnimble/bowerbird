//! A buffer kept between prepares reads as a fresh one.
//!
//! The editor keeps every buffer a prepare lets go for the next photo's (`gpu::hold_buffers`), and
//! a kept buffer held what its last owner wrote where a fresh one holds zeros - which the camera
//! match's accumulators read. Its own binary because the pool is process-wide.
#![cfg(feature = "fixtures")]

/// The editor's open of a real RAW, and its grade at rest: the header, the frame and the picture.
fn opened(bytes: &[u8]) -> (String, Vec<u16>, Vec<u8>) {
    let gpu = rawshim::gpu::device().expect("an adapter");
    let request: rawshim::edit::EditRequest = serde_json::from_value(serde_json::json!({
        "longEdge": 0,
        "grade": { "referenceWhiteNits": 203.0, "whiteQuantile": 0.99 },
        "defringe": 1.0,
        "denoiseLuminance": 40.0,
        "denoiseColour": 40.0,
        "dust": { "enabled": true, "sensitivity": 0.5, "intensity": 1.0 },
    }))
    .expect("an open request");
    let prepared = rawshim::edit::prepare_bytes(bytes, &request, 0.5).expect("the RAW opens");
    let header = &prepared.header;
    let grade = rawshim::gpu::Grade::new(
        header.width,
        header.height,
        rawshim::tone::Levels {
            white: header.white,
            peak: header.peak,
            floor: header.floor,
        },
        header.grade.reference_white_nits,
        rawshim::gpu::Output::Pq.mastered(header.grade.reference_white_nits),
    );
    let shown = gpu
        .upload(&prepared.samples, &grade, &gpu.scene_peak())
        .encode_bytes(&grade);
    (
        serde_json::to_string(header).expect("the header serialises"),
        prepared.samples,
        shown,
    )
}

#[test]
fn a_reused_buffer_reads_as_a_fresh_one() {
    if rawshim::gpu::device().is_none() {
        eprintln!("SKIPPED: no adapter answered, so nothing here was run.");
        return;
    }
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/DSC02981.ARW");
    let bytes = std::fs::read(path).expect("the fixture reads");

    let fresh = opened(&bytes);
    assert!(
        opened(&bytes) == fresh,
        "two fresh opens disagree, so this compares nothing"
    );

    rawshim::gpu::hold_buffers();
    // The first fills the pool and the second takes its buffers from it, holding the first's.
    opened(&bytes);
    let before = rawshim::gpu::buffers_reused();
    let reused = opened(&bytes);
    let taken = rawshim::gpu::buffers_reused() - before;
    rawshim::gpu::release_buffers();
    assert!(
        taken > 100,
        "the second open took {taken} buffers, so this compares little"
    );

    let fields = |header: &str| -> serde_json::Map<String, serde_json::Value> {
        serde_json::from_str(header).expect("the header parses")
    };
    let (was, now) = (fields(&fresh.0), fields(&reused.0));
    let moved: Vec<_> = was
        .iter()
        .filter(|(name, value)| now.get(*name) != Some(value))
        .map(|(name, value)| match value.as_array() {
            Some(list) if list.len() > 8 => format!("{name} (a list of {})", list.len()),
            _ => format!(
                "{name}: {value} became {}",
                now.get(name).unwrap_or(&serde_json::Value::Null)
            ),
        })
        .collect();
    assert!(
        moved.is_empty(),
        "a kept buffer moved what the open measured: {moved:?}"
    );
    assert!(reused.1 == fresh.1, "a kept buffer moved the frame");
    assert!(
        reused.2 == fresh.2,
        "a kept buffer moved the graded picture"
    );
}
