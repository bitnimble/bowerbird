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

/// Deriving, per photo, the transform that makes a RAW render look like the camera's
/// own JPEG - the maker's colour treatment and whichever picture profile the
/// photographer had set. None of it is visible from a synthetic input: the curves come
/// out of the camera's own rendering, and the failure modes that mattered were all
/// "the fit ran and the picture was wrong" (§10.8).
mod camera_match {
    use super::*;
    use crate::image::SPLINE_UNIT;

    /// The 8-bit render a worker would already have in hand, and the profile fitted
    /// from it. Not cached: two of the assertions below are that fitting twice agrees
    /// and that fitting off either decode agrees, and a cache would answer both with
    /// the same object and prove nothing.
    fn fit(path: &PathBuf) -> crate::fit::Profile {
        let render = decode(path, 8, false, 0);
        crate::fit_profile_for(&render, path.to_str().unwrap()).expect("a fitted profile")
    }

    /// Centre-to-corner displacement, which is what a geometry actually does to the
    /// picture. A tier, a knot count and a crop are three ways of saying something the
    /// eye only sees as displacement.
    fn corner_scale(profile: &crate::fit::Profile) -> f64 {
        let last = profile.knots.as_ref().and_then(|k| k.last().copied()).unwrap_or(0.0);
        profile.crop * (1.0 + last / SPLINE_UNIT)
    }

    mod lens_metadata {
        use super::*;

        /// The parser lives in `lens.rs`, whose own tests use synthetic TIFFs. Those
        /// cannot catch a wrong assumption about how Sony actually nests this; only a
        /// real file can.
        #[test]
        fn reads_the_ilce_6300_distortion_spline_out_of_a_real_arw() {
            let knots = crate::ffi::_for_testing_distortion_spline(sony().to_str().unwrap())
                .expect("the ARW records a spline");
            // This body writes 11 knots, not the ILCE-7CR's 16.
            assert_eq!(knots.len(), 11);
            // Anchored at zero in the centre, and a small correction on a 50mm prime.
            assert!(knots[0].abs() <= 2.0);
            assert!((knots[10] / SPLINE_UNIT - -0.0029).abs() < 0.0005);
        }

        /// The case the database exists for: a Canon body records no spline, and the
        /// string it writes matches nothing exactly - "TAMRON SP 70-200mm F/2.8 Di VC
        /// USD A009" against lensfun's "Tamron SP 70-200mm f/2.8 Di VC USD A009". Only
        /// a real database can say whether the scored search still lands on it.
        #[test]
        fn resolves_a_third_party_lens_name_against_the_lensfun_database() {
            let header = crate::header::read_path(canon().to_str().unwrap()).expect("header");
            let knots = crate::lensfun::knots(
                crate::header::name(&header.camera_make),
                crate::header::name(&header.camera_model),
                crate::header::name(&header.lens_model),
                header.focal,
                header.aperture,
                header.width as usize,
                header.height as usize,
            )
            .expect("lensfun has this lens");
            assert_eq!(knots.len(), 16);
            assert_eq!(knots[0], 0.0);
            // Barely anything at 70mm, which is where this lens crosses over.
            assert!((knots[15] / SPLINE_UNIT - -0.0024).abs() < 0.0005);
        }

        /// The guard that makes the scored search safe to trust: it returns everything
        /// it scored above zero, so without a range check a 70-200 answers for a 24mm
        /// frame and the render gets warped by a curve from the wrong lens.
        #[test]
        fn refuses_a_lens_the_shot_could_not_have_been_taken_with() {
            let header = crate::header::read_path(canon().to_str().unwrap()).expect("header");
            let knots = crate::lensfun::knots(
                crate::header::name(&header.camera_make),
                crate::header::name(&header.camera_model),
                crate::header::name(&header.lens_model),
                24.0,
                2.8,
                header.width as usize,
                header.height as usize,
            );
            assert!(knots.is_none(), "a 70-200 answered for a 24mm frame");
        }

        /// The order is measured, not assumed: over 83 Sony frames carrying both, the
        /// spline beat lensfun 31 to 4, because a spline is recorded per shot and a
        /// profile is one average of every copy of the lens. lensfun has this exact
        /// lens, so nothing but the priority keeps it out.
        ///
        /// Not asserted as `camera`: this frame is a 50mm prime bent by 0.29% at the
        /// corner, and correcting by that much does not beat leaving it alone, so the
        /// fit correctly settles on no geometry at all. What must never happen is the
        /// database being consulted behind the body's back.
        #[test]
        fn never_takes_the_database_over_a_spline_the_body_recorded() {
            assert_ne!(fit(&sony()).source, crate::fit::SOURCE_LENSFUN);
        }
    }

    #[test]
    fn matches_the_camera_jpeg_far_more_closely_than_the_raw_render_does() {
        let profile = fit(&sony());
        // Held out inside the fit, so this is not a training score.
        assert!(profile.delta_e < 2.5, "held-out deltaE {}", profile.delta_e);

        // What the render looks like before any transform, on the same pixels, to show
        // the fit is doing the work rather than the metric being generous.
        let preview = crate::decode_embedded_rgb(sony().to_str().unwrap(), 400).expect("a preview");
        // `at_least_long_edge` only decides halving on the 8-bit path, so fitting to
        // size is a separate step - the same order the worker applies.
        let decoded = decode(&sony(), 8, false, 400);
        let fitted = resize(decoded.rgb8().expect("an 8-bit render"), 400);
        let render = fitted.as_ref();
        // Both fitted to the same long edge, and the render and its own embedded
        // preview share an aspect, so this is like-for-like.
        assert_eq!(
            (render.width, render.height),
            (preview.width, preview.height),
            "the render and its own preview must be fitted alike",
        );

        let (mut before, mut after, mut counted) = (0.0, 0.0, 0usize);
        for p in (0..render.data.len() / 3).step_by(37) {
            let i = p * 3;
            let target = [
                f64::from(preview.data[i]),
                f64::from(preview.data[i + 1]),
                f64::from(preview.data[i + 2]),
            ];
            let source = [
                f64::from(render.data[i]),
                f64::from(render.data[i + 1]),
                f64::from(render.data[i + 2]),
            ];
            before += crate::fit::delta_e76(&source, &target);
            after += crate::fit::delta_e76(&colour_at(&profile.colour, source), &target);
            counted += 1;
        }
        assert!(counted > 100);
        assert!(after / (counted as f64) < before / (counted as f64));
    }

    /// The colour half of a profile, for one pixel.
    fn colour_at(transform: &crate::fit::ColourTransform, rgb: [f64; 3]) -> [f64; 3] {
        let channel =
            |c: usize| f64::from(transform.curves[c][rgb[c].round().clamp(0.0, 255.0) as usize]);
        let (r, g, b) = (channel(0), channel(1), channel(2));
        let out = |row: usize| {
            (transform.matrix[row][0] * r
                + transform.matrix[row][1] * g
                + transform.matrix[row][2] * b)
                .clamp(0.0, 255.0)
        };
        [out(0), out(1), out(2)]
    }

    /// The check this module exists to keep honest. Three earlier detectors reported
    /// "no distortion" on a frame that had 4.4% of it, because a radial model and a
    /// radial error will always find each other and a null result looks the same as no
    /// sensitivity. So: warp the camera's JPEG by a known amount, hand it back as the
    /// target, and require the fit to notice.
    #[test]
    fn recovers_a_distortion_that_was_injected_on_purpose() {
        const K1: f64 = 0.03;
        let preview = crate::decode_embedded_rgb(sony().to_str().unwrap(), 0).expect("a preview");
        let target = crate::vips::Pipeline::from_rgb(pincushion(&preview, K1).as_ref())
            .and_then(|p| p.encode_jpeg(95))
            .expect("the injected target encodes");

        let render = decode(&sony(), 8, false, 0);
        // Unstated forces the fitted path: the question is whether the search finds a
        // displacement, not whether it can read one off the file.
        let fitted = crate::fit::fit(
            render.rgb8().expect("an 8-bit render"),
            &target,
            crate::fit::Geometry::Unstated,
        )
        .expect("the fit runs")
        .expect("the fit finds something worth applying");
        assert_eq!(fitted.source, crate::fit::SOURCE_FITTED);

        // The target samples outward, so the map from target back to render carries the
        // same sign as the injected coefficient. Compare centre-to-corner displacement
        // rather than raw coefficients, since crop and knots trade off.
        let knots = fitted.knots.as_ref().expect("a fitted curve");
        let recovered = (knots[knots.len() - 1] - knots[0]) / SPLINE_UNIT;
        assert!(recovered > K1 / 2.0 && recovered < K1 * 2.0, "recovered {recovered} from {K1}");
    }

    /// A centre-to-corner pincushion of `k1`, applied by resampling.
    fn pincushion(source: &crate::vips::Rgb, k1: f64) -> crate::vips::Rgb {
        let (width, height) = (source.width, source.height);
        let mut out = vec![0u8; width * height * 3];
        let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
        for y in 0..height {
            let dy = (y as f64 - height as f64 / 2.0) / half;
            for x in 0..width {
                let dx = (x as f64 - width as f64 / 2.0) / half;
                let factor = 1.0 + k1 * (dx * dx + dy * dy);
                let px = width as f64 / 2.0 + dx * factor * half;
                let py = height as f64 / 2.0 + dy * factor * half;
                let o = (y * width + x) * 3;
                if px < 0.0 || py < 0.0 || px >= width as f64 - 1.0 || py >= height as f64 - 1.0 {
                    continue;
                }
                let (x0, y0) = (px as usize, py as usize);
                let (fx, fy) = (px - x0 as f64, py - y0 as f64);
                let i00 = (y0 * width + x0) * 3;
                let i01 = i00 + width * 3;
                for c in 0..3 {
                    out[o + c] = (f64::from(source.data[i00 + c]) * (1.0 - fx) * (1.0 - fy)
                        + f64::from(source.data[i00 + 3 + c]) * fx * (1.0 - fy)
                        + f64::from(source.data[i01 + c]) * (1.0 - fx) * fy
                        + f64::from(source.data[i01 + 3 + c]) * fx * fy)
                        as u8;
                }
            }
        }
        crate::vips::Rgb { width, height, data: out }
    }

    /// Load-bearing: the profile is deliberately not stored anywhere. The grid and the
    /// full view are fitted in one job, but the max-resolution export is built on demand
    /// later and refits from scratch. If the fit were not deterministic those two copies
    /// of one photo would be graded differently, and the only remedy would be persisting
    /// the profile.
    #[test]
    fn fits_the_same_profile_twice_so_renditions_built_at_different_times_agree() {
        let (first, second) = (fit(&sony()), fit(&sony()));
        assert_eq!(first.delta_e, second.delta_e);
        assert_eq!(first.crop, second.crop);
        assert_eq!(first.source, second.source);
        assert_eq!(first.knots, second.knots);
        assert_eq!(first.colour.matrix, second.colour.matrix);
        assert_eq!(first.colour.curves, second.colour.curves);
    }

    /// The worker applies the profile to the *sized* image, because warping a 60MP
    /// decode to produce an 800px tile costs seconds per rendition. That is only
    /// legitimate if the order does not matter: the distortion model is in normalised
    /// radii and the colour transform is a per-pixel lookup, so it should not.
    #[test]
    fn gives_the_same_picture_whether_applied_before_or_after_the_resize() {
        const SIZE: usize = 800;
        let profile = fit(&sony());
        let render = decode(&sony(), 8, false, 0);
        let source = render.rgb8().expect("an 8-bit render");

        let before = resize(crate::fit::apply(source, &profile).as_ref(), SIZE);
        let after = crate::fit::apply(resize(source, SIZE).as_ref(), &profile);
        assert_eq!((after.width, after.height), (before.width, before.height));

        let n = before.data.len().min(after.data.len()) / 3;
        let mut total = 0.0;
        for p in 0..n {
            let i = p * 3;
            total += crate::fit::delta_e76(
                &[f64::from(before.data[i]), f64::from(before.data[i + 1]), f64::from(before.data[i + 2])],
                &[f64::from(after.data[i]), f64::from(after.data[i + 1]), f64::from(after.data[i + 2])],
            );
        }
        // Resampling order still moves a few edge pixels, so this is "the same
        // picture", not "the same bytes".
        let mean = total / (n as f64);
        assert!(mean < 1.0, "mean deltaE {mean}");
    }

    fn resize(source: crate::vips::RgbRef<'_>, long: usize) -> crate::vips::Rgb {
        crate::vips::Pipeline::from_rgb(source)
            .and_then(|p| p.resize_to_fit(long))
            .and_then(crate::vips::Pipeline::finish)
            .expect("the resize")
    }

    /// A transform that returned the render untouched would pass every size assertion
    /// while doing nothing.
    #[test]
    fn applying_a_profile_leaves_the_render_the_same_size_and_shape() {
        let profile = fit(&sony());
        let render = decode(&sony(), 8, false, 0);
        let source = render.rgb8().expect("an 8-bit render");
        let corrected = crate::fit::apply(source, &profile);

        assert_eq!((corrected.width, corrected.height), (source.width, source.height));
        assert_eq!(corrected.data.len(), source.data.len());
        assert_ne!(corrected.data, source.data);
    }

    /// An HDR job wants only the geometry, and holds a scene-linear decode already, so
    /// it fits off that rather than demosaicing the file a second time in 8-bit. The two
    /// renders differ in tone - LibRaw auto-brightens its sRGB path where the linear one
    /// is deliberately scene-referred - so what survives that has to be checked rather
    /// than assumed.
    ///
    /// What is pinned is the match, not the route to it. The *tier* is deliberately not
    /// pinned: `fit.rs` keeps a known curve only where it beats correcting nothing, and
    /// on IMG_5360 lensfun wins that by 0.0028 deltaE76 - so any perturbation decides it,
    /// and the 8-bit fit takes the curve where this one declines it.
    #[test]
    fn matches_the_camera_as_closely_off_either_decode() {
        for path in [canon(), sony()] {
            let sdr = decode(&path, 8, false, 640);
            let via_sdr = crate::fit_profile_for(&sdr, path.to_str().unwrap()).expect("the SDR fit");

            let linear = decode(&path, 16, true, 3840);
            let samples = linear.samples16().expect("a 16-bit decode");
            let source = crate::hdr::Source { samples, width: linear.width, height: linear.height };
            let geometry = crate::ffi::geometry_for(path.to_str().unwrap()).expect("a geometry");
            let (via_linear, _) =
                crate::hdr::fit_all(path.to_str().unwrap(), &source, 0.9, geometry).expect("the linear fit");

            // The point of the fit: how close to the camera it lands. A render whose
            // tone was too far off to search against would show up here as a match that
            // is plainly worse, not as one that took a different road to the same place.
            assert!(
                via_linear.delta_e < via_sdr.delta_e + 0.1,
                "{}: linear {} against sdr {}",
                path.display(),
                via_linear.delta_e,
                via_sdr.delta_e,
            );

            // And how far apart the two geometries actually put the picture, which is
            // the thing that matters and the thing the tier is only a proxy for.
            // Bounded rather than pinned, because on IMG_5360 the two land on opposite
            // sides of a coin toss. What must not happen is disagreeing by a lot, which
            // is what a linear fit that had quietly stopped resolving geometry would look
            // like: an uncorrected 4.5% barrel is ~100px at this radius, the toss is 17.
            let radius = ((3840.0f64 / 2.0).powi(2) + (2560.0f64 / 2.0).powi(2)).sqrt();
            let gap = (corner_scale(&via_sdr) - corner_scale(&via_linear)).abs() * radius;
            assert!(gap < 30.0, "{}: the two fits are {gap}px apart at the corner", path.display());

            // Where both keep a curve it must be the same curve, since those knots are
            // read from the file or the database rather than fitted from pixels.
            if let (Some(a), Some(b)) = (&via_linear.knots, &via_sdr.knots) {
                assert_eq!(a, b, "{}", path.display());
                // The crop is scanned against the render, so it may land a hair apart.
                assert!((via_linear.crop - via_sdr.crop).abs() < 0.002);
            }
        }
    }
}
