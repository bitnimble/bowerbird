//! What the decoded frame holds over a window, in the units its own levels are named in.
//!
//! ```text
//! frame_probe <raw> <x,y,w,h>...
//! ```
//!
//! **Between the photosites and the render there are two scales and it is easy to compare across
//! them by mistake.** `photosites` reports the conditioned mosaic, a fraction of the sensor's
//! saturation; `renders` reports coded bytes. This reports the frame the grade is actually handed -
//! interleaved RGB, scene-linear - beside the diffuse white it will be divided by, so "how far above
//! white is this" is one subtraction rather than a chain of assumptions.
//!
//! Window coordinates are the cropped frame's, which is what `renders --crop` takes.

use rawshim::galosh::{Detail, Fit};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("frame_probe <raw> <x,y,w,h>...");
    let windows: Vec<(usize, usize, usize, usize)> = args
        .map(|spec| {
            let v: Vec<usize> =
                spec.split(',').map(|n| n.parse().expect("x,y,w,h are numbers")).collect();
            (v[0], v[1], v[2], v[3])
        })
        .collect();

    let frame = rawshim::decode_frame_denoised(&path, 0, Detail::at(0.0, 0.0), Fit::Only)
        .expect("the frame decodes");
    let samples = frame.samples16().expect("16-bit");
    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let levels = rawshim::hdr::levels_of(gpu, samples, frame.width, frame.height, 0.9)
        .expect("the frame has levels");
    let white = levels.white.raw();
    println!(
        "{}x{}  white {white:.0}  peak {:.0}  (of {})",
        frame.width,
        frame.height,
        levels.peak.raw(),
        u16::MAX,
    );

    for (wx, wy, ww, wh) in windows {
        let mut sum = [0.0f64; 3];
        let mut seen = 0.0f64;
        for y in wy..(wy + wh).min(frame.height) {
            for x in wx..(wx + ww).min(frame.width) {
                let at = (y * frame.width + x) * 3;
                for c in 0..3 {
                    sum[c] += f64::from(samples[at + c]);
                }
                seen += 1.0;
            }
        }
        let mean = sum.map(|total| total / seen.max(1.0));
        println!(
            "  {wx},{wy} {ww}x{wh}  R {:.0} G {:.0} B {:.0}  = {:.3} {:.3} {:.3} of white",
            mean[0],
            mean[1],
            mean[2],
            mean[0] / white,
            mean[1] / white,
            mean[2] / white,
        );
    }
}
