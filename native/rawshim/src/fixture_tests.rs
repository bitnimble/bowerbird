// The tests that need a real RAW file.
//
// Split from the rest of the suite because they cost seconds where a synthetic test
// costs microseconds, and because they need the LFS fixtures to be checked out. The
// `fixtures` feature gates the whole module, so `cargo test` stays fast enough to run
// on every edit and `bun run test:native --features fixtures fixture_tests` is the pass
// before calling something done.
//
// Here rather than driven over the FFI from a TypeScript suite: nothing they assert involves
// TypeScript - a masked border that was not cropped, two decode routes agreeing, a fit
// recovering a distortion that was injected on purpose - so a round trip through Bun would buy
// only a JSON encoding of the answer.

use std::path::PathBuf;

/// A body that records a distortion spline, shot portrait so the flip path is live.
pub fn sony() -> PathBuf {
    fixture("DSC02981.ARW")
}

/// A body that records no spline, so the lensfun tier is the only geometry.
pub fn canon() -> PathBuf {
    fixture("IMG_5360.CR3")
}

/// A frame whose 99.5th percentile is the sensor's own ceiling, so diffuse white lands on
/// clipped highlights and the picture sits three stops under it.
pub fn clipped() -> PathBuf {
    fixture("DSC00853.ARW")
}

/// An X-Trans body: a 6x6 period, twenty greens to eight reds and eight blues, and none of the
/// 2x2 structure every other fixture here has.
pub fn fuji() -> PathBuf {
    fixture("AFXT2721.RAF")
}

/// The same pattern on a different generation of it, shot at ISO 4000.
///
/// **Two things the X-T3 fixture cannot say.** It is an X-Trans II sensor where that one is IV, so
/// the pattern reaching the decoder is a second body's rather than a second copy of one; and it is
/// noisy, which is the property every claim about a noise fit has to be made against - the other
/// fixture is a lit still life at ISO 160.
pub fn fuji_noisy() -> PathBuf {
    fixture("DSCF8146.RAF")
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

/// The corner factor `injected_falloff` darkens by, and the one every test that uses
/// it asserts against.
const INJECTED_CORNER: f64 = 0.65;

/// How far a held-out fit may sit from the camera's own rendering, in CIEDE2000, measured
/// on the fit's own pairs.
///
/// **A sanity bound, not a quality one**, because the units move when the fit does. It has
/// been re-derived twice for reasons that had nothing to do with the fit getting worse:
///
/// - It was 2.5 in deltaE76, unnamed and written out at each use. When the metric became
///   CIEDE2000 the number stayed, and nothing said what it was denominated in - so the
///   plain fit passed at 2.460 on 1.6% of headroom it had not earned, and the
///   injected-falloff fit read 2.806 and looked like a regression that never happened
///   (the same fit scores 1.844 under the old metric). CIEDE2000 is not a rescaling of
///   deltaE76: `S_H` drops below one wherever `T` does and `R_T` rotates blue error into
///   chroma, so a chromatic frame can read higher while being no worse.
/// - Then the planes stopped being blurred (`hdr_fit::registered`). Scoring against sharp
///   corresponded samples is a harder test than scoring against smeared ones, so the same
///   quality of fit reads 4.315 and 4.551 where it read 2.460 and 2.806.
///
/// - Then thirty commits of the fit moved underneath it at once, and no single one of them
///   owns the drift: the two frames read 6.185 and 6.435 against a bound of 6.
///
/// The lesson every time is that this number cannot be compared across a change to what
/// it measures against.
///
/// Kept rather than deleted because it still catches a fit that has fallen over entirely, which
/// is the one thing it can say that survives its own instability.
const MAX_HELD_OUT_DELTA_E: f64 = 7.0;

/// A profile carrying a real falloff, for the tests that need the radial branch to do
/// something.
///
/// Neither fixture supplies one: the Sony body corrects no illumination at all and the
/// Canon frame is third-party glass the body has no profile for, so it lands within a
/// few percent of the identity. Both facts are asserted by
/// `invents_no_falloff_where_the_camera_corrected_none`, which is exactly why a test
/// that wants a gain has to inject one rather than fit the fixture and hope.
/// The device the fit's correspondence search runs on. A fixture test with no adapter has nothing
/// to measure, and saying so beats a `None` that reads as a fit declining.
fn adapter() -> &'static crate::gpu::Gpu {
    crate::gpu::device().expect("an adapter for the fit's search")
}

fn injected_falloff() -> (crate::fit::Profile, crate::hdr_fit::HdrMatch) {
    let preview = crate::decode_embedded_rgb(sony().to_str().unwrap(), 0).expect("a preview");
    let target = crate::jpeg::encode(falloff(&preview, INJECTED_CORNER).as_ref(), 95)
        .expect("the injected target encodes");
    let target = crate::jpeg::decode(&target, 0).expect("the injected target decodes");
    let frame = decode(&sony(), 3840);
    let resident = frame.on_device(adapter()).expect("a 16-bit decode");
    // Uncorrected skips the geometry search, so nothing but the falloff is in play.
    let (fitted, matched, _) = pollster::block_on(crate::hdr::fit_all_from_preview(
        adapter(),
        &resident,
        0.9,
        crate::fit::Geometry::Uncorrected,
        &target,
        None,
    ))
    .expect("the fit finds something worth applying");
    assert!(fitted.gain.is_some(), "the injected frame must carry a gain");
    (fitted, matched)
}

/// Multiplies linear light by `1 + (corner - 1) r^2`, the shape a lens's falloff has
/// and the one the fit models.
fn falloff(source: &crate::rgb::Rgb, corner: f64) -> crate::rgb::Rgb {
    let (width, height) = (source.width, source.height);
    let (cx, cy) = (width as f64 / 2.0, height as f64 / 2.0);
    let half = (cx * cx + cy * cy).sqrt();
    let to_linear = |v: u8| {
        let s = f64::from(v) / 255.0;
        if s <= 0.04045 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
    };
    let mut data = vec![0u8; source.data.len()];
    for y in 0..height {
        for x in 0..width {
            let r2 = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)) / (half * half);
            let g = 1.0 + (corner - 1.0) * r2;
            let i = (y * width + x) * 3;
            for c in 0..3 {
                let lit = to_linear(source.data[i + c]) * g;
                data[i + c] = (crate::hdr_fit::srgb_oetf(lit.clamp(0.0, 1.0)) * 255.0).round() as u8;
            }
        }
    }
    crate::rgb::Rgb { width, height, data }
}

fn decode(path: &PathBuf, long_edge: u32) -> crate::frame::Frame {
    crate::decode_frame(path.to_str().unwrap(), long_edge)
        .unwrap_or_else(|| panic!("could not decode {}", path.display()))
}

fn long_edge(frame: &crate::frame::Frame) -> usize {
    frame.width.max(frame.height)
}

fn tile_job(path: &str, tile: Option<[usize; 4]>, levels: Option<crate::tone::Levels>) -> crate::job::Job {
    crate::job::Job {
        raw_file_path: path.to_string(),
        // A crop cannot fit one, and the point here is the coding rather than the colour.
        match_embedded_jpeg: false,
        half_size: false,
        scan: false,
        composite: None,
        tile,
        noise_fit: None,
        levels,
        scene_peak: None,
        photo_analysis: None,
        // **On, and that took a bug to learn.** Off, this compared everything about a tile
        // except the one stage that reads a *neighbourhood* of the region it was handed - so a
        // region decode whose origin sat off `pass12`'s shrinkage grid shrank every pixel
        // against a different neighbourhood than the frame did, and nothing said so.
        denoise_luminance: Some(40.0),
        denoise_colour: Some(40.0),
        // Off: a tile of this job is compared against a whole render of it, and a correction
        // the whole render detected for itself is not one a tile can be handed here.
        dust: crate::dust::Settings { enabled: false, ..Default::default() },
        repairs: Vec::new(),
        sharpen: 0.0,
        defringe: 0.0,
        exposure: crate::light::Stops::ZERO,
        adjust: crate::gpu::Adjust::none(),
        geometry: crate::image::Geometry::none(),
        preserve_source_orientation: false,
        grade: crate::hdr::Grade {
            peak_nits: crate::light::Light::exactly(1000.0),
            reference_white_nits: crate::light::Light::exactly(203.0),
            white_quantile: 0.9,
        },
        targets: Vec::new(),
        measure: false,
        report_progress: false,
    }
}

/// Which lens a [`rendition`] is gathered through.
enum Lensing {
    /// The camera match's, as a job takes it.
    Fitted,
    Without,
    Given(crate::fit::Lens),
}

/// The rendition, assembled as `job::run` assembles it: cut, sharpened, and graded through a
/// peak measured over the whole frame. `decode` is the size floor `Base::build` takes, 0 for the
/// sensor's own.
fn rendition(
    job: &crate::job::Job,
    decode: u32,
    lensing: Lensing,
) -> (Vec<u16>, usize, usize, crate::light::Light<crate::light::DisplayNits>) {
    let base = crate::job::Base::build(job, decode).expect("the frame");
    let scene = crate::tone::SceneGrade::new(
        base.matched.as_ref().map(|m| &m.colour),
        base.levels,
        job.grade.reference_white_nits,
        job.exposure,
        job.adjust,
        base.as_shot,
    );
    let size = crate::hdr_args::Size { width: base.width as u32, height: base.height as u32 };
    let lens = match lensing {
        Lensing::Fitted => base.matched.as_ref().map(|m| m.lens.clone()),
        Lensing::Without => None,
        Lensing::Given(lens) => Some(lens),
    };
    let sigma = crate::image::deconvolve_split(
        base.capture_sigma,
        base.sensor_long,
        size.width.max(size.height) as usize,
    );
    let crate::job::Cutting::OnDevice(frame) = base.frame else {
        panic!("a whole-frame build leaves its frame on the device")
    };
    let cut = crate::hdr::Cut::from_base(frame, lens.as_ref(), size, job.sharpen, sigma);
    let gpu = crate::gpu::device().expect("an adapter");
    let grade = scene
        .gpu_grade(cut.width, cut.height, job.grade.peak_nits, crate::gpu::Output::Pq)
        .showing(job.pixel_geometry());
    let (out_width, out_height) = grade.output_size();
    let peak = gpu.scene_peak();
    let resident = cut.resident().expect("from_base leaves the cut on the device");
    let frame = gpu.upload_resident(resident, &grade, &peak).encode(&grade);
    let measured = crate::light::Light::measured(f64::from(gpu.read_peak(&peak)));
    (frame, out_width, out_height, measured)
}

mod decode_geometry {
    use super::*;

    /// **What the whole X-Trans arm rests on, and the one thing no synthetic test can stand in
    /// for.** The pattern is read out of the file's own metadata rather than the camera table
    /// (`raf.rs`, `get_xtrans_cfa`), reversed on the way, and the tables for several Fuji bodies
    /// carry a 6x6 that is not a valid X-Trans phase at all. So the claim that a real RAF yields a
    /// real X-Trans period is an empirical one about this decoder and this file.
    #[test]
    fn a_real_raf_yields_a_six_by_six_xtrans_period() {
        let path = fuji();
        let source = crate::decode_rawler::mapped(path.to_str().unwrap()).expect("the fixture maps");
        let image = rawler::get_decoder(&source)
            .expect("a decoder for a RAF")
            .raw_image(&source, &rawler::decoders::RawDecodeParams::default(), false)
            .expect("the frame decodes");

        let cfa = crate::cfa::Cfa::from_rawler(&image.camera.cfa).expect("a pattern we can carry");
        assert_eq!(cfa.period(), (6, 6));
        assert_eq!(cfa.counts(), [8, 20, 8], "twenty greens to eight reds and eight blues");
        assert!(cfa.is_xtrans(), "every row and column carries all three colours");
        assert!(!cfa.is_bayer());
        assert_eq!(cfa.as_2x2(), None, "and nothing downstream may treat it as a quad");
    }

    /// **A second body's pattern, read the same way, and not necessarily the same phase.**
    ///
    /// Bodies write different phases of the one 6x6 and name theirs in metadata, so what the
    /// decoder hands back is the file's rather than the format's. `the_carriers_survive_every_phase`
    /// makes the claim over all 36 translations synthetically; this is the one that says a real
    /// second body lands on one of them. An X-Trans II sensor against the X-T3's IV.
    #[test]
    fn a_second_body_yields_a_pattern_of_its_own() {
        let source =
            crate::decode_rawler::mapped(fuji_noisy().to_str().unwrap()).expect("the fixture maps");
        let image = rawler::get_decoder(&source)
            .expect("a decoder for a RAF")
            .raw_image(&source, &rawler::decoders::RawDecodeParams::default(), false)
            .expect("the frame decodes");
        let cfa = crate::cfa::Cfa::from_rawler(&image.camera.cfa).expect("a pattern we can carry");
        assert!(cfa.is_xtrans(), "an X-Trans II sensor is still X-Trans");
        assert_eq!(cfa.counts(), [8, 20, 8]);
    }

    /// **The two Fuji fixtures sit at opposite ends of the sensor's noise, and that is the point.**
    ///
    /// Pinned as the sensitivity rather than as a statistic of the pixels. The obvious measurement -
    /// a Laplacian down one CFA phase's own sub-lattice - reads 133 against 71 here, which sounds
    /// like a result and is not one: the two frames are different sensors at different bit depths,
    /// and a second difference over a sharply detailed still life is measuring the still life. What
    /// makes one of these the frame to fit a noise model against is that it was shot at ISO 4000 in
    /// a dim interior, and that is a fact about the file. When there is a fit to check, the fit is
    /// the measurement.
    #[test]
    fn the_two_fuji_fixtures_are_four_stops_apart() {
        let iso = |path: &PathBuf| -> f32 {
            crate::header::read_path(path.to_str().unwrap()).expect("header").iso
        };
        assert!(iso(&fuji_noisy()) >= 3200.0, "the noisy one is ISO {}", iso(&fuji_noisy()));
        assert!(iso(&fuji()) <= 400.0, "the lit one is ISO {}", iso(&fuji()));
    }

    /// **The X-Trans arm end to end: a real RAF becomes a picture.**
    ///
    /// What it can assert without pinning bytes is that the demultiplexing produced a *photograph* -
    /// the failures it is written against are not subtle ones. A pattern read at the wrong phase, a
    /// conditioning slot that missed, a chroma estimate that never got divided by its `K`: each of
    /// those comes out as a frame that is flat, black, or carrying a colour cast no scene has. So:
    /// the three channels have to differ from each other, each has to vary across the frame, and
    /// nothing may be NaN.
    #[test]
    fn an_xtrans_frame_decodes_to_a_picture() {
        let frame = decode(&fuji(), 0);
        let header = crate::header::read_path(fuji().to_str().unwrap()).expect("header");
        assert_eq!(frame.width, header.width as usize);
        assert_eq!(frame.height, header.height as usize);

        let host = pollster::block_on(frame.to_host()).expect("the frame reads back");
        let samples = host.samples16().expect("sixteen-bit samples");
        let mut sums = [0f64; 3];
        let mut highs = [0u16; 3];
        let mut lows = [u16::MAX; 3];
        for pixel in samples.chunks_exact(3) {
            for (channel, value) in pixel.iter().enumerate() {
                sums[channel] += f64::from(*value);
                highs[channel] = highs[channel].max(*value);
                lows[channel] = lows[channel].min(*value);
            }
        }
        let scale = f64::from(u16::MAX);
        let count = (host.width * host.height) as f64;
        let means = sums.map(|sum| sum / count / scale);

        for channel in 0..3 {
            let spread = f64::from(highs[channel] - lows[channel]) / scale;
            assert!(spread > 0.05, "channel {channel} is flat: {spread}");
            assert!(means[channel] > 0.005, "channel {channel} is black at {}", means[channel]);
        }
        // A demultiplexing that lost its chroma entirely returns luma three times over, which every
        // check above passes.
        let spread = means.iter().cloned().fold(f64::MIN, f64::max)
            - means.iter().cloned().fold(f64::MAX, f64::min);
        assert!(spread > 0.002, "the three channels agree too closely: {means:?}");
    }

    /// Pinned, because the failure this guards is a plausible-looking number: the EOS
    /// R8 decoded to 3879x5811, a 3% tight and off-centre crop of the picture the
    /// camera took, from applying a crop that had already been applied.
    ///
    /// The numbers moved when LibRaw did. These are the manufacturer's recommended crop,
    /// which is what `crop_area` states and what the camera's own JPEG is; LibRaw emitted a
    /// slightly larger frame on both bodies - 4024x6024 here and 3999x5999 there - because it
    /// trimmed to its own margins instead. Same picture, a couple of dozen pixels of border.
    #[test]
    fn decodes_the_frame_the_camera_says_it_took() {
        for (path, width, height) in [(sony(), 4000, 6000), (canon(), 4000, 6000)] {
            let frame = decode(&path, 0);
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
            let frame = decode(&path, 0);
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
            let frame = decode(&path, 0);
            let data = frame.samples16().expect("a 16-bit decode");
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

    /// A window of a photograph on disk, at the sensor's own resolution.
    fn viewing(path: &str, tile: crate::Tile) -> crate::view::View {
        let header = crate::header::read_path(path).expect("a header");
        crate::view::View::whole(crate::px::Size::exact(
            header.width as usize,
            header.height as usize,
        ))
        .showing(crate::px::Rect::exact(tile.left, tile.top, tile.width, tile.height))
    }

    /// A tile of any size and at any offset, with the denoise running.
    ///
    /// **The odd cases are the ordinary ones.** The loupe rounds a span to whole pixels, so it asks
    /// for odd widths and odd origins about half the time. The decode grows the region by the
    /// demosaic's reach and the denoise's window and aligns the origin to a whole CFA site, and it
    /// has to align the far edge too: the denoise pairs samples into 2x2 sites and refuses - by
    /// assertion, not by declining - a region that does not. That panic was reachable from an
    /// ordinary drag of the magnifier, and nothing here decoded a tile at all.
    #[test]
    fn a_tile_of_any_size_survives_the_denoise() {
        let detail = crate::galosh::Detail::at(20.0, 30.0);
        assert!(detail.could_do_anything(), "the denoise has to run or this tests nothing");
        for (left, top, width, height) in
            [(2000, 1400, 400, 400), (2000, 1400, 401, 400), (2001, 1401, 400, 401), (2001, 1401, 401, 401)]
        {
            let tile = crate::Tile { left, top, width, height };
            let frame = crate::decode_tile(
                canon().to_str().unwrap(),
                viewing(canon().to_str().unwrap(), tile),
                detail,
                crate::galosh::Fit::Measure,
                crate::RENDITION_TILE_HALO,
            )
            .unwrap_or_else(|| panic!("the {width}x{height} tile at {left},{top} declined"));
            assert_eq!((frame.width, frame.height), (width, height));
        }
    }

    /// A tile large enough to be cut into more than one is still the frame's own samples.
    ///
    /// **The size is the whole point.** Past `RENDER_TILE` the region is demosaiced in pieces
    /// rather than in one pass, which is a second route through the decode for a caller that
    /// cannot tell it took one - so it has to land on exactly what the whole frame does. Nothing
    /// smaller reaches it: `a_tile_is_graded_as_the_rendition_is` cuts 512 and its grown region
    /// stays inside one tile.
    ///
    /// The denoise is off because it fits whatever region it is shown, so with it on this would be
    /// comparing two fits rather than the tiling.
    ///
    /// **Both widths, because a seam at an odd offset is the case that broke.** The demosaic's
    /// window is aligned down to an even origin, so a tile boundary on an odd column left it a
    /// pixel short of RCD's margin and border-extended the last column - one seam, invisible in a
    /// mean and worth thousands of counts on an edge. The two widths differ by one in their half,
    /// so whichever parity the region's own inset lands on, one of them puts a boundary on an odd
    /// column.
    #[test]
    fn a_tile_past_one_render_tile_is_the_frame_it_was_cut_from() {
        let detail = crate::galosh::Detail::at(0.0, 0.0);
        assert!(!detail.could_do_anything(), "a fitted denoise would not compare against the frame");
        let path = canon();
        let path = path.to_str().unwrap();
        let whole = pollster::block_on(
            crate::decode_rawler::decode(path, detail).expect("the whole frame").to_host(),
        )
        .expect("the frame reads back");
        let frame = whole.samples16().expect("16-bit");

        // Large enough that the region grown around it crosses 2048 on both axes.
        for span in [2200usize, 2202] {
            let tile = crate::Tile { left: 700, top: 900, width: span, height: span };
            let cut = crate::decode_rawler::decode_tile(
                path,
                viewing(path, tile),
                detail,
                crate::galosh::Fit::Measure,
                crate::RENDITION_TILE_HALO,
                crate::dust::Known::Off,
            )
            .and_then(|cut| pollster::block_on(cut.to_host()))
            .expect("the tile");
            assert_eq!((cut.width, cut.height), (tile.width, tile.height));

            let cut_samples = cut.samples16().expect("16-bit");
            let mut worst = 0u32;
            for row in 0..cut.height {
                for col in 0..cut.width {
                    for channel in 0..3 {
                        let from = ((tile.top + row) * whole.width + tile.left + col) * 3 + channel;
                        let to = (row * cut.width + col) * 3 + channel;
                        worst = worst.max(u32::from(frame[from].abs_diff(cut_samples[to])));
                    }
                }
            }
            assert_eq!(worst, 0, "the {span} tile is not what the frame decoded to");
        }
    }

    /// **A RAF carries an embedded preview, and the camera match is fitted against it.**
    ///
    /// rawler's RAF decoder could already find the JPEG and only ever handed it back decoded, so
    /// the trait's default answered `None` and this format had no embedded preview at all. What
    /// that costs is not a thumbnail: `open::matched` fits the grade against the camera's own
    /// rendering, so a body with no preview renders down the neutral arm and every Fuji photograph
    /// would have been graded less accurately than every Sony one for a reason nothing reported.
    #[test]
    fn a_raf_hands_back_the_preview_the_camera_wrote() {
        let jpeg = crate::decode_rawler::upright_preview_jpeg(
            fuji().to_str().unwrap(),
            crate::decode_rawler::Preview::Largest,
        )
        .expect("the embedded JPEG");
        assert_eq!(&jpeg[..2], &[0xff, 0xd8], "a JPEG starts with SOI");
        // Large enough to be the camera's own rendering rather than a thumbnail, which is what the
        // match needs: the fit pairs pixels against the RAW render.
        assert!(jpeg.len() > 100_000, "only {} bytes came back", jpeg.len());
    }

    /// Asking for more colour denoising never returns a rougher picture.
    ///
    /// **The amount is a distance up the chroma pyramid, and a level is an anchor rather than a
    /// knob**, so a threshold crossed part way along the track can bring in a level that makes the
    /// picture worse and nothing about the slider would say so. On a period wider than a 2x2 that
    /// is what happened: `chroma_extract_halfres` takes its value over a whole period, so every
    /// level above the first has three times the support it has on a 2x2, and past the first that
    /// support has crossed the picture's own edges - which the joint upsample then puts back against
    /// luma's, as a coloured blotch. Measured before the divide, on this frame's darkest blue, the
    /// track fell to 1.72/3.52 at 33 and jumped to 2.55/3.98 at 40, `walks_third` turning the
    /// quarter-resolution level on at 33.3.
    ///
    /// The claim is the end of the track against the middle of it, which is where the jump was, and
    /// it is made on the mosaic rather than on a render: a rendered roughness runs through the gamut
    /// rule and the tone curve, neither of which is linear, so it is not a measurement of what the
    /// denoise did.
    #[test]
    fn more_colour_denoising_does_not_return_a_rougher_mosaic() {
        let path = fuji_noisy();
        let path = path.to_str().unwrap();
        let read = |colour: f64| {
            let detail = crate::galosh::Detail::at(0.0, colour);
            pollster::block_on(
                crate::decode_rawler::decode(path, detail).expect("the frame").to_host(),
            )
            .expect("the frame reads back")
        };
        // Neighbour to neighbour over the green channel, which every position of the period holds
        // something of, against the level - the same shape of measure the pane test takes.
        let roughness = |frame: &crate::frame::Frame| {
            let samples = frame.samples16().expect("16-bit");
            let (x0, y0, side) = (2078usize, 1020, 64);
            let at = |x: usize, y: usize| f64::from(samples[(y * frame.width + x) * 3 + 1]);
            let (mut sum, mut step) = (0.0, 0.0);
            for y in y0..y0 + side {
                for x in x0..x0 + side {
                    sum += at(x, y);
                    if x > x0 {
                        step += (at(x, y) - at(x - 1, y)).abs();
                    }
                }
            }
            step / sum.max(1.0)
        };

        let middle = roughness(&read(40.0));
        let top = roughness(&read(100.0));
        assert!(
            top <= middle * 1.02,
            "the track's top reads {top:.4} against {middle:.4} at forty, so asking for more \
             colour denoising returned a rougher picture",
        );
    }

    /// A saturated colour keeps its brightness and its smoothness through the gamut rule.
    ///
    /// **Both halves come off one line and this is where they were visible.** `in_gamut` took the
    /// luma it pulls a colour towards from the triple as the matrix left it, a negative channel
    /// included - and green's weight is the largest of the three, so an out-of-gamut colour
    /// subtracted its own out-of-gamut channel from its in-gamut ones. The deepest blue pane of
    /// this frame left the matrix at (+0.00002, -0.01056, +0.14775), whose luma is 0.0016 where its
    /// positive part's is 0.0088, and the pane rendered at a twentieth of the body's own answer.
    /// The strength of the correction divides by that same luma, so the photosites' noise landed in
    /// it and desaturated every pixel by a different amount, which is speckle.
    ///
    /// The window is inside one pane rather than across the window's leading, so what it holds is
    /// one colour and the smoothness below means what it says. Both bounds sit an order of
    /// magnitude clear of either state, measured by putting the line back: with the triple's luma
    /// the pane reads **0.451** of diffuse white and varies by **0.809** of itself from one pixel
    /// to the next, and with the positive part's it reads 1.686 and 0.073. What they are for is a
    /// collapse, not a tuning.
    #[test]
    fn a_saturated_pane_keeps_its_brightness_and_comes_back_smooth() {
        let path = fuji_noisy();
        let frame =
            crate::decode_frame_denoised(path.to_str().unwrap(), 0, crate::galosh::Detail::at(0.0, 0.0), crate::galosh::Fit::Only)
                .expect("the frame decodes");
        let samples = frame.samples16().expect("16-bit");
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        let levels = crate::hdr::levels_of(gpu, samples, frame.width, frame.height, 0.9)
            .expect("the frame has levels");
        let white = levels.white.raw();

        let (x0, y0, side) = (2030usize, 980usize, 64usize);
        let blue = |x: usize, y: usize| f64::from(samples[(y * frame.width + x) * 3 + 2]);
        let mut sum = 0.0;
        let mut step = 0.0;
        let mut seen = 0.0;
        for y in y0..y0 + side {
            for x in x0..x0 + side {
                sum += blue(x, y);
                if x > x0 {
                    step += (blue(x, y) - blue(x - 1, y)).abs();
                }
                seen += 1.0;
            }
        }
        let mean = sum / seen;
        let roughness = step / seen / mean.max(1.0);
        assert!(
            mean / white > 1.0,
            "the pane came back at {:.3} of diffuse white, where its own photosites put it near two",
            mean / white,
        );
        // Neighbour to neighbour, against the level: a colour whose gamut correction is decided
        // per pixel by its own noise varies by a large fraction of itself over one pixel.
        assert!(roughness < 0.12, "the pane varies by {roughness:.3} of itself from pixel to pixel");
    }

    /// **What the denoise takes off an X-Trans frame is noise, and not the pattern.**
    ///
    /// The failure this exists for is a picture rather than a panic: a denoise that reads the
    /// mosaic on the wrong periodicity returns a plausible frame at the right exposure, with a maze
    /// woven into every flat surface, and every aggregate a looser test could take of it passes.
    /// So the claim is about the *residual* - what the filter removed - and it is that the residual
    /// has no 6x6 structure. Removing noise takes the same amount from every position of the
    /// period; laying a maze does not, and the thirty-six positions separate.
    ///
    /// **Measured on the picture and not on the residual.** The residual is allowed to be
    /// pattern-shaped - a green photosite carries four fifths of the period and its neighbourhood
    /// is not a red's, so a filter that works takes a different amount at each position. What may
    /// not happen is that the *picture* comes back modulated by the period, which is what a maze is:
    /// averaged over a whole frame the scene falls out of a position's mean and the CFA-correlated
    /// part is all that is left.
    ///
    /// **Both bodies, because the lit one barely exercises it.** The amount a slider asks for is a
    /// multiple of the noise the frame was measured to have, so at ISO 160 the filter moves very
    /// little and a maze it laid would be faint enough to sit inside this margin. The ISO 4000 frame
    /// is where the denoise does its whole job, and so where a wrong periodicity has the most to
    /// write into the picture.
    #[test]
    fn the_denoise_takes_no_pattern_off_an_xtrans_frame() {
        for path in [fuji(), fuji_noisy()] {
            the_denoise_takes_no_pattern_off(path.to_str().unwrap());
        }
    }

    fn the_denoise_takes_no_pattern_off(path: &str) {
        let read = |detail| {
            pollster::block_on(
                crate::decode_rawler::decode(path, detail).expect("the frame").to_host(),
            )
            .expect("the frame reads back")
        };

        let plain = read(crate::galosh::Detail::at(0.0, 0.0));
        let asked = crate::galosh::Detail::at(80.0, 80.0);
        assert!(asked.could_do_anything(), "the sliders have to be asking for something");
        let filtered = read(asked);
        let fit = filtered.noise.expect("an X-Trans mosaic is one GALOSH fits");
        assert!(fit.usable(), "the fit this frame was denoised at is {fit:?}");

        let before = plain.samples16().expect("16-bit");
        let after = filtered.samples16().expect("16-bit");
        assert_ne!(before, after, "the sliders asked for a denoise and nothing moved");

        let width = filtered.width;
        let patterning = |samples: &[u16]| {
            let mut sums = [0.0f64; 36];
            let mut counts = [0.0f64; 36];
            let mut total = 0.0f64;
            // The green channel, which every position of an X-Trans period has something to say
            // about.
            for (at, value) in samples.iter().enumerate().skip(1).step_by(3) {
                let pixel = at / 3;
                let slot = (pixel / width) % 6 * 6 + (pixel % width) % 6;
                sums[slot] += *value as f64;
                counts[slot] += 1.0;
                total += *value as f64;
            }
            let n: f64 = counts.iter().sum();
            let mean = total / n;
            let spread = (sums.iter().zip(counts).map(|(sum, c)| (sum / c - mean).powi(2)).sum::<f64>()
                / 36.0)
                .sqrt();
            spread / mean
        };

        let (was, is) = (patterning(before), patterning(after));
        assert!(
            is <= was + 1e-4,
            "the denoised frame's thirty-six positions differ by {is} of its own level against the \
             undenoised {was}, which is a maze laid over the picture",
        );
    }

    /// The denoise alone, straight off the demosaic with nothing after it, at 1:1 on the noisy
    /// X-Trans frame: flat plaster in shadow for the luma, the halo and lettering for the edges and
    /// the chroma.
    #[test]
    fn the_denoise_at_each_setting_is_the_one_last_looked_at() {
        use crate::snapshot::{Anchoring, Frame, Snapshot, Tolerance};
        let path = fuji_noisy();
        let path = path.to_str().unwrap();
        let decode = |detail| crate::decode_rawler::decode(path, detail).expect("the frame");
        let crops = [
            crate::px::Rect::<crate::px::Drawn>::exact(300, 2100, 256, 256),
            crate::px::Rect::exact(1900, 700, 256, 256),
        ];

        let off = decode(crate::galosh::Detail::at(0.0, 0.0));
        let resident = off.resident().expect("the decode leaves the frame on the device");
        let samples = pollster::block_on(resident.host()).expect("the frame reads back");
        // One anchoring for every setting, off the undenoised frame, so only the denoise moves.
        let levels = crate::hdr::levels_of(adapter(), &samples, off.width, off.height, 0.995)
            .expect("the frame has levels");
        let anchoring = Anchoring {
            levels: levels.anchored(),
            reference_white_nits: crate::light::Light::exactly(203.0),
        };
        // Measured across NVIDIA, radv and lavapipe: 173 codes worst, on single pixels, mean 0.006.
        let tolerance = Tolerance { worst: 512, mean: 0.1 };

        Snapshot::crops(Frame::Scene(resident, anchoring), &crops).check("denoise/off", tolerance);
        for (name, detail) in [
            ("denoise/auto", crate::galosh::Detail::AUTO),
            ("denoise/full", crate::galosh::Detail::at(100.0, 100.0)),
        ] {
            let frame = decode(detail);
            let resident = frame.resident().expect("the decode leaves the frame on the device");
            Snapshot::crops(Frame::Scene(resident, anchoring), &crops).check(name, tolerance);
        }
    }

    /// The same claim on an X-Trans body, where it is a much sharper one.
    ///
    /// **Six phases to land on, five of them wrong.** A loupe tile's region is lifted out of the
    /// mosaic at an origin the tile decides, and the demultiplexing reads a photosite's colour from
    /// where it sits *inside that region* - so an origin off the period relabels every sample. On a
    /// 2x2 pattern there is one wrong phase and it rotates the colours; on a 6x6 there are five, and
    /// what comes back has the right shape and a lattice of false colour through it. Byte equality
    /// against the whole frame is what says the region kept the frame's own phase, and the origin
    /// below is deliberately on none of the boundaries anything aligns to.
    #[test]
    fn an_xtrans_tile_is_the_frame_it_was_cut_from() {
        let detail = crate::galosh::Detail::at(0.0, 0.0);
        assert!(!detail.could_do_anything(), "a fitted denoise would not compare against the frame");
        let path = fuji();
        let path = path.to_str().unwrap();
        let whole = pollster::block_on(
            crate::decode_rawler::decode(path, detail).expect("the whole frame").to_host(),
        )
        .expect("the frame reads back");
        let frame = whole.samples16().expect("16-bit");

        let tile = crate::Tile { left: 703, top: 901, width: 512, height: 512 };
        let cut = crate::decode_rawler::decode_tile(
            path,
            viewing(path, tile),
            detail,
            crate::galosh::Fit::Measure,
            crate::RENDITION_TILE_HALO,
            crate::dust::Known::Off,
        )
        .and_then(|cut| pollster::block_on(cut.to_host()))
        .expect("the tile");
        assert_eq!((cut.width, cut.height), (tile.width, tile.height));

        let cut_samples = cut.samples16().expect("16-bit");
        let mut worst = 0u32;
        for row in 0..cut.height {
            for col in 0..cut.width {
                for channel in 0..3 {
                    let from = ((tile.top + row) * whole.width + tile.left + col) * 3 + channel;
                    let to = (row * cut.width + col) * 3 + channel;
                    worst = worst.max(u32::from(frame[from].abs_diff(cut_samples[to])));
                }
            }
        }
        assert_eq!(worst, 0, "the tile is not what the frame decoded to");
    }

    /// The band the *page* asks for is the open's own frame over those rows.
    ///
    /// **Where the strips are actually drawn from.** The claim below is about the decode's half;
    /// this is about everything above it, and the two are not the same call: a band goes through
    /// `tile::prepared_async`, which grows the window past the rows asked for so the sharpen has
    /// context either side and reports the rectangle back in `keep`. A caller that draws the
    /// window rather than `keep` of it slides the picture down the frame by the halo and runs off
    /// the end of the buffer at the last strip.
    ///
    /// The levels, the noise fit, the aberration and the match are the open's, handed in exactly as
    /// `wasm::HeldRaw` hands them. Every one of those is fitted over a whole frame, so a band left
    /// to work one out describes its own rows: a white quantile of one strip, an envelope of one
    /// strip's noise, a channel residual of one strip's edges. That is a photograph assembled from
    /// pieces each corrected to a different standard, and it is what this fails on.
    #[test]
    fn a_band_the_page_asks_for_is_the_open_over_those_rows() {
        // Off neither end of the track, and the same number the band is handed: a whole frame and a
        // strip of it deconvolve the same blur or the comparison below is measuring the amount.
        const SHARPEN: f64 = 0.6;
        let bytes = std::fs::read(canon()).expect("the fixture reads");
        let request = crate::edit::EditRequest {
            long_edge: 0,
            grade: crate::hdr::Grade {
                peak_nits: crate::light::Light::exactly(1000.0),
                reference_white_nits: crate::light::Light::exactly(203.0),
                white_quantile: 0.995,
            },
            defringe: 0.5,
            // **Seeded with particles, because this fixture has none to find** - it was shot at
            // f/2.8, where the pupil spreads a speck's shadow into nothing. Arriving this way is
            // also the ordinary case: a photograph that has been opened before carries its spots
            // in the sidecar, and this is the route by which a band ever sees them.
            photo_analysis: Some(crate::photo_analysis::encode(
                &crate::photo_analysis::PhotoAnalysis {
                    from_raw: crate::photo_analysis::FromRaw {
                        dust: Some(particles()),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )),
            denoise_luminance: Some(40.0),
            denoise_colour: Some(40.0),
            // **On, and that is the point of it being on here.** The frame corrects from that list
            // and the bands are handed it through the analysis; a band that looked for its own, or
            // that was handed coordinates in the wrong space, would divide a shadow out of the
            // wrong photosites and this is what says so.
            dust: crate::dust::Settings { enabled: true, sensitivity: 0.5, intensity: 1.0 },
            repairs: Vec::new(),
        };

        let held = pollster::block_on(crate::decode::hold_bytes(&bytes)).expect("held");
        let Some(fit) = pollster::block_on(held.fit()) else { return };
        let frame = pollster::block_on(held.frame(
            request.detail(),
            request.long_edge,
            crate::galosh::Fit::Given(fit),
            request.dust.wanted(request.stored().from_raw.dust.as_deref()),
        ))
        .expect("the whole frame");
        // Taken to the host here because this is the comparison: the browser draws this frame
        // where it lies and never asks for the samples.
        let whole = pollster::block_on(async {
            crate::edit::from_frame(frame, &bytes, true, &request, SHARPEN).await?.shipped().await
        })
        .expect("the open");
        let (width, height) = (whole.header.width, whole.header.height);

        let rows = 512;
        for top in [0usize, rows, height - rows] {
            let band = pollster::block_on(crate::tile::prepared_async(
                crate::tile::Source::Held(&held),
                &crate::tile::TileRequest {
                    tile: [0, top, width, rows],
                    frame: [width, height],
                    grade: request.grade,
                    strengths: crate::image::Strengths {
                        sharpen: SHARPEN,
                        defringe: request.defringe,
                    },
                    denoise_luminance: request.denoise_luminance,
                    denoise_colour: request.denoise_colour,
                    dust: request.dust,
                    adjust: crate::gpu::Adjust::none(),
                    levels: Some(crate::tone::Levels {
                        white: whole.header.white,
                        peak: whole.header.peak,
                        floor: whole.header.floor,
                    }),
                    noise_fit: Some(fit),
                    // The open's, through the analysis below: a band that read its own off a few
                    // hundred rows would sharpen the frame at a different blur down its length.
                    capture_sigma: None,
                    sensor_long: Some(held.picture_long()),
                    defocus: crate::base::Defringe::Take(whole.header.defocus),
                    photo_analysis: whole.header.photo_analysis.clone(),
                            scale: crate::view::Scale::Full,
                    repairs: Vec::new(),
                },
            ))
            .expect("the band");

            let [keep_left, keep_top, keep_width, keep_height] = band.keep;
            assert_eq!((keep_width, keep_height), (width, rows), "the band changed size");
            let (mut worst, mut worst_at) = (0u32, 0usize);
            for row in 0..keep_height {
                for col in 0..keep_width {
                    for channel in 0..3 {
                        let from = ((top + row) * width + col) * 3 + channel;
                        let to = ((keep_top + row) * band.width + keep_left + col) * 3 + channel;
                        let diff = u32::from(whole.samples[from].abs_diff(band.samples[to]));
                        if diff > worst {
                            (worst, worst_at) = (diff, top + row);
                        }
                    }
                }
            }
            assert!(
                worst <= 8,
                "the band at row {top} differs from the open by {worst}, at row {worst_at}",
            );
        }
    }

    /// Particles to correct with, spread down the frame so no band escapes having one.
    ///
    /// **Placed rather than found**, because both fixtures were shot wide open: a shadow at f/2.8
    /// is the pupil's image of a speck too small to survive it, so `dust::detect` correctly reports
    /// nothing on either file and a test resting on it would pass having corrected no pixel. The
    /// claim the fixtures can settle is where a correction lands, and for that a made list is
    /// better - it is deterministic, and it can be put exactly on the seams.
    ///
    /// Coordinates are the sensor's own, halved, which is the space a `Spot` speaks.
    fn particles() -> Vec<crate::dust::Spot> {
        [(420.0, 260.0), (900.0, 1040.0), (1500.0, 1560.0), (760.0, 2260.0)]
            .into_iter()
            .map(|(x, y)| crate::dust::Spot {
                x,
                y,
                scale: 7.0,
                axes: (1.1, 1.0 / 1.1),
                // On the unit circle, as the search's `(cos, sin)` is and `Spot::from_words` insists.
                turn: (0.8, 0.6),
                snr: 6.0,
                profile: std::array::from_fn(|bin| {
                    let along = (bin as f32 + 0.5) / crate::dust::BINS as f32 * crate::dust::SPAN;
                    0.12 * (1.4 - along).clamp(0.0, 1.0)
                }),
            })
            .collect()
    }

    /// A band cut out of a held mosaic is the frame that mosaic decodes to.
    ///
    /// **The claim the editor's progressive re-prepare rests on.** A Detail slider re-runs the
    /// decode from the mosaic down, in horizontal strips, so a reader watches the picture arrive a
    /// band at a time - and every one of those strips has to be the same pixels the whole frame
    /// would have produced, or the photograph is assembled out of pieces that disagree.
    ///
    /// Denoised, unlike `a_tile_past_one_render_tile_is_the_frame_it_was_cut_from`, because the
    /// denoise is the whole reason a band exists: it is what a slider moves and what the strips
    /// are waiting for. The fit is handed in rather than measured per band - Phase 0 reduces over
    /// whatever region it is shown, so a band fitting itself is filtered at its own statistics and
    /// the strips step against each other down the frame. That is the failure this pins.
    #[test]
    fn a_band_of_a_held_mosaic_is_the_frame_it_was_cut_from() {
        let detail = crate::galosh::Detail::at(40.0, 40.0);
        assert!(detail.could_do_anything(), "a band that filters nothing proves nothing");
        let path = canon();
        let bytes = std::fs::read(&path).expect("the fixture reads");

        let held = pollster::block_on(crate::decode::hold_bytes(&bytes)).expect("held");
        let Some(fit) = pollster::block_on(held.fit()) else { return };

        // On here as well as in the band test above, and for a sharper reason: this is the half
        // where the coordinates are, so a spot placed in the window's space rather than the
        // sensor's shows up as a band that differs from the frame exactly where a particle is.
        let settings =
            crate::dust::Settings { enabled: true, sensitivity: 0.5, intensity: 1.0 };
        // **Handed in, never detected.** Both fixtures were shot wide open, where a particle's
        // shadow is spread by the pupil until there is nothing left of it - so the detection
        // correctly finds none, and a test that relied on it would report green having corrected
        // nothing. What is being pinned here is the *placing*, so the list is made rather than
        // measured, and every band then has something to get wrong.
        let spots = particles();

        // The frame the whole photograph makes at those amounts, off the same mosaic.
        let decoded = pollster::block_on(held.frame(
            detail,
            0,
            crate::galosh::Fit::Given(fit),
            settings.wanted(Some(&spots)),
        ))
        .expect("the whole frame");
        let whole = pollster::block_on(decoded.to_host()).expect("the frame on the host");
        let frame = whole.samples16().expect("16-bit");

        // Bands across the seam rather than one: a strip that only ever ran at the top would not
        // show a halo that was grown on the wrong side. The last is there because it is the one
        // band whose window cannot grow downwards, so it is where a rule about the region's edge
        // and a rule about the photograph's stop being the same rule.
        let rows = 512;
        for top in [0usize, rows, 2 * rows, whole.height - rows] {
            if top + rows > whole.height {
                break;
            }
            let tile = crate::Tile { left: 0, top, width: whole.width, height: rows };
            let cut = pollster::block_on(async {
                held.window(
                    crate::px::Rect::exact(tile.left, tile.top, tile.width, tile.height),
                    crate::view::Scale::Full,
                    detail,
                    crate::galosh::Fit::Given(fit),
                    crate::RENDITION_TILE_HALO,
                    settings.known(&spots),
                )
                .await?
                .to_host()
                .await
            })
            .expect("the band");
            assert_eq!((cut.width, cut.height), (tile.width, tile.height));

            let cut_samples = cut.samples16().expect("16-bit");
            let mut worst = 0u32;
            for row in 0..cut.height {
                for col in 0..cut.width {
                    for channel in 0..3 {
                        let from = ((top + row) * whole.width + col) * 3 + channel;
                        let to = (row * cut.width + col) * 3 + channel;
                        worst = worst.max(u32::from(frame[from].abs_diff(cut_samples[to])));
                    }
                }
            }
            assert_eq!(worst, 0, "the band at row {top} is not what the whole frame decoded to");
        }
    }

    /// The fit taken alone is the fit the denoise takes, and neither depends on the size asked for.
    ///
    /// Both halves matter. The first is what makes `Fit::Only` a prefix of the chain rather than a
    /// second estimator that happens to agree today. The second is what lets one measurement answer
    /// for the editor's frame, every loupe tile and every rendition: the halving decision comes
    /// after the denoise, so both of these see the same full-resolution mosaic.
    #[test]
    fn the_fit_alone_is_the_fit_the_denoise_makes() {
        let detail = crate::galosh::Detail::at(20.0, 30.0);
        for path in [sony(), canon()] {
            let path = path.to_str().unwrap().to_string();
            let denoised =
                crate::decode_frame_denoised(&path, 0, detail, Default::default())
                    .and_then(|frame| frame.noise)
                .expect("the denoise fits the frame");
            let bytes = std::fs::read(&path).expect("the fixture reads");
            for long_edge in [0u32, 1000] {
                let alone =
                    crate::decode_frame_bytes(&bytes, long_edge, crate::galosh::Fit::Only)
                        .and_then(|frame| frame.noise)
                        .expect("the fit alone");
                assert_eq!(alone, denoised, "{path} fitted differently at {long_edge}");
            }
        }
    }

    /// An unset Detail is this frame's own measurement, and the decode is where that is resolved.
    ///
    /// **The failure it exists for is silent.** `Detail::AUTO` reaching a gate that reads it as
    /// zero, or a fit measured after the amount was fixed, both produce a photograph - an
    /// undenoised one, or one denoised at whatever the fallback was - and every other test in this
    /// file passes because every other test names its numbers. So the claim is that the automatic
    /// decode lands on exactly the explicit decode at the numbers the ramp asks for, off the fit
    /// the automatic decode itself reports.
    ///
    /// **And that at least one fixture is filtered, or the equality above is two undenoised frames
    /// agreeing.** Both fixtures are daylight, which is the half of the ramp that declines: the
    /// Canon's read floor is 9.9e-5 against a `GATE` of 6e-4 and resolves to 0/0, and the Sony's is
    /// 7.0e-4, just over, resolving to 2/6. So the Sony carries the whole claim and carries it at
    /// the bottom of the track - the coarse chroma levels are not reached here, and
    /// `the_suggested_colour_runs_ahead_of_the_luminance` is what pins the ramp where they are. A
    /// ramp moved until the Sony was declined too would leave this green and empty, which is what
    /// the count at the end refuses.
    #[test]
    fn an_unset_detail_is_the_frame_it_was_measured_on() {
        let mut filtered = 0;
        for path in [sony(), canon()] {
            let path = path.to_str().unwrap().to_string();
            let auto = crate::decode_frame_denoised(
                &path,
                0,
                crate::galosh::Detail::AUTO,
                crate::galosh::Fit::Measure,
            )
            .expect("the frame decodes");
            let fit = auto.noise.expect("an automatic decode measures the frame");
            let (luminance, colour) = crate::galosh::Detail::AUTO.resolved(Some(fit));
            if crate::galosh::Detail::AUTO.amounts(Some(fit)).does_anything() {
                filtered += 1;
            }

            let asked = crate::decode_frame_denoised(
                &path,
                0,
                crate::galosh::Detail::at(luminance, colour),
                crate::galosh::Fit::Given(fit),
            )
            .expect("the frame decodes");
            let (from_auto, from_asking) =
                (auto.samples16().expect("16-bit"), asked.samples16().expect("16-bit"));
            let apart = from_auto.iter().zip(from_asking).filter(|(a, b)| a != b).count();
            assert_eq!(
                apart, 0,
                "{path} at an unset Detail differs from one asked for {luminance}/{colour} at \
                 {apart} of {} samples",
                from_auto.len(),
            );
        }
        assert!(filtered > 0, "every fixture was declined, so the comparison above filtered nothing");
    }

    /// The fit these sensors actually have, held against the numbers rather than against itself.
    ///
    /// **Every other test of the fit is relative**, and that is the gap this fills. `the_fit_alone_
    /// is_the_fit_the_denoise_makes` compares two routes of the same build, the region and band
    /// tests compare a window against the frame it was cut from - so a change that moved the fit
    /// *everywhere* passes all of them, and every pixel of every photograph is scaled by these
    /// numbers. `DR_WORKGROUPS` is exactly such a change: widening the reduction moves the last
    /// bits of `dark_ref`, and nothing but this would have noticed.
    ///
    /// Loose enough not to fail on a driver's summation order, tight enough that a real move in the
    /// model is a failure: shot noise and read noise to a part in a thousand, the dark reference to
    /// a thousandth of a level, which is far inside the `ACHROMATIC_RANGE` of 4 the slots are
    /// gated on.
    #[test]
    fn the_fit_is_the_one_this_sensor_has() {
        let detail = crate::galosh::Detail::at(20.0, 30.0);
        // alpha, sigma_sq, and the four dark reference slots, in the conditioned mosaic's own
        // units - where full scale is the most amplified channel's saturation
        // (`decode_rawler::channel_ceilings`), so the scale is the frame's white balance spread
        // below what a reader might expect. `alpha` tracks it, 0.350 against 0.353 on the Sony
        // and 0.536 against 0.524 on the Canon.
        let recorded = [
            (
                sony(),
                0.0000519686_f32,
                0.0000005350266_f32,
                [31.926577_f32, 31.907892, 31.890705, 31.73153],
            ),
            (
                canon(),
                0.000018469538,
                0.00000002887757,
                [30.684685, 30.435102, 30.445705, 30.55717],
            ),
        ];
        for (path, alpha, sigma_sq, dark) in recorded {
            let path = path.to_str().unwrap().to_string();
            let fit = crate::decode_frame_denoised(&path, 0, detail, Default::default())
                .and_then(|frame| frame.noise)
                .expect("the denoise fits the frame");
            let near = |got: f32, want: f32, tol: f32, what: &str| {
                assert!(
                    (got - want).abs() <= tol,
                    "{path} fitted {what} {got}, where this sensor reads {want}",
                );
            };
            near(fit.alpha, alpha, alpha.abs() * 1e-3 + 1e-9, "alpha");
            near(fit.sigma_sq, sigma_sq, sigma_sq.abs() * 1e-3 + 1e-9, "sigma_sq");
            for (slot, want) in fit.dark_ref.iter().zip(dark) {
                near(*slot, want, 1e-3, "a dark reference slot");
            }
        }
    }

    /// What the automatic Detail is chosen from ranks these five photographs the way their
    /// sensitivities do.
    ///
    /// **The one property `read_noise` has to have, and the only one it is used for.** Nothing reads
    /// its absolute value: `suggested_amount` ramps it between a gate and a span, so what decides
    /// whether a photograph is filtered is where it sits against the others. Five frames over 40x of
    /// ISO, two sensor patterns interleaved, and the order has to be the ISO order.
    ///
    /// It was not. `ne_dark_finalize` took `alpha * dark_thresh * 0.5` back out of the measurement
    /// as shot noise's share of it, and that guess at the dark population's level is five to ten
    /// times under what the population actually sits at - so the correction landed anywhere between
    /// 6% and 89% of the measurement depending on the frame's own histogram. The ISO 4000 X-Trans
    /// frame lost 89% of its, came out reading like a base-ISO frame, and opened undenoised.
    ///
    /// A strict ordering rather than a tolerance, because a rule that ramps cannot be stated as a
    /// number per frame without pinning this machine's GPU into the suite.
    ///
    /// **Three bodies, so the ordering is worth only as much as its margins.** `read_noise`'s own
    /// doc records base-ISO frames spanning 0.17 to 0.52 of a thousandth across the 42-frame
    /// library, which is threefold at one end of the scale - so five frames from three sensors
    /// could in principle order by sensor rather than by sensitivity. Measured here they do not:
    /// 0.00017, 0.00052, 0.00072, 0.00154, 0.00267, whose tightest neighbouring gap is the Sony at
    /// 640 over the X-T3 at 160, and that is still 1.38x. Nothing a reduction order moves is near
    /// that. A frame swapped into this list wants the gaps checked again.
    #[test]
    fn the_dark_variance_orders_the_fixtures_by_iso() {
        // The sensitivity each fixture was shot at, which is the premise the ordering is against.
        let frames = [(125, canon()), (160, fuji()), (640, sony()), (4000, fuji_noisy()), (5000, clipped())];
        let mut measured = Vec::new();
        for (iso, path) in frames {
            let path = path.to_str().unwrap().to_string();
            let fit = crate::decode_frame_denoised(
                &path,
                0,
                crate::galosh::Detail::at(0.0, 0.0),
                crate::galosh::Fit::Only,
            )
            .and_then(|frame| frame.noise)
            .expect("every fixture here has a mosaic to fit");
            measured.push((iso, path, fit.model().read_noise()));
        }
        for pair in measured.windows(2) {
            let [(lower_iso, lower_path, lower), (higher_iso, higher_path, higher)] = pair else {
                unreachable!("windows(2) yields pairs")
            };
            assert!(
                higher > lower,
                "{higher_path} at ISO {higher_iso} reads {higher} against {lower_path} at ISO \
                 {lower_iso} reading {lower}, so the ramp would filter the quieter frame harder",
            );
        }
    }

    /// Both of the defringe's noise inputs survive the decode, which no other test would miss.
    ///
    /// `measure_defocus` takes them as `Option`, and every unit test of it passes `None` because a
    /// GPU fixture has neither. So a refactor that stopped `decode_rawler` populating either one
    /// leaves the fit falling back to a constant ceiling and the lattice's own correlations, on
    /// every photograph, with the whole suite still green.
    #[test]
    fn a_decoded_frame_carries_what_the_defringe_measures_its_noise_with() {
        let detail = crate::galosh::Detail::at(20.0, 30.0);
        for path in [sony(), canon()] {
            let path = path.to_str().unwrap().to_string();
            let frame =
                crate::decode_frame_denoised(&path, 0, detail, Default::default())
                    .expect("the frame decodes");
            assert!(frame.matrix.is_some(), "{path} decoded without its camera matrix");
            let fit = frame.noise.expect("the denoise fits the frame");
            let ceiling = crate::image::noise_ceiling(Some(fit));
            assert!(
                ceiling > 0.0 && ceiling < 1.0,
                "{path} fitted a ceiling of {ceiling}, which is not a fraction of full scale",
            );
        }
    }

    /// A denoised region is the frame's own pixels, whatever size the region is.
    ///
    /// **The denoise is the one stage that reads a neighbourhood of the region it was handed**, so
    /// it is the one that can make a window stop being a piece of the picture. `pass12` shrinks
    /// against tiles laid from the region's own origin, which is why that origin is rounded down to
    /// `SHRINK_LATTICE` - and `a_tile_is_graded_as_the_rendition_is` pins the result for one 512px
    /// rectangle in one place.
    ///
    /// One rectangle is not the claim. A region large enough to be denoised in tiles of its own, a
    /// region whose origin sits at an awkward offset, a region up against the frame's edge: each is
    /// a different arrangement of the same arithmetic, and a render that restricts its decode to a
    /// crop asks for all of them. This sweeps the sizes and origins that a crop actually produces.
    ///
    /// **On both patterns, because the origin owes the pattern as well as the shrinkage.** A region
    /// that starts a whole `SHRINK_LATTICE` in is on no whole period of a 6x6, and a denoise that
    /// read the colours one phase out is exactly what it looks like: the ISO 4000 fixture came back
    /// woven with a diagonal cross-hatch. `galosh::lattice` is what this holds.
    #[test]
    fn a_denoised_region_is_the_frame_it_was_cut_from() {
        let detail = crate::galosh::Detail::at(40.0, 40.0);
        for path in [sony(), fuji_noisy()] {
            let path = path.to_str().unwrap().to_string();
            let path = path.as_str();
            let whole = crate::decode_frame_denoised(path, 0, detail, Default::default())
                .expect("the frame decodes");
            let fit = crate::galosh::Fit::Given(whole.noise.expect("the frame fits its noise"));
            let (width, height) = (whole.width, whole.height);
            let samples = whole.samples16().expect("a 16-bit decode");

            // Small and lattice-aligned, small and not, and then large enough that the denoise tiles
            // the region as well as the frame - which is the arrangement a cropped render produces
            // and the one no test asked about.
            let regions = [
                crate::Tile { left: 504, top: 504, width: 512, height: 512 },
                crate::Tile { left: 501, top: 733, width: 512, height: 512 },
                crate::Tile { left: 800, top: 600, width: width / 2, height: height / 2 },
                crate::Tile { left: width - 900, top: height - 700, width: 896, height: 696 },
            ];
            for region in regions {
                let cut = crate::decode_tile(
                    path,
                    viewing(path, region),
                    detail,
                    fit,
                    crate::RENDITION_TILE_HALO,
                )
                .expect("the region decodes");
                assert_eq!((cut.width, cut.height), (region.width, region.height));
                let cut = cut.samples16().expect("a 16-bit decode").to_vec();

                let (mut worst, mut differing) = (0u16, 0usize);
                for row in 0..region.height {
                    for column in 0..region.width {
                        for channel in 0..3 {
                            let from =
                                ((region.top + row) * width + region.left + column) * 3 + channel;
                            let to = (row * region.width + column) * 3 + channel;
                            let off = samples[from].abs_diff(cut[to]);
                            if off > 0 {
                                differing += 1;
                            }
                            worst = worst.max(off);
                        }
                    }
                }
                assert_eq!(
                    worst, 0,
                    "{path}: a {}x{} region at {},{} differs from the frame by {worst} counts over \
                     {differing} samples",
                    region.width, region.height, region.left, region.top,
                );
            }
        }
    }

    /// A tile handed the frame's fit does not measure its own.
    ///
    /// What the loupe is for: the crop is denoised at the photograph's strength, so the magnified
    /// pixels are the ones the export would have. The tile's own fit is a different number - 0.49
    /// to 1.51 times the frame's, measured over the fixtures - so this is a real substitution and
    /// not two names for one measurement.
    #[test]
    fn a_tile_denoises_at_the_frame_it_was_cut_from() {
        let detail = crate::galosh::Detail::at(20.0, 30.0);
        let path = canon().to_str().unwrap().to_string();
        let bytes = std::fs::read(&path).expect("the fixture reads");
        let frame = crate::decode_frame_bytes(&bytes, 0, crate::galosh::Fit::Only)
            .and_then(|f| f.noise)
            .expect("the frame's fit");

        let tile = crate::Tile { left: 2000, top: 1400, width: 512, height: 512 };
        let halo = crate::RENDITION_TILE_HALO;
        let given = crate::decode_tile(&path, viewing(&path, tile), detail, crate::galosh::Fit::Given(frame), halo)
            .and_then(|f| f.noise)
            .expect("the tile decodes");
        let own = crate::decode_tile(&path, viewing(&path, tile), detail, crate::galosh::Fit::Measure, halo)
            .and_then(|f| f.noise)
            .expect("the tile decodes");

        assert_eq!(given, frame, "the tile reported something other than what it was handed");
        assert_ne!(own.alpha, frame.alpha, "the crop happens to fit the frame's own alpha");
    }

    /// A held region is the decode it stands in for, and only the rectangle it was decoded for.
    ///
    /// **The two ways a cache is wrong rather than absent.** It can miss every time, which is a
    /// cache nobody notices is doing nothing; or it can answer one rectangle with another's pixels,
    /// which is a picture of somewhere else and no test of the eviction would see it. Both need a
    /// real file, the key being the file's own identity.
    #[test]
    fn a_held_region_is_the_decode_it_stands_in_for() {
        let path = clipped();
        let source = crate::decode_rawler::mapped(path.to_str().unwrap()).expect("the fixture maps");
        let params = rawler::decoders::RawDecodeParams::default();
        // Off the grid the rest of the suite asks on, so that this test's own two calls are the
        // only ones the process-wide store has ever been asked for these rectangles.
        let asked = rawler::imgop::Rect::new(
            rawler::imgop::Point::new(3072, 2048),
            rawler::imgop::Dim2::new(1024, 768),
        );
        let elsewhere = rawler::imgop::Rect::new(
            rawler::imgop::Point::new(5120, 3072),
            rawler::imgop::Dim2::new(1024, 768),
        );

        let decodes = std::cell::Cell::new(0);
        let decode = |region: rawler::imgop::Rect| {
            decodes.set(decodes.get() + 1);
            let (image, covered) = rawler::get_decoder(&source)
                .expect("a decoder")
                .raw_image_region_tight(&source, &params, region, false)
                .expect("the region decodes");
            crate::raw_cache::Region { image, covered }
        };
        let samples = |region: &crate::raw_cache::Region| match &region.image.data {
            rawler::RawImageData::Integer(samples) => samples.clone(),
            rawler::RawImageData::Float(_) => panic!("a CFA frame came back as floats"),
        };

        let first = crate::raw_cache::region(&source, &params, asked, || Some(decode(asked)))
            .expect("the region decodes");
        let again = crate::raw_cache::region(&source, &params, asked, || Some(decode(asked)))
            .expect("the region is held");
        assert_eq!(decodes.get(), 1, "the second ask decoded the rectangle again");
        assert_eq!(samples(&first), samples(&again), "what was held is not what was decoded");
        assert_eq!(first.covered, again.covered);

        // And a rectangle the store has not been asked for is decoded rather than answered with
        // the one it holds, which is the failure a key too loose would produce.
        let other = crate::raw_cache::region(&source, &params, elsewhere, || Some(decode(elsewhere)))
            .expect("the region decodes");
        assert_eq!(decodes.get(), 2, "a rectangle nothing had decoded came back from the store");
        assert_ne!(other.covered, first.covered);
        assert_ne!(samples(&other), samples(&first), "two rectangles of one frame are identical");
    }
}

/// What the loupe magnifies has to be the export's pixels for that part of the photograph, and
/// everything a crop can measure about itself is a different number from the frame's.
mod loupe_tile {
    use super::*;

    /// A dark corner of the Sony fixture, which is where the difference is worth measuring: its
    /// own diffuse white is a third of the frame's, so a tile coded against it is lifted by that
    /// factor and rolls its highlights into a peak barely above white.
    const DARK: crate::Tile = crate::Tile { left: 500, top: 4500, width: 512, height: 512 };

    /// A tile is the export's pixels for that rectangle, and nothing about the crop leaks in.
    ///
    /// **Held against the rendition itself** - `rendition` above assembles what `job::run` writes
    /// - because that is the claim the loupe makes, and because every fault this has had was
    /// invisible to a comparison of two tiles. Each row below is one of them: a stage that read
    /// its own crop where it needed the photograph.
    ///
    /// Exact, not close. Every whole-frame quantity travels with the request, the gather is the
    /// frame's own over this window of it, and the region decoded is what that window reads plus
    /// the reach of everything that runs after it - so there is no border to allow for either.
    ///
    /// **Both fixtures, because the two answer different halves.** The Sony's fitted lens is an
    /// identity, so it holds the grade still while nothing is being warped; the Canon's is not,
    /// and it is the one that fails if a tile is corrected at its own radius rather than the
    /// photograph's.
    #[test]
    fn a_tile_is_graded_as_the_rendition_is() {
        for path in [sony(), canon()] {
            a_tile_is_the_rendition(path.to_str().unwrap());
        }
    }

    fn a_tile_is_the_rendition(path: &str) {
        let mut fitted = tile_job(path, None, None);
        fitted.match_embedded_jpeg = true;
        let base = crate::job::Base::build(&fitted, 0).expect("the frame");
        let levels = *base.levels;
        let kept = crate::photo_analysis::encode(&base.analysis);
        // The brightest block there is, for the roll-off: a crop of shadow reaches nowhere near
        // the photograph's top end, and a crop of highlight reaches most of the way to it.
        let bright = brightest(base);

        let edits: [(&str, fn(&mut crate::job::Job)); 5] = [
            // The grade alone, which is the levels and nothing else.
            ("as metered", |_| {}),
            // The deconvolution, which the tile skipped entirely and which is the whole reason a
            // reader magnifies anything.
            ("sharpened", |job| job.sharpen = 1.0),
            // The presence three, which read a blur of the picture: the scale that blur is built
            // at belongs to the photograph, and the window it averages over reaches two hundred
            // pixels past a tile's own edge.
            ("clarity and texture", |job| {
                job.adjust = crate::gpu::Adjust {
                    clarity: 60.0,
                    texture: 60.0,
                    dehaze: 25.0,
                    ..crate::gpu::Adjust::none()
                };
            }),
            // Both at once, which is the shipping default plus a slider a reader would reach for,
            // and the only case where the two reaches compose: the blur is built from the
            // sharpened window, so a kept pixel needs the blur's reach *and* the sharpen's inside
            // it. Summing them is by construction rather than by measurement - on these fixtures
            // the difference is under a count, because the deconvolution has little to do at the
            // window's edge in either region this looks at.
            ("sharpened, with clarity", |job| {
                job.sharpen = 1.0;
                job.adjust = crate::gpu::Adjust {
                    clarity: 60.0,
                    texture: 60.0,
                    ..crate::gpu::Adjust::none()
                };
            }),
            // Diffuse white far above the display peak, so the roll-off is compressing most of
            // the picture rather than only its speculars - a peak read off the crop cannot hide
            // there, where at the shipping grade this frame never reaches the knee at all.
            ("rolled hard", |job| {
                job.grade.reference_white_nits = crate::light::Light::exactly(1000.0);
                job.grade.peak_nits = crate::light::Light::exactly(50.0);
            }),
        ];
        for (what, edit) in edits {
            let built = |tile: Option<[usize; 4]>, levels: Option<crate::tone::Levels>| {
                let mut job = tile_job(path, tile, levels);
                job.match_embedded_jpeg = true;
                job.photo_analysis = Some(kept.clone());
                edit(&mut job);
                job
            };
            for (place, at) in [("shadow", DARK), ("highlight", bright)] {
                let (reference, width, _, peak) = rendition(&built(None, None), 0, Lensing::Fitted);
                let mut cut = built(Some([at.left, at.top, at.width, at.height]), Some(levels));
                // As the loupe sends it: the editor's tick measured this over the whole frame.
                cut.scene_peak = Some(peak);
                let (tile, tile_width, tile_height) = crate::job::graded(&cut).expect("the tile");

                let mut worst = 0u32;
                for row in 0..tile_height {
                    for col in 0..tile_width {
                        for channel in 0..3 {
                            let from = ((at.top + row) * width + at.left + col) * 3 + channel;
                            let to = (row * tile_width + col) * 3 + channel;
                            worst = worst.max(u32::from(reference[from].abs_diff(tile[to])));
                        }
                    }
                }
                assert_eq!(worst, 0, "{path}, {what}, over {place}: the tile is not the rendition");
            }
        }
    }

    /// A cropped render that decoded only its crop is the render that decoded everything.
    ///
    /// **The claim the restriction rests on.** A photograph cropped to a quarter has three quarters
    /// of the decode, the denoise, the coding, the defringe and the lens gather thrown away at the
    /// grade, so a cropped render asks for the rectangle its geometry reads and nothing else
    /// (`job::Base::cropped`). What must not change is the picture - the crop decides how much is
    /// decoded and nothing about what the decoded part looks like.
    ///
    /// **Two comparisons, because there are two ways to be wrong** and one number cannot tell them
    /// apart. The frame the two routes hand the grade is compared first, over the pixels they
    /// share: a difference there is the decode, the denoise, the coding, the defringe or the
    /// gather. Only then the graded output, which adds the geometry and the grade itself. A single
    /// end-to-end assertion says "something moved" and leaves half the pipeline to search.
    ///
    /// Close and not exact, and `ROUTE_COUNTS` says why the difference between the two is a
    /// coordinate's last bit rather than anything about the picture.
    #[test]
    fn a_render_that_decoded_only_its_crop_is_the_one_that_decoded_everything() {
        restricted_decode_is_the_whole_one(0);
    }

    /// The same claim at the other resolution the decode offers.
    ///
    /// **The restricted route is the one that has two coordinate spaces in it.** A request names its
    /// rectangle in the photograph's pixels and a halved decode hands back a buffer at half of them,
    /// so `tile::grown` converts the window, the reach, the texel grid and the kept rectangle and
    /// leaves only the region to read in the photograph's. Every one of those is a place to be off
    /// by a pixel, and the whole-frame route - which halves inside the decode and never converts
    /// anything - is the answer they all have to come back to.
    ///
    /// Half of the sensor's long edge exactly, because that is the only size that reaches the
    /// halving fork: anything smaller is a resize on top, which `cropped` declines.
    #[test]
    fn a_restricted_decode_at_half_is_the_whole_one_halved() {
        let path = sony();
        let header = crate::header::read_path(path.to_str().unwrap()).expect("the header reads");
        let half = (header.width.max(header.height) / 2) as u32;
        restricted_decode_is_the_whole_one(half);
    }

    /// Both of the above: the restricted decode against the whole one, at the size given.
    ///
    /// `0` is the sensor's own resolution, where the two routes agree pixel for pixel because
    /// neither converts anything.
    fn restricted_decode_is_the_whole_one(size: u32) {
        let path = sony();
        let path = path.to_str().unwrap();
        // Off-centre, straightened and turned, and small enough that the restriction is worth
        // taking - `cropped` declines a crop that reads nearly the whole picture anyway.
        let geometry = crate::image::Geometry {
            crop: [0.31, 0.22, 0.68, 0.63],
            angle_degrees: 1.75,
            rotate: 90,
            keystone: None,
        };
        let target = crate::job::Target {
            rendition: crate::job::Rendition::Full,
            output: crate::job::Output::Pq,
            output_path: String::new(),
            // The sensor's own or exactly half of it, which are the two the decode produces.
            // Anything between is a resize on top, and `cropped` declines it.
            size,
            source: crate::job::Source::Render,
            sdr_quantizer: 30,
            hdr_quantizer: 30,
            preset: 6,
            still_full_chroma: false,
            sdr_full_chroma: false,
        };
        let mut job = tile_job(path, None, None);
        job.match_embedded_jpeg = true;
        job.geometry = geometry;
        job.sharpen = 1.0;
        job.defringe = 1.0;
        job.targets = vec![target];

        // Exactly what `job::run` does with a `Base`: a whole frame is cut through the lens and
        // sharpened here, where a window arrived already through both (`tile::prepared`).
        //
        // The frame is taken out rather than borrowed, `Cut::from_base` consuming what it cuts -
        // and the rest of the base is read after this, by `graded` below.
        let framed = |base: &mut crate::job::Base| {
            let (width, height) = (base.width, base.height);
            let lens = base.matched.as_ref().map(|m| m.lens.clone());
            let taken = std::mem::replace(
                &mut base.frame,
                crate::job::Cutting::AlreadyCut(crate::hdr::Cut::host(Vec::new(), 0, 0)),
            );
            match taken {
                crate::job::Cutting::AlreadyCut(cut) => cut,
                crate::job::Cutting::OnDevice(frame) => {
                    let size =
                        crate::hdr_args::Size { width: width as u32, height: height as u32 };
                    let sigma = crate::image::deconvolve_split(
                        base.capture_sigma,
                        base.sensor_long,
                        width.max(height),
                    );
                    crate::hdr::Cut::from_base(frame, lens.as_ref(), size, job.sharpen, sigma)
                }
            }
        };
        let pixel_geometry = job.pixel_geometry();
        let graded = |base: &crate::job::Base, cut: &crate::hdr::Cut| {
            let scene = crate::tone::SceneGrade::new(
                base.matched.as_ref().map(|m| &m.colour),
                base.levels,
                job.grade.reference_white_nits,
                job.exposure,
                job.adjust,
                base.as_shot,
            );
            let gpu = crate::gpu::device().expect("an adapter");
            let mut grade = scene
                .gpu_grade(cut.width, cut.height, job.grade.peak_nits, crate::gpu::Output::Pq)
                .showing(pixel_geometry);
            if let Some(window) = base.window {
                grade = grade.windowed(window.photograph, window.origin);
            }
            let out = grade.output_size();
            // The photograph's own peak, so the two roll off against one number rather than against
            // whatever each frame happens to reach - which is the whole reason it is stored, and
            // what a window could not measure for itself.
            let peak = gpu.given_peak(4000.0);
            let up = match cut.resident() {
                Some(resident) => gpu.upload_resident(resident, &grade, &peak),
                None => gpu.upload(
                    cut.host_samples().expect("a cut holds one frame or the other"),
                    &grade,
                    &peak,
                ),
            };
            (up.encode(&grade), out)
        };

        // Measured once, and then *both* routes are handed it - which is what production does, a
        // job arriving with the photograph's analysis beside it. Measuring for one route and
        // storing for the other would compare a freshly fitted camera match against the same match
        // through the file, and the chroma lattice is kept at the `f16` its texture holds: that is
        // a fifth of a percent of colour on every pixel, which is a real difference about storage
        // and nothing to do with how much of the sensor was decoded.
        job.photo_analysis = Some(crate::photo_analysis::encode(
            // At the size the restricted route will ask for, not at the sensor's: the whole-frame
            // decode halves itself for the same floor, and the aberration it measures is keyed on
            // the resolution it was measured at.
            &crate::job::Base::build(&job, size).expect("the frame").analysis,
        ));
        let stored = crate::photo_analysis::decode(job.photo_analysis.as_ref().unwrap())
            .expect("it reads back");
        let mut whole = crate::job::Base::build(&job, size).expect("the frame");
        let mut cropped = crate::job::Base::cropped(&job, &[&job.targets[0]], &stored)
            .expect("the crop restricts the decode")
            .expect("the window builds");
        let origin = cropped.window.expect("a window").origin;
        assert!(
            cropped.width * cropped.height < whole.width * whole.height,
            "the restricted decode was not smaller than the photograph",
        );

        // The frames, over the rectangle the geometry reads. Everything below the decode is in this
        // and nothing about the geometry is.
        //
        // That rectangle rather than the whole window: a window is grown by what the sharpen reads
        // past what it writes, and its outer ring is deconvolved against a neighbourhood that stops
        // at the window's edge where the frame's carries on. That ring is halo - it exists to be
        // read past and never to be read - so comparing it would be asserting the two routes agree
        // about pixels neither of them shows.
        let out_size = crate::hdr::cropped_size(whole.width, whole.height, geometry);
        let read = crate::image::geometry_footprint((whole.width, whole.height), out_size, geometry);
        let (whole_cut, cropped_cut) = (framed(&mut whole), framed(&mut cropped));
        let (whole_w, cropped_w) = (whole_cut.width, cropped_cut.width);
        // Both routes are graded below off the same cuts, so the frames are read here rather
        // than taken: a copy for the comparison, the buffers left for the grade.
        let whole_samples = match whole_cut.resident() {
            Some(resident) => pollster::block_on(resident.host()).expect("the frame maps"),
            None => whole_cut.host_samples().expect("one or the other").to_vec(),
        };
        let cropped_samples = match cropped_cut.resident() {
            Some(resident) => pollster::block_on(resident.host()).expect("the frame maps"),
            None => cropped_cut.host_samples().expect("one or the other").to_vec(),
        };
        let worst = worst_over(
            &whole_samples,
            whole_w,
            (read.0, read.1),
            &cropped_samples,
            cropped_w,
            (read.0 - origin.raw().0, read.1 - origin.raw().1),
            (read.2, read.3),
        );
        assert!(
            worst <= ROUTE_COUNTS,
            "the restricted decode's frame is not the whole decode's frame: {worst} counts",
        );

        // And then the picture, which adds the geometry and the grade.
        let (reference, out) = graded(&whole, &whole_cut);
        let (restricted, restricted_out) = graded(&cropped, &cropped_cut);
        assert_eq!(restricted_out, out, "the two routes framed differently");
        let mut worst = 0u16;
        let mut at = 0u16;
        let mut outliers = 0usize;
        for (a, b) in reference.iter().zip(&restricted) {
            let off = a.abs_diff(*b);
            if off > ROUTE_COUNTS {
                outliers += 1;
            }
            if off > worst {
                (worst, at) = (off, *a);
            }
        }
        assert!(
            worst <= ROUTE_CODES,
            "the restricted decode is not the picture the whole one renders: {worst} codes, at a \
             code of {at}",
        );
        assert!(
            outliers <= ROUTE_OUTLIERS,
            "{outliers} samples of {} are past {ROUTE_COUNTS} codes, which is a picture that moved \
             rather than a handful that crossed something",
            reference.len(),
        );
    }

    /// What the two routes may differ by, per sample, in the 16-bit scene-linear frame.
    ///
    /// **The one thing that is not the same arithmetic on the two routes is where it is measured
    /// from.** Every whole-frame quantity is handed to the window rather than measured off it, so
    /// the two ask `warp.slang` for the same source position - and then subtract a different
    /// `params.origin` from it in f32, which rounds differently. Measured on the 3080: one count
    /// in the frame. Zero is not available, and a run that read zero was reading one compiler's
    /// FMA contraction.
    const ROUTE_COUNTS: u16 = 8;

    /// The same, for the picture - which is a different unit and cannot take the same number.
    ///
    /// **PQ is steep in the shadows, so one scene-linear count is tens of codes down there.** The
    /// frames above agree to a single count; what the grade does with that count depends on where
    /// the pixel sits, and a deep shadow is where the curve spends most of its range. Measured on
    /// the 3080: 43 codes at a code of 10595, on one sample of 11.6 million.
    const ROUTE_CODES: u16 = 64;

    /// How many samples may be past [`ROUTE_COUNTS`] in the picture before the difference is the
    /// picture rather than a handful of pixels.
    ///
    /// **The maximum alone cannot tell those apart**, and it is the wrong one to trust: a route
    /// that shifted every pixel by a little would pass a generous ceiling, and this is what refuses
    /// it. One sample of 11.6 million is what the two routes actually differ by.
    const ROUTE_OUTLIERS: usize = 8;

    /// The worst sample difference between two frames, over a rectangle each names its own origin
    /// for.
    fn worst_over(
        whole: &[u16],
        whole_width: usize,
        whole_at: (usize, usize),
        cut: &[u16],
        cut_width: usize,
        cut_at: (usize, usize),
        size: (usize, usize),
    ) -> u16 {
        let mut worst = 0u16;
        for row in 0..size.1 {
            for column in 0..size.0 {
                for channel in 0..3 {
                    let from =
                        ((whole_at.1 + row) * whole_width + whole_at.0 + column) * 3 + channel;
                    let to = ((cut_at.1 + row) * cut_width + cut_at.0 + column) * 3 + channel;
                    worst = worst.max(whole[from].abs_diff(cut[to]));
                }
            }
        }
        worst
    }

    /// A crop measuring its own is a different picture, at each of the three.
    ///
    /// Not a proof that the substitutions are right - the test above is that - but the guard
    /// against them being substitutions of one number for the same number, which would leave that
    /// test passing whether or not any of this worked.
    #[test]
    fn what_a_tile_is_handed_is_not_what_it_would_measure() {
        let path = sony();
        let path = path.to_str().unwrap();
        let mut fitted = tile_job(path, None, None);
        fitted.match_embedded_jpeg = true;
        let base = crate::job::Base::build(&fitted, 0).expect("the frame");
        let levels = *base.levels;
        let kept = crate::photo_analysis::encode(&base.analysis);
        drop(base);

        // The camera match and the noise fit, with nothing a render measured: what is being asked
        // here is what a tile left to read its own levels does, and a stored analysis would answer
        // that question for it - which is the whole point of storing one, and not this test's
        // subject.
        let from_raw = crate::photo_analysis::encode(&crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::decode(&kept).expect("it reads back").from_raw,
            ..Default::default()
        });
        let a_peak = crate::light::Light::measured(4000.0);
        let built = |levels: Option<crate::tone::Levels>,
                     peak: Option<crate::light::Light<crate::light::DisplayNits>>| {
            let mut job = tile_job(path, Some([DARK.left, DARK.top, DARK.width, DARK.height]), levels);
            job.match_embedded_jpeg = true;
            job.photo_analysis = Some(from_raw.clone());
            job.scene_peak = peak;
            // The roll-off has to be compressing something for the peak to be readable in the
            // picture at all; `a_tile_is_graded_as_the_rendition_is` says why.
            job.grade.reference_white_nits = crate::light::Light::exactly(1000.0);
            job.grade.peak_nits = crate::light::Light::exactly(50.0);
            job
        };
        let (given, width, height) = crate::job::graded(&built(Some(levels), Some(a_peak)))
            .expect("the tile");
        for (what, job) in [
            ("levels", built(None, Some(a_peak))),
            ("scene peak", built(Some(levels), None)),
        ] {
            let (own, _, _) = crate::job::graded(&job).expect("the tile");
            let mean: f64 = given
                .iter()
                .zip(&own)
                .map(|(a, b)| f64::from(a.abs_diff(*b)))
                .sum::<f64>()
                / (width * height * 3) as f64;
            assert!(mean > 100.0, "the crop's own {what} graded it {mean:.1} counts away");
        }
    }

    /// The brightest tile-sized block of the frame.
    fn brightest(base: crate::job::Base) -> crate::Tile {
        let (width, height) = (base.width, base.height);
        let samples = base.frame.host();
        let mean = |left: usize, top: usize| {
            let mut total = 0f64;
            for row in (0..DARK.height).step_by(8) {
                for col in (0..DARK.width).step_by(8) {
                    total += f64::from(samples[((top + row) * width + left + col) * 3 + 1]);
                }
            }
            total / ((DARK.height / 8) * (DARK.width / 8)) as f64
        };
        let mut best = (crate::Tile { left: 0, top: 0, width: DARK.width, height: DARK.height }, 0.0);
        for top in (0..height - DARK.height).step_by(512) {
            for left in (0..width - DARK.width).step_by(512) {
                let found = mean(left, top);
                if found > best.1 {
                    best = (crate::Tile { left, top, ..DARK }, found);
                }
            }
        }
        best.0
    }

    /// Levels that describe no photograph are refused, and the tile measures its own.
    ///
    /// They cross the API from a client rather than coming off a decode, and a white of zero is
    /// divided by. Refusing means falling back, so what is asserted is that such a tile is the
    /// tile that was handed nothing - not that it declined.
    #[test]
    fn a_tile_refuses_levels_that_describe_nothing() {
        let path = sony();
        let path = path.to_str().unwrap();
        let at = [DARK.left, DARK.top, DARK.width, DARK.height];
        let own = crate::job::Base::build(&tile_job(path, Some(at), None), 0)
            .expect("the tile")
            .frame
            .host();

        let level = crate::light::Light::measured;
        let floor = Some(level(141.0));
        for levels in [
            crate::tone::Levels { white: level(0.0), peak: level(13783.0), floor },
            crate::tone::Levels { white: level(f64::NAN), peak: level(13783.0), floor },
            crate::tone::Levels { white: level(8133.0), peak: level(f64::INFINITY), floor },
            // A peak below white would roll the highlights the wrong way.
            crate::tone::Levels { white: level(8133.0), peak: level(100.0), floor },
            // No floor at all, which is a client that cannot say where the low pair go.
            crate::tone::Levels { white: level(8133.0), peak: level(13783.0), floor: None },
            // A floor above the white it is a fraction of describes no photograph either.
            crate::tone::Levels {
                white: level(8133.0),
                peak: level(13783.0),
                floor: Some(level(9000.0)),
            },
        ] {
            let built = crate::job::Base::build(&tile_job(path, Some(at), Some(levels)), 0)
                .expect("the tile")
                .frame
                .host();
            assert_eq!(built, own, "{levels:?} was coded against");
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
        let whole = decode(&path, 0);
        let halved = decode(&path, FULL_RENDITION);

        assert!(long_edge(&halved) < long_edge(&whole));
        assert!(long_edge(&halved) >= FULL_RENDITION as usize);
        // Close to exactly half; the recommended crop is halved alongside and rounds, so
        // this is not an equality.
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
        let whole = decode(&sony(), 0);
        let asked = decode(&sony(), FULL_RENDITION);
        assert_eq!((asked.width, asked.height), (whole.width, whole.height));
        assert_eq!(asked.reduced, 1);
    }

    #[test]
    fn never_halves_when_the_caller_needs_native_resolution() {
        // A max-resolution rendition passes 0, which has to mean "the whole frame"
        // rather than "no constraint, do as you like".
        let Some(path) = big() else { return };
        let whole = decode(&path, 0);
        assert_eq!(whole.reduced, 1, "0 must mean the whole frame");
        assert!(long_edge(&whole) > FULL_RENDITION as usize);
    }

    #[test]
    fn produces_a_sane_picture_not_a_misplaced_struct_write() {
        // Halving combines each 2x2 site into one pixel, so a site taken off an odd row or
        // column reads the colours next door: still the right size, still sharp, and green.
        // Checked as a picture rather than as dimensions for that reason.
        let Some(path) = big() else { return };
        let whole = crate::debug::summarise(&decode(&path, 0));
        let halved = crate::debug::summarise(&decode(&path, FULL_RENDITION));

        // Per channel, because a whole-frame average would hide a shift in one, and a
        // shift in one is exactly what a stray white-balance write looks like.
        for (a, b) in whole.channels.iter().zip(&halved.channels) {
            assert!((a.mean - b.mean).abs() < a.mean * 0.05, "{} against {}", a.mean, b.mean);
        }
    }
}

/// The half-size decode against the frame it stands in for.
///
/// What is worth pinning is that halving happens when it should and that what comes out is the
/// same photograph: a site combined off an odd row reads the colours next door and comes out
/// plausible, sharp and green, which no assertion about dimensions would catch.
mod a_halved_frame_is_the_same_picture {
    use super::*;

    #[test]
    fn on_both_bodies() {
        for path in [sony(), canon()] {
            let whole = decode(&path, 0);
            // A floor of 640 is under half of either fixture, so both are candidates.
            let halved = decode(&path, 640);

            assert_eq!(halved.reduced, 2, "{} was not halved", path.display());
            assert_eq!(
                (halved.width, halved.height),
                (whole.width / 2, whole.height / 2),
                "{}",
                path.display(),
            );

            let mean = |frame: &crate::frame::Frame| -> f64 {
                let samples = frame.samples16().expect("16-bit");
                samples.iter().map(|v| f64::from(*v)).sum::<f64>() / samples.len() as f64
            };
            let (full, small) = (mean(&whole), mean(&halved));
            assert!(
                (small - full).abs() / full < 0.01,
                "{}: the halved frame means {small} against the full frame's {full}, which is a \
                 different picture rather than a smaller one",
                path.display(),
            );
        }
    }

    /// **The same claim on the pattern that reduces by three.**
    ///
    /// A Bayer 2x2 holds every colour and no 2x2 of a 6x6 does, so X-Trans's smallest block that
    /// does is the 3x3 - and the factor being the sensor's rather than the caller's is the whole of
    /// this route's contract. The mean is what says the block was read at the right phase: a 3x3
    /// taken one column over holds a different count of each colour, and what comes back is
    /// plausible, sharp, and the wrong colour.
    #[test]
    fn an_xtrans_frame_reduces_by_three() {
        let path = fuji();
        let whole = decode(&path, 0);
        // Comfortably under a third of the 6384-wide sensor, so the reduction is worth taking.
        let smaller = decode(&path, 640);

        assert_eq!(smaller.reduced, 3, "an X-Trans frame does not reduce by two");
        // Within a pixel of a third, not exactly it: the crop's origin floors to a whole block and
        // this body's is row 13, which is on no multiple of six.
        assert!(smaller.width.abs_diff(whole.width / 3) <= 1, "{} wide", smaller.width);
        assert!(smaller.height.abs_diff(whole.height / 3) <= 1, "{} high", smaller.height);

        let mean = |frame: &crate::frame::Frame| -> f64 {
            let samples = frame.samples16().expect("16-bit");
            samples.iter().map(|v| f64::from(*v)).sum::<f64>() / samples.len() as f64
        };
        let (full, small) = (mean(&whole), mean(&smaller));
        assert!(
            (small - full).abs() / full < 0.01,
            "the reduced frame means {small} against the full frame's {full}, which is a different \
             picture rather than a smaller one",
        );
    }
}

// Nothing measures a prepared frame's noise: GALOSH fits its own model on the mosaic, before the
// demosaic and the resample, and `galosh::NoiseModel` rides out on the frame.

/// Deriving, per photo, the transform that makes a RAW render look like the camera's
/// own JPEG - the maker's colour treatment and whichever picture profile the
/// photographer had set. None of it is visible from a synthetic input: the curves come
/// out of the camera's own rendering, and the failure modes that mattered were all
/// "the fit ran and the picture was wrong" (§10.8).
mod camera_match {
    use super::*;
    use crate::image::SPLINE_UNIT;

    /// The lens and the match, fitted the way a job fits them off the linear decode. Not
    /// cached: one of the assertions below is that fitting twice agrees, and a cache would
    /// answer it with the same object and prove nothing.
    fn fitted(path: &PathBuf) -> (crate::fit::Profile, crate::hdr_fit::HdrMatch) {
        let frame = decode(path, 3840);
        let resident = frame.on_device(adapter()).expect("a 16-bit decode");
        let geometry = crate::ffi::geometry_for(path.to_str().unwrap()).expect("a geometry");
        let (profile, matched, _) = pollster::block_on(crate::hdr::fit_all(
            adapter(),
            path.to_str().unwrap(),
            &resident,
            0.9,
            geometry,
        ))
        .expect("the fit finds something worth applying");
        (profile, matched)
    }

    /// **A caller that wants the fit and no picture asks for one.**
    ///
    /// The match is made inside the base a render builds, so a library that serves the cameras'
    /// pictures has never made one - and a panorama of those frames then has no lens table to
    /// reach their sensors through, which shows as a doubled edge at every seam. `Job::measure`
    /// is how that fit is asked for on its own: it pays the decode, which is what the fit is
    /// measured over, and none of the cut, the grade, the encode or the file.
    #[test]
    fn a_measure_job_writes_the_match_and_no_picture() {
        // As the worker sends one, which is JSON: what is asserted below rests on `measure`
        // crossing that boundary, and on the job naming no target at all.
        let job: crate::job::Job = serde_json::from_str(&format!(
            r#"{{
                "rawFilePath": {:?},
                "matchEmbeddedJpeg": true,
                "measure": true,
                "denoiseLuminance": 0,
                "denoiseColour": 0,
                "sharpen": 0,
                "defringe": 0,
                "grade": {{ "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 }},
                "targets": []
            }}"#,
            sony().to_string_lossy(),
        ))
        .expect("the measure job parses");

        let outcome = crate::job::run(&job).expect("the measure runs");

        let bytes = outcome.photo_analysis.expect("a measure job answers an analysis to keep");
        let analysis = crate::photo_analysis::decode(&bytes).expect("the analysis parses");
        // The match is the whole point of asking: its lens is the table a panorama's RAW gather
        // reaches each sensor through, and a canvas stitched without one doubles every seam. What
        // that lens *contains* is the fit's own business, pinned by the tests beside this one.
        assert!(analysis.from_raw.matched.is_some(), "the camera match was not fitted");
    }

    /// **A rendition a client renders is the picture the server would have written.** The client
    /// runs the same render from the RAW's bytes and hands the samples over (`job::render_bytes`),
    /// so anything either side does differently is a rendition that depends on which machine made it.
    ///
    /// SDR crosses whole, so its file is the server's byte for byte. HDR crosses as the twelve bits
    /// the encode keeps, and a lossy encoder handed input a fraction of a code away makes different
    /// choices of equal accuracy - so what is held there is that the file is as close to the picture
    /// as the server's.
    ///
    /// With the photograph's analysis on file, as the server always hands one over: without it
    /// the match is fitted from each host's own source (`job::fitting`).
    #[test]
    fn a_rendition_rendered_from_bytes_is_the_one_the_server_writes() {
        let path = sony().to_string_lossy().into_owned();
        let job = |analysis: &[u8], output: &str, out: &std::path::Path| -> crate::job::Job {
            serde_json::from_str(&format!(
                r#"{{
                    "rawFilePath": {path:?},
                    "matchEmbeddedJpeg": true,
                    "photoAnalysis": {analysis:?},
                    "denoiseLuminance": 0,
                    "denoiseColour": 0,
                    "sharpen": 0.5,
                    "defringe": 1,
                    "grade": {{ "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 }},
                    "targets": [{{
                        "rendition": "full",
                        "output": "{output}",
                        "outputPath": {:?},
                        "size": 1600,
                        "source": "render",
                        "sdrQuantizer": 20,
                        "hdrQuantizer": 1,
                        "preset": 8,
                        "stillFullChroma": false,
                        "sdrFullChroma": false
                    }}]
                }}"#,
                out.to_string_lossy(),
            ))
            .expect("the rendition job parses")
        };
        let decoded = |file: &std::path::Path| {
            let bytes = std::fs::read(file).expect("the rendition was written");
            crate::avif::decode_at(&bytes, 12).expect("the rendition decodes").0
        };
        let mean_error = |file: &[u16], picture: &[u16]| {
            let total: u64 = file.iter().zip(picture).map(|(a, b)| u64::from(a.abs_diff(*b))).sum();
            total as f64 / picture.len() as f64
        };
        let dir = std::env::temp_dir();
        let measured = crate::job::run(&job(&[], "srgb", &dir.join("bb-rendered-measure.avif")))
            .expect("the first render runs")
            .photo_analysis
            .expect("the first render measures the photograph");
        let bytes = std::fs::read(sony()).expect("the fixture reads");

        for output in ["pq", "srgb"] {
            let served = dir.join(format!("bb-rendered-served-{output}.avif"));
            let rendered = dir.join(format!("bb-rendered-client-{output}.avif"));
            crate::job::run(&job(&measured, output, &served)).expect("the server renders");
            let client = job(&measured, output, &rendered);
            let framed = pollster::block_on(crate::job::render_bytes(&client, &bytes))
                .expect("the bytes render");
            crate::job::write_rendered(&client, &framed).expect("the frame is written");

            if output == "srgb" {
                assert!(
                    std::fs::read(&served).expect("the server wrote")
                        == std::fs::read(&rendered).expect("the frame was written"),
                    "the SDR rendition differs by where it was rendered",
                );
                continue;
            }
            let header = u32::from_le_bytes(framed[0..4].try_into().expect("a length")) as usize;
            let (high, low) = framed[crate::edit::samples_at(header)..].split_at(
                (framed.len() - crate::edit::samples_at(header)) / 2,
            );
            let picture: Vec<u16> =
                high.iter().zip(low).map(|(&h, &l)| u16::from_be_bytes([h, l])).collect();
            let (server, client) = (
                mean_error(&decoded(&served), &picture),
                mean_error(&decoded(&rendered), &picture),
            );
            assert!(server < 8.0, "the server's HDR file is {server:.3} codes from the picture");
            assert!(
                client <= server * 1.02,
                "the client's HDR file is {client:.3} codes from the picture, the server's {server:.3}",
            );
        }
    }

    /// The pair the body recorded beside its distortion spline, which is what the fit
    /// prefers where there is one.
    ///
    /// The layout is not documented anywhere reachable and was worked out from the
    /// files: a count prefix of 32, then 16 red knots and 16 blue. What validates it is
    /// that the tag's corner value correlates +0.85 on red and +0.78 on blue with the
    /// aberration measured off the same 51 frames - a wrong split would correlate with
    /// nothing. This holds the parser to that shape.
    #[test]
    fn reads_the_lateral_pair_the_body_recorded() {
        let Some(curve) = crate::ffi::recorded_lateral(sony().to_str().unwrap()) else {
            eprintln!("SKIPPED: this ARW records no lateral pair");
            return;
        };
        assert_eq!(curve[0].len(), 16, "red is sixteen knots, as the distortion spline is");
        assert_eq!(curve[1].len(), 16, "and blue is the sixteen after it");
        for channel in &curve {
            for knot in channel {
                assert!(
                    (knot / SPLINE_UNIT).abs() < 0.01,
                    "{} is not a lateral aberration - the layout or the unit is wrong",
                    knot / SPLINE_UNIT,
                );
            }
        }
    }

    /// A body that records nothing must not be read as recording zeroes, which would
    /// take the frame off the measured path and correct nothing instead.
    #[test]
    fn reads_no_lateral_pair_from_a_body_that_writes_none() {
        assert!(
            crate::ffi::recorded_lateral(canon().to_str().unwrap()).is_none(),
            "a CR3 is not a TIFF and carries no Sony SubIFD",
        );
    }

    /// The lensfun TCA reader, which the fit does not use and which therefore has only
    /// this to keep it honest.
    ///
    /// It is off the path because it lost: over five sampled frames it covered three and
    /// never beat measuring the frame, reaching a halo split of +21.74 on IMG_0116 where
    /// the regression reaches +18.67 (`tca::supplied_curve` carries the full numbers). The
    /// reader itself is correct, so this asserts the shape of what it returns rather
    /// than deleting a source that may be worth revisiting when coverage improves.
    #[test]
    fn reads_a_lateral_curve_out_of_the_database() {
        let header = crate::header::read_path(canon().to_str().unwrap()).expect("header");
        let Some(curve) = crate::ffi::database_lateral(canon().to_str().unwrap()) else {
            // Not a failure: this lens is third-party glass and lensfun's TCA coverage
            // is far thinner than its distortion coverage.
            eprintln!("SKIPPED: lensfun has no TCA for {}", crate::header::name(&header.lens_model));
            return;
        };
        assert_eq!(curve[0].len(), curve[1].len(), "both channels sample the same grid");
        assert!(curve[0].len() >= 2, "a curve needs at least two knots to interpolate");
        // A lateral correction is a fraction of a percent. Anything larger is a misread
        // of the model's coordinates rather than a lens.
        for channel in &curve {
            for knot in channel {
                assert!(
                    (knot / SPLINE_UNIT).abs() < 0.01,
                    "{} is not a lateral aberration",
                    knot / SPLINE_UNIT,
                );
            }
        }
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
            assert_ne!(fitted(&sony()).0.source, crate::fit::SOURCE_LENSFUN);
        }
    }

    /// The preview the fit measures against has to be the right way up, and nothing said so.
    ///
    /// A preview is stored as the sensor read it, so on a portrait frame it arrives lying down
    /// while the render is upright - and the fit derives a colour transform by comparing the two,
    /// so a sideways one is fitted against unrelated content. Measured at 15% of the mean luma
    /// when it went wrong. Both fixtures are `Rotate270`, so this is a claim about each of them
    /// rather than a case that had to be arranged.
    #[test]
    fn the_preview_the_fit_measures_arrives_upright() {
        for raw in [sony(), canon()] {
            let path = raw.to_str().expect("a fixture path");
            let largest = crate::decode_rawler::Preview::Largest;
            let stored =
                crate::decode_rawler::upright_preview_jpeg(path, largest).expect("a preview");
            let long_edge = crate::hdr_fit::sample_long_edge();
            let upright = crate::decode_embedded_rgb(path, long_edge).expect("a preview");
            let render = decode(&raw, 0);

            // Against the render's own aspect, which is the thing it is compared with. Asserting
            // "taller than wide" would pass a landscape fixture by accident.
            assert_eq!(
                upright.height > upright.width,
                render.height > render.width,
                "{path}: the preview is {}x{} against a render of {}x{}",
                upright.width,
                upright.height,
                render.width,
                render.height,
            );
            assert!(
                upright.width.max(upright.height) <= long_edge,
                "{path}: the preview is {}x{}, over the {long_edge} the fit asks for",
                upright.width,
                upright.height,
            );
            // The JPEG-returning path has to agree, since the editor's open and the download
            // read that one and a viewer would show it lying down.
            let bytes = crate::jpeg::decode(&stored, long_edge).expect("the stored preview decodes");
            assert_eq!(
                (bytes.width, bytes.height),
                (upright.width, upright.height),
                "{path}: the two ways to the same preview disagree on its shape",
            );
        }
    }

    /// The two hosts fit against one set of pixels.
    ///
    /// A rendition reaches the preview by path and the editor's open by bytes it already holds,
    /// and the two stand it up differently: `hdr::match_preview` turns the pixels after the
    /// decode, `hdr::match_preview_from_bytes` writes the turn into the JPEG's EXIF for
    /// `jpeg::decode` to honour. Both fixtures are `Rotate270`, so this pins the two turns
    /// against each other, not only the two fetches.
    #[test]
    fn both_hosts_take_the_same_preview_pixels() {
        for raw in [sony(), canon()] {
            let path = raw.to_str().expect("a fixture path");
            let bytes = std::fs::read(&raw).expect("the fixture reads");
            let editor =
                crate::hdr::match_preview_from_bytes(&bytes).expect("the editor's preview");
            let rendition = crate::hdr::match_preview(path).expect("a rendition's preview");

            assert_eq!(
                (editor.width, editor.height),
                (rendition.width, rendition.height),
                "{path}: the two hosts fit against different sizes",
            );
            // Counted rather than compared: a failing `assert_eq!` over two 18MB planes prints
            // both of them and says nothing a reader can use.
            let differing =
                editor.data.iter().zip(&rendition.data).filter(|(a, b)| a != b).count();
            assert_eq!(
                differing,
                0,
                "{path}: the two hosts fit against different pixels, {differing} of {} samples",
                editor.data.len(),
            );
        }
    }

    /// The falloff term, kept honest the same way the distortion is: darken the
    /// camera's own JPEG towards the corners by a known factor, hand it back as the
    /// target, and require the fit to find that factor. A radial model will always
    /// find *a* radial error, so a plausible number proves nothing without a known
    /// one to compare it to.
    ///
    /// Darkened rather than brightened because brightening clips, and a clipped
    /// corner reads as less falloff than was injected.
    #[test]
    fn recovers_a_falloff_that_was_injected_on_purpose() {
        let (fitted, matched) = injected_falloff();
        let gain = fitted.gain.as_ref().expect("a falloff");
        assert!(
            (gain.corner() - INJECTED_CORNER).abs() < 0.1,
            "recovered {} from {INJECTED_CORNER}",
            gain.corner(),
        );
        // Recovering the coefficient is not the same as matching the frame, and the
        // fit is free to report either. This is the one that decides the picture.
        assert!(
            matched.colour.delta_e < MAX_HELD_OUT_DELTA_E,
            "held-out deltaE {}",
            matched.colour.delta_e,
        );
        assert_eq!(matched.lens.falloff, Some(gain.coefficients()));
    }

    /// The other half of the same question. Every frame's corners differ from its
    /// centre for reasons that are not falloff - shading, subject placement, the sky
    /// being at the top - and two free parameters will happily absorb some of that.
    /// This body applied no illumination correction to its preview, so the honest
    /// answer is no gain at all.
    #[test]
    fn invents_no_falloff_where_the_camera_corrected_none() {
        assert!(fitted(&sony()).0.gain.is_none());
        // The Canon body has no profile for a third-party lens either, so it corrects
        // nothing here - but it is a different decode and a different preview, so it
        // is worth its own case. Not asserted as None: something near the identity is
        // allowed to win on a frame this large.
        let canon_gain = fitted(&canon()).0.gain.map(|g| g.corner()).unwrap_or(1.0);
        assert!((canon_gain - 1.0).abs() < 0.1, "invented {canon_gain}");
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
        // Scaled to fill, which is the half of the injection that makes it a picture a
        // camera could have produced: one that left the corners black would ask the fit
        // for a geometry it correctly refuses to consider.
        let target = crate::jpeg::encode(pincushion(&preview, K1, 1.0 / (1.0 + K1)).as_ref(), 95)
            .expect("the injected target encodes");
        let target = crate::jpeg::decode(&target, 0).expect("the injected target decodes");

        let frame = decode(&sony(), 3840);
        let resident = frame.on_device(adapter()).expect("a 16-bit decode");
        // Unstated forces the fitted path: the question is whether the search finds a
        // displacement, not whether it can read one off the file.
        let (fitted, _, _) = pollster::block_on(crate::hdr::fit_all_from_preview(
            adapter(),
            &resident,
            0.9,
            crate::fit::Geometry::Unstated,
            &target,
            None,
        ))
        .expect("the fit finds something worth applying");
        assert_eq!(fitted.source, crate::fit::SOURCE_FITTED);

        // The target samples outward, so the map from target back to render carries the
        // same sign as the injected coefficient. Compare centre-to-corner displacement
        // rather than raw coefficients, since crop and knots trade off.
        let knots = fitted.knots.as_ref().expect("a fitted curve");
        let recovered = (knots[knots.len() - 1] - knots[0]) / SPLINE_UNIT;
        assert!(recovered > K1 / 2.0 && recovered < K1 * 2.0, "recovered {recovered} from {K1}");
    }

    /// A centre-to-corner pincushion of `k1`, scaled by `crop`, applied by resampling.
    ///
    /// Hand-rolled rather than through `fit_warp.slang`: injecting with the same code the
    /// fit inverts would let a bug in it cancel itself out.
    fn pincushion(source: &crate::rgb::Rgb, k1: f64, crop: f64) -> crate::rgb::Rgb {
        let (width, height) = (source.width, source.height);
        let mut out = vec![0u8; width * height * 3];
        let half = ((width as f64 / 2.0).powi(2) + (height as f64 / 2.0).powi(2)).sqrt();
        for y in 0..height {
            let dy = (y as f64 - height as f64 / 2.0) / half;
            for x in 0..width {
                let dx = (x as f64 - width as f64 / 2.0) / half;
                let factor = crop * (1.0 + k1 * (dx * dx + dy * dy));
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
        crate::rgb::Rgb { width, height, data: out }
    }

    /// Load-bearing: the profile is deliberately not stored anywhere. The grid and the
    /// full view are fitted in one job, but the max-resolution export is built on demand
    /// later and refits from scratch. If the fit were not deterministic those two copies
    /// of one photo would be graded differently, and the only remedy would be persisting
    /// the profile.
    #[test]
    fn fits_the_same_profile_twice_so_renditions_built_at_different_times_agree() {
        let ((first, a), (second, b)) = (fitted(&sony()), fitted(&sony()));

        assert_eq!(first.crop, second.crop);
        assert_eq!(first.source, second.source);
        assert_eq!(first.knots, second.knots);
        let (a, b) = (&a.colour, &b.colour);
        assert_eq!(a.delta_e, b.delta_e);
        assert_eq!(a.matrix, b.matrix);
        assert_eq!(a.curves, b.curves);
        // The coefficients, not `corner()`: two different fits can agree on what they
        // do to a corner while disagreeing about the curve that got them there, and
        // it is the curve that ships.
        assert_eq!(
            first.gain.map(|g| g.coefficients()),
            second.gain.map(|g| g.coefficients()),
        );
    }

}

/// The HDR colour fit and grade against a real RAW and its real embedded JPEG.
///
/// None of this is visible from a synthetic input: the curves come out of the camera's
/// own rendering, and the failure modes that mattered were all "the fit ran and the
/// picture was wrong" (§10.8). §10.7.1 records a magenta sky at deltaA* +5.2 from
/// per-channel extrapolation, and a matrix that oversaturated by 9.3% before it was
/// weighted - neither would fail an assertion about shape.
mod hdr_grade {
    use super::*;
    use crate::hdr_args::{Chroma, EncodeOptions};

    const QUANTILE: f64 = 0.9;
    const REFERENCE: crate::light::Light<crate::light::SceneNits> =
        crate::light::Light::exactly(203.0);
    const PEAK: crate::light::Light<crate::light::DisplayNits> =
        crate::light::Light::exactly(1000.0);

    fn options(
        peak_nits: crate::light::Light<crate::light::DisplayNits>,
        max_edge: f64,
        output_path: &str,
    ) -> EncodeOptions {
        EncodeOptions {
            still_chroma: Chroma::Yuv420,
            output_path: output_path.to_string(),
            grade: crate::hdr::Grade {
                peak_nits,
                reference_white_nits: REFERENCE,
                white_quantile: QUANTILE,
            },
            crf: 40,
            preset: 8,
            // The grade is what is pinned here, and all of these run after it.
            strengths: crate::image::Strengths::default(),
            sharpen_sigma: None,
            max_edge,
        }
    }

    /// The scene-linear decode every case here grades from.
    fn linear() -> crate::frame::Frame {
        decode(&sony(), 0)
    }

    fn source(frame: &crate::frame::Frame) -> crate::hdr::Source<'_> {
        crate::hdr::Source {
            samples: frame.samples16().expect("a 16-bit decode"),
            width: frame.width,
            height: frame.height,
        }
    }

    /// The camera match, fitted the way a job fits it (§10.8.1).
    fn matched(frame: &crate::frame::Frame) -> Option<crate::hdr_fit::HdrMatch> {
        let resident = frame.on_device(adapter())?;
        crate::fit_hdr_for(&resident, sony().to_str().unwrap(), QUANTILE)
    }

    /// The falloff is the one half of the SDR match that lifts to the grade unchanged
    /// (§10.8.1), and "lifts" has to mean it reaches the pixels, not just the struct.
    /// A `falloff` the match carries and `apply_lens` ignores would pass a fit test.
    #[test]
    fn the_falloff_reaches_the_graded_frame_and_not_only_the_match() {
        let frame = linear();
        let mut fitted = matched(&frame).expect("the HDR fit finds a match");
        // This body corrects no illumination, so the lift has to be given something to
        // carry - which is also the only way to reach a corner gain worth measuring.
        // A quarter more light at the corner, none at the centre.
        fitted.lens =
            crate::fit::Lens { distortion: None, crop: 1.0, falloff: Some((0.25, 0.0)), tca: None };

        let (width, height) = (frame.width, frame.height);
        // Coded, because that is what the lens stage is handed on both hosts - and so the
        // ratio has to be read in light rather than in codes, which is the claim anyway: a
        // falloff correction is a multiplication of light whatever the buffer holds.
        let mut samples = frame.samples16().expect("a 16-bit decode").to_vec();
        let gpu = crate::gpu::device().expect("an adapter");
        let levels =
            crate::hdr::levels_of(gpu, &samples, width, height, QUANTILE).expect("levels").anchored();
        crate::hdr::code_base(&mut samples, levels, REFERENCE);
        let base = crate::base::device(gpu).expect("the base pipelines");
        let resident = crate::resident::Resident::upload(gpu, &samples, width, height);
        let gathered = crate::base::warp_lens(
            gpu,
            base,
            &resident,
            crate::base::Gather::frame(crate::px::Size::exact(width, height)),
            &fitted.lens,
        )
        .expect("the lens stage runs");
        resident.reclaim();
        let lit = pollster::block_on(gathered.0.into_host()).expect("the warped frame maps");

        let at = |data: &[u16], x: usize, y: usize| {
            let code = f64::from(data[(y * width + x) * 3 + 1]) / 65535.0;
            crate::tone::pq_inv::<crate::light::SceneNits>(crate::light::Light::measured(code))
        };
        let (corner_x, corner_y) = (width - 1, height - 1);
        // The corner sits at r = 1, so it takes the whole of the coefficient.
        let floor = crate::light::Light::measured(1e-9);
        let corner = at(&samples, corner_x, corner_y).max(floor);
        let ratio = (at(&lit, corner_x, corner_y) / corner).raw();
        assert!((ratio - 1.25).abs() < 0.02, "corner scaled by {ratio}, wanted 1.25");
        assert_eq!(
            at(&lit, width / 2, height / 2),
            at(&samples, width / 2, height / 2),
            "the centre must not move",
        );
    }

    /// `fit_all` fits both halves off the linear decode, and it has to hand the whole lens
    /// across rather than assembling one. It assembled one for a while, forgot the falloff,
    /// and the suite stayed green.
    ///
    /// What this pins is that shape, not a value - on this fixture the linear route
    /// fits no falloff at all, so the equality below is None to None. The value is
    /// covered by `recovers_a_falloff_that_was_injected_on_purpose`, which injects one.
    #[test]
    fn the_falloff_survives_the_route_that_fits_both_halves_at_once() {
        let path = canon();
        let frame = decode(&path, 3840);
        let resident = frame.on_device(adapter()).expect("a 16-bit decode");
        let geometry = crate::ffi::geometry_for(path.to_str().unwrap()).expect("a geometry");
        let (profile, matched, _) = pollster::block_on(crate::hdr::fit_all(
            adapter(),
            path.to_str().unwrap(),
            &resident,
            QUANTILE,
            geometry,
        ))
        .expect("the linear fit");
        let lens = profile.lens();
        assert_eq!(matched.lens.falloff, lens.falloff);
        assert_eq!(matched.lens.distortion, lens.distortion);
        assert_eq!(matched.lens.crop, lens.crop);
    }

    /// The falloff has to be on the render *before* the colour is fitted, or the curves
    /// are fitted against corners `apply_lens` will later lift and then asked at grade
    /// time for levels they never saw. Fitting with one and without it must therefore
    /// produce different curves - if it does not, the pre-fit application is not
    /// happening.
    #[test]
    fn the_falloff_is_on_the_render_the_hdr_colour_is_fitted_from() {
        let frame = decode(&sony(), 3840);
        let resident = frame.on_device(adapter()).expect("a 16-bit decode");
        let path = sony();
        let p = path.to_str().unwrap();
        let curves = |falloff| {
            let lens = crate::fit::Lens { distortion: None, crop: 1.0, falloff, tca: None };
            pollster::block_on(crate::hdr::fit_match(adapter(), p, &resident, QUANTILE, lens))
                .expect("a match")
                .0
                .colour
                .curves
        };
        assert_ne!(curves(Some((0.6, 0.0))), curves(None));
    }

    /// `hdr::graded`, which is already the shader - these tests only ever wanted the rolled
    /// frame it returns.
    fn graded(
        frame: &crate::frame::Frame,
        options: &EncodeOptions,
        m: Option<&crate::hdr_fit::HdrMatch>,
    ) -> (Vec<u16>, usize, usize) {
        crate::hdr::graded(&source(frame), options, m)
    }

    #[test]
    fn the_fit_reproduces_the_camera_rendering() {
        let frame = linear();
        let fitted = matched(&frame).expect("the HDR fit finds a match");
        // The same bound the SDR path applies to itself. Above it the transform is not
        // worth applying and the caller renders untransformed.
        assert!(fitted.colour.delta_e < 6.0, "deltaE {}", fitted.colour.delta_e);
    }

    #[test]
    fn the_fitted_transform_is_monotone_so_a_gradient_cannot_posterise() {
        let frame = linear();
        let fitted = matched(&frame).expect("the HDR fit finds a match");
        for curve in &fitted.colour.curves {
            for pair in curve.windows(2) {
                assert!(pair[1] >= pair[0], "the curve dips: {} then {}", pair[0], pair[1]);
            }
        }
    }

    /// The regression the shipped extrapolation exists for. Before it, red and green
    /// left the fit domain at slopes differing by more than 2x and the sky drifted
    /// magenta; the end values are what that divergence shows up in.
    #[test]
    fn the_three_channels_leave_the_fit_domain_at_comparable_levels() {
        let frame = linear();
        let fitted = matched(&frame).expect("the HDR fit finds a match");
        let ends: Vec<f64> = fitted.colour.curves.iter().map(|c| c[c.len() - 1]).collect();
        let high = ends.iter().cloned().fold(f64::MIN, f64::max);
        let low = ends.iter().cloned().fold(f64::MAX, f64::min);
        assert!(high / low < 1.5, "the channels end {}x apart", high / low);
    }

    #[test]
    fn grading_with_the_match_keeps_diffuse_white_near_the_reference() {
        let frame = linear();
        let fitted = matched(&frame);
        let (graded, _, _) =
            graded(&frame,&options(PEAK, f64::INFINITY, "/dev/null"), fitted.as_ref());
        let at = crate::debug::luma_quantiles(&graded, PEAK, &[QUANTILE, 1.0]);

        // The anchor is measured on the brightest component and this is luma, so the
        // quantile lands under the reference rather than on it - but nowhere near the
        // peak, which is what a lost anchor would look like.
        let of_reference = |by: f64| {
            crate::light::Light::at_diffuse_white(REFERENCE) * crate::light::Gain::of_ratio(by)
        };
        assert!(at[0] > of_reference(0.25), "diffuse white at {:?}", at[0]);
        assert!(at[0] < of_reference(1.5), "diffuse white at {:?}", at[0]);
        // Nothing may exceed the display peak the file will declare.
        assert!(at[1] <= PEAK + crate::light::Light::exactly(1.0), "peak luma {:?}", at[1]);
    }

    #[test]
    fn the_neutral_grade_is_reproducible_and_differs_from_the_matched_one() {
        // At a rendition's size, not the frame's: what is compared is whether two
        // grades agree, which no amount of resolution makes truer.
        let frame = linear();
        let digest = |m: Option<&crate::hdr_fit::HdrMatch>| {
            let (graded, _, _) = graded(&frame,&options(PEAK, 800.0, "/dev/null"), m);
            crate::debug::sha256_hex(&crate::debug::to_bytes(&crate::frame::Pixels::Sixteen(graded)))
        };
        let first = digest(None);
        assert_eq!(digest(None), first, "the neutral grade is not reproducible");
        // Otherwise the profile is being dropped somewhere between here and the grade,
        // which is the failure this module was written for.
        let fitted = matched(&frame);
        assert_ne!(digest(fitted.as_ref()), first, "the match never reached the grade");
    }

    /// Renditions of one photo must not disagree about how bright it is. The grade runs
    /// after the fit-to-size rather than before, so without sharing the levels each size
    /// would measure its own - and averaging pulls a specular peak in, so the numbers
    /// would drift apart with the scale factor.
    #[test]
    fn every_size_of_one_photo_grades_to_the_same_brightness() {
        let frame = linear();
        let fitted = matched(&frame);
        let median = |max_edge: f64| {
            let (graded, _, _) =
                graded(&frame,&options(PEAK, max_edge, "/dev/null"), fitted.as_ref());
            crate::debug::luma_quantiles(&graded, PEAK, &[0.5])[0]
        };
        let native = median(f64::INFINITY);
        for other in [median(3012.0), median(753.0)] {
            let drift = ((other - native) / native).raw().abs();
            assert!(drift < 0.05, "{other:?} against {native:?} at native");
        }
    }

    /// Through the encode, not the grade, because the encode is where a match gets dropped:
    /// options built by spread go unchecked for excess fields, so an undeclared one vanishes in
    /// silence, and every unit test calling the grade directly passes while the product path
    /// renders unmatched.
    #[test]
    fn the_encode_carries_the_match_through_to_the_encoded_file() {
        let dir = std::env::temp_dir().join("bb-hdr-match-fixture");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let plain = dir.join("plain.avif");
        let with_match = dir.join("matched.avif");

        let frame = linear();
        let fitted = matched(&frame);
        for (path, m) in [(&plain, None), (&with_match, fitted.as_ref())] {
            crate::hdr::encode_still(
                source(&frame).samples.to_vec(),
                frame.width,
                frame.height,
                &options(PEAK, 640.0, path.to_str().unwrap()),
                m,
            )
            .expect("the encode");
        }

        // Same encoder, same size, same everything but the transform, so identical bytes
        // mean the transform never reached the encoder.
        let a = std::fs::read(&plain).expect("the plain file");
        let b = std::fs::read(&with_match).expect("the matched file");
        let _ = std::fs::remove_dir_all(&dir);
        assert_ne!(a, b, "the match never reached the encoder");
    }

    /// The encoded still is actually in the PQ transfer.
    ///
    /// **Nothing else checks this, and the failure is silent and total.** The transfer is
    /// applied in the grade's own dispatch (`frame.slang`), and dropping it there leaves every
    /// other pin green: the argv pin does not carry it, the grade pin fixes `graded()` from
    /// *before* the transfer, the match test above still differs because both its arms are
    /// equally wrong, and `ffprobe` reports `smpte2084` because that is the CICP tag rather than
    /// the pixels. Every HDR still would come out several stops dark, with a green suite.
    ///
    /// So it is measured against the two things the file could be. PQ is a steep curve
    /// near black: a mid-grey that is 0.2 of full scale linear sits near 0.58 in PQ, so
    /// the two predictions are far apart and no tolerance has to be argued about.
    #[test]
    fn the_still_is_written_in_the_transfer_it_claims() {
        let dir = std::env::temp_dir().join("bb-hdr-transfer-fixture");
        std::fs::create_dir_all(&dir).expect("a scratch directory");
        let path = dir.join("still.avif");

        let frame = linear();
        let options = options(PEAK, 640.0, path.to_str().unwrap());
        let (graded, _, _) = graded(&frame,&options, None);
        crate::hdr::encode_still(
            source(&frame).samples.to_vec(),
            frame.width,
            frame.height,
            &options,
            None,
        )
        .expect("the encode");

        // What the file would average at if the samples went out linear, and what it
        // averages at with the transfer applied. Both off the very frame that was
        // encoded, so this cannot drift with the grade or the fixture.
        let full = f64::from(u16::MAX);
        let linear_mean = graded.iter().map(|s| f64::from(*s) / full).sum::<f64>() / graded.len() as f64;
        let pq_mean = graded
            .iter()
            .map(|s| {
                crate::tone::pq(PEAK * crate::light::Gain::of_ratio(f64::from(*s) / full)).raw()
            })
            .sum::<f64>()
            / graded.len() as f64;

        let encoded = std::fs::read(&path).expect("the still");
        let decoded = crate::avif::decode(&encoded).expect("the still decodes");
        let _ = std::fs::remove_dir_all(&dir);
        let mean = decoded.data.iter().map(|v| f64::from(*v) / 255.0).sum::<f64>()
            / decoded.data.len() as f64;

        assert!(
            (mean - pq_mean).abs() < (mean - linear_mean).abs(),
            "the still averages {mean:.3}; PQ predicts {pq_mean:.3} and untransformed {linear_mean:.3}",
        );
    }

    /// A rendition cut from a larger one's frame is the picture it would have been prepared
    /// on its own.
    ///
    /// **This is what makes a job with several outputs cheap, and nothing else enforces it.**
    /// The largest target is resized, warped and sharpened, and every smaller one is a
    /// downscale of *that* rather than its own resize and its own warp. The claim is that the
    /// two land in the same place, and it is not free: the sharpen ran at the larger size, so
    /// the smaller frame carries a deconvolution calibrated for a resample it did not have,
    /// softened by the downscale that followed.
    ///
    /// Cutting before the colour transform rather than after is what keeps this honest:
    /// averaging a *rendered* picture runs into `mean(f(x))` not being `f(mean(x))` across a
    /// whole tone curve and a chroma lattice, where the base is one transfer. Not the sensor's
    /// own integration either - `Cut::downscale` says why the coding is averaged rather than
    /// the light - which is part of what this measures.
    ///
    /// Graded through the shader both ways, since that is the only grade there is.
    #[test]
    fn a_rendition_cut_from_a_larger_frame_is_the_picture_it_would_have_been() {
        let Some(gpu) = crate::gpu::device() else {
            eprintln!("SKIPPED: no GPU adapter, so the grade could not run");
            return;
        };
        let frame = linear();
        let fitted = matched(&frame);
        let mut rows: Vec<String> = Vec::new();
        for with_match in [false, true] {
            let m = match with_match {
                true => fitted.as_ref(),
                false => None,
            };
            let decoded = source(&frame);
            let levels =
                crate::hdr::levels_of(gpu, decoded.samples, decoded.width, decoded.height, QUANTILE)
                    .expect("levels")
                    .anchored();
            // Coded as both hosts code it, since what a `Cut` carries is the coded base.
            let mut coded = decoded.samples.to_vec();
            crate::hdr::code_base(&mut coded, levels, REFERENCE);
            let source =
                crate::hdr::Source { samples: &coded, width: decoded.width, height: decoded.height };
            // As the camera rendered it, and upright: this measures the resample, not anybody's
            // edit of it.
            let scene = crate::tone::SceneGrade::new(
                m.map(|m| &m.colour),
                levels,
                REFERENCE,
                crate::light::Stops::measured(1.0),
                crate::gpu::Adjust::none(),
                None,
            );
            let sized = |edge: f64| {
                crate::hdr_args::target_size(
                    frame.width as u32,
                    frame.height as u32,
                    &options(PEAK, edge, "/dev/null"),
                )
            };
            let (large, small) = (sized(1600.0), sized(800.0));

            // Cut at 1600 and taken down, against cut at 800 outright.
            let resident = || {
                crate::resident::Resident::upload(gpu, source.samples, source.width, source.height)
            };
            let unsharpened = |size| {
                crate::hdr::Cut::from_base(
                    resident(),
                    m.map(|m| &m.lens),
                    size,
                    0.0,
                    crate::image::SharpenSigma::fixed(crate::image::DECONVOLVE_SIGMA),
                )
            };
            let shared = unsharpened(large).downscale(small);
            let own = unsharpened(small);

            assert_eq!((shared.width, shared.height), (own.width, own.height));
            let grade = |cut: &crate::hdr::Cut| {
                crate::hdr::encode_cut(
                    gpu,
                    cut,
                    &scene.gpu_grade(cut.width, cut.height, PEAK, crate::gpu::Output::Pq),
                )
            };
            let (a, b) = (grade(&shared), grade(&own));
            let worst = a.iter().zip(&b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
            let mean =
                a.iter().zip(&b).map(|(x, y)| u64::from(x.abs_diff(*y))).sum::<u64>() as f64
                    / a.len() as f64;
            rows.push(format!("match={with_match}: mean {mean:.1} worst {worst}"));
            // Of 65535. A box mean of a box mean is not the box mean the one-step resize
            // takes, so this is a resampling difference rather than a grading one - the two
            // are the same picture, not the same bytes.
            assert!(mean < 200.0, "{}", rows.join("; "));
        }
        eprintln!("cut from larger against cut outright: {}", rows.join("; "));
    }

    /// The graded picture, neutral and matched, with and without the roll-off.
    ///
    /// `peak_nits` is a case dimension, not a constant, because the roll-off is
    /// conditional: the EETF returns early when the frame already fits the display, so
    /// at 1000 nits this fixture never reaches the BT.2390 knee at all. A pin without a
    /// low-peak case would have covered none of that curve - which is where the subtlest
    /// arithmetic in the grade lives - and was silently passing a deliberate
    /// perturbation of it. 203 is also what the SDR reference uses.
    #[test]
    fn the_graded_picture_neutral_and_matched_with_and_without_the_roll_off() {
        use crate::snapshot::{Frame, Snapshot, Tolerance};
        let frame = linear();
        let fitted = matched(&frame);
        let gpu = crate::gpu::device().expect("a Vulkan adapter");
        // Measured against radv: the matched cases are 5.8 codes out on average and 1735 at worst,
        // the chroma lattice's filter weights rounding differently by vendor over a real photo; the
        // neutral ones, which read no lattice, 0.13 and 18. A wrong matrix row or a moved knee moves
        // the mean by hundreds.
        let matched_arm = Tolerance { worst: 4096, mean: 16.0 };
        let neutral_arm = Tolerance { worst: 256, mean: 1.5 };

        for (label, with_match, max_edge, peak_nits) in [
            ("neutral-3840", false, 3840.0, 1000.0),
            ("matched-3840", true, 3840.0, 1000.0),
            ("matched-800", true, 800.0, 1000.0),
            ("neutral-rolloff", false, 800.0, 203.0),
            ("matched-rolloff", true, 800.0, 203.0),
        ] {
            let (m, tolerance) = match with_match {
                true => (fitted.as_ref(), matched_arm),
                false => (None, neutral_arm),
            };
            let (graded, width, height) = crate::hdr::graded_as(
                &source(&frame),
                &options(crate::light::Light::exactly(peak_nits), max_edge, "/dev/null"),
                m,
                crate::gpu::Output::Pq,
            );
            let name = format!("hdr-grade/{label}");
            if width.max(height) <= 800 {
                Snapshot::pq(&graded, crate::px::Size::<crate::px::Output>::measured(width, height))
                    .check(&name, tolerance);
                continue;
            }
            let resident = crate::resident::Resident::upload(gpu, &graded, width, height);
            Snapshot::whole(Frame::Coded(&resident), crate::px::Span::exact(960))
                .check(&name, tolerance);
            // The nose and whiskers on the floor, with the fur above white at their edge.
            let detail = crate::px::Rect::<crate::px::Output> {
                at: crate::px::At {
                    x: crate::px::Place::measured(1150),
                    y: crate::px::Place::measured(2000),
                },
                size: crate::px::Size::measured(512, 512),
            };
            Snapshot::crops(Frame::Coded(&resident), &[detail])
                .check(&format!("{name}-1to1"), tolerance);
        }
    }

}

/// What each stage a reader can see does to a real photograph, as pictures (`snapshot.rs`): one
/// snapshot per setting, with every stage the claim is not about held off.
mod pictures {
    use super::*;
    use crate::px::{At, Output, Place, Rect, Size, Span};
    use crate::snapshot::{Anchoring, Frame, Snapshot, Tolerance};

    /// The decode floor for a claim a frame shrunk to [`WHOLE`] answers, which lets the decode halve.
    const SHRUNK: u32 = 1600;
    const WHOLE: Span<crate::px::Pinned> = Span::exact(960);
    /// No camera match, so no lattice: every pin under it holds on SwiftShader against the
    /// 3080's, the lens gather and the sharpen included.
    const NEUTRAL: Tolerance = Tolerance { worst: 256, mean: 1.5 };
    /// A frame whose straighten or keystone leaves a black border: a sample on that edge falls in
    /// or out on a rounding, and the shrink carries it whole, 898 codes on SwiftShader.
    const BORDERED: Tolerance = Tolerance { worst: 2048, mean: 1.5 };

    /// A job running only the stage under test: no match, no denoise, no sharpen, no defringe.
    fn plain(path: &PathBuf) -> crate::job::Job {
        let mut job = tile_job(path.to_str().unwrap(), None, None);
        job.denoise_luminance = Some(0.0);
        job.denoise_colour = Some(0.0);
        job
    }

    fn rendered(job: &crate::job::Job, decode: u32) -> crate::resident::Resident {
        rendered_through(job, decode, Lensing::Without)
    }

    fn rendered_through(
        job: &crate::job::Job,
        decode: u32,
        lensing: Lensing,
    ) -> crate::resident::Resident {
        let (samples, width, height, _) = rendition(job, decode, lensing);
        crate::resident::Resident::upload(adapter(), &samples, width, height)
    }

    fn square(x: usize, y: usize, side: usize) -> Rect<Output> {
        Rect {
            at: At { x: Place::measured(x), y: Place::measured(y) },
            size: Size::measured(side, side),
        }
    }

    #[test]
    fn the_white_balance_is_the_one_the_sliders_ask_for() {
        for (name, temperature, tint) in [
            ("white-balance/as-shot", None, None),
            ("white-balance/3000k", Some(3000.0), None),
            ("white-balance/7500k", Some(7500.0), None),
            ("white-balance/tint-minus-30", None, Some(-30.0)),
            ("white-balance/tint-plus-30", None, Some(30.0)),
        ] {
            let mut job = plain(&sony());
            job.adjust = crate::gpu::Adjust { temperature, tint, ..crate::gpu::Adjust::none() };
            Snapshot::whole(Frame::Coded(&rendered(&job, SHRUNK)), WHOLE)
                .check(name, NEUTRAL);
        }
    }

    #[test]
    fn the_geometry_is_the_one_the_reader_drew() {
        // `keystone.ts`'s correction for a pair of leaning uprights, as `gpu.rs` pins it.
        const LEANING: [f64; 8] = [
            0.847_222_222_222_222_2,
            0.0,
            0.076_388_888_888_888_9,
            0.0,
            0.847_222_222_222_222_2,
            0.076_388_888_888_888_9,
            -0.083_333_333_333_333_3,
            -0.125,
        ];
        let none = crate::image::Geometry::none();
        for (name, geometry) in [
            ("geometry/none", none),
            ("geometry/crop", crate::image::Geometry { crop: [0.1, 0.15, 0.85, 0.8], ..none }),
            ("geometry/straighten", crate::image::Geometry { angle_degrees: 6.0, ..none }),
            ("geometry/keystone", crate::image::Geometry { keystone: Some(LEANING), ..none }),
        ] {
            let mut job = plain(&sony());
            job.geometry = geometry;
            Snapshot::whole(Frame::Coded(&rendered(&job, SHRUNK)), WHOLE)
                .check(name, BORDERED);
        }
    }

    /// The Canon's, because its fitted lens is not an identity and the Sony's is: the whole frame
    /// for the distortion, a corner at 1:1 for the lateral colour.
    #[test]
    fn the_lens_correction_is_the_curve_it_was_given() {
        // What the camera match fitted to this frame on an RTX 3080, held as constants: the fit
        // lands on a different curve on each adapter (SwiftShader's first knot is -5.05), which
        // would move this pin by as much as the whole correction does.
        const CANON_KNOTS: [f64; 16] = [
            0.0,
            -0.201_211_057_656_414_87,
            -1.484_479_274_974_629_2,
            -0.989_652_849_983_085_9,
            5.358_703_666_929_134,
            4.286_962_933_543_307_5,
            4.736_558_726_277_765_5,
            4.059_907_479_666_657,
            -0.057_615_414_696_319_2,
            -0.051_213_701_952_283_7,
            -1.978_750_911_836_189_5,
            -1.798_864_465_305_627,
            0.0,
            0.0,
            0.0,
            0.0,
        ];
        let lens = crate::fit::Lens {
            distortion: Some(CANON_KNOTS.to_vec()),
            ..crate::fit::Lens::none()
        };
        let job = plain(&canon());
        // The tablecloth's edge at the left border and the shelf's at the right, high-contrast
        // edges as far out as the frame has them.
        let edges = [square(0, 4600, 512), square(3488, 1900, 512)];
        for (name, lensing) in [("lens/off", Lensing::Without), ("lens/on", Lensing::Given(lens))] {
            let frame = rendered_through(&job, 0, lensing);
            Snapshot::whole(Frame::Coded(&frame), WHOLE).check(name, NEUTRAL);
            Snapshot::crops(Frame::Coded(&frame), &edges)
                .check(&format!("{name}-edges"), NEUTRAL);
        }
    }

    /// The small print and the headline lettering on the X-T3's packet, which is in focus where
    /// the Sony's subject is not.
    #[test]
    fn the_sharpening_at_each_setting_is_the_one_last_looked_at() {
        let crops = [square(4300, 2500, 384), square(4250, 420, 384)];
        for (name, amount) in [("sharpen/off", 0.0), ("sharpen/half", 0.5), ("sharpen/full", 1.0)] {
            let mut job = plain(&fuji());
            job.sharpen = amount;
            Snapshot::crops(Frame::Coded(&rendered(&job, 0)), &crops).check(name, NEUTRAL);
        }
    }

    /// The demosaic straight off the mosaic, undenoised, beside the photosites it read: a Bayer
    /// body and an X-Trans one.
    #[test]
    fn the_demosaic_is_the_one_last_looked_at() {
        let gpu = adapter();
        for (name, path, crops) in [
            // The vase's ridges, a fine period to alias, and the poppy's stamens.
            ("demosaic/bayer", canon(), [(1800, 4000, 256), (2080, 2050, 256)]),
            // Red lettering on white, and the small print beside the heart.
            ("demosaic/xtrans", fuji(), [(3380, 1560, 256), (5500, 2400, 256)]),
        ] {
            let bytes = std::fs::read(&path).expect("the fixture reads");
            let held = pollster::block_on(crate::decode_rawler::hold_bytes(&bytes))
                .expect("the mosaic");
            let frame = pollster::block_on(held.frame(
                crate::galosh::Detail::at(0.0, 0.0),
                0,
                crate::galosh::Fit::Only,
                crate::dust::Wanted::Off,
            ))
            .expect("the frame");
            let resident = frame.resident().expect("the decode leaves the frame on the device");
            let samples = pollster::block_on(resident.host()).expect("the frame reads back");
            let levels = crate::hdr::levels_of(gpu, &samples, frame.width, frame.height, 0.995)
                .expect("the frame has levels");
            let anchoring = Anchoring {
                levels: levels.anchored(),
                reference_white_nits: crate::light::Light::exactly(203.0),
            };
            // The denoise snapshot's, which is this path with a denoise after it.
            let tolerance = Tolerance { worst: 512, mean: 0.1 };

            let drawn = crops.map(|(x, y, side)| Rect::<crate::px::Drawn>::exact(x, y, side, side));
            // The same photosites, in the orientation the file stored them in.
            let (left, top, width, height) = held.crop();
            let sensor = crops.map(|(x, y, side)| {
                let stored = crate::orientation::unoriented_rect(
                    crate::Tile { left: x, top: y, width: side, height: side },
                    width,
                    height,
                    held.upright(),
                );
                Rect::<crate::px::Sensor>::exact(
                    stored.left + left,
                    stored.top + top,
                    stored.width,
                    stored.height,
                )
            });
            Snapshot::crops(Frame::Scene(resident, anchoring), &drawn).check(name, tolerance);
            Snapshot::mosaic(gpu, held.device_mosaic(), &held.cfa(), anchoring, &sensor)
                .check(&format!("{name}-mosaic"), tolerance);
        }
    }
}

/// What bounds the editor's open, which is the only thing that can: it cannot be cancelled.
///
/// A reader who opens the editor and changes their mind leaves the decode running - neither
/// a browser abandoning a request nor Tauri dropping an invoke reaches the thread already
/// inside the decode - so the question is how many can be underway at once, and the answer has
/// to be one. Two 61MP opens together are the decode plus an f32 buffer of the same shape,
/// each, which is where a laptop runs out of memory.
///
/// Timed, because the exclusion is the whole behaviour and it is not otherwise visible: the
/// lock is private, and a caller cannot see whether it waited.
///
/// The two opens are timed against each other rather than against a single one measured
/// first, which is the difference between a pin and a flaky one. A baseline says how long an
/// open takes on an idle machine, and the rest of this suite runs in parallel with it - so
/// under `cargo test` the baseline came out inflated and the comparison collapsed. Two
/// threads started together share whatever load there is equally: if they queued, one of them
/// waited out the other and took about twice as long, and that ratio holds however busy the
/// machine is.
mod one_open_at_a_time {
    use super::*;

    fn request() -> crate::edit::EditRequest {
        crate::edit::EditRequest {
            // Small, so this costs a second rather than ten. What is being measured is
            // whether two of them overlap, which does not depend on how big each one is.
            long_edge: 1200,
            grade: crate::hdr::Grade {
                peak_nits: crate::light::Light::exactly(1000.0),
                reference_white_nits: crate::light::Light::exactly(203.0),
                white_quantile: 0.9,
            },
            defringe: 0.5,
            photo_analysis: None,
            dust: Default::default(),
            repairs: Vec::new(),
            // The document's own defaults, so the open this times is the one a reader gets
            // rather than a cheaper one that skips the denoise.
            denoise_luminance: Some(20.0),
            denoise_colour: Some(30.0),
        }
    }

    fn open(path: &PathBuf) {
        let bytes = std::fs::read(path).expect("the fixture reads");
        crate::edit::prepare_bytes(&bytes, &request(), 0.6).expect("the fixture opens");
    }

    /// **Asked as overlap, not as duration.** This compared how long the two opens took and
    /// wanted the slower to be 1.5x the faster, which is the right shape of answer but a guess
    /// at it: the ratio only separates the two outcomes while the machine is otherwise idle.
    /// Run beside the rest of the suite the first open slows down too, the ratio collapses, and
    /// the test failed on a lock that was working perfectly - reliably enough that it was
    /// dismissed as a flake for the whole of this branch.
    ///
    /// Two opens either overlapped or they did not, and `edit::served` says which, so this
    /// asks that instead. Exact, and it cannot care how loaded the machine is.
    #[test]
    fn a_second_open_waits_for_the_first() {
        let path = sony();
        // Warmed, so neither open pays for a cold page cache on a 24MP file.
        open(&path);
        let before = crate::edit::served().len();

        std::thread::scope(|scope| {
            let threads: Vec<_> = (0..2).map(|_| scope.spawn(|| open(&path))).collect();
            for thread in threads {
                thread.join().expect("the open finished");
            }
        });

        let served = crate::edit::served();
        // Every turn since, not exactly two: `served` is the process's, so another test opening a
        // fixture beside this one is one more turn here and says nothing about the lock. What the
        // lock claims is that no two of them overlap, whoever took them.
        let mut turns = served[before..].to_vec();
        assert!(turns.len() >= 2, "two opens should have taken at least two turns");
        turns.sort_by_key(|turn| turn.0);
        for pair in turns.windows(2) {
            let (first, next) = (pair[0], pair[1]);
            assert!(
                next.0 >= first.1,
                "an open began at {}us while another was still running until {}us, so neither \
                 waited for the other",
                next.0,
                first.1,
            );
        }
    }

    /// The open carries the frame's noise, and carries one a tile will accept.
    ///
    /// The client cannot check it - it holds the numbers without reading them - and the tile route
    /// refuses a fit that does not describe a sensor, so an open that sent a fit `usable` rejects
    /// would leave every loupe tile quietly fitting its own with nothing to say so.
    #[test]
    fn an_open_hands_over_the_frame_it_measured() {
        let bytes = std::fs::read(sony()).expect("the fixture reads");
        let prepared =
            crate::edit::prepare_bytes(&bytes, &request(), 0.6).expect("the fixture opens");
        let fit = prepared.header.noise_fit.expect("the open measured the mosaic");
        assert!(fit.usable(), "the open sent a fit a tile would refuse: {fit:?}");
    }
}

/// The scan's half of an import, which builds the grid tile while it holds the RAW open (10.4).
mod fused_scan {
    use super::*;

    fn tile_job(path: &PathBuf, out: &str, scan: bool) -> crate::job::Job {
        serde_json::from_str(&format!(
            r#"{{
                "rawFilePath": {:?},
                "matchEmbeddedJpeg": false,
                "scan": {scan},
                "denoiseLuminance": 0,
                "denoiseColour": 0,
                "sharpen": 0,
                "defringe": 0,
                "grade": {{ "peakNits": 1000, "referenceWhiteNits": 203, "whiteQuantile": 0.9 }},
                "targets": [{{
                    "rendition": "grid",
                    "output": "srgb",
                    "outputPath": {out:?},
                    "size": 800,
                    "source": "embedded",
                    "sdrQuantizer": 13,
                    "hdrQuantizer": 13,
                    "preset": 0,
                    "stillFullChroma": false,
                    "sdrFullChroma": false
                }}]
            }}"#,
            path.to_string_lossy(),
        ))
        .expect("the tile job parses")
    }

    /// **The catalogue's answer cannot depend on which pass read the file.** A fused scan reports
    /// these fields off the source it lifts the preview from, where a scan that stages nothing
    /// reads them through `header::read_path`, and the row is written from whichever ran - so a
    /// field that came back differently would date, orient or credit a photograph according to a
    /// decision about speed.
    #[test]
    fn the_fused_header_is_the_one_the_scan_would_have_read() {
        let path = sony();
        let out = std::env::temp_dir().join("bb-fused-scan-header.avif");
        let fused = crate::job::run(&tile_job(&path, &out.to_string_lossy(), true))
            .expect("the fused job runs")
            .header
            .expect("a fused job reports the header");
        let read = crate::header::read_path(&path.to_string_lossy()).expect("the header reads");

        assert_eq!(fused, crate::job::HeaderFields::from(read));
    }

    /// The tile and its descriptor both. The pass that adopts the tile cannot recover the
    /// descriptor from it - the pixels are inside an AVIF by then - so a fused scan that wrote
    /// the one without the other would leave that photograph silently unable to stack.
    #[test]
    fn the_fused_pass_writes_the_tile_and_describes_it() {
        let path = sony();
        let out = std::env::temp_dir().join("bb-fused-scan-tile.avif");
        std::fs::remove_file(&out).ok();

        let outcome =
            crate::job::run(&tile_job(&path, &out.to_string_lossy(), true)).expect("the job runs");

        assert!(out.is_file(), "the fused pass wrote no tile");
        assert!(std::fs::metadata(&out).expect("the tile stats").len() > 0);
        assert!(outcome.descriptor.is_some(), "the fused pass described no frame");
    }

    /// A job that did not ask reports nothing, which is every rendition the viewer and the editor
    /// ask for: the fields cost an open and a shape decode that none of them reads.
    #[test]
    fn a_job_that_did_not_ask_for_the_header_does_not_pay_for_it() {
        let path = sony();
        let out = std::env::temp_dir().join("bb-fused-scan-unasked.avif");
        let outcome =
            crate::job::run(&tile_job(&path, &out.to_string_lossy(), false)).expect("the job runs");
        assert!(outcome.header.is_none());
    }

    /// **A scan never demosaics, and this is the test that says so.**
    ///
    /// A target whose preview cannot be lifted falls through to `Base::build` for every other
    /// caller, which is what a rendition job wants and what a scan must not do: 1.5 seconds on
    /// the *scan* pool, for a tile the rendition pass is about to be asked for anyway, rendered
    /// without the library settings a scan does not carry. Asked of a file with no preview at
    /// all, so the fallback is the only thing that could produce a tile.
    #[test]
    fn a_scan_leaves_a_file_it_cannot_lift_a_preview_from_to_the_rendition_pass() {
        let raw = std::env::temp_dir().join("bb-fused-scan-not-a-raw.arw");
        // Not a RAW at all, which is the same thing to this code as a body that embeds no JPEG:
        // there is no preview to lift. A real such body would be a better fixture and there is
        // not one in the tree.
        std::fs::write(&raw, b"not a raw file").expect("the scratch file writes");
        let out = std::env::temp_dir().join("bb-fused-scan-no-preview.avif");
        std::fs::remove_file(&out).ok();

        let outcome = crate::job::run(&tile_job(&raw, &out.to_string_lossy(), true));

        // Either answer is a scan that gave up rather than rendered; what must not happen is a
        // tile on disk, which could only have come from a demosaic.
        assert!(
            outcome.as_ref().map_or(true, |done| done.descriptor.is_none()),
            "a scan described a frame it could not lift a preview from",
        );
        assert!(!out.is_file(), "a scan rendered a tile it should have left to the rendition pass");
    }
}

/// The tone group has to land on the tones it names whatever the camera match did.
///
/// **This is what "highlights is an exposure slider" would be, measured.** `adjusted` places
/// every zone against diffuse white and middle grey, and the matched arm reaches it *after* the
/// camera's own rendering - which lands white wherever that body's JPEG put it and lifts middle
/// grey by upwards of a stop, both by a different amount on every photograph. Take either from
/// the scene instead of from that rendering and the zones sit two to three stops off, which is
/// far enough to put `shadows` at full strength in the midtones and `highlights` four stops down
/// in the subject.
///
/// So the claim is that the two name *disjoint ends* of the scene, on frames whose matches
/// differ - one of them a frame whose white is the sensor's ceiling, where the picture sits
/// three stops under white and there is the most room to be wrong.
mod tone_domain {
    use super::*;

    const QUANTILE: f64 = 0.995;
    const REFERENCE_NITS: crate::light::Light<crate::light::SceneNits> =
        crate::light::Light::exactly(203.0);
    /// What counts as leaving a band alone. Generous on purpose: the claim is disjoint ends,
    /// not a particular falloff, and the constants in `adjust.slang` are taste.
    const ALONE: f64 = 3.0;
    /// Depths measured, in stops under diffuse white. Every fixture keeps pixels at all of
    /// them, which `response` asserts rather than averaging an empty band into a pass.
    const BANDS: usize = 6;
    /// How much of its own full move a slider must make at the end it is named for.
    ///
    /// **The assertion that a zone is centred where it claims to be**, and the one a "moves its
    /// end by *some* amount" bound cannot make: a highlights centre that has drifted past white
    /// leaves the zone with only its falling side inside the range, which is a slider at seven
    /// eighths strength on the very pixels it exists for - visible in a sky, and comfortably
    /// past any threshold phrased as a minimum.
    const OPEN: f64 = 0.96;
    /// How much further open an inner zone must be than its outer partner, over the range
    /// between their two centres. Three is well clear of the ratio a collapsed pair shows,
    /// which is the strength difference alone and nothing else.
    const APART: f64 = 3.0;
    /// How much of the open sky's move an equally bright but walled-in pixel must still take.
    /// Not all of it: the fit pulls a pixel part-way towards its surroundings on purpose, and
    /// where the surroundings are two stops down that pull is real. Measured on `clipped()`,
    /// where a fit read at the texel gives 81% and one read at the pixel 95%.
    const ENCLOSED: f64 = 0.9;
    /// Pixels a block-brightness bin needs before it is compared. Bright pixels walled in by dark
    /// ones are rare - two of the three fixtures hold a few dozen, which is noise, and only
    /// `clipped()` has a real population of them.
    const ENOUGH: u64 = 10_000;
    /// How much of its resting mean a channel must still hold at the end of the temperature
    /// slider. A tenth is far below anything anyone would call correct and far above nothing,
    /// which is the only thing being ruled out.
    const ALIVE: f64 = 0.1;

    /// A `static const float` of `adjust.slang`, so retuning one retunes what these demand
    /// instead of quietly loosening it.
    fn declared(name: &str) -> f64 {
        const ADJUST_SLANG: &str = include_str!("../../../slang/adjust.slang");
        let at = ADJUST_SLANG
            .find(&format!("static const float {name} ="))
            .unwrap_or_else(|| panic!("{name} is declared"));
        let line = &ADJUST_SLANG[at..][..ADJUST_SLANG[at..].find(';').expect("terminated")];
        line.rsplit('=').next().expect("a value").trim().parse().expect("a number")
    }

    /// What a slider at 100 does to the counts under it with its zone fully open.
    fn full_move(stops: f64) -> f64 {
        (2.0f64.powf(declared("ZONE_STOPS") * stops) - 1.0) * 100.0
    }

    /// How open a zone was, backed out of what it did to the counts.
    ///
    /// The inverse of the gain, not a share of the full move: a zone worth 1.5 stops and one
    /// worth 2.0 move the same pixel by different amounts at the same weight, and a ratio taken
    /// off the percentages would be reading that difference rather than the shape.
    fn openness(percent: f64, stops: f64) -> f64 {
        -(1.0 + percent / 100.0).log2() / stops
    }

    /// Mean change in graded counts, indexed by depth under the frame's own diffuse white.
    ///
    /// Binned off the source rather than off either grade, so a slider is measured against the
    /// picture it was handed rather than the one it just changed. Every band at once because the
    /// decode and the match either side of it are seconds, and both tests read two.
    fn response(path: &PathBuf, adjust: crate::gpu::Adjust) -> Vec<f64> {
        let gpu = crate::gpu::device().expect("a Vulkan adapter, since the grade is a shader");
        let frame = decode(path, 0);
        let samples = frame.samples16().expect("16-bit").to_vec();
        let matched = {
            let resident = frame.on_device(gpu).expect("the frame reaches the device");
            crate::fit_hdr_for(&resident, path.to_str().unwrap(), QUANTILE)
        };
        assert!(matched.is_some(), "{} must fit a match, or this measures nothing", path.display());
        let colour = matched.as_ref().map(|m| &m.colour);
        let levels = crate::hdr::levels_of(gpu, &samples, frame.width, frame.height, QUANTILE)
            .expect("levels");
        let flat = graded(gpu, &samples, &frame, colour, levels, crate::gpu::Adjust::none());
        let moved = graded(gpu, &samples, &frame, colour, levels, adjust);

        let mut total = vec![0.0f64; BANDS];
        let mut count = vec![0u64; BANDS];
        for i in (0..flat.len()).step_by(3) {
            let scene = (0.2627 * f64::from(samples[i])
                + 0.6780 * f64::from(samples[i + 1])
                + 0.0593 * f64::from(samples[i + 2]))
                / levels.white.raw();
            let was = f64::from(flat[i]);
            if scene <= 0.0 || was <= 0.0 {
                continue;
            }
            let band = (-scene.log2()).round();
            if band < 0.0 || band >= BANDS as f64 {
                continue;
            }
            total[band as usize] += (f64::from(moved[i]) - was) / was;
            count[band as usize] += 1;
        }
        (0..BANDS)
            .map(|band| {
                assert!(count[band] > 0, "{} has no pixels {band} stops under white", path.display());
                total[band] / count[band] as f64 * 100.0
            })
            .collect()
    }

    fn graded(
        gpu: &'static crate::gpu::Gpu,
        samples: &[u16],
        frame: &crate::frame::Frame,
        colour: Option<&crate::hdr_fit::HdrColour>,
        levels: crate::tone::Levels,
        adjust: crate::gpu::Adjust,
    ) -> Vec<u16> {
        let mut coded = samples.to_vec();
        crate::hdr::code_base(&mut coded, levels.anchored(), REFERENCE_NITS);
        gpu.encode(&coded, &crate::gpu::Grade {
            width: frame.width,
            height: frame.height,
            photograph_long: crate::px::Span::measured(frame.width.max(frame.height)),
            colour,
            white: levels.white,
            source_level: levels.peak,
            floor: levels.floor,
            reference_nits: REFERENCE_NITS,
            peak_nits: crate::light::Light::exactly(1000.0),
            exposure: crate::light::Stops::ZERO,
            adjust,
            // The frame's own, or the balance has no illuminant to move away from and the
            // temperature slider is the identity whatever it is set to.
            as_shot: frame.as_shot,
            output: crate::gpu::Output::Rolled,
            geometry: crate::image::Geometry::none(),
            window: None,
            surround_window: None,
            canvas: None,
        })
    }

    #[test]
    fn highlights_leaves_the_dark_end_of_a_matched_frame_alone() {
        for path in [sony(), canon(), clipped()] {
            let pulled = crate::gpu::Adjust { highlights: -100.0, ..crate::gpu::Adjust::none() };
            let by_band = response(&path, pulled);
            let (bright, dark) = (by_band[0], by_band[4]);
            let full = full_move(-1.0);
            assert!(
                bright < full * OPEN,
                "highlights at -100 moved white by {bright:.1}% on {} where a zone open at white \
                 moves it {full:.1}%: the centre has drifted off the end it is named for",
                path.display(),
            );
            assert!(
                dark.abs() < ALONE,
                "highlights at -100 moved a band four stops under white by {dark:.1}% on {} \
                 (white moved {bright:.1}%): it is reaching the subject, which is what a zone \
                 placed against the scene's middle grey rather than the match's own does",
                path.display(),
            );
        }
    }

    /// Each pair has to be two controls, not one control at two strengths.
    ///
    /// **`shoulder` is flat past its centre, so two of them facing the same way are the same
    /// function everywhere beyond the further centre.** Highlights and whites both open fully on
    /// everything near white; what makes them different controls is only the range between their
    /// centres, where the inner one is still open and the outer one has rolled off. Squeeze that
    /// range - which is what placing the zones against a camera rendering's middle grey does,
    /// there being about a stop of room under its white instead of two and a half - and the pair
    /// collapse onto one curve that differs only in how hard it pulls. Reported as "highlights
    /// and whites seem to do the same thing", and measured here as the ratio between them a
    /// stop and a half under white.
    ///
    /// Normalised by each slider's own full move, because the two are worth a different number of
    /// stops at the ends they name and this is a claim about *shape*.
    #[test]
    fn each_pair_is_two_controls_rather_than_one_at_two_strengths() {
        for path in [sony(), canon(), clipped()] {
            let none = crate::gpu::Adjust::none();
            let (zone, end) = (declared("ZONE_STOPS"), declared("END_STOPS"));
            let inner = |band: usize, by: Vec<f64>| openness(by[band], zone);
            let outer = |band: usize, by: Vec<f64>| openness(by[band], end);

            let highlights =
                inner(2, response(&path, crate::gpu::Adjust { highlights: -100.0, ..none }));
            let whites = outer(2, response(&path, crate::gpu::Adjust { whites: -100.0, ..none }));
            assert!(
                highlights > whites * APART,
                "two stops under white, highlights is {:.0}% open and whites {:.0}% on {}: the \
                 two are one control at two strengths, and moving either reads the same",
                highlights * 100.0,
                whites * 100.0,
                path.display(),
            );

            let shadows =
                inner(3, response(&path, crate::gpu::Adjust { shadows: -100.0, ..none }));
            let blacks = outer(3, response(&path, crate::gpu::Adjust { blacks: -100.0, ..none }));
            assert!(
                shadows > blacks * APART,
                "three stops under white, shadows is {:.0}% open and blacks {:.0}% on {}: the \
                 same collapse at the bottom of the range",
                shadows * 100.0,
                blacks * 100.0,
                path.display(),
            );
        }
    }

    /// A bright pixel takes the move its own brightness earns, not its surroundings'.
    ///
    /// **This is "the sky darkens where it is open and not where it shows through a tree".** The
    /// neighbourhood is built at `detail_step` square per texel - nineteen pixels a side at 61MP -
    /// so a gap of sky narrower than that is averaged in with the branches before the edge-aware
    /// fit ever sees it. Weight a zone by the texel itself and the gap takes the move its dark
    /// surroundings deserve; `detail.slang` hands the fit over unevaluated so the grade can put
    /// the pixel back into it, and this is the difference that makes.
    ///
    /// Needs a real photograph. A synthetic bar chart puts its edges at whatever multiple of the
    /// texel the fixture picks, and at the aliasing limit the fit degenerates to a box mean for
    /// reasons that have nothing to do with what is being pinned - a frame of bare trees has
    /// gaps at every scale at once, which is the case that matters.
    #[test]
    fn an_isolated_highlight_moves_with_the_open_sky_it_matches() {
        for path in [sony(), canon(), clipped()] {
            let by_block = by_surroundings(&path);
            // The brightest surroundings a frame has plenty of, against the darkest: same pixels
            // either way, and only what is around them differs.
            let (open, enclosed) = (by_block.0, by_block.1);
            assert!(
                open < -20.0,
                "highlights at -100 moved sky in the open by {open:.1}% on {}, which is not a \
                 recovery and leaves the ratio below meaningless",
                path.display(),
            );
            assert!(
                enclosed < open * ENCLOSED,
                "highlights at -100 moved sky in the open {open:.1}% and equally bright pixels \
                 walled in by dark ones {enclosed:.1}% on {}: the zone is following the block a \
                 pixel was averaged into rather than the pixel",
                path.display(),
            );
        }
    }

    /// The highlights response for pixels within a stop of white, in the openest surroundings the
    /// frame has and in the most enclosed, as percentages.
    ///
    /// The block is `detail.slang`'s own footprint - a linear area mean of `detail_step` square,
    /// which is the thing a narrow gap of sky disappears into.
    fn by_surroundings(path: &PathBuf) -> (f64, f64) {
        let gpu = crate::gpu::device().expect("a Vulkan adapter, since the grade is a shader");
        let frame = decode(path, 0);
        let samples = frame.samples16().expect("16-bit").to_vec();
        let (width, height) = (frame.width, frame.height);
        let matched = {
            let resident = frame.on_device(gpu).expect("the frame reaches the device");
            crate::fit_hdr_for(&resident, path.to_str().unwrap(), QUANTILE)
        };
        let colour = matched.as_ref().map(|m| &m.colour);
        let levels =
            crate::hdr::levels_of(gpu, &samples, width, height, QUANTILE).expect("levels");
        let flat = graded(gpu, &samples, &frame, colour, levels, crate::gpu::Adjust::none());
        let pulled = graded(gpu, &samples, &frame, colour, levels, crate::gpu::Adjust {
            highlights: -100.0,
            ..crate::gpu::Adjust::none()
        });

        let luma = |i: usize| {
            (0.2627 * f64::from(samples[i])
                + 0.6780 * f64::from(samples[i + 1])
                + 0.0593 * f64::from(samples[i + 2]))
                / levels.white.raw()
        };
        let step = crate::gpu::detail_step(width.max(height)) as usize;
        let tiles = width.div_ceil(step);
        let mut block = vec![0.0f64; tiles * height.div_ceil(step)];
        let mut count = vec![0u32; block.len()];
        for y in 0..height {
            for x in 0..width {
                let at = (y / step) * tiles + x / step;
                block[at] += luma((y * width + x) * 3);
                count[at] += 1;
            }
        }
        for (mean, n) in block.iter_mut().zip(&count) {
            *mean /= f64::from(*n).max(1.0);
        }

        let mut total = [0.0f64; BANDS];
        let mut seen = [0u64; BANDS];
        for y in 0..height {
            for x in 0..width {
                let i = (y * width + x) * 3;
                let (scene, was) = (luma(i), f64::from(flat[i]));
                let around = block[(y / step) * tiles + x / step];
                if scene <= 0.0 || was <= 0.0 || around <= 0.0 || scene.log2() < -1.0 {
                    continue;
                }
                let bin = (-around.log2()).round().clamp(0.0, (BANDS - 1) as f64) as usize;
                total[bin] += (f64::from(pulled[i]) - was) / was;
                seen[bin] += 1;
            }
        }
        // An absolute count rather than a share: bright pixels walled in by dark ones are rare by
        // nature - a fraction of a percent of a frame - and a share-of-total filter would drop
        // exactly the pixels this is about while leaving the open sky that proves nothing.
        let held: Vec<usize> = (0..BANDS).filter(|b| seen[*b] > ENOUGH).collect();
        let mean = |b: usize| total[b] / seen[b] as f64 * 100.0;
        (mean(*held.first().expect("a bright block")), mean(*held.last().expect("a dark block")))
    }

    /// The far end of the temperature slider is still a photograph, not one channel.
    ///
    /// **A balance is a claim about the light, so it has to reach the tone curve.** Applied after
    /// the camera's rendering it lands on values that curve has already compressed, with no
    /// headroom left: a daylight frame told the light was 2000K needs most of a decade of blue,
    /// and post-curve that is green floored at zero across the whole frame - measured on this
    /// fixture, a mean green of 0 against a blue of 29367, which is a flat field with the hue of
    /// one primary.
    ///
    /// The claim is only that every channel survives with something in it. Where the slider ends
    /// up looking is taste and the numbers below are deliberately loose; a channel at nothing is
    /// not taste.
    #[test]
    fn the_cold_end_of_the_temperature_slider_keeps_every_channel() {
        for path in [sony(), canon(), clipped()] {
            let frame = decode(&path, 0);
            let samples = frame.samples16().expect("16-bit").to_vec();
            let gpu = crate::gpu::device().expect("a Vulkan adapter, since the grade is a shader");
            let matched = {
                let resident = frame.on_device(gpu).expect("the frame reaches the device");
                crate::fit_hdr_for(&resident, path.to_str().unwrap(), QUANTILE)
            };
            let levels = crate::hdr::levels_of(gpu, &samples, frame.width, frame.height, QUANTILE)
                .expect("levels");
            let rest = graded(gpu, &samples, &frame, matched.as_ref().map(|m| &m.colour), levels,
                crate::gpu::Adjust::none());
            let cold = graded(gpu, &samples, &frame, matched.as_ref().map(|m| &m.colour), levels,
                crate::gpu::Adjust { temperature: Some(2000.0), ..crate::gpu::Adjust::none() });

            let mean = |out: &[u16], channel: usize| {
                out.iter().skip(channel).step_by(3).map(|v| f64::from(*v)).sum::<f64>()
                    / (out.len() / 3) as f64
            };
            assert!(frame.as_shot.is_some(), "{} records no neutral, so nothing here is exercised", path.display());
            let (was, now) = (mean(&rest, 1), mean(&cold, 1));
            assert!(
                now > was * ALIVE,
                "2000K took the green channel of {} from a mean of {was:.0} to {now:.0}: the \
                 balance is landing past the curve that should have compressed it, and what is \
                 left is one channel",
                path.display(),
            );
            // And it went the way it is named. Colder is bluer, all the way down: a slider that
            // reversed somewhere near the end would still pass a test that only asked for a
            // change, and reversing near the end is exactly what an illuminant walked off the
            // chromaticity diagram does (`white_balance.slang`'s `step_within`).
            assert!(
                mean(&cold, 2) > mean(&rest, 2) * 2.0,
                "2000K took the blue channel of {} from a mean of {:.0} to {:.0}, which is not \
                 the cold end of anything",
                path.display(),
                mean(&rest, 2),
                mean(&cold, 2),
            );
        }
    }

    #[test]
    fn shadows_leaves_the_bright_end_of_a_matched_frame_alone() {
        for path in [sony(), canon(), clipped()] {
            let lifted = crate::gpu::Adjust { shadows: 100.0, ..crate::gpu::Adjust::none() };
            let by_band = response(&path, lifted);
            let (dark, bright) = (by_band[5], by_band[1]);
            let full = full_move(1.0);
            assert!(
                dark > full * OPEN,
                "shadows at +100 moved a band five stops under white by {dark:.1}% on {} where a \
                 zone open in the shadows moves it {full:.1}%: it does not reach the end it is \
                 named for",
                path.display(),
            );
            assert!(
                bright.abs() < ALONE,
                "shadows at +100 moved a band one stop under white by {bright:.1}% on {} (the \
                 shadows moved {dark:.1}%): it is lifting the midtones, so the two inner sliders \
                 sum to an exposure",
                path.display(),
            );
        }
    }
}
