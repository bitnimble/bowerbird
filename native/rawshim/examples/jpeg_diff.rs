//! Two written files against each other, decoded back from disk.
//!
//! ```text
//! jpeg_diff <a.jpg> <b.jpg> <out.jpg> [gain]
//! ```
//!
//! Every difference reported by the seam harnesses is computed from buffers they are holding
//! anyway, so a bug anywhere in that path - the wrong buffer compared, a crop taken at the wrong
//! offset, an amplification applied to the wrong pair - reads as a result rather than as a
//! failure. This decodes the delivered files instead and shares nothing with it, so agreeing with
//! it means something.
//!
//! It also answers the question the numbers cannot: whether what survives into the file a reader
//! would actually be handed still has a seam in it.

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(a), Some(b), Some(out)) = (args.next(), args.next(), args.next()) else {
        eprintln!("jpeg_diff <a.jpg> <b.jpg> <out.jpg> [gain]");
        std::process::exit(2);
    };
    let gain: f32 = args.next().and_then(|g| g.parse().ok()).unwrap_or(32.0);

    let read = |path: &str| {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("could not read {path}: {e}"));
        // Far past any crop these write, so nothing is scaled on the way in - a resample would
        // invent differences of its own.
        rawshim::jpeg::decode(&bytes, 1 << 20).unwrap_or_else(|e| panic!("{path}: {e}"))
    };
    let (left, right) = (read(&a), read(&b));
    assert_eq!(
        (left.width, left.height),
        (right.width, right.height),
        "the two files are different sizes",
    );

    let (mut worst, mut total) = (0u8, 0f64);
    let mut data = vec![0u8; left.data.len()];
    for (at, out) in data.iter_mut().enumerate() {
        let delta = left.data[at].abs_diff(right.data[at]);
        worst = worst.max(delta);
        total += f64::from(delta);
        *out = ((f32::from(delta) * gain).min(255.0)) as u8;
    }

    println!(
        "{}x{}  worst {worst}  mean {:.4}  at {gain}x",
        left.width,
        left.height,
        total / left.data.len() as f64,
    );
    let image = rawshim::rgb::RgbRef { width: left.width, height: left.height, data: &data };
    std::fs::write(&out, rawshim::jpeg::encode(image, 100).expect("encodes"))
        .expect("the difference writes");
    eprintln!("wrote {out}");
}
