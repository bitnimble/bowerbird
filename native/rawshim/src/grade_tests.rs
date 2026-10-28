//! The grade against a frame anchored at its measured levels, which the fit layer measures.

use units::light::Light;

/// How far a tick may sit from a rendition of the same balance, as a share of its level.
///
/// Loose, because the knee differs by construction and this is not a parity fixture; tight
/// enough that a host applying no balance at all cannot pass, which at these temperatures is
/// tens of percent out.
const FAITHFUL: f64 = 2.0;

/// A slider that reads the neighbourhood reaches a frame that is already up.
///
/// **The editor uploads once, at `Adjust::none()`, and grades every tick off that upload**
/// (`wasm.rs`), where a rendition uploads with the edit it is about to apply. So any resource
/// an upload builds from the adjust it was handed is a resource the editor never gets: the
/// reader moves Shadows off zero, the tick samples whatever stands in for the blur, reads a
/// neighbourhood of zero stops, and weights every zone as though the pixel sat that far above
/// its surroundings. Silent, and only on the one host nothing else exercises.
///
/// Held against a one-shot `encode` of the same adjust rather than against a number, because
/// what has to be true is that the editor and a rendition are one implementation.
#[test]
fn a_neighbourhood_slider_reaches_a_frame_that_is_already_up() {
    let Some(gpu) = gpu::device() else { return };
    let Some(base) = render::base::device(gpu) else {
        return;
    };

    let (width, height) = (64usize, 64usize);
    // Structured rather than flat: the neighbourhood only differs from the pixel where there
    // is something to average, so a uniform frame would agree however `detail` was built.
    let mut frame: Vec<u16> = (0..width * height * 3)
        .map(|i| {
            let (x, y) = ((i / 3) % width, (i / 3) / width);
            colour::resident::bits_of_level(match (x / 8 + y / 8) % 2 == 0 {
                true => 26000.0,
                false => 1200.0,
            })
        })
        .collect();
    // Coded and anchored as every other caller hands a frame over, so the dark squares grade
    // to counts a lift can be read off rather than to zero.
    let levels = crate::hdr::levels_of(gpu, &frame, width, height, 0.995).expect("levels");
    render::base::code_base(&mut frame, levels.anchored(), Light::exactly(203.0));
    let colour = colour::matched::HdrColour::identity();
    let shown = render::grade::Canvas {
        region: (0.0, 0.0, width as f64, height as f64),
        size: units::px::Size::measured(width, height),
        max_lod: 0,
    };
    let grade = |adjust, canvas| render::grade::Grade {
        colour: Some(&colour),
        adjust,
        output: render::grade::Output::Rolled,
        canvas,
        ..render::grade::Grade::new(
            width,
            height,
            levels,
            Light::exactly(203.0),
            Light::exactly(1000.0),
        )
    };
    let rest = render::grade::Adjust::none();

    let peak = render::grade::device(gpu).scene_peak();
    let held = render::grade::device(gpu).upload(&frame, &grade(rest.clone(), None), &peak);
    // The open's own sequence (`wasm.rs`): the candidates are kept once, and the knee is
    // re-measured off them every tick, because the peak is read after the sliders.
    held.collect_candidates(&grade(rest.clone(), None));
    let pyramid = render::base::pyramid(gpu, base, &frame, (width, height)).expect("a pyramid");

    // **The parity below is symmetric, so it cannot see a blur nobody builds**: stub the
    // texture for every caller and the two hosts agree perfectly on the same wrong picture.
    // This is the asymmetric half - the dark squares of the checker are what Shadows is for,
    // and a neighbourhood read as zero stops puts every one of them far above its zone.
    let at_rest = held.encode(&grade(rest.clone(), None));
    let dark_mean = |graded: &[u16]| {
        let (mut total, mut count) = (0.0f64, 0u64);
        for (pixel, sample) in graded.iter().step_by(3).enumerate() {
            if (pixel % width / 8 + pixel / width / 8) % 2 != 0 {
                total += f64::from(*sample);
                count += 1;
            }
        }
        total / count as f64
    };

    for (name, adjust) in [
        (
            "shadows",
            render::grade::Adjust {
                shadows: 100.0,
                ..rest.clone()
            },
        ),
        (
            "highlights",
            render::grade::Adjust {
                highlights: -100.0,
                ..rest.clone()
            },
        ),
        (
            "clarity",
            render::grade::Adjust {
                clarity: 100.0,
                ..rest.clone()
            },
        ),
        (
            "dehaze",
            render::grade::Adjust {
                dehaze: 100.0,
                ..rest.clone()
            },
        ),
    ] {
        held.peak_from_candidates(&grade(adjust.clone(), None));
        let ticked = held.encode(&grade(adjust.clone(), None));
        let rendered = render::grade::device(gpu).encode(&frame, &grade(adjust.clone(), None));
        let worst = ticked
            .iter()
            .zip(&rendered)
            .map(|(tick, render)| i64::from(*tick).abs_diff(i64::from(*render)))
            .max()
            .expect("a graded frame");
        // Exactly, not nearly: the same shader over the same frame on the same device, so
        // any difference at all is a resource one host built and the other did not.
        assert_eq!(
            worst, 0,
            "{name} at the end of its range read back {worst} counts apart from a rendition \
                 of the same edit: the tick is grading against a neighbourhood the upload never \
                 built",
        );

        if name == "shadows" {
            let (was, now) = (dark_mean(&at_rest), dark_mean(&ticked));
            assert!(
                was > 1.0,
                "the checker's dark squares grade to {was:.0}, so a lift of \
                     them would be unmeasurable and this fixture proves nothing"
            );
            assert!(
                now > was * 1.2,
                "shadows at +100 took the checker's dark squares from {was:.0} to {now:.0}: \
                     the zone is being weighted by a neighbourhood of zero stops, which puts \
                     every dark pixel above the range the slider covers",
            );
        }

        // And again through `draw`, which is the entry point a tick actually takes
        // (`wasm.rs` calls `present`, which calls `draw_into`) and a different bind group
        // from the readback above. Against an upload made *with* the slider already set,
        // which is the same photograph opened with the edit already on it.
        let opened = render::grade::device(gpu).upload(
            &frame,
            &grade(adjust.clone(), Some(shown)),
            &render::grade::device(gpu).scene_peak(),
        );
        opened.collect_candidates(&grade(adjust.clone(), Some(shown)));
        opened.peak_from_candidates(&grade(adjust.clone(), Some(shown)));
        let dragged = held.draw(&grade(adjust.clone(), Some(shown)), &pyramid);
        let reopened = opened.draw(&grade(adjust, Some(shown)), &pyramid);
        let apart = dragged
            .iter()
            .zip(&reopened)
            .map(|(drag, open)| (drag - open).abs())
            .fold(0.0f32, f32::max);
        assert!(
            apart < 1e-5,
            "{name} drew {apart} apart depending on whether it was set before the open or \
                 dragged after it, which is the same picture either way",
        );
    }
}

/// A temperature drag draws what a rendition of the same temperature renders.
///
/// **The editor uploads once at `Adjust::none()` and grades every tick off that upload**
/// (`wasm.rs`), so anything the upload derives from the balance is a thing the two hosts
/// disagree about the moment the reader moves it. `chroma_smoothed` is that: it encodes
/// `matched_scene`, the balance is upstream of `matched_scene`, and the blend in
/// `colour.slang` *replaces* a pixel's chroma with this neighbourhood's - so a texture built
/// at one illuminant and read at another puts the old colour back and the slider does nothing
/// whatever. Measured at 2000K on a daylight frame before the rebuild: the tick came out
/// 3851, 3746, 3916 against the rendition's 1441, 3749, 27156.
///
/// Not to the byte, which is why this is not folded into
/// `a_neighbourhood_slider_reaches_a_frame_that_is_already_up`: the knee a tick rolls against
/// is re-measured off the candidates the open kept rather than off the whole frame, so the two
/// differ by a fraction of a percent by construction. What is being ruled out is a host that
/// balances and one that does not.
#[test]
fn a_temperature_drag_draws_what_a_rendition_of_it_renders() {
    let Some(gpu) = gpu::device() else { return };

    let (width, height) = (64usize, 64usize);
    let mut frame: Vec<u16> = (0..width * height * 3)
        .map(|i| {
            // Coloured rather than neutral: a balance moves channels against each other, and
            // a grey frame would agree between the two hosts however wrong both were.
            let (x, y) = ((i / 3) % width, (i / 3) / width);
            let channel = i % 3;
            colour::resident::bits_of_level(
                6000.0 + 4000.0 * ((x + y * 2 + channel * 7) % 11) as f32,
            )
        })
        .collect();
    let levels = crate::hdr::levels_of(gpu, &frame, width, height, 0.995).expect("levels");
    render::base::code_base(&mut frame, levels.anchored(), Light::exactly(203.0));

    let colour = colour::matched::HdrColour::identity();
    let grade = |adjust| render::grade::Grade {
        colour: Some(&colour),
        adjust,
        // Without one the balance has no illuminant to move away from and every temperature
        // below is the identity, which would make this pass on a host that ignores the pair.
        as_shot: Some(colour::white_balance::Illuminant {
            temperature: 5500.0,
            tint: 12.0,
        }),
        output: render::grade::Output::Rolled,
        ..render::grade::Grade::new(
            width,
            height,
            levels,
            Light::exactly(203.0),
            Light::exactly(1000.0),
        )
    };

    let rest = render::grade::Adjust::none();
    let peak = render::grade::device(gpu).scene_peak();
    let held = render::grade::device(gpu).upload(&frame, &grade(rest.clone()), &peak);
    held.collect_candidates(&grade(rest.clone()));

    for kelvin in [2000.0, 2800.0, 4000.0, 6500.0, 12000.0] {
        for tint in [-40.0, 0.0, 40.0] {
            let moved = render::grade::Adjust {
                temperature: Some(kelvin),
                tint: Some(tint),
                ..rest.clone()
            };
            held.peak_from_candidates(&grade(moved.clone()));
            let ticked = held.encode(&grade(moved.clone()));
            let rendered = render::grade::device(gpu).encode(&frame, &grade(moved));

            let (apart, level) = ticked.iter().zip(&rendered).fold(
                (0.0f64, 0.0f64),
                |(apart, level), (tick, render)| {
                    (
                        apart + (f64::from(*tick) - f64::from(*render)).abs(),
                        level + f64::from(*render),
                    )
                },
            );
            let off = apart / level.max(1.0) * 100.0;
            assert!(
                off < FAITHFUL,
                "at {kelvin}K tint {tint} the editor's tick is {off:.2}% from a rendition of \
                     the same balance: one of the two is grading against an illuminant the other \
                     is not",
            );
        }
    }
}
