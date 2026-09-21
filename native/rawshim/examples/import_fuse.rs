//! Which bytes of a RAW each pass of an import actually reads.
//!
//! ```text
//! import_fuse <dir-of-raws> [--limit 3] [--skip N] [--out DIR]
//! ```
//!
//! An import reads every file twice: once for the catalogue row (`header::read_path`), then
//! again for the 800px grid tile (`job::run` with one `Source::Embedded` target). What that
//! second read costs is `scripts/bench_import.ts`, which times the product's own pools. What it
//! *reads* is this, and the two answer different halves of the same question.
//!
//! **A map holds whatever is cached, where a timing does not.** Evicting this machine's page
//! cache says nothing about the cache on the far side of a network mount: the first 256KB of a
//! file the NAS has not been asked for in a month costs 32ms and the same file a second later
//! 1.8ms. So this evicts one file, runs one pass, and asks `mincore` which pages that left
//! resident - the byte ranges the pass faulted, which is where the disk had to travel, and the
//! same answer whatever is cached in front of it.
//!
//! It reads what it maps, so point it at fixtures rather than at a corpus something else is
//! about to measure.

use rawshim::{header, job};
use std::path::Path;

/// `grid_rendition_size` and `grid_rendition_quantizer`.
const GRID_SIZE: u32 = 800;
const GRID_QUANTIZER: i32 = 13;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("import_fuse <dir-of-raws> [--limit N] [--skip N] [--out DIR]");
        std::process::exit(2);
    };
    let (mut limit, mut skip) = (3usize, 0usize);
    let mut out_dir = std::env::temp_dir().join("bb-import-fuse");
    while let Some(flag) = args.next() {
        let mut value = || args.next().expect("that flag takes a value");
        match flag.as_str() {
            "--limit" => limit = value().parse().expect("--limit is a count"),
            "--skip" => skip = value().parse().expect("--skip is a count"),
            "--out" => out_dir = std::path::PathBuf::from(value()),
            other => panic!("unknown flag {other}"),
        }
    }

    for variant in ["split", "fused"] {
        std::fs::create_dir_all(out_dir.join(variant)).expect("the output directory is writable");
    }
    for raw in raws(&dir, skip, limit) {
        regions(&raw, &out_dir);
    }
}

/// Pass 1, exactly as the scan worker reaches it (`readHeaderFields` -> `bb_read_header`).
fn scan(raw: &str) {
    header::read_path(raw).expect("the header reads");
}

/// Pass 2, exactly as the rendition worker reaches it: one grid target from the camera's JPEG.
fn tile(raw: &str, out_path: &str) {
    job::run(&tile_job(raw, out_path, false)).expect("the tile builds");
}

/// Both of the above out of one open, which is what `Job::header` is for.
fn fused(raw: &str, out_path: &str) {
    let outcome = job::run(&tile_job(raw, out_path, true)).expect("the fused pass runs");
    assert!(outcome.header.is_some(), "a fused pass reports the catalogue's fields");
}

/// The job `processing_service.target` builds for a grid tile, as JSON because that is how it
/// crosses to the worker - the same fields, so nothing here can drift from what an import sends.
fn tile_job(raw: &str, out_path: &str, scan: bool) -> job::Job {
    serde_json::from_str(&format!(
        r#"{{
            "rawFilePath": {raw:?},
            "cameraMatch": "lensAndColour",
            "scan": {scan},
            "denoiseLuminance": 20,
            "denoiseColour": 30,
            "sharpen": 1,
            "defringe": 1,
            "grade": {{ "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 }},
            "targets": [{{
                "rendition": "grid",
                "output": "srgb",
                "outputPath": {out_path:?},
                "size": {GRID_SIZE},
                "source": "embedded",
                "sdrQuantizer": {GRID_QUANTIZER},
                "hdrQuantizer": 32,
                "preset": 6,
                "stillFullChroma": false,
                "sdrFullChroma": false
            }}]
        }}"#
    ))
    .expect("the tile job parses")
}

/// Which bytes of the file each pass reads, which on a cold library is what it costs.
///
/// Each pass runs against an evicted file, so the pages resident afterwards are the ones it
/// faulted, plus whatever readahead came with them - which is the same thing the disk had to
/// travel to.
fn regions(raw: &str, out_dir: &Path) {
    let show = |label: &str| {
        let runs = resident(raw);
        let bytes: usize = runs.iter().map(|(_, len)| len).sum();
        print!("  {label:<8} {:>4} runs, {:>7.2}MB  ", runs.len(), bytes as f64 / 1e6);
        for (at, len) in runs.iter().take(6) {
            print!("[{:.2}MB +{:.2}] ", *at as f64 / 1e6, *len as f64 / 1e6);
        }
        println!("{}", if runs.len() > 6 { "..." } else { "" });
        runs
    };

    println!("{raw}");
    evict(raw);
    scan(raw);
    let after_scan = show("pass 1");

    evict(raw);
    tile(raw, &out(out_dir, "split", raw));
    let after_tile = show("pass 2");

    evict(raw);
    fused(raw, &out(out_dir, "fused", raw));
    show("fused");

    // What pass 2 wants that pass 1 did not already bring in. The rest is the second trip fusing
    // removes; this is the part it would have to make anyway.
    let covered = |at: usize, len: usize| {
        after_scan.iter().any(|(from, size)| at >= *from && at + len <= from + size)
    };
    let fresh: usize =
        after_tile.iter().filter(|(at, len)| !covered(*at, *len)).map(|(_, len)| len).sum();
    println!("  pass 2 reads {:.2}MB pass 1 had not\n", fresh as f64 / 1e6);
}

/// Every run of resident pages in the file, as `(offset, length)` in bytes.
fn resident(path: &str) -> Vec<(usize, usize)> {
    use std::os::fd::AsRawFd;
    const PROT_READ: i32 = 1;
    const MAP_SHARED: i32 = 1;
    const SC_PAGESIZE: i32 = 30;

    let file = std::fs::File::open(path).expect("the file opens");
    let len = file.metadata().expect("the file stats").len() as usize;
    let page = unsafe { sysconf(SC_PAGESIZE) } as usize;
    // Mapping does not fault anything in, and `mincore` reports rather than reads, so asking the
    // question does not change the answer.
    let base =
        unsafe { mmap(std::ptr::null_mut(), len, PROT_READ, MAP_SHARED, file.as_raw_fd(), 0) };
    assert!(base as isize != -1, "could not map {path}");
    let mut pages = vec![0u8; len.div_ceil(page)];
    let status = unsafe { mincore(base, len, pages.as_mut_ptr()) };
    assert_eq!(status, 0, "could not ask which pages of {path} are resident");
    unsafe { munmap(base, len) };

    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (index, here) in pages.iter().enumerate() {
        if here & 1 == 0 {
            continue;
        }
        match runs.last_mut() {
            Some((at, size)) if *at + *size == index * page => *size += page,
            _ => runs.push((index * page, page)),
        }
    }
    runs
}

fn out(dir: &Path, variant: &str, raw: &str) -> String {
    let stem = Path::new(raw).file_stem().expect("a RAW has a name").to_string_lossy().into_owned();
    dir.join(variant).join(format!("{stem}.avif")).to_string_lossy().into_owned()
}

/// The body this is about embeds a full-resolution JPEG beside a small one, and its files are
/// past this. A smaller RAW is a different question.
const SMALLEST_RAW: u64 = 70_000_000;

/// Every large RAW under `dir`, in name order, `limit` of them from `skip` on.
///
/// Sized off the directory entry, which costs a `stat` and reads none of the file.
fn raws(dir: &str, skip: usize, limit: usize) -> Vec<String> {
    let known = ["arw", "cr2", "cr3", "nef", "raf", "rw2", "dng", "orf"];
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .expect("the corpus directory reads")
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let extension = path.extension()?.to_string_lossy().to_lowercase();
            let big = entry.metadata().ok()?.len() >= SMALLEST_RAW;
            (big && known.contains(&extension.as_str())).then(|| path.to_string_lossy().into_owned())
        })
        .collect();
    files.sort();
    files.drain(..skip.min(files.len()));
    files.truncate(limit);
    files
}

unsafe extern "C" {
    fn posix_fadvise(fd: i32, offset: i64, len: i64, advice: i32) -> i32;
    fn mmap(addr: *mut u8, len: usize, prot: i32, flags: i32, fd: i32, offset: i64) -> *mut u8;
    fn munmap(addr: *mut u8, len: usize) -> i32;
    fn mincore(addr: *mut u8, len: usize, vec: *mut u8) -> i32;
    fn sysconf(name: i32) -> i64;
}

/// Drops a file from the page cache, which needs no root where its pages are clean.
fn evict(file: &str) {
    use std::os::fd::AsRawFd;
    const POSIX_FADV_DONTNEED: i32 = 4;
    let Ok(handle) = std::fs::File::open(file) else { return };
    // 0 length means "to the end of the file".
    let status = unsafe { posix_fadvise(handle.as_raw_fd(), 0, 0, POSIX_FADV_DONTNEED) };
    assert_eq!(status, 0, "could not evict {file} from the page cache");
}
