//! What the demosaic reconstructs, against what the photosites under it actually measured.
//!
//! ```text
//! demosaic_probe <raw> <x,y,side>...
//! ```
//!
//! **A demosaic that loses chroma amplitude is invisible on anything neutral.** Where the three
//! colours are close, pulling them toward their common mean changes nothing anyone can see; where
//! they are far apart, the same error is most of the picture. So the test is the ratio, per colour,
//! between what the reconstruction says a pixel holds and what that colour's own photosites in the
//! same window measured - one on neutral content and one on saturated, read together.
//!
//! The window's origin is taken to the period below it, because a region lifted off the mosaic at
//! any other origin carries a different phase and would be measuring that instead.

use rawler::RawImageData;
use rawler::decoders::RawDecodeParams;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("demosaic_probe <raw> <x,y,side>...");
    let windows: Vec<(usize, usize, usize)> = args
        .map(|spec| {
            let v: Vec<usize> =
                spec.split(',').map(|n| n.parse().expect("x,y,side are numbers")).collect();
            (v[0], v[1], v[2])
        })
        .collect();

    let source = rawler::rawsource::RawSource::new(std::path::Path::new(&path)).expect("the file");
    let decoder = rawler::get_decoder(&source).expect("a decoder");
    let image =
        decoder.raw_image(&source, &RawDecodeParams::default(), false).expect("the frame decodes");
    let RawImageData::Integer(samples) = &image.data else {
        panic!("not integer samples");
    };
    let w = image.width;
    let cfa = rawshim::cfa::Cfa::from_rawler(&image.camera.cfa).expect("a pattern");
    let (pw, ph) = cfa.period();
    let gains = rawshim::decode_rawler::channel_ceilings(&image);
    let white = rawshim::decode_rawler::saturation_of(&image);
    // **By position, as `Coefficients::at` takes it.** A sensor reports a black level per position
    // of the period and they are not equal - `per_position_black` says the two greens of a 2x2 can
    // differ by enough to leave a checkerboard - so conditioning a window against the first of them
    // would measure that difference as a reconstruction error. X-Trans repeats one value 36 times
    // and would not notice; this tool takes any pattern.
    let levels = &image.blacklevel.levels;
    let slots = pw * ph;
    let black_at = |position: usize| match levels.len() >= slots {
        true => levels[position].as_f32(),
        false => levels.first().map_or(0.0, |first| first.as_f32()),
    };
    println!("pattern {pw}x{ph}, white {white}, gains {gains:?}");

    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let rcd = rawshim::demosaic::device(gpu).expect("the demosaic built");

    for (wx, wy, side) in windows {
        // Onto the period, so the window's phase is the frame's.
        let (wx, wy) = (wx / pw * pw, wy / ph * ph);
        let side = side / pw * pw;
        let mut window = vec![0.0f32; side * side];
        let mut sum = [0.0f64; 3];
        let mut seen = [0.0f64; 3];
        for y in 0..side {
            for x in 0..side {
                let raw = f32::from(samples[(wy + y) * w + wx + x]);
                let (row, col) = (wy + y, wx + x);
                let colour = usize::from(cfa.colour_at(row, col));
                let black = black_at((row % ph) * pw + (col % pw));
                let range = (white - black).max(1.0);
                let value = ((raw - black) / range).min(1.0) * gains[colour.min(2)];
                window[y * side + x] = value;
                if colour < 3 {
                    sum[colour] += f64::from(value);
                    seen[colour] += 1.0;
                }
            }
        }
        let measured = [
            sum[0] / seen[0].max(1.0),
            sum[1] / seen[1].max(1.0),
            sum[2] / seen[2].max(1.0),
        ];

        let uploaded = rawshim::condition::Mosaic::upload(gpu, &window, side, side);
        let plane = pollster::block_on(rawshim::demosaic::demosaic_plane(
            gpu,
            rcd,
            &uploaded,
            &cfa,
            |bytes| {
                bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
                    .collect::<Vec<f32>>()
            },
        ))
        .expect("the demosaic runs");

        // The margin the reconstruction needs is not the picture, so it is not measured.
        let margin = 16.min(side / 4);
        let mut out = [0.0f64; 3];
        let mut coded = [0.0f64; 3];
        let mut count = 0.0f64;
        let matrix = rawshim::decode_rawler::camera_to_rec2020(&image).expect("a colour matrix");
        for y in margin..side - margin {
            for x in margin..side - margin {
                let at = (y * side + x) * 3;
                let cam = [plane[at], plane[at + 1], plane[at + 2]];
                for c in 0..3 {
                    out[c] += f64::from(cam[c]);
                    // Per pixel and clamped as `assemble` does, because a mean taken before the
                    // clamp is not what the frame holds - a channel the matrix sends negative is
                    // answered by the clamp, and averaging first hides that it ever happened.
                    let mixed: f32 =
                        (0..3).map(|k| matrix[c][k] * cam[k]).sum::<f32>().max(0.0);
                    coded[c] += f64::from(mixed);
                }
                count += 1.0;
            }
        }
        let built = out.map(|total| total / count.max(1.0));
        let after = coded.map(|total| total / count.max(1.0));

        println!("\n  {wx},{wy} {side}x{side}");
        println!(
            "    photosites  R {:.5} G {:.5} B {:.5}",
            measured[0], measured[1], measured[2],
        );
        println!("    demosaiced  R {:.5} G {:.5} B {:.5}", built[0], built[1], built[2]);
        println!(
            "    matrixed    R {:.5} G {:.5} B {:.5}  ({:.0} {:.0} {:.0} of 65535)",
            after[0],
            after[1],
            after[2],
            after[0] * 65535.0,
            after[1] * 65535.0,
            after[2] * 65535.0,
        );
        println!(
            "    ratio       R {:.3} G {:.3} B {:.3}",
            built[0] / measured[0].max(1e-9),
            built[1] / measured[1].max(1e-9),
            built[2] / measured[2].max(1e-9),
        );
        // How far each is from its own window's mean, which is what a chroma loss shows in.
        let spread = |v: [f64; 3]| {
            let mean = (v[0] + v[1] + v[2]) / 3.0;
            ((v[0] - mean).powi(2) + (v[1] - mean).powi(2) + (v[2] - mean).powi(2)).sqrt()
        };
        println!(
            "    chroma amplitude {:.5} measured against {:.5} reconstructed, {:.3}x",
            spread(measured),
            spread(built),
            spread(built) / spread(measured).max(1e-12),
        );
    }
}
