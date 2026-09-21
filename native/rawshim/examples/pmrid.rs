//! PMRID over one window of a photograph, beside GALOSH over the same window.
//!
//! ```text
//! pmrid <raw> <out-dir> <x,y,w,h|whole> [lift] [luma] [chroma]
//! ```
//!
//! What the two denoisers do to the same frame, as PNGs lifted by `lift` stops of gain so a night
//! frame is watchable: undenoised, GALOSH, PMRID. `whole` filters the frame instead and reports
//! what that costs, which is the only honest answer to what a rendition would pay.
//!
//! The network itself is `crate::pmrid`, which is what a rendition and the editor both dispatch;
//! nothing here describes it a second time.

use rawshim::galosh::{Amounts, Detail};

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let out = args.next().expect("an output directory");
    let asked = args.next().expect("x,y,w,h, or whole");
    let over_the_frame = asked.starts_with("whole");
    let rect: Vec<usize> = match over_the_frame {
        true => vec![0, 0, 0, 0],
        false => asked.split(',').map(|v| v.parse().expect("a number")).collect(),
    };
    let (x, y, w, h) = (rect[0], rect[1], rect[2], rect[3]);
    let lift: f32 = args.next().map_or(8.0, |v| v.parse().expect("a number"));
    // How much of the residual the network predicted to keep, which is all the strength it has.
    let luma: f64 = args.next().map_or(100.0, |v| v.parse().expect("a number"));
    let colour: f64 = args.next().map_or(luma, |v| v.parse().expect("a number"));
    assert!(
        over_the_frame || (x % 2 == 0 && y % 2 == 0),
        "the window's origin has to keep the frame's CFA phase"
    );
    std::fs::create_dir_all(&out).expect("the output directory");

    let gpu = rawshim::gpu::device().expect("an adapter");
    let bytes = std::fs::read(&path).expect("read the raw");
    let held = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)).expect("held");
    let cfa = held.cfa();
    let mosaic = held.device_mosaic();
    let stride = mosaic.width;
    let kernels = rawshim::galosh::device(gpu).expect("the kernels built");
    let fit = pollster::block_on(rawshim::galosh::fit(gpu, kernels, mosaic, &cfa));

    // The conditioning divided every photosite by the largest white balance coefficient and
    // multiplied it by its own, and the network wants what the sensor read.
    let image = rawler::decode_file(&path).expect("rawler reads the coefficients");
    let gains = rawshim::decode_rawler::channel_ceilings(&image);
    let model = fit.model();
    eprintln!("fit alpha {:.3e} sigma_sq {:.3e}", model.alpha, model.sigma_sq);

    let network = rawshim::pmrid::device(gpu).expect("the network built");
    let filter = |window: &rawshim::condition::Mosaic| {
        let started = std::time::Instant::now();
        rawshim::pmrid::denoise(gpu, network, window, &cfa, gains, Detail::at(luma, colour), fit);
        gpu.block_until_done();
        started.elapsed()
    };

    if over_the_frame {
        let spent = filter(mosaic);
        let megapixels = (stride * mosaic.height) as f64 / 1e6;
        eprintln!(
            "{stride}x{}: {spent:?}, {:.0}ms per megapixel of sensor",
            mosaic.height,
            spent.as_secs_f64() * 1e3 / megapixels,
        );
        return;
    }

    let samples = pollster::block_on(mosaic.read(gpu)).expect("reads back");
    let filtered = mosaic.duplicate(gpu);
    pollster::block_on(rawshim::galosh::denoise_with(
        gpu,
        kernels,
        &filtered,
        &cfa,
        Amounts::from_sliders(40.0, 40.0),
        fit,
    ));
    let galosh = pollster::block_on(filtered.read(gpu)).expect("reads back");

    let cut = |from: &[f32]| {
        let mut window = Vec::with_capacity(w * h);
        for row in 0..h {
            let at = (y + row) * stride + x;
            window.extend_from_slice(&from[at..at + w]);
        }
        window
    };
    let (noisy, galosh) = (cut(&samples), cut(&galosh));

    let window = rawshim::condition::Mosaic::upload(gpu, &noisy, w, h);
    eprintln!("the window denoised in {:?}", filter(&window));
    let pmrid = pollster::block_on(window.read(gpu)).expect("reads back");

    let rcd = rawshim::demosaic::device(gpu).expect("the demosaic built");
    let rgb = |samples: &[f32]| {
        let uploaded = rawshim::condition::Mosaic::upload(gpu, samples, w, h);
        pollster::block_on(rawshim::demosaic::demosaic_plane(gpu, rcd, &uploaded, &cfa, |bytes| {
            bytes
                .chunks_exact(4)
                .map(|word| f32::from_ne_bytes([word[0], word[1], word[2], word[3]]))
                .collect::<Vec<f32>>()
        }))
        .expect("demosaics")
    };
    let encode = |name: &str, linear: &[f32]| {
        let rgb8: Vec<u8> = linear
            .iter()
            .map(|channel| ((channel * lift).clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0).round() as u8)
            .collect();
        let png = rawshim::png_write::encode_sdr(&rgb8, w, h).expect("a png");
        let at = format!("{out}/{name}.png");
        std::fs::write(&at, png).expect("wrote");
        eprintln!("wrote {at}");
    };
    encode("noisy", &rgb(&noisy));
    encode("galosh", &rgb(&galosh));
    encode("pmrid", &rgb(&pmrid));
}
