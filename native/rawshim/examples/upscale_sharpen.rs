//! Mosaics a model trainer made, taken through the rest of the editor's chain for an unedited photo:
//! demosaiced, defringed, coded and capture-sharpened with the photo's own matrix, levels, measured
//! blur and noise, as `support::cut` does a whole frame.
//!
//! ```text
//! upscale_sharpen <raw> <mosaics> <width> <height> <gain r>,<gain g>,<gain b> <out>
//! ```
//!
//! `<mosaics>` is a stack of RGGB mosaics in the photo's conditioning, little-endian `f32`. `<out>`
//! gets each one twice, unsharpened then sharpened, as Rec.2020 light over reference white,
//! interleaved RGB `f32`.

mod support;

use rawshim::light::Light;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, raw, mosaics, width, height, gains, out] = args.as_slice() else {
        eprintln!("usage: upscale_sharpen <raw> <mosaics> <width> <height> <r,g,b gains> <out>");
        std::process::exit(2);
    };
    let (width, height): (usize, usize) = (
        width.parse().expect("width"),
        height.parse().expect("height"),
    );
    let gains: Vec<f32> = gains
        .split(',')
        .map(|gain| gain.parse().expect("a gain"))
        .collect();
    let ceiling: [f32; 3] = gains.try_into().expect("three gains");

    let opened = support::Open::shipped(raw, 0)
        .run()
        .expect("the photo opens");
    let frame = &opened.frame;
    let gpu = rawshim::gpu::device().expect("an adapter");
    let base = rawshim::base::device(gpu).expect("the base kernels");
    let rcd = rawshim::demosaic::device(gpu).expect("the demosaic kernels");
    let matrix = frame.matrix.expect("a RAW's camera matrix");
    let levels = opened.measured.levels.anchored();
    let white = support::GRADE.reference_white_nits;
    let sensor_long = frame.width.max(frame.height) * frame.reduced.max(1);
    let capture = opened
        .measured
        .blur
        .map(|blur| blur * frame.reduced.max(1) as f32);
    let sigma = rawshim::image::deconvolve_split(capture, sensor_long, sensor_long);
    let noise = rawshim::base::sharpen_noise(
        levels,
        white,
        frame.noise,
        frame.matrix,
        frame.wb_gains,
        frame.reduced,
    )
    .at(
        rawshim::px::Span::<rawshim::px::Sensor>::exact(sensor_long),
        rawshim::px::Span::<rawshim::px::Drawn>::exact(sensor_long),
    );
    eprintln!(
        "capture blur {capture:?} sensor px, sharpen sigma {:.3}",
        sigma.composed
    );

    let cfa = rawshim::cfa::Cfa::bayer([0, 1, 1, 2]).expect("RGGB");
    let bytes = std::fs::read(mosaics).expect("the mosaics");
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|word| f32::from_le_bytes([word[0], word[1], word[2], word[3]]))
        .collect();
    let mut light = Vec::new();
    for mosaic in samples.chunks_exact(width * height) {
        let demosaiced = demosaic(gpu, rcd, mosaic, &cfa, width, height, matrix, ceiling);
        for amount in [0.0, support::STRENGTHS.sharpen] {
            let resident = rawshim::resident::Resident::upload(gpu, &demosaiced, width, height);
            let (prepared, _) = pollster::block_on(rawshim::base::prepare(
                gpu,
                base,
                resident,
                rawshim::base::Gather::frame(rawshim::px::Size::exact(width, height)),
                levels,
                white,
                support::STRENGTHS.before_the_fit(),
                rawshim::image::SharpenSigma::fixed(rawshim::image::DECONVOLVE_SIGMA),
                rawshim::image::SharpenNoise::NONE,
                &rawshim::fit::Lens::none(),
                opened.measured.defringe,
                frame.noise,
                frame.matrix,
            ))
            .expect("the coding");
            let size = rawshim::hdr_args::Size {
                width: width as u32,
                height: height as u32,
            };
            let coded = rawshim::hdr::Cut::from_base(prepared, None, size, amount, sigma, noise)
                .into_samples();
            light.extend(coded[..width * height * 3].iter().map(|&code| {
                let nits = rawshim::tone::pq_inv::<rawshim::light::SceneNits>(Light::measured(
                    f64::from(code) / f64::from(u16::MAX),
                ));
                (nits.raw() / white.raw()) as f32
            }));
        }
    }
    let bytes: Vec<u8> = light.iter().flat_map(|value| value.to_le_bytes()).collect();
    std::fs::write(out, bytes).expect("the output");
}

#[allow(clippy::too_many_arguments)]
fn demosaic(
    gpu: &'static rawshim::gpu::Gpu,
    rcd: &'static rawshim::demosaic::Rcd,
    mosaic: &[f32],
    cfa: &rawshim::cfa::Cfa,
    width: usize,
    height: usize,
    matrix: [[f32; 3]; 3],
    ceiling: [f32; 3],
) -> Vec<u16> {
    let uploaded = rawshim::condition::Mosaic::upload(gpu, mosaic, width, height);
    let at = rawshim::demosaic::Placement {
        stride: rawshim::px::Span::exact(width),
        crop: rawshim::px::Rect::exact(0, 0, width, height),
        dest: rawshim::px::At::ORIGIN,
        frame: rawshim::px::Size::exact(width, height),
        orientation: 0,
        reduce: 1,
    };
    let into = rawshim::demosaic::frame_buffer(gpu, width * height);
    let (_held, shape) = rawshim::demosaic::shape_group(gpu, rcd, cfa, &uploaded, 0);
    pollster::block_on(rawshim::demosaic::demosaic_into(
        gpu,
        rcd,
        &uploaded,
        cfa,
        &at,
        rawshim::demosaic::Colour { matrix, ceiling },
        &into,
        &shape,
    ))
    .expect("the demosaic");
    pollster::block_on(rawshim::demosaic::read_frame(gpu, &into, width * height))
        .expect("the frame")
}
