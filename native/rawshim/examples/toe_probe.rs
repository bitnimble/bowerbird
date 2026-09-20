//! Which pixels the curve's darkest bins are fitted from, and what the body rendered them as.
//!
//! ```text
//! toe_probe <raw> <out-dir> [ceiling]
//! ```
//!
//! **A curve's toe can only be as good as the pairs under it.** `fit_curve` bins our render by its
//! own level and averages the body's rendering of the same pixels in each bin, so a toe that comes
//! back inverted - the darkest bin reading higher than the ones above it - is saying our darkest
//! pixels are not the body's darkest. `pool_violators` then merges the whole inverted run into one
//! value, which is a flat pedestal, which is a lifted black. The question this answers is *which*
//! pixels those are, because the arithmetic cannot say and a picture can.
//!
//! The binning is reproduced on the host rather than read out of the fit: both sides are box
//! averaged to one grid, which is what `prepared_planes` does on the device, and nothing here needs
//! the lens or the colour transform to tell a region apart from another region.
//!
//! Writes `toe-bin<N>.pgm` marking where each of the darkest bins lies, over a dimmed render of the
//! frame, so a bin that is one object rather than one tone is visible as one.

use rawshim::galosh::{Detail, Fit};

/// The grid both sides are averaged onto, as `hdr_fit::FIT_LONG_EDGE` has it.
const GRID: usize = 808;

/// How many bins of the toe are reported and drawn.
const TOE: usize = 16;

fn grey(path: &str, values: &[u8], width: usize, height: usize) {
    let rgb: Vec<u8> = values.iter().flat_map(|v| [*v, *v, *v]).collect();
    let bytes =
        rawshim::jpeg::encode(rawshim::rgb::RgbRef { width, height, data: &rgb }, 92)
            .expect("the mask encodes");
    std::fs::write(path, bytes).expect("the mask writes");
    eprintln!("wrote {path}");
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("toe_probe <raw> <out-dir> [ceiling]");
    let out = args.next().expect("an output directory");
    let ceiling: f64 = args.next().map_or(1.8, |v| v.parse().expect("a number"));
    std::fs::create_dir_all(&out).expect("the output directory");

    let frame = rawshim::decode_frame_denoised(&path, 0, Detail::at(0.0, 0.0), Fit::Only)
        .expect("the frame decodes");
    let samples = frame.samples16().expect("16-bit");
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let levels = rawshim::hdr::levels_of(gpu, samples, frame.width, frame.height, 0.9)
        .expect("the frame has levels");
    let white = levels.white.raw();

    // Ours, box averaged to the grid, in multiples of diffuse white - the domain the curve bins.
    //
    // Averaged from the 16-bit samples rather than through `image::resize`, which takes bytes: the
    // whole question is about levels under a hundredth of white, and an 8-bit intermediate has two
    // codes to say that in.
    let (wide, tall) = (GRID.min(frame.width), GRID.min(frame.width) * frame.height / frame.width);
    let box_w = frame.width as f64 / wide as f64;
    let box_h = frame.height as f64 / tall as f64;
    let mut ours = vec![0.0f64; wide * tall];
    for y in 0..tall {
        for x in 0..wide {
            let (x0, x1) = ((x as f64 * box_w) as usize, (((x + 1) as f64 * box_w) as usize).min(frame.width));
            let (y0, y1) = ((y as f64 * box_h) as usize, (((y + 1) as f64 * box_h) as usize).min(frame.height));
            let mut total = 0.0f64;
            let mut seen = 0usize;
            for row in y0..y1.max(y0 + 1) {
                for col in x0..x1.max(x0 + 1) {
                    total += f64::from(samples[(row * frame.width + col) * 3 + 1]);
                    seen += 1;
                }
            }
            ours[y * wide + x] = total / seen.max(1) as f64;
        }
    }
    let preview = rawshim::decode_embedded_rgb(&path, 0).expect("an embedded preview");
    let theirs = rawshim::image::resize(preview.as_ref(), wide, tall);

    // The green channel, which is what the shared curve is read at when a toe is reported.
    let mut sum = vec![0.0f64; TOE];
    let mut count = vec![0usize; TOE];
    let mut bin_of = vec![usize::MAX; wide * tall];
    for at in 0..wide * tall {
        let level = ours[at] / white;
        let bin = (level / ceiling * 256.0) as usize;
        if bin < TOE {
            sum[bin] += f64::from(theirs.data[at * 3 + 1]) / 255.0;
            count[bin] += 1;
            bin_of[at] = bin;
        }
    }

    println!("{:>4} {:>9} {:>9}", "bin", "camera", "pixels");
    for bin in 0..TOE {
        if count[bin] == 0 {
            continue;
        }
        println!("{bin:>4} {:>9.4} {:>9}", sum[bin] / count[bin] as f64, count[bin]);
    }

    // The frame at a readable brightness, with each of the darkest bins drawn white over it, so a
    // bin that is one region of the picture cannot be mistaken for a tone spread over it.
    let dim: Vec<u8> = ours
        .iter()
        .map(|v| (((v / white).clamp(0.0, 1.0).powf(1.0 / 2.2)) * 85.0) as u8)
        .collect();
    for bin in 0..4 {
        if count[bin] == 0 {
            continue;
        }
        let mut mask = dim.clone();
        for (at, of) in bin_of.iter().enumerate() {
            if *of == bin {
                mask[at] = 255;
            }
        }
        grey(&format!("{out}/toe-bin{bin}.jpg"), &mask, wide, tall);
    }
}
