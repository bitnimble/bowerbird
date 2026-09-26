//! Whether a rendition is better cut at size or cut whole and reduced.
//!
//! ```text
//! supersample <raw> <out-dir> [edge] [--crop x,y,side]...
//! ```
//!
//! The viewer's rendition resizes on the way past: `Cut::from_base` takes the prepared frame to
//! the target's size with `reduce.slang`, an area average over each output pixel's footprint, and
//! then deconvolves a sigma composed for that scale. At 6000 to 3840 a footprint is 1.56 source
//! pixels across, which is a soft filter to be reconstructing an edge with.
//!
//! The other way round is to render at the sensor's own size - which is what `max` is - and reduce
//! the *picture* with a Lanczos3 kernel. Same output size, same grade, and the demosaic and the
//! deconvolution both ran at full resolution.
//!
//! Both are written, and a crop of each at 1:1, because the numbers below say how much detail
//! survived and not whether it is the right detail.

use rawshim::hdr::{self, Grade};
use rawshim::hdr_args::{Chroma, EncodeOptions};
use rawshim::image::Strengths;
use rawshim::light::Light;

fn grade() -> Grade {
    Grade {
        peak_nits: Light::exactly(1000.0),
        reference_white_nits: Light::exactly(203.0),
        white_quantile: 0.9,
    }
}

fn strengths() -> Strengths {
    Strengths {
        sharpen: 1.0,
        defringe: 1.0,
    }
}

fn options(edge: usize) -> EncodeOptions {
    EncodeOptions {
        still_chroma: Chroma::Yuv444,
        output_path: String::new(),
        grade: grade(),
        crf: 4,
        preset: 6,
        strengths: strengths(),
        sharpen_sigma: None,
        max_edge: match edge {
            0 => 100_000.0,
            edge => edge as f64,
        },
    }
}

/// `job::Base::build`'s own chain at whatever size is asked for, rather than `hdr::graded_as`,
/// which sharpens at a fixed sigma. The sigma is the whole question here: it is composed for the
/// target's scale, so a render cut at 3840 deconvolves a different blur from one cut whole, and a
/// harness that held it still would be comparing something nothing ships.
fn rendition(path: &str, edge: usize) -> (Vec<u8>, usize, usize) {
    let amounts = rawshim::galosh::Detail::at(20.0, 30.0);
    let frame =
        rawshim::decode_frame_denoised(path, 0, amounts, Default::default()).expect("decode");
    let samples = frame.samples16().expect("16-bit").to_vec();
    let options = options(edge);

    let gpu = rawshim::gpu::device().expect("a Vulkan adapter");
    let resident = frame.on_device(gpu).expect("the frame reaches the device");
    let matched = rawshim::fit_hdr_for(&resident, path, options.grade.white_quantile);
    let levels = rawshim::hdr::levels_of(
        gpu,
        &samples,
        frame.width,
        frame.height,
        options.grade.white_quantile,
    )
    .expect("levels")
    .anchored();

    let base = rawshim::base::device(gpu).expect("the device the pipelines were built on");
    let size = rawshim::hdr_args::target_size(frame.width as u32, frame.height as u32, &options);
    let sensor_long = frame.width.max(frame.height) * frame.reduced.max(1);
    let capture_sigma = pollster::block_on(rawshim::base::measure_edge_spread(
        gpu,
        base,
        resident.buffer(),
        frame.width,
        frame.height,
    ))
    .map(|blur| blur * frame.reduced.max(1) as f32);
    let sigma = rawshim::image::deconvolve_split(
        capture_sigma,
        sensor_long,
        size.width.max(size.height) as usize,
    );
    let sharpen_noise = rawshim::base::sharpen_noise(
        levels,
        options.grade.reference_white_nits,
        frame.noise,
        frame.matrix,
        frame.wb_gains,
        frame.reduced,
    )
    .at(
        rawshim::px::Span::<rawshim::px::Sensor>::exact(sensor_long),
        rawshim::px::Span::<rawshim::px::Drawn>::exact(
            size.width.max(size.height) as usize,
        ),
    );
    let cut = {
        let resident =
            rawshim::resident::Resident::upload(gpu, &samples, frame.width, frame.height);
        let (prepared, _) = pollster::block_on(rawshim::base::prepare(
            gpu,
            base,
            resident,
            rawshim::base::Gather::frame(rawshim::px::Size::exact(frame.width, frame.height)),
            levels,
            options.grade.reference_white_nits,
            strengths().before_the_fit(),
            rawshim::image::SharpenSigma::fixed(rawshim::image::DECONVOLVE_SIGMA),
            rawshim::image::SharpenNoise::NONE,
            &rawshim::fit::Lens::none(),
            rawshim::base::Defringe::Measure,
            frame.noise,
            frame.matrix,
        ))
        .expect("the coding and the defringe");
        let lens = matched.as_ref().map(|m| &m.lens);
        hdr::Cut::from_base(
            prepared,
            lens,
            size,
            strengths().sharpen,
            sigma,
            sharpen_noise,
        )
    };

    let scene = rawshim::tone::SceneGrade::new(
        matched.as_ref().and_then(|m| m.colour.as_ref()),
        levels,
        options.grade.reference_white_nits,
        None,
        rawshim::gpu::Adjust::none(),
        frame.as_shot,
    );
    let coded = hdr::encode_cut(
        gpu,
        &cut,
        &scene.gpu_grade(
            cut.width,
            cut.height,
            // sRGB, so the peak is diffuse white and everything above it rolls into white -
            // `job::peak_nits` again, and the crossing is spelled here as it is there.
            rawshim::light::Light::at_diffuse_white(options.grade.reference_white_nits),
            rawshim::gpu::Output::Srgb,
        ),
    );
    (
        coded.iter().map(|v| *v as u8).collect(),
        cut.width,
        cut.height,
    )
}

fn laplacians(image: rawshim::rgb::RgbRef<'_>) -> Vec<f64> {
    let luma = |i: usize| {
        0.2126 * f64::from(image.data[i * 3])
            + 0.7152 * f64::from(image.data[i * 3 + 1])
            + 0.0722 * f64::from(image.data[i * 3 + 2])
    };
    let mut laps = Vec::with_capacity(image.width * image.height);
    for row in 0..image.height {
        for col in 0..image.width - 2 {
            let at = row * image.width + col;
            laps.push((luma(at) - 2.0 * luma(at + 1) + luma(at + 2)).abs());
        }
    }
    laps
}

/// Three readings off one three-tap Laplacian, because detail and grain are the same operator at
/// different percentiles: the median is what the pipeline estimates *noise* with, and a flat frame
/// is most of any photograph, so it says nothing about an edge. The mean and the top percentile are
/// where a reduction that lost detail shows.
fn detail(image: rawshim::rgb::RgbRef<'_>) -> (f64, f64, f64) {
    let mut laps = laplacians(image);
    let mean = laps.iter().sum::<f64>() / laps.len() as f64;
    let mid = laps.len() / 2;
    laps.select_nth_unstable_by(mid, f64::total_cmp);
    let median = laps[mid];
    let top = laps.len() * 99 / 100;
    laps.select_nth_unstable_by(top, f64::total_cmp);
    (mean, laps[top], median)
}

/// Median absolute Laplacian of each colour difference, over blocks rather than pixels.
///
/// **Chroma noise is blotchy, and a three-tap Laplacian cannot see it.** Run pixel to pixel on an
/// 8-bit frame, every arm reports the same 0.72 - which is 0.7152, the luma weight of a single
/// green code, so the operator is measuring quantization and nothing else. Blotches survive a
/// block mean where a one-code step does not, so the planes are averaged down first and the
/// Laplacian run on that.
const CHROMA_BLOCK: usize = 8;

fn chroma_noise(image: rawshim::rgb::RgbRef<'_>) -> (f64, f64) {
    let (bw, bh) = (image.width / CHROMA_BLOCK, image.height / CHROMA_BLOCK);
    let mut planes = [vec![0.0; bw * bh], vec![0.0; bw * bh]];
    for by in 0..bh {
        for bx in 0..bw {
            let (mut sr, mut sb) = (0.0, 0.0);
            for y in by * CHROMA_BLOCK..(by + 1) * CHROMA_BLOCK {
                for x in bx * CHROMA_BLOCK..(bx + 1) * CHROMA_BLOCK {
                    let i = (y * image.width + x) * 3;
                    let (r, g, b) = (
                        f64::from(image.data[i]),
                        f64::from(image.data[i + 1]),
                        f64::from(image.data[i + 2]),
                    );
                    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    sr += r - luma;
                    sb += b - luma;
                }
            }
            let n = (CHROMA_BLOCK * CHROMA_BLOCK) as f64;
            planes[0][by * bw + bx] = sr / n;
            planes[1][by * bw + bx] = sb / n;
        }
    }

    let mut out = [0.0, 0.0];
    for (plane, slot) in out.iter_mut().enumerate() {
        let p = &planes[plane];
        let mut laps = Vec::with_capacity(bw * bh);
        for row in 0..bh {
            for col in 0..bw.saturating_sub(2) {
                let i = row * bw + col;
                laps.push((p[i] - 2.0 * p[i + 1] + p[i + 2]).abs());
            }
        }
        let mid = laps.len() / 2;
        laps.select_nth_unstable_by(mid, f64::total_cmp);
        *slot = laps[mid];
    }
    (out[0], out[1])
}

/// The reduction the rendition path runs, on the host: an area average over each output pixel's
/// footprint, fractional ends and all, matching `reduce.slang`.
///
/// Here to separate the resampler from everything else. It is the one thing that differs between
/// cutting at size and reducing afterwards, so an arm that reduces the whole render *this* way
/// says whether the kernel accounts for what the two arms disagree about - in the frame's own
/// coding rather than in light, which is the one way it is not `reduce.slang`.
fn area_reduce(source: rawshim::rgb::RgbRef<'_>, width: usize, height: usize) -> rawshim::rgb::Rgb {
    let sx = source.width as f64 / width as f64;
    let sy = source.height as f64 / height as f64;
    let mut data = vec![0u8; width * height * 3];
    for row in 0..height {
        let (top, bottom) = (row as f64 * sy, (row + 1) as f64 * sy);
        for col in 0..width {
            let (left, right) = (col as f64 * sx, (col + 1) as f64 * sx);
            let mut sums = [0.0f64; 3];
            let mut weight = 0.0;
            for y in top.floor() as usize..(bottom.ceil() as usize).min(source.height) {
                let wy = (bottom.min(y as f64 + 1.0) - top.max(y as f64)).max(0.0);
                for x in left.floor() as usize..(right.ceil() as usize).min(source.width) {
                    let w = wy * (right.min(x as f64 + 1.0) - left.max(x as f64)).max(0.0);
                    let at = (y * source.width + x) * 3;
                    for (c, sum) in sums.iter_mut().enumerate() {
                        *sum += w * f64::from(source.data[at + c]);
                    }
                    weight += w;
                }
            }
            let at = (row * width + col) * 3;
            for (c, sum) in sums.iter().enumerate() {
                data[at + c] = (sum / weight).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    rawshim::rgb::Rgb {
        width,
        height,
        data,
    }
}

fn rmse(a: &[u8], b: &[u8]) -> f64 {
    let sum: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| f64::from(x.abs_diff(*y)).powi(2))
        .sum();
    (sum / a.len() as f64).sqrt()
}

fn cut(image: rawshim::rgb::RgbRef<'_>, x: usize, y: usize, side: usize) -> rawshim::rgb::Rgb {
    let x = x.min(image.width.saturating_sub(side));
    let y = y.min(image.height.saturating_sub(side));
    let mut data = vec![0u8; side * side * 3];
    for row in 0..side {
        let from = ((y + row) * image.width + x) * 3;
        data[row * side * 3..(row + 1) * side * 3]
            .copy_from_slice(&image.data[from..from + side * 3]);
    }
    rawshim::rgb::Rgb {
        width: side,
        height: side,
        data,
    }
}

fn write(path: &str, image: rawshim::rgb::RgbRef<'_>) {
    rawshim::avif::encode_rendition(
        image.data.into(),
        image.width,
        image.height,
        4,
        10,
        true,
        path,
    )
    .expect("the write");
    // A crop exists to be looked at, and not everything that opens a picture opens an AVIF. 98
    // rather than the download's 92: this one is read next to its pair at 1:1, so the encoder must
    // not be a third thing between them.
    let jpeg = rawshim::jpeg::encode(image, 98).expect("the jpeg");
    std::fs::write(path.replace(".avif", ".jpg"), jpeg).expect("the write");
}

/// At the quantizer the SDR rendition ships, since what survives a reduction has to be paid for.
fn shipped_bytes(image: rawshim::rgb::RgbRef<'_>) -> f64 {
    let file =
        rawshim::avif::encode_rgb8(image.data.into(), image.width, image.height, 13, 10, false)
            .expect("the encode");
    file.len() as f64 / 1024.0
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a raw path");
    let out = args.next().expect("an output directory");
    let mut edge = 3840usize;
    let mut crops: Vec<(usize, usize, usize)> = Vec::new();
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--crop" => {
                let spec = args.next().expect("x,y,side");
                let n: Vec<usize> = spec
                    .split(',')
                    .map(|v| v.parse().expect("a number"))
                    .collect();
                crops.push((n[0], n[1], n[2]));
            }
            other => edge = other.parse().expect("a number"),
        }
    }
    std::fs::create_dir_all(&out).expect("the output directory");

    let started = std::time::Instant::now();
    let (direct, dw, dh) = rendition(&path, edge);
    let cut_at_size = started.elapsed().as_millis();

    let started = std::time::Instant::now();
    let (whole, ww, wh) = rendition(&path, 0);
    let cut_whole = started.elapsed().as_millis();

    // Onto the other's exact grid, so the two are comparable pixel for pixel rather than nearly.
    let reduced = rawshim::image::resize(
        rawshim::rgb::RgbRef {
            width: ww,
            height: wh,
            data: &whole,
        },
        dw,
        dh,
    );

    let boxed = area_reduce(
        rawshim::rgb::RgbRef {
            width: ww,
            height: wh,
            data: &whole,
        },
        dw,
        dh,
    );

    let a = rawshim::rgb::RgbRef {
        width: dw,
        height: dh,
        data: &direct,
    };
    let b = reduced.as_ref();
    let c = boxed.as_ref();
    println!("cut at size   {dw}x{dh} in {cut_at_size}ms");
    println!("cut whole     {ww}x{wh} in {cut_whole}ms, reduced to {dw}x{dh}");

    println!("\n                        mean lap  p99 lap  median lap   chroma r/b   q13 kB");
    for (name, image) in [("at size", a), ("whole, lanczos", b), ("whole, area", c)] {
        let (mean, top, median) = detail(image);
        let (cr, cb) = chroma_noise(image);
        println!(
            "  {name:<20}{mean:8.3} {top:8.2} {median:11.3}   {cr:4.2}/{cb:4.2}  {:7.1}",
            shipped_bytes(image),
        );
    }
    println!(
        "\n  lanczos against at size: rmse {:.2} of 255",
        rmse(&direct, &reduced.data)
    );
    println!(
        "  area    against at size: rmse {:.2} of 255",
        rmse(&direct, &boxed.data)
    );

    write(&format!("{out}/at-size.avif"), a);
    write(&format!("{out}/whole-lanczos.avif"), b);
    write(&format!("{out}/whole-area.avif"), c);
    for (x, y, side) in &crops {
        write(
            &format!("{out}/at-size-{x}-{y}.avif"),
            cut(a, *x, *y, *side).as_ref(),
        );
        write(
            &format!("{out}/whole-lanczos-{x}-{y}.avif"),
            cut(b, *x, *y, *side).as_ref(),
        );
        write(
            &format!("{out}/whole-area-{x}-{y}.avif"),
            cut(c, *x, *y, *side).as_ref(),
        );
    }
    println!("\nwritten to {out}");
}
