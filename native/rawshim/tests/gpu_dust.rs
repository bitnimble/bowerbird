//! The search and the correction, both on a device, because both of them only exist on one.
//!
//! Two halves. **The search** plants particles in a frame and asks what comes back - where, how deep,
//! what shape, and which of them the gates keep; every one of those answers is computed by
//! `dust_find.slang` and there is nowhere else to ask. **The correction** plants a shadow in the
//! shape a [`Spot`] describes, divides it out, and looks at the picture afterwards, which is the one
//! thing the fixture suite cannot see: an uncorrected band matches an uncorrected frame perfectly.
//!
//! Skipped where no Vulkan adapter answers, loudly rather than silently.

use rawshim::dust::{self, Removal, Spot, BINS, SPAN};

/// A flat mosaic with one particle's shadow multiplied into it, in the shape a spot describes.
///
/// Built from the same profile the [`Spot`] carries, so a correct kernel divides it back to flat
/// and the residual left over is a statement about the arithmetic rather than about the model.
fn shadowed(width: usize, height: usize, spot: &Spot, level: f32) -> Vec<f32> {
    let mut samples = vec![level; width * height];
    for (at, sample) in samples.iter_mut().enumerate() {
        let (x, y) = ((at % width) as f32 / 2.0, (at / width) as f32 / 2.0);
        // **Into the ellipse's own frame, spelled out here rather than borrowed from the kernel.**
        // A round spot makes this plain distance, and against plain distance a transposed rotation,
        // a swapped pair of axes or a `turn` read from the wrong slot all pass. Written
        // independently, an elongated spot is a statement about the geometry the shader has to
        // agree with.
        let (px, py) = (x - spot.x, y - spot.y);
        let (u, v) = (
            px * spot.turn.0 + py * spot.turn.1,
            -px * spot.turn.1 + py * spot.turn.0,
        );
        let radius = ((u / spot.axes.0).powi(2) + (v / spot.axes.1).powi(2)).sqrt() / spot.scale;
        if radius >= SPAN {
            continue;
        }
        // The kernel's own read: between bins rather than at one, since anything else would be
        // comparing this file's interpolation with the shader's.
        let along = (radius / SPAN * BINS as f32 - 0.5).clamp(0.0, (BINS - 1) as f32);
        let low = along.floor() as usize;
        let high = (low + 1).min(BINS - 1);
        let dip = spot.profile[low]
            + (spot.profile[high] - spot.profile[low]) * (along - along.floor());
        *sample *= (-dip).exp();
    }
    samples
}

/// A round particle, flat-topped with a soft rim, which is the shape the optics make.
fn a_spot(x: f32, y: f32) -> Spot {
    Spot {
        x,
        y,
        scale: 7.0,
        axes: (1.0, 1.0),
        turn: (1.0, 0.0),
        snr: 6.0,
        profile: std::array::from_fn(|bin| {
            let along = (bin as f32 + 0.5) / BINS as f32 * SPAN;
            0.12 * (1.4 - along).clamp(0.0, 1.0)
        }),
    }
}

#[test]
fn the_kernel_divides_the_shadow_it_was_given_back_out() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the dust kernel was not run.");
        return;
    };
    let (width, height) = (256usize, 256usize);
    const LEVEL: f32 = 0.5;
    let spot = a_spot(64.0, 70.0);

    let before = shadowed(width, height, &spot, LEVEL);
    let centre = (spot.y as usize * 2) * width + spot.x as usize * 2;
    let deepest = 1.0 - before[centre] / LEVEL;
    assert!(deepest > 0.10, "the planted shadow is only {deepest}, so nothing is being tested");

    let mosaic = rawshim::condition::Mosaic::upload(gpu, &before, width, height);
    dust::correct(
        gpu,
        dust::device(gpu),
        &mosaic,
        std::slice::from_ref(&spot),
        Removal { sensitivity: 0.5, intensity: 1.0 },
        (0, 0),
    );
    let after = pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back");

    // **Over the whole footprint, not at the centre.** A kernel that corrected the plateau and
    // left the skirt is the failure the profile exists to prevent, and a centre sample cannot see
    // it - the skirt is where a threshold-shaped mask stops and beta is still a third of its peak.
    let mut worst = 0.0f32;
    let mut worst_at = 0usize;
    for at in 0..width * height {
        let off = (after[at] / LEVEL - 1.0).abs();
        if off > worst {
            worst = off;
            worst_at = at;
        }
    }
    // Tight, because both sides exponentiate the same interpolated dip in f32 and the true residual
    // is nearer 1e-7: a tolerance loose enough to accept a percent would accept a systematic error
    // in the profile's magnitude, which is exactly the failure worth catching here.
    assert!(
        worst < 1e-4,
        "the corrected frame is {worst} off flat at ({}, {})",
        worst_at % width,
        worst_at / width,
    );
}

/// A body the search is sized for: wide enough that the implied pitch predicts a six-quad shadow at
/// f/5.6, which is the scale the blurs, the area bracket and the margin are all tuned at.
///
/// **The aperture has to be one the search would look at.** Anything wider is refused outright, and a
/// frame small enough to test in milliseconds implies a very coarse pitch - so a narrower plane than
/// this rejects a particle of the size worth planting.
fn sized(edge: usize) -> rawshim::dust::Sensor {
    rawshim::dust::Sensor {
        width: edge,
        height: edge,
        crop: (0, 0, edge, edge),
        cfa: rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap(),
        aperture: 5.6,
        width_mm: rawshim::dust::FULL_FRAME_MM,
    }
}

/// A flat grey frame with faint deterministic grain, and the particles asked for on top.
///
/// The dip is flat-topped with a soft rim rather than Gaussian, because that is the shape the optics
/// make: the shadow is the pupil convolved with a much smaller particle. Coordinates are the plane's
/// own quad grid, whatever working grid the search then picks.
fn planted(sensor: &rawshim::dust::Sensor, spots: &[(f32, f32, f32, f32)]) -> Vec<f32> {
    let mut samples = vec![0f32; sensor.width * sensor.height];
    let mut noise = 0x5eed_1234u32;
    for (at, sample) in samples.iter_mut().enumerate() {
        noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let grain = (noise >> 8) as f32 / (1 << 24) as f32 - 0.5;
        let (x, y) = ((at % sensor.width) as f32 / 2.0, (at / sensor.width) as f32 / 2.0);
        let dip: f32 = spots
            .iter()
            .map(|(cx, cy, radius, depth)| {
                let away = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() / radius;
                depth * (1.5 - away).clamp(0.0, 1.0)
            })
            .sum();
        *sample = 0.5 * (1.0 + 0.004 * grain) * (-dip).exp();
    }
    samples
}

/// What the search makes of a planted frame, or None where no adapter answered.
fn found(
    sensor: &rawshim::dust::Sensor,
    spots: &[(f32, f32, f32, f32)],
) -> Option<Vec<Spot>> {
    found_in(sensor, sensor, spots)
}

/// The same, where the picture the search is told about is inset in a larger plane.
fn found_in(
    plane: &rawshim::dust::Sensor,
    sensor: &rawshim::dust::Sensor,
    spots: &[(f32, f32, f32, f32)],
) -> Option<Vec<Spot>> {
    let gpu = rawshim::gpu::device()?;
    let samples = planted(plane, spots);
    let mosaic =
        rawshim::condition::Mosaic::upload(gpu, &samples, plane.width, plane.height);
    pollster::block_on(rawshim::dust::detect(gpu, &mosaic, sensor))
}

#[test]
fn a_particle_is_found_where_it_was_put() {
    let Some(spots) = found(&sized(1200), &[(180.0, 220.0, 6.0, 0.12)]) else {
        eprintln!("SKIPPED: no adapter answered, so nothing was searched for.");
        return;
    };
    assert_eq!(spots.len(), 1, "found {:?}", spots.iter().map(|s| (s.x, s.y)).collect::<Vec<_>>());
    let spot = &spots[0];
    assert!((spot.x - 180.0).abs() < 3.0, "x is {}", spot.x);
    assert!((spot.y - 220.0).abs() < 3.0, "y is {}", spot.y);

    // The profile is what the correction divides out, so the plateau has to be the dip that was
    // planted rather than merely something positive. Measured against the ring the depth is read
    // from, which is why this is a tolerance and not an equality.
    assert!((spot.profile[0] - 0.12).abs() < 0.03, "the plateau is {}", spot.profile[0]);
    assert!(spot.profile[0] > spot.profile[BINS - 1], "the profile does not fall off");
    // Round, because a round particle was planted: the ellipse must not invent an elongation out of
    // noise, or every correction wears two lobes.
    assert!((spot.axes.0 / spot.axes.1 - 1.0).abs() < 0.25, "axes {:?}", spot.axes);
}

/// A denser body is read coarser, and still says where a particle is in the frame's own coordinates.
///
/// **The conversion this pins is the one that fails silently.** A shrunk frame is searched on a grid
/// coarser than the mosaic, so a spot handed back in working coordinates would land at half or a
/// quarter of its true position - a correction confidently dividing a shadow out of empty sky, and
/// nothing to say so but the picture.
#[test]
fn a_denser_body_still_answers_in_frame_coordinates() {
    // A real 61MP body reaches this at f/10.
    let dense = sized(3200);
    assert_eq!(dense.shrink(), 2, "this body was meant to be worth reading coarser");
    let put = (700.0, 480.0, 16.0, 0.12);
    let Some(spots) = found(&dense, &[put]) else {
        eprintln!("SKIPPED: no adapter answered, so the coarse read was not run.");
        return;
    };
    assert_eq!(spots.len(), 1, "found {}", spots.len());
    // Within a working sample of where it was put, in the *frame's* quad grid.
    assert!((spots[0].x - put.0).abs() < 4.0, "x is {}", spots[0].x);
    assert!((spots[0].y - put.1).abs() < 4.0, "y is {}", spots[0].y);
    // And the radius comes back in that grid too, or the footprint is corrected at half size.
    assert!((spots[0].scale - put.2).abs() < 6.0, "scale is {}", spots[0].scale);
}

/// A frame that is not square puts its particle at the coordinates it was planted at.
///
/// **The blurs turn the frame over and back**, because a running box sum is only coalesced down the
/// columns - so between the two halves of every blur the planes are `hh` wide and `hw` tall. On a
/// square frame a transpose that swapped the wrong pair, or wrote at the wrong stride, is invisible:
/// every index still lands inside the buffer and the answer is merely the picture's mirror. Every
/// other case here is square, and a real sensor never is.
#[test]
fn a_frame_that_is_not_square_answers_the_right_way_round() {
    let oblong = rawshim::dust::Sensor {
        width: 1200,
        height: 800,
        crop: (0, 0, 1200, 800),
        cfa: rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).unwrap(),
        aperture: 5.6,
        width_mm: rawshim::dust::FULL_FRAME_MM,
    };
    let put = (180.0, 220.0, 6.0, 0.12);
    let Some(spots) = found(&oblong, &[put]) else {
        eprintln!("SKIPPED: no adapter answered, so the oblong frame was not read.");
        return;
    };
    assert_eq!(spots.len(), 1, "found {:?}", spots.iter().map(|s| (s.x, s.y)).collect::<Vec<_>>());
    assert!((spots[0].x - put.0).abs() < 3.0, "x is {}", spots[0].x);
    assert!((spots[0].y - put.1).abs() < 3.0, "y is {}", spots[0].y);
}

/// A particle only just above the visibility floor is still found.
///
/// **What the half-float planes are held against.** The logged frame quantises at about 5e-4 where
/// `LOG_ANCHOR` puts it, and the band-pass is a difference of two stored values, so the question this
/// asks is whether that noise has eaten into the 0.02 the floor sits at. Planted at 0.04, which is
/// twice the floor and a fifth of what the other tests use - a quantisation an order of magnitude
/// worse than the analysis says would take it.
#[test]
fn a_particle_just_above_the_visibility_floor_survives_the_planes() {
    let Some(spots) = found(&sized(1200), &[(180.0, 220.0, 6.0, 0.04)]) else {
        eprintln!("SKIPPED: no adapter answered, so the faint particle was not looked for.");
        return;
    };
    assert_eq!(spots.len(), 1, "a visible particle was lost");
    assert!(
        (spots[0].profile[0] - 0.04).abs() < 0.015,
        "the plateau came back {} for a 0.04 dip",
        spots[0].profile[0],
    );
}

/// A dip too deep to be a shadow is a scene feature, however round and dust-sized it is.
///
/// **The only gate that reads magnitude**, and the one that stops a reader who turns the sensitivity
/// up from having a dark patch of hillside brightened threefold. The particle here is otherwise
/// perfect - round, the right size, in smooth surroundings - so nothing else in the chain has
/// anything to say about it.
#[test]
fn a_dip_deeper_than_a_particle_makes_is_refused() {
    let Some(shallow) = found(&sized(1200), &[(180.0, 220.0, 6.0, 0.30)]) else {
        eprintln!("SKIPPED: no adapter answered, so the depth gate was not run.");
        return;
    };
    assert_eq!(shallow.len(), 1, "a dense particle is still a particle");

    let deep = found(&sized(1200), &[(180.0, 220.0, 6.0, 0.90)]).expect("the same adapter");
    assert!(
        deep.is_empty(),
        "a {:?} deep dip was taken for dust",
        deep.first().map(|spot| spot.profile[0]),
    );
}

/// Empty sky is empty. **The gate this rests on is the visibility floor**, not the SNR one: the
/// band-pass averages tens of photosites, so grain well under the per-pixel noise still reaches the
/// mask as a confident statistical detection.
#[test]
fn a_clean_frame_offers_nothing() {
    let Some(spots) = found(&sized(1200), &[]) else {
        eprintln!("SKIPPED: no adapter answered, so the clean frame was not read.");
        return;
    };
    assert!(spots.is_empty(), "a clean frame reported {} particles", spots.len());
}

/// Two particles close enough for their footprints to touch come back as one correction.
///
/// `dust.slang` runs a workgroup per spot and multiplies into the mosaic in place, so it is this
/// that makes the read-modify-write safe without an atomic.
///
/// **Far enough apart to be two blobs, close enough to be one correction.** Planted on top of each
/// other they merge in the flood fill instead, and the test then passes with `prune_overlaps`
/// replaced by the identity - proving connected components rather than the thing the kernel's safety
/// actually rests on. A footprint is `SPAN * scale`, so two spots of radius ~6 overlap out to about
/// 30 apart while separating as masks by about 15.
#[test]
fn overlapping_footprints_are_one_spot() {
    let apart = |gap: f32| {
        found(&sized(1200), &[(300.0, 300.0, 6.0, 0.12), (300.0 + gap, 300.0, 6.0, 0.10)])
    };
    let Some(touching) = apart(20.0) else {
        eprintln!("SKIPPED: no adapter answered, so the prune was not run.");
        return;
    };
    // Two masks, one surviving footprint.
    assert_eq!(touching.len(), 1, "two overlapping footprints were both kept");
    // And far enough apart that neither reaches the other, both stand.
    assert_eq!(apart(60.0).expect("the same adapter").len(), 2, "two particles were pruned to one");
}

/// A picture that does not start at the corner of the readable plane is read from the right place,
/// and never past the end of a row.
///
/// **Every real sensor is this case.** The masked columns the black level is read from sit outside
/// the picture, so `crop` has a non-zero origin on every body - and the origin is file metadata,
/// which is free to describe a rectangle that does not fit.
#[test]
fn a_picture_inside_a_larger_plane_is_read_from_where_it_starts() {
    let plane = sized(1200);
    let inset = rawshim::dust::Sensor { crop: (16, 8, 1100, 1100), ..plane };
    // Planted in the plane's coordinates, so the search has to apply the origin to find it.
    let Some(spots) = found_in(&plane, &inset, &[(180.0, 220.0, 6.0, 0.12)]) else {
        eprintln!("SKIPPED: no adapter answered, so the inset picture was not read.");
        return;
    };
    assert_eq!(spots.len(), 1, "the particle was not found inside the inset picture");
    assert!((spots[0].x - 180.0).abs() < 2.0, "x is {}", spots[0].x);
    assert!((spots[0].y - 220.0).abs() < 2.0, "y is {}", spots[0].y);

    // A crop the file says is larger than the plane holding it reads as far as the plane goes,
    // rather than off the end of it.
    let overrun = rawshim::dust::Sensor { crop: (100, 100, 1200, 1200), ..plane };
    let _ = found_in(&plane, &overrun, &[(180.0, 220.0, 6.0, 0.12)]);
}

/// The same, on a spot that is neither round nor axis-aligned.
///
/// **The rotation and the axis divide have no other cover.** Every other case here is circular, and
/// on a circle `turned` is the offset itself and `/axes` is a divide by one - so the whole elliptical
/// half of the kernel collapses to plain distance and a sign error in it is invisible. The ellipse is
/// worth 8 points of residual over a circle on the reference frame, which is worth an assertion.
#[test]
fn an_elongated_particle_is_divided_out_at_its_own_angle() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the dust kernel's ellipse was not run.");
        return;
    };
    let (width, height) = (256usize, 256usize);
    const LEVEL: f32 = 0.5;
    // Unit product, as the search normalises them, and a real angle rather than a right one.
    let turn = (0.6f32, 0.8f32);
    let spot = Spot { axes: (1.6, 1.0 / 1.6), turn, ..a_spot(64.0, 70.0) };

    let before = shadowed(width, height, &spot, LEVEL);
    let mosaic = rawshim::condition::Mosaic::upload(gpu, &before, width, height);
    dust::correct(
        gpu,
        dust::device(gpu),
        &mosaic,
        std::slice::from_ref(&spot),
        Removal { sensitivity: 0.5, intensity: 1.0 },
        (0, 0),
    );
    let after = pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back");

    let planted = before.iter().fold(0.0f32, |worst, v| worst.max(1.0 - v / LEVEL));
    assert!(planted > 0.10, "the planted shadow is only {planted}");
    let worst = after.iter().fold(0.0f32, |worst, v| worst.max((v / LEVEL - 1.0).abs()));
    assert!(worst < 1e-4, "an elongated spot left {worst} behind");
}

/// The sensitivity slider is a cut in the kernel rather than a filter on the buffer, so a spot it
/// rejects has to leave the picture exactly as it found it.
#[test]
fn a_spot_below_the_reader_bar_is_left_alone() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the dust kernel's gate was not run.");
        return;
    };
    let (width, height) = (128usize, 128usize);
    let spot = Spot { snr: 3.0, ..a_spot(32.0, 32.0) };
    let before = shadowed(width, height, &spot, 0.5);

    let mosaic = rawshim::condition::Mosaic::upload(gpu, &before, width, height);
    dust::correct(
        gpu,
        dust::device(gpu),
        &mosaic,
        std::slice::from_ref(&spot),
        // The least sensitive end, whose bar is well above this spot's confidence.
        Removal { sensitivity: 0.0, intensity: 1.0 },
        (0, 0),
    );
    let after = pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back");
    assert_eq!(after, before, "a spot under the bar was corrected anyway");
}

/// A window is corrected from the photograph's own list, so the spots arrive in sensor coordinates
/// and the origin is what places them. Getting this wrong puts every correction in the wrong place
/// on every band but the first, which is exactly what a whole-frame test cannot see.
#[test]
fn a_window_corrects_where_the_frame_would_have() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the dust kernel's origin was not run.");
        return;
    };
    let (width, height) = (256usize, 256usize);
    const LEVEL: f32 = 0.5;
    // Far enough down that a band starting at row 64 holds it well clear of its own edges.
    let spot = a_spot(64.0, 70.0);
    let whole = shadowed(width, height, &spot, LEVEL);

    let correct = |samples: &[f32], w: usize, h: usize, origin: (usize, usize)| {
        let mosaic = rawshim::condition::Mosaic::upload(gpu, samples, w, h);
        dust::correct(
            gpu,
            dust::device(gpu),
            &mosaic,
            std::slice::from_ref(&spot),
            Removal { sensitivity: 0.5, intensity: 1.0 },
            origin,
        );
        pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back")
    };

    let top = 64usize;
    let rows = 128usize;
    let band: Vec<f32> = whole[top * width..(top + rows) * width].to_vec();

    let frame = correct(&whole, width, height, (0, 0));
    // **A positive control, or this test is two uncorrected pictures agreeing.** The whole point of
    // the file is that an untouched band matches an untouched frame perfectly, so a spot silently
    // dropped by the gate - or a pass that never encoded - would leave both sides identical and
    // this green.
    assert_ne!(frame, whole, "the correction did nothing, so the comparison proves nothing");

    let cut = correct(&band, width, rows, (0, top));

    for row in 0..rows {
        for col in 0..width {
            let (was, is) = (frame[(top + row) * width + col], cut[row * width + col]);
            assert!(
                (was - is).abs() < 1e-6,
                "the band differs from the frame at ({col}, {}) - {was} against {is}",
                top + row,
            );
        }
    }
}

/// Zero intensity is the switch off, and has to be exactly that: a reader who takes the slider to
/// the bottom is asking for the photograph they started with, not for one that has been through a
/// multiply by something very close to one.
#[test]
fn no_intensity_is_no_change_at_all() {
    let Some(gpu) = rawshim::gpu::device() else {
        eprintln!("SKIPPED: no adapter answered, so the dust kernel's intensity was not run.");
        return;
    };
    let (width, height) = (128usize, 128usize);
    let spot = a_spot(32.0, 32.0);
    let before = shadowed(width, height, &spot, 0.5);

    let mosaic = rawshim::condition::Mosaic::upload(gpu, &before, width, height);
    dust::correct(
        gpu,
        dust::device(gpu),
        &mosaic,
        std::slice::from_ref(&spot),
        Removal { sensitivity: 1.0, intensity: 0.0 },
        (0, 0),
    );
    let after = pollster::block_on(mosaic.read(gpu)).expect("the mosaic reads back");
    assert_eq!(after, before, "an intensity of zero still moved the picture");
}
