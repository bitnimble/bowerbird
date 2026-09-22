//! Where the lens database is read from.
//!
//! One process reads it once, so each arm of the claim is a process of its own:
//! `the_database_holds_the_lens` is the whole of what a caller can observe, and the two tests
//! below run it again with `BOWERBIRD_LENSFUN_DATA` naming the directory each is about. This
//! process has the variable unset, so the same test here is the unconfigured arm.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A body that records no geometry of its own, and a third-party lens whose string matches
/// nothing exactly - which is the query the database is consulted for at all.
const SHOT: (&str, &str, &str, f32, f32) = (
    "Canon",
    "Canon EOS 5D Mark IV",
    "TAMRON SP 70-200mm F/2.8 Di VC USD A009",
    70.0,
    2.8,
);

#[test]
fn the_database_holds_the_lens() {
    let named = std::env::var_os(rawshim::lensfun::DATA);
    if named.is_none() && installed().is_none() {
        eprintln!("SKIPPED: no lensfun database is installed, so there is none to resolve against.");
        return;
    }
    let (make, model, lens, focal, aperture) = SHOT;
    let knots = rawshim::lensfun::knots(make, model, lens, focal, aperture, 6720, 4480);
    assert!(knots.is_some(), "the database did not resolve {lens}");
    assert_eq!(rawshim::lensfun::crop_factor(make, model), Some(1.0));
}

/// A directory the variable names resolves what the installed database does, and is read
/// *instead* of it - which together are what let a packaged application carry its own copy.
#[test]
fn a_named_directory_replaces_the_installed_database() {
    let Some(installed) = installed() else {
        eprintln!("SKIPPED: no lensfun database is installed, so there is none to copy.");
        return;
    };
    let run = resolving_from(&copy_of(&installed, "whole", |_| true));
    assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));

    // The control, without which the arm above would pass on a variable that did nothing: a
    // database that loads and has this lens left out of it. Resolving from that says the
    // installed one was read as well.
    let partial = copy_of(&installed, "partial", |name| name == "compact-casio.xml");
    let said = String::from_utf8_lossy(&resolving_from(&partial).stderr).into_owned();
    assert!(said.contains("did not resolve"), "a database without the lens answered for it: {said}");
}

/// And a directory holding none of it fails, rather than loading empty and leaving every frame
/// to fit its own geometry with nothing saying why.
#[test]
fn a_named_directory_with_no_data_refuses_to_load() {
    let run = resolving_from(&scratch("empty"));
    assert!(!run.status.success(), "an empty directory loaded as a database");
    let said = String::from_utf8_lossy(&run.stderr);
    assert!(said.contains(rawshim::lensfun::DATA), "the failure did not name the variable: {said}");
}

/// This test binary again, reading the database at `data`.
fn resolving_from(data: &Path) -> std::process::Output {
    Command::new(std::env::current_exe().expect("this test binary"))
        .args(["--exact", "the_database_holds_the_lens", "--nocapture"])
        .env(rawshim::lensfun::DATA, data)
        .output()
        .expect("run this test binary again")
}

/// A database of our own holding the files of `installed` that `keep` accepts.
fn copy_of(installed: &Path, name: &str, keep: impl Fn(&str) -> bool) -> PathBuf {
    let at = scratch(name);
    for entry in std::fs::read_dir(installed).expect("read the installed database") {
        let from = entry.expect("a database entry").path();
        let file = from.file_name().expect("a file name").to_string_lossy().into_owned();
        if file.ends_with(".xml") && keep(&file) {
            std::fs::copy(&from, at.join(&file)).expect("copy one of the database's files");
        }
    }
    at
}

/// An empty directory of our own.
fn scratch(name: &str) -> PathBuf {
    let at = std::env::temp_dir().join("bowerbird-lensfun").join(name);
    let _ = std::fs::remove_dir_all(&at);
    std::fs::create_dir_all(&at).expect("a scratch directory");
    at
}

/// The database lensfun would find for itself, where the machine has one.
///
/// Asked of `pkg-config` rather than listed, because a list is how this skips on the platforms
/// the variable exists for: Homebrew and MSYS2 are on neither of the two Unix prefixes, so the
/// tests that load a database would pass without loading one on exactly the machines whose
/// answer is in question. `build-sidecar.ts` finds the shipped copy the same way.
fn installed() -> Option<PathBuf> {
    let asked = Command::new("pkg-config").args(["--variable=datadir", "lensfun"]).output().ok()?;
    let datadir = String::from_utf8_lossy(&asked.stdout).trim().to_owned();
    if !asked.status.success() || datadir.is_empty() {
        return None;
    }
    // One directory of XML under it, whose name is the database's version and not ours to know.
    std::fs::read_dir(PathBuf::from(datadir).join("lensfun"))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|at| at.is_dir() && holds_xml(at))
}

fn holds_xml(at: &Path) -> bool {
    std::fs::read_dir(at)
        .map(|entries| entries.flatten().any(|e| e.path().extension().is_some_and(|it| it == "xml")))
        .unwrap_or(false)
}
