//! How far apart two renders of one crop actually are, in counts.
//!
//! ```text
//! pixdiff <a.jpg> <b.jpg> [--reduce N]
//! ```
//!
//! `--reduce` box-averages both sides by N first, which is what to use when the two pictures are
//! not the same *render* - ours against the camera's own JPEG, say. At 1:1 such a comparison is
//! dominated by however many fractions of a pixel the two geometries disagree by, and a texture
//! answers that far louder than it answers the question being asked; reduced, what is left is tone
//! and colour, which is what "does this look like the camera's picture" actually means.
//!
//! **Because an eye is a bad instrument for a small difference and a confident one.** A change that
//! reads as "visibly more speckle" at 1:1 and a change that reads as nothing can be the same
//! number, and only one of them is worth refusing. This reports the mean and the worst, per channel
//! and over all three, so a claim about a picture has a figure attached.
//!
//! The comparison is sound despite going through JPEG: the same build renders a crop
//! byte-identically twice, so the encoder contributes nothing of its own to a difference between
//! two builds - what comes out is the change and the encoder's response to it.

fn main() {
    let mut args = std::env::args().skip(1);
    let left = args.next().expect("a.jpg");
    let right = args.next().expect("b.jpg");

    let (mut reduce, mut long) = (1usize, 0usize);
    while let Some(flag) = args.next() {
        let value: usize = args.next().expect("a number").parse().expect("a number");
        match flag.as_str() {
            "--reduce" => reduce = value,
            "--long" => long = value,
            other => panic!("unknown flag {other}"),
        }
    }
    let read = |path: &str| {
        let bytes = std::fs::read(path).unwrap_or_else(|why| panic!("{path}: {why}"));
        rawshim::jpeg::decode(&bytes, long).unwrap_or_else(|why| panic!("{path}: {why}"))
    };
    let shrink = |image: rawshim::rgb::Rgb| -> rawshim::rgb::Rgb {
        if reduce <= 1 {
            return image;
        }
        let (width, height) = (image.width / reduce, image.height / reduce);
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            for x in 0..width {
                for c in 0..3 {
                    let mut total = 0u32;
                    for dy in 0..reduce {
                        for dx in 0..reduce {
                            let at = ((y * reduce + dy) * image.width + x * reduce + dx) * 3 + c;
                            total += u32::from(image.data[at]);
                        }
                    }
                    data[(y * width + x) * 3 + c] = (total / (reduce * reduce) as u32) as u8;
                }
            }
        }
        rawshim::rgb::Rgb { data, width, height }
    };
    // Trimmed to the smaller rather than refused, for the reason `stitch` gives: two pictures of one
    // scene bounded to the same long edge land a pixel apart when their sources round differently.
    let trim = |image: rawshim::rgb::Rgb, width: usize, height: usize| -> rawshim::rgb::Rgb {
        if (image.width, image.height) == (width, height) {
            return image;
        }
        let mut data = vec![0u8; width * height * 3];
        for y in 0..height {
            let from = y * image.width * 3;
            data[y * width * 3..(y + 1) * width * 3]
                .copy_from_slice(&image.data[from..from + width * 3]);
        }
        rawshim::rgb::Rgb { data, width, height }
    };
    let (raw_a, raw_b) = (read(&left), read(&right));
    let width = raw_a.width.min(raw_b.width);
    let height = raw_a.height.min(raw_b.height);
    let a = shrink(trim(raw_a, width, height));
    let b = shrink(trim(raw_b, width, height));

    let mut sums = [0f64; 3];
    let mut worst = [0u8; 3];
    let mut over_one = 0usize;
    let pixels = a.width * a.height;
    for p in 0..pixels {
        for c in 0..3 {
            let delta = a.data[p * 3 + c].abs_diff(b.data[p * 3 + c]);
            sums[c] += f64::from(delta);
            worst[c] = worst[c].max(delta);
            if delta > 1 {
                over_one += 1;
            }
        }
    }

    // Each side's own levels as well as the gap, because a mean absolute difference cannot tell a
    // picture that is the wrong brightness from one that is the wrong colour, and those are not the
    // same fault.
    let levels = |image: &rawshim::rgb::Rgb| {
        let mut totals = [0f64; 3];
        for p in 0..pixels {
            for c in 0..3 {
                totals[c] += f64::from(image.data[p * 3 + c]);
            }
        }
        totals.map(|t| t / pixels as f64)
    };
    let la = levels(&a);
    let lb = levels(&b);

    let mean = |c: usize| sums[c] / pixels as f64;
    let all = (sums[0] + sums[1] + sums[2]) / (pixels * 3) as f64;
    println!("{}x{}, {pixels} pixels", a.width, a.height);
    println!("  a levels       r {:.1}  g {:.1}  b {:.1}", la[0], la[1], la[2]);
    println!("  b levels       r {:.1}  g {:.1}  b {:.1}", lb[0], lb[1], lb[2]);
    println!("  mean |delta|   r {:.3}  g {:.3}  b {:.3}   all {all:.3}", mean(0), mean(1), mean(2));
    println!("  worst          r {}  g {}  b {}", worst[0], worst[1], worst[2]);
    println!(
        "  samples over 1 count: {over_one} of {} ({:.2}%)",
        pixels * 3,
        100.0 * over_one as f64 / (pixels * 3) as f64
    );
    // 255 counts here, not 65535: these are 8-bit display samples, which is the domain the
    // difference has to be invisible in.
    println!("  (counts of 255)");
}
