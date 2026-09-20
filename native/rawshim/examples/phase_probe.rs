//! Which phase of the CFA the photosites actually agree with, searched rather than believed.
//!
//! ```text
//! phase_probe <raw> <x,y,w,h>...
//! ```
//!
//! **A wrong phase is invisible on anything neutral and ruinous on anything saturated**, which is
//! the worst shape a bug can have: a frame of plaster looks right, a stained glass window comes
//! apart, and every aggregate anyone would think to take passes. It is also easy to arrive at
//! without noticing - a pattern read from the file describes the sensor, a crop moves the origin,
//! and `CFA::shift` exists in rawler precisely because a crop whose origin is not a multiple of the
//! period needs the pattern moved with it.
//!
//! The test needs no ground truth and no assumption about the scene's colour. Label the window's
//! photosites under each of the period's translations and total the variance *within* each colour:
//! at the right phase a label holds one colour's population, and at a wrong one it holds a mixture
//! of two, which is wider. On a saturated region the two populations are far apart and the
//! minimum is unmistakable; on a neutral one every phase scores alike, which is the point.

use rawler::RawImageData;
use rawler::decoders::RawDecodeParams;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("phase_probe <raw> <x,y,w,h>...");
    let windows: Vec<(usize, usize, usize, usize)> = args
        .map(|spec| {
            let v: Vec<usize> =
                spec.split(',').map(|n| n.parse().expect("x,y,w,h are numbers")).collect();
            (v[0], v[1], v[2], v[3])
        })
        .collect();
    assert!(!windows.is_empty(), "at least one x,y,w,h");

    let source = rawler::rawsource::RawSource::new(std::path::Path::new(&path)).expect("the file");
    let decoder = rawler::get_decoder(&source).expect("a decoder");
    let image =
        decoder.raw_image(&source, &RawDecodeParams::default(), false).expect("the frame decodes");
    let RawImageData::Integer(samples) = &image.data else {
        panic!("not integer samples");
    };
    let (w, h) = (image.width, image.height);
    let cfa = &image.camera.cfa;
    let (pw, ph) = (cfa.width, cfa.height);
    println!("{}x{} pattern {}x{} \"{}\"", w, h, pw, ph, cfa.name);
    println!("crop {:?}", image.crop_area);

    for (wx, wy, ww, wh) in windows {
        println!("\nwindow {wx},{wy} {ww}x{wh}");
        let mut best: Option<(f64, usize, usize)> = None;
        let mut at_zero = 0.0;
        for dy in 0..ph {
            for dx in 0..pw {
                // Sums per colour, for a variance that needs one pass.
                let mut n = [0.0f64; 3];
                let mut sum = [0.0f64; 3];
                let mut sq = [0.0f64; 3];
                for y in wy..(wy + wh).min(h) {
                    for x in wx..(wx + ww).min(w) {
                        let colour = cfa.color_at((y + dy) % ph, (x + dx) % pw);
                        if colour > 2 {
                            continue;
                        }
                        let v = f64::from(samples[y * w + x]);
                        n[colour] += 1.0;
                        sum[colour] += v;
                        sq[colour] += v * v;
                    }
                }
                // Pooled within-colour variance: what a mixture of two populations inflates.
                let mut within = 0.0;
                let mut total = 0.0;
                for c in 0..3 {
                    if n[c] < 2.0 {
                        continue;
                    }
                    within += sq[c] - sum[c] * sum[c] / n[c];
                    total += n[c];
                }
                let score = within / total.max(1.0);
                if dy == 0 && dx == 0 {
                    at_zero = score;
                }
                if best.is_none_or(|(held, _, _)| score < held) {
                    best = Some((score, dy, dx));
                }
            }
        }
        let (score, dy, dx) = best.expect("a phase");
        println!(
            "  best shift ({dy},{dx}) within-colour variance {score:.0}, against {at_zero:.0} at \
             the pattern as read - {:.2}x",
            at_zero / score.max(1e-9),
        );

        // What each colour reads at the two, since a number per colour is what says whether the
        // winner is a colour separation or a coincidence.
        for (name, sy, sx) in [("as read", 0, 0), ("best   ", dy, dx)] {
            let mut n = [0.0f64; 3];
            let mut sum = [0.0f64; 3];
            for y in wy..(wy + wh).min(h) {
                for x in wx..(wx + ww).min(w) {
                    let colour = cfa.color_at((y + sy) % ph, (x + sx) % pw);
                    if colour > 2 {
                        continue;
                    }
                    n[colour] += 1.0;
                    sum[colour] += f64::from(samples[y * w + x]);
                }
            }
            println!(
                "  {name} R {:.0}  G {:.0}  B {:.0}",
                sum[0] / n[0].max(1.0),
                sum[1] / n[1].max(1.0),
                sum[2] / n[2].max(1.0),
            );
        }
    }
}
