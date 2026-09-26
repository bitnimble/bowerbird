//! What the database answers, against what the C library answered for the same shots.
//!
//! The expected values were read out of lensfun 0.3.99 over its own `version_2` data, which is
//! the release the bundled copy is cut from, and they are the whole of what makes a pre-alpha
//! port safe to put a photograph through. A sweep over every entry in that database - 2422 shots
//! through both - agreed to better than 1e-6 on 2019 of the 2026 it resolved, the remainder being
//! ties between two entries broken in a different order.
//!
//! One process reads the database once, so nothing here may name `DATA`: these run against the
//! copy that ships.

/// A tenth of what a knot is quantised to where `rawshim` carries it, so a difference this test
/// allows cannot reach a picture.
const TOLERANCE: f64 = 1e-5;

fn corner(knots: &[f64]) -> f64 {
    knots[knots.len() - 1]
}

#[test]
fn a_third_party_lens_named_loosely_still_resolves() {
    // The query the database exists for: the body records no geometry, and the string it writes
    // matches nothing exactly - "TAMRON SP 70-200mm F/2.8 Di VC USD A009" against lensfun's
    // "Tamron SP 70-200mm f/2.8 Di VC USD A009".
    let knots = lensdb::distortion_knots(
        "Canon",
        "Canon EOS 5D Mark IV",
        "TAMRON SP 70-200mm F/2.8 Di VC USD A009",
        70.0,
        2.8,
        None,
        6720,
        4480,
    )
    .expect("the database has this lens");
    assert_eq!(knots.len(), 16);
    assert_eq!(knots[0], 0.0);
    assert!((corner(&knots) - -0.003_502_964_973_449_707).abs() < TOLERANCE, "{knots:?}");
    assert!((knots[8] - -0.000_996_887_631_876_664).abs() < TOLERANCE, "{knots:?}");
}

/// The case that decides whether the search is usable at all: lensfun files this lens as
/// "E 17-70mm F2.8 B070" by default and "Tamron 17-70mm F/2.8 Di III-A VC RXD" in English, and
/// the body writes the English name without the slash. Matching the default name alone answers
/// None here, and eleven of the thirteen frames in this repository's Sony set are this shape.
///
/// The claim is the resolution. Its value is the bundled entry's own, not the C library's, that
/// release having refiled this lens under a different default name with a calibration of its own.
#[test]
fn a_lens_filed_under_its_english_name_resolves_from_what_the_body_wrote() {
    let knots = lensdb::distortion_knots(
        "Sony",
        "ILCE-6300",
        "Tamron 17-70mm F2.8 Di III-A VC RXD",
        45.0,
        4.0,
        None,
        6000,
        4000,
    )
    .expect("the database has this lens under its English name");
    assert!((corner(&knots) - 0.061_802_029_609_680_176).abs() < TOLERANCE, "{knots:?}");
    assert_eq!(lensdb::crop_factor("Sony", "ILCE-6300", None), Some(1.534_000_039_100_647));
}

/// A full-frame body in APS-C mode writes an APS-C picture, and says so only through its 35mm
/// focal length: 45mm written as 68.
#[test]
fn a_full_frame_body_in_apsc_mode_takes_an_apsc_lens() {
    let asked = |stated| {
        lensdb::distortion_knots(
            "Sony",
            "ILCE-7CR",
            "Tamron 17-70mm F2.8 Di III-A VC RXD",
            45.0,
            4.0,
            stated,
            6240,
            4160,
        )
    };
    let knots = asked(Some(68.0 / 45.0)).expect("the APS-C picture takes its APS-C lens");
    assert!((corner(&knots) / 0.061_802_029_609_680_176 - 1.0).abs() < 0.05, "{knots:?}");
    let stated = 68.0f32 / 45.0;
    assert_eq!(lensdb::crop_factor("Sony", "ILCE-7CR", Some(stated)), Some(f64::from(stated)));
}

/// The same full-frame lens reaches only the middle of its own barrel on the smaller picture.
#[test]
fn a_full_frame_lens_on_an_apsc_mode_picture_corrects_its_middle() {
    let asked = |stated| {
        let lens = "Canon RF24-50mm F4.5-6.3 IS STM";
        lensdb::distortion_knots("Canon", "Canon EOS R5", lens, 24.0, 4.5, stated, 5088, 3392)
            .expect("the database has this lens")
    };
    let (full, cropped) = (corner(&asked(None)), corner(&asked(Some(38.0 / 24.0))));
    assert!(cropped.abs() < full.abs() * 0.6, "{cropped} against {full}");
}

#[test]
fn a_zoom_answers_for_the_end_of_its_range_it_was_shot_at() {
    let knots = lensdb::distortion_knots(
        "Sony",
        "ILCE-7CR",
        "Tamron 25-200mm F2.8-5.6 Di III VXD G2",
        25.0,
        2.8,
        None,
        9504,
        6336,
    )
    .expect("the database has this lens");
    assert!((corner(&knots) - -0.011_024_296_283_721_924).abs() < TOLERANCE, "{knots:?}");
}

/// A body's own lens, and the strongest correction in the set: 16% at the corner, which is the
/// magnitude a mistake in the normalisation would show up at.
#[test]
fn a_kit_zoom_answers_with_the_whole_of_its_barrel() {
    let knots =
        lensdb::distortion_knots("Canon", "Canon EOS R8", "Canon RF24-50mm F4.5-6.3 IS STM", 24.0, 4.5, None, 6000, 4000)
            .expect("the database has this lens");
    assert!((corner(&knots) - -0.158_402_502_536_773_68).abs() < TOLERANCE, "{knots:?}");
    assert_eq!(lensdb::crop_factor("Canon", "Canon EOS R8", None), Some(1.0));
}

/// Sixty of the database's 1300 lenses state a focal range in the XML and the rest have it read
/// out of their own name, which the C library does as it parses and the port does not. Left
/// unguessed every range is zero, `covers` rejects nothing, and a 70-200 answers for a 24mm
/// frame with a curve from the wrong end of the wrong lens.
#[test]
fn a_lens_that_states_no_range_still_has_one_read_from_its_name() {
    let asked = |focal| {
        lensdb::distortion_knots(
            "Canon",
            "Canon EOS 5D Mark IV",
            "Canon EF 70-200mm f/2.8L IS II USM",
            focal,
            2.8,
            None,
            6720,
            4480,
        )
    };
    assert!(asked(70.0).is_some(), "the lens did not answer inside its own range");
    assert!(asked(600.0).is_none(), "a 70-200 answered for a 600mm frame");
}

#[test]
fn a_body_the_database_has_never_heard_of_has_no_crop_factor() {
    assert_eq!(lensdb::crop_factor("Bowerbird", "Imaginary One", None), None);
    assert_eq!(lensdb::crop_factor("Bowerbird", "Imaginary One", Some(1.5)), Some(1.5));
}

/// A directory holding no lens data is refused, rather than loaded as a database with nothing in
/// it.
///
/// **The failure this exists for is the quiet one.** `load_dir` globs `*.xml` and loops, so the
/// directory one level above a `version_2` - the exact mistake the refusal message describes -
/// parses cleanly into an empty database. Every photograph afterwards gets None, which is
/// indistinguishable from a lens the database has never listed, and nothing says why.
///
/// In a process of its own because one process reads the database once: this binary's own
/// `DATA` is unset, which is what every test above is asserting against.
#[test]
fn a_named_directory_with_no_lens_data_is_refused() {
    let at = std::env::temp_dir().join("bowerbird-lensdb-empty");
    let _ = std::fs::remove_dir_all(&at);
    std::fs::create_dir_all(&at).expect("a scratch directory");

    let run = std::process::Command::new(std::env::current_exe().expect("this test binary"))
        .args(["--exact", "a_third_party_lens_named_loosely_still_resolves", "--nocapture"])
        .env("BOWERBIRD_LENSFUN_DATA", &at)
        .output()
        .expect("run this test binary again");

    assert!(!run.status.success(), "an empty directory loaded as a database");
    let said = String::from_utf8_lossy(&run.stderr);
    assert!(
        said.contains("BOWERBIRD_LENSFUN_DATA"),
        "the failure did not name the variable: {said}"
    );
}
