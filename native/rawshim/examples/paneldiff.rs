//! The chroma difference between a stitched pair's two panels, as a picture: grey where
//! they agree, signed colour where they do not.
//!
//! ```text
//! paneldiff <stitched.jpg> <out.jpg> [gain] [hp]
//! ```
//!
//! The difference of the chroma-per-luma ratios - the hue story with the exposure and
//! roll-off gap divided away. With `hp`, a 100px box mean of the field is subtracted
//! first, so band-scale structure shows on its own whatever the broad offset between the
//! panels is.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (path, out, gain, highpass) = match &args[..] {
        [path, out] => (path, out, 1000.0, false),
        [path, out, gain] => (path, out, gain.parse().unwrap(), false),
        [path, out, gain, flag] => (path, out, gain.parse().unwrap(), flag == "hp"),
        _ => panic!("paneldiff <stitched.jpg> <out.jpg> [gain] [hp]"),
    };
    let bytes = std::fs::read(path).unwrap();
    // A `.ppm` sidecar is read raw: a JPEG's subsampled chroma rings at exactly the
    // scale this tool amplifies.
    let image = match path.ends_with(".ppm") {
        false => rawshim::jpeg::decode(&bytes, 100_000).unwrap(),
        true => {
            let mut cuts = 0usize;
            let mut at = 0usize;
            while cuts < 3 {
                if bytes[at] == b'\n' {
                    cuts += 1;
                }
                at += 1;
            }
            let header = std::str::from_utf8(&bytes[..at]).unwrap();
            let dims: Vec<usize> = header
                .split_whitespace()
                .skip(1)
                .take(2)
                .map(|v| v.parse().unwrap())
                .collect();
            rawshim::rgb::Rgb { width: dims[0], height: dims[1], data: bytes[at..].to_vec() }
        }
    };
    let panel = (image.width - 8) / 2;
    let height = image.height;

    let mut field = vec![0.0f64; panel * height * 2];
    for y in 0..height {
        for x in 0..panel {
            let cam = (y * image.width + x) * 3;
            let ours = (y * image.width + panel + 8 + x) * 3;
            let l = |i: usize| {
                (0.2126 * f64::from(image.data[i])
                    + 0.7152 * f64::from(image.data[i + 1])
                    + 0.0722 * f64::from(image.data[i + 2]))
                .max(1.0)
            };
            let (lc, lo) = (l(cam), l(ours));
            for (k, c) in [0usize, 2].into_iter().enumerate() {
                field[(y * panel + x) * 2 + k] = f64::from(image.data[ours + c]) / lo
                    - f64::from(image.data[cam + c]) / lc;
            }
        }
    }

    if highpass {
        let radius = 100usize;
        let mut low = field.clone();
        for horizontal in [true, false] {
            let (span, lines) = if horizontal { (panel, height) } else { (height, panel) };
            let src = low.clone();
            for line in 0..lines {
                for i in 0..span {
                    let (lo, hi) = (i.saturating_sub(radius), (i + radius).min(span - 1));
                    let mut acc = [0.0f64; 2];
                    for j in lo..=hi {
                        let at = if horizontal { line * panel + j } else { j * panel + line };
                        acc[0] += src[at * 2];
                        acc[1] += src[at * 2 + 1];
                    }
                    let n = (hi - lo + 1) as f64;
                    let at = if horizontal { line * panel + i } else { i * panel + line };
                    low[at * 2] = acc[0] / n;
                    low[at * 2 + 1] = acc[1] / n;
                }
            }
        }
        for (v, base) in field.iter_mut().zip(low) {
            *v -= base;
        }
    }

    let mut data = vec![128u8; panel * height * 3];
    for p in 0..panel * height {
        let (r, b) = (field[p * 2], field[p * 2 + 1]);
        data[p * 3] = (128.0 + r * gain).clamp(0.0, 255.0) as u8;
        data[p * 3 + 1] = (128.0 - (r + b) * 0.5 * gain).clamp(0.0, 255.0) as u8;
        data[p * 3 + 2] = (128.0 + b * gain).clamp(0.0, 255.0) as u8;
    }
    let image = rawshim::rgb::Rgb { width: panel, height, data };
    std::fs::write(out, rawshim::jpeg::encode(image.as_ref(), 95).unwrap()).unwrap();
    eprintln!("wrote {out}");
}
