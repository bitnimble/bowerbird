//! Every snapshot that moved, drawn before | after | difference, as an SDR PNG anything can open.
//!
//! ```text
//! snapshot_diff [--against <rev> | --before <dir>] [name...]
//! ```
//!
//! Before is the snapshot at `<rev>` (HEAD by default), or `<dir>/<name>.png` for a picture no
//! revision holds yet; after is the working tree's. With no names, every snapshot that differs from
//! `<rev>` or is new since it. Writes under `$TMPDIR/bowerbird-snapshots/` and prints each path
//! with how far it moved.

use rawshim::snapshot::{self, Snapshot};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SNAPSHOTS: &str = "test/fixtures/snapshots";

fn main() {
    let mut rev = "HEAD".to_string();
    let mut before_dir: Option<PathBuf> = None;
    let mut names: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--against" => rev = args.next().expect("--against <rev>"),
            "--before" => before_dir = Some(PathBuf::from(args.next().expect("--before <dir>"))),
            _ => names.push(arg.trim_end_matches(".png").to_string()),
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    if names.is_empty() {
        names = changed(&root, &rev);
    }
    if names.is_empty() {
        eprintln!("no snapshot differs from {rev}");
        return;
    }

    for name in names {
        let relative = format!("{SNAPSHOTS}/{name}.png");
        let Ok(bytes) = std::fs::read(root.join(&relative)) else {
            println!("{name}: deleted since {rev}");
            continue;
        };
        let after = Snapshot::decode(&bytes).unwrap_or_else(|e| panic!("{relative}: {e}"));
        let held = match &before_dir {
            Some(dir) => std::fs::read(dir.join(format!("{name}.png"))).ok(),
            None => committed(&root, &rev, &relative),
        };
        let before = held.map(|bytes| {
            Snapshot::decode(&bytes).unwrap_or_else(|e| panic!("{rev}:{relative}: {e}"))
        });

        let out: PathBuf = snapshot::scratch().join(format!("{name}.diff.png"));
        std::fs::create_dir_all(out.parent().expect("a directory")).expect("the scratch directory");
        std::fs::write(&out, snapshot::side_by_side_png(before.as_ref(), &after)).expect("writes");

        let moved = match &before {
            None => "new".to_string(),
            Some(before) => match snapshot::drift(before, &after) {
                Some(d) => format!("worst {} codes at {:?}, mean {:.3}", d.worst, d.at, d.mean),
                None => format!(
                    "{}x{} {:?} -> {}x{} {:?}",
                    before.width,
                    before.height,
                    before.coding,
                    after.width,
                    after.height,
                    after.coding
                ),
            },
        };
        println!("{name}: {moved}\n  {}", out.display());
    }
}

/// Snapshot names differing from `rev`, tracked or not.
fn changed(root: &Path, rev: &str) -> Vec<String> {
    let tracked = git(root, &["diff", "--name-only", rev, "--", SNAPSHOTS]);
    let untracked = git(
        root,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            SNAPSHOTS,
        ],
    );
    let listed = String::from_utf8(tracked.into_iter().chain(untracked).collect()).expect("paths");
    let mut names: Vec<String> = listed
        .lines()
        .filter_map(|path| {
            path.strip_prefix(&format!("{SNAPSHOTS}/"))?
                .strip_suffix(".png")
        })
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The picture at `rev`, through LFS where it is a pointer there.
fn committed(root: &Path, rev: &str, relative: &str) -> Option<Vec<u8>> {
    let shown = Command::new("git")
        .current_dir(root)
        .args(["show", &format!("{rev}:{relative}")])
        .stderr(Stdio::null())
        .output()
        .expect("git runs");
    if !shown.status.success() {
        return None;
    }
    if !shown.stdout.starts_with(b"version https://git-lfs") {
        return Some(shown.stdout);
    }
    let mut smudge = Command::new("git")
        .current_dir(root)
        .args(["lfs", "smudge", "--", relative])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("git lfs runs");
    std::io::Write::write_all(&mut smudge.stdin.take().expect("stdin"), &shown.stdout)
        .expect("the pointer reaches git lfs");
    let smudged = smudge.wait_with_output().expect("git lfs smudge");
    assert!(
        smudged.status.success(),
        "git lfs smudge failed for {rev}:{relative}"
    );
    Some(smudged.stdout)
}

fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let out = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&out.stderr)
    );
    out.stdout
}
