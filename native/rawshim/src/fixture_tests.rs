// The tests that need a real RAW file.
//
// Split from the rest of the suite because they cost seconds where a synthetic test
// costs microseconds, and because they need the LFS fixtures to be checked out. The
// `fixtures` feature gates the whole module, so `cargo test` stays fast enough to run
// on every edit and `bun run test:native:full` is the pass before calling something
// done.
//
// These used to be TypeScript, driven over FFI through the debug commands. Nothing
// they assert involves TypeScript: a masked border that was not cropped, two decode
// routes agreeing, a fit recovering a distortion that was injected on purpose - all of
// it is this crate checking itself, and the round trip through Bun bought nothing but
// a JSON encoding of the answer.

use std::path::PathBuf;

/// A body that records a distortion spline, shot portrait so the flip path is live.
pub fn sony() -> PathBuf {
    fixture("DSC02981.ARW")
}

/// A body that records no spline, so the lensfun tier is the only geometry.
pub fn canon() -> PathBuf {
    fixture("IMG_5360.CR3")
}

fn fixture(name: &str) -> PathBuf {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures").join(name);
    // A hard failure rather than a skip. The feature is opt-in, so asking for it and
    // silently getting nothing is worse than being told the checkout is incomplete -
    // that is how a suite rots into passing without running.
    assert!(
        path.is_file(),
        "{} is missing. These fixtures are Git LFS objects; run `git lfs pull`.",
        path.display(),
    );
    path
}

/// A 61MP body, which is the only way to exercise halving: the committed fixture is
/// 24MP, below the threshold by design.
///
/// Not committed - a 61MP RAW is ~70MB - so this returns None and the caller says so
/// rather than failing on a checkout that never had it.
fn big() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.photos/Test/DSC03451.ARW");
    match path.is_file() {
        true => Some(path),
        false => {
            eprintln!("SKIPPED: {} is absent, so the halving cases did not run", path.display());
            None
        }
    }
}

fn decode(path: &PathBuf, depth: u32, rec2020_linear: bool, long_edge: u32) -> crate::frame::Frame {
    crate::decode_frame(path.to_str().unwrap(), depth, rec2020_linear, long_edge)
        .unwrap_or_else(|| panic!("could not decode {}", path.display()))
}

fn long_edge(frame: &crate::frame::Frame) -> usize {
    frame.width.max(frame.height)
}

mod decode_geometry {
    use super::*;

    /// Pinned, because the failure this guards is a plausible-looking number: the EOS
    /// R8 decoded to 3879x5811, a 3% tight and off-centre crop of the picture the
    /// camera took, from applying a crop LibRaw had already applied.
    #[test]
    fn decodes_the_frame_the_camera_says_it_took() {
        for (path, width, height) in [(sony(), 4024, 6024), (canon(), 3999, 5999)] {
            let frame = decode(&path, 8, false, 0);
            assert_eq!((frame.width, frame.height), (width, height), "{}", path.display());
        }
    }

    /// Bodies that state a visible frame inside the raw frame (the ILCE-7CR does) get
    /// cropped to it, or the masked border decodes as black bars down two edges. The
    /// stored dimensions have to describe the same picture the rendition shows, so
    /// these two must never disagree - that is what breaks first if the crop is applied
    /// in one path and not the other.
    #[test]
    fn the_recorded_dimensions_are_the_dimensions_that_get_decoded() {
        for path in [sony(), canon()] {
            let header = crate::header::read_path(path.to_str().unwrap()).expect("header");
            let frame = decode(&path, 8, false, 0);
            assert_eq!(frame.width, header.width as usize, "{}", path.display());
            assert_eq!(frame.height, header.height as usize, "{}", path.display());
        }
    }

    /// The masked border itself, which no aggregate can see: the frame is mostly
    /// picture, so a black bar down one edge barely moves a mean. It has to be read at
    /// the edges, one pixel per side.
    #[test]
    fn the_decoded_image_has_no_black_border_on_any_edge() {
        for path in [sony(), canon()] {
            let frame = decode(&path, 8, false, 0);
            let data = frame.rgb8().expect("an 8-bit decode").data;
            let lit = |x: usize, y: usize| {
                let i = (y * frame.width + x) * 3;
                u32::from(data[i]) + u32::from(data[i + 1]) + u32::from(data[i + 2]) > 24
            };
            let (mid_x, mid_y) = (frame.width / 2, frame.height / 2);
            for (x, y, edge) in [
                (0, mid_y, "left"),
                (frame.width - 1, mid_y, "right"),
                (mid_x, 0, "top"),
                (mid_x, frame.height - 1, "bottom"),
            ] {
                assert!(lit(x, y), "{} edge is black on {}", edge, path.display());
            }
        }
    }
}

/// Half-size decoding is a real quality trade - a faint checkerboard on dark edges -
/// bought for about 40% of the decode. It is only acceptable where the halved frame
/// still exceeds what is being built, so the gate is the whole feature.
mod halving {
    use super::*;

    /// What a full rendition asks for, and the threshold the gate is measured against.
    const FULL_RENDITION: u32 = 3840;

    #[test]
    fn halves_a_61mp_frame_because_4864_still_clears_a_3840_rendition() {
        let Some(path) = big() else { return };
        let whole = decode(&path, 8, false, 0);
        let halved = decode(&path, 8, false, FULL_RENDITION);

        assert!(long_edge(&halved) < long_edge(&whole));
        assert!(long_edge(&halved) >= FULL_RENDITION as usize);
        // Close to exactly half; LibRaw rounds and the masked-border crop is halved
        // alongside, so this is not an equality.
        let ratio = long_edge(&halved) as f64 / long_edge(&whole) as f64;
        assert!((0.45..0.55).contains(&ratio), "halved to {ratio} of the frame");
        // Aspect must survive the halving, or the crop insets were scaled wrongly and
        // the frame comes out stretched.
        let aspect = |f: &crate::frame::Frame| f.width as f64 / f.height as f64;
        assert!((aspect(&halved) - aspect(&whole)).abs() < 0.01);
    }

    #[test]
    fn leaves_a_24mp_frame_alone_because_halving_it_would_fall_short() {
        // 6024 halves to about 3012, under the 3840 a full rendition wants, so asking
        // for that size must not get a half decode.
        let whole = decode(&sony(), 8, false, 0);
        let asked = decode(&sony(), 8, false, FULL_RENDITION);
        assert_eq!((asked.width, asked.height), (whole.width, whole.height));
        assert!(!asked.halved);
    }

    #[test]
    fn never_halves_when_the_caller_needs_native_resolution() {
        // A max-resolution rendition passes 0, which has to mean "the whole frame"
        // rather than "no constraint, do as you like".
        let Some(path) = big() else { return };
        let whole = decode(&path, 8, false, 0);
        assert!(!whole.halved, "0 must mean the whole frame");
        assert!(long_edge(&whole) > FULL_RENDITION as usize);
    }

    #[test]
    fn produces_a_sane_picture_not_a_misplaced_struct_write() {
        // The half_size flag is written into LibRaw's params through a bindgen-resolved
        // offset. A wrong address would land on a neighbouring field - four_color_rgb
        // and use_auto_wb are both nearby - so this checks the result still looks like
        // the same photograph rather than only checking its dimensions.
        let Some(path) = big() else { return };
        let whole = crate::debug::summarise(&decode(&path, 8, false, 0));
        let halved = crate::debug::summarise(&decode(&path, 8, false, FULL_RENDITION));

        // Per channel, because a whole-frame average would hide a shift in one, and a
        // shift in one is exactly what a stray white-balance write looks like.
        for (a, b) in whole.channels.iter().zip(&halved.channels) {
            assert!((a.mean - b.mean).abs() < 6.0, "{} against {}", a.mean, b.mean);
        }
    }
}

/// The scene-linear decode skips `dcraw_make_mem_image` and reads `imgdata.image`
/// itself, interleaving, orienting and cropping in one pass (§10.4). That is only safe
/// because the output curve on this path is a constant we set rather than one LibRaw
/// derives: `no_auto_bright` pins dcraw's `t_white`, `bright` is 1 and `gamm` is {1,1},
/// which makes the curve the identity.
///
/// So it is pinned rather than reasoned about: both routes must agree to the byte, on
/// both orientations of the flip, on a body that declares a crop and one that does not,
/// and at half size as well as full, since the half-size decision changes the insets.
mod fused_decode_matches_libraw {
    use super::*;

    #[test]
    fn on_both_bodies_at_both_sizes() {
        for path in [sony(), canon()] {
            for long in [0u32, 640] {
                let direct = decode(&path, 16, true, long);
                let reference =
                    crate::_for_testing_decode_frame_reference(path.to_str().unwrap(), 16, true, long)
                        .expect("the reference decode");

                // A guard on the fixture rather than the code: a half-size case that
                // stopped halving would pass the comparison while testing the same
                // thing twice.
                assert_eq!(direct.halved, long > 0, "{} at {long}", path.display());
                assert_eq!(
                    (direct.width, direct.height),
                    (reference.width, reference.height),
                    "{} at {long}",
                    path.display(),
                );

                // And a guard on the fork itself. `copy_processed` declines - falling
                // back to the very path this compares against - on any of five
                // conditions, one of which is a curve parameter it does not set. If it
                // ever starts declining, everything above passes with both arms on the
                // reference path and the thing under test is dead with nothing to say
                // so.
                assert!(direct.direct, "the fused path declined on {}", path.display());
                assert!(!reference.direct, "the reference path took the fused route");

                assert_eq!(
                    crate::debug::summarise(&direct).sha1,
                    crate::debug::summarise(&reference).sha1,
                    "{} at {long} differs between the two decode routes",
                    path.display(),
                );
            }
        }
    }
}
