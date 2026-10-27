//! How far a stacking descriptor taken off an Android-sized thumbnail strays from the one the
//! grid tile path takes off the original, and whether the stacks it forms change.
//!
//! ```text
//! thumbnail_descriptors <arw or folder of them>...
//! ```
//!
//! Each RAW's largest embedded JPEG stands in for a phone's original. The thumbnail is that JPEG
//! fitted inside 512px and re-encoded by `vips` at two qualities, bracketing what MediaProvider
//! keeps. Frames are taken in capture order.

use rawshim::decode_rawler::{Preview, upright_preview_jpeg};
use rawshim::stacks::{describe, group, similarity};

const TILE: usize = 800;
const THUMBNAIL: usize = 512;
const QUALITIES: [u8; 2] = [75, 95];
const THRESHOLD: f32 = 0.78;
const WINDOW_SECONDS: i64 = 60;

struct Frame {
    name: String,
    timestamp: i64,
    tile: Vec<u8>,
    thumbnails: Vec<Vec<u8>>,
}

fn main() {
    let gpu = gpu::device().expect("a Vulkan adapter");
    let scratch = std::env::temp_dir().join("bb-thumbnail-descriptors");
    std::fs::create_dir_all(&scratch).expect("scratch dir");
    let mut paths = Vec::new();
    for arg in std::env::args().skip(1) {
        raws_under(std::path::Path::new(&arg), &mut paths);
    }
    let mut frames: Vec<Frame> = paths
        .iter()
        .filter_map(|path| frame(gpu, &scratch, path))
        .collect();
    frames.sort_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.name.cmp(&b.name))
    });
    if frames.is_empty() {
        eprintln!("no frames described; is `vips` on the PATH?");
        std::process::exit(1);
    }
    println!("{} frames", frames.len());

    for (q, quality) in QUALITIES.iter().enumerate() {
        println!("\n== thumbnail q{quality}");
        let mut own: Vec<f32> = frames
            .iter()
            .map(|f| similarity(&f.tile, &f.thumbnails[q]))
            .collect();
        own.sort_by(f32::total_cmp);
        println!(
            "tile vs own thumbnail: min {:.3}  p1 {:.3}  p5 {:.3}  median {:.3}",
            own[0],
            percentile(&own, 0.01),
            percentile(&own, 0.05),
            percentile(&own, 0.5)
        );

        let (mut adjacent, mut flips_thumb, mut flips_mixed) = (0, 0, 0);
        let mut drift: Vec<f32> = Vec::new();
        for pair in frames.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if b.timestamp.saturating_sub(a.timestamp) > WINDOW_SECONDS {
                continue;
            }
            adjacent += 1;
            let tiles = similarity(&a.tile, &b.tile);
            let thumbs = similarity(&a.thumbnails[q], &b.thumbnails[q]);
            let mixed = similarity(&a.tile, &b.thumbnails[q]);
            drift.push((thumbs - tiles).abs().max((mixed - tiles).abs()));
            if (tiles >= THRESHOLD) != (thumbs >= THRESHOLD) {
                flips_thumb += 1;
                println!(
                    "  flip thumb/thumb {} {}: {tiles:.3} -> {thumbs:.3}",
                    a.name, b.name
                );
            }
            if (tiles >= THRESHOLD) != (mixed >= THRESHOLD) {
                flips_mixed += 1;
                println!(
                    "  flip tile/thumb  {} {}: {tiles:.3} -> {mixed:.3}",
                    a.name, b.name
                );
            }
        }
        drift.sort_by(f32::total_cmp);
        println!(
            "adjacent pairs {adjacent}: decision flips at {THRESHOLD}: thumb/thumb {flips_thumb}, tile/thumb {flips_mixed}; score change median {:.3} p95 {:.3} max {:.3}",
            percentile(&drift, 0.5),
            percentile(&drift, 0.95),
            drift.last().copied().unwrap_or(0.0)
        );

        let timestamps: Vec<i64> = frames.iter().map(|f| f.timestamp).collect();
        let stacked = |pick: &dyn Fn(usize, &Frame) -> &[u8]| {
            let descriptors: Vec<u8> = frames
                .iter()
                .enumerate()
                .flat_map(|(i, f)| pick(i, f).to_vec())
                .collect();
            group(&descriptors, &timestamps, THRESHOLD, WINDOW_SECONDS)
        };
        let tiles = stacked(&|_, f| &f.tile);
        let thumbs = stacked(&|_, f| &f.thumbnails[q]);
        let mixed = stacked(&|i, f| {
            if i % 2 == 0 {
                &f.tile
            } else {
                &f.thumbnails[q]
            }
        });
        println!("stacks: {}", summary(&tiles));
        println!(
            "  all thumbnails: {}; same stacks as tiles {}",
            summary(&thumbs),
            agreement(&tiles, &thumbs)
        );
        println!(
            "  alternating:    {}; same stacks as tiles {}",
            summary(&mixed),
            agreement(&tiles, &mixed)
        );
    }
}

fn raws_under(path: &std::path::Path, out: &mut Vec<String>) {
    if path.is_dir() {
        let Ok(entries) = std::fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            raws_under(&entry.path(), out);
        }
    } else if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("arw"))
    {
        out.push(path.to_string_lossy().into_owned());
    }
}

fn frame(gpu: &'static gpu::Gpu, scratch: &std::path::Path, path: &str) -> Option<Frame> {
    let name = std::path::Path::new(path)
        .file_name()?
        .to_string_lossy()
        .into_owned();
    let timestamp = formats::header::read_path(path)?.timestamp;
    let original = upright_preview_jpeg(path, Preview::Largest)?;
    let tile = describe_jpeg(gpu, &original, TILE)?;
    let source = scratch.join(format!("{name}.jpg"));
    std::fs::write(&source, &original).ok()?;
    let thumbnails = QUALITIES
        .iter()
        .map(|quality| {
            let out = scratch.join(format!("{name}.q{quality}.jpg"));
            let made = std::process::Command::new("vips")
                .arg("thumbnail")
                .arg(&source)
                .arg(format!("{}[Q={quality}]", out.display()))
                .arg(THUMBNAIL.to_string())
                .status()
                .ok()?;
            if !made.success() {
                return None;
            }
            describe_jpeg(gpu, &std::fs::read(&out).ok()?, THUMBNAIL)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(Frame {
        name,
        timestamp,
        tile,
        thumbnails,
    })
}

fn describe_jpeg(gpu: &'static gpu::Gpu, jpeg: &[u8], long_edge: usize) -> Option<Vec<u8>> {
    let rgb = formats::jpeg::decode_tile(jpeg, long_edge).ok()?;
    describe(gpu, rgb.as_ref())
}

fn percentile(sorted: &[f32], at: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f32 * at).round() as usize]
}

fn summary(groups: &[i32]) -> String {
    let stacks = groups
        .iter()
        .copied()
        .filter(|g| *g >= 0)
        .max()
        .map_or(0, |g| g + 1);
    let members = groups.iter().filter(|g| **g >= 0).count();
    format!("{stacks} stacks holding {members} photos")
}

/// The share of adjacent pairs both groupings agree are, or are not, in one stack.
fn agreement(a: &[i32], b: &[i32]) -> String {
    let together = |g: &[i32], i: usize| g[i] >= 0 && g[i] == g[i + 1];
    let pairs = a.len().saturating_sub(1);
    let same = (0..pairs)
        .filter(|&i| together(a, i) == together(b, i))
        .count();
    format!("{same}/{pairs} adjacent pairs")
}
