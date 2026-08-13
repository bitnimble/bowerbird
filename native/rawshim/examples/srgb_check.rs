//! The 8-bit sRGB decode, written out so it can be looked at.
//!
//! ```text
//! srgb_check <out-dir> <raw>...
//! ```
//!
//! `dcraw_process` produced this directly and now it is the scene-linear frame with a matrix and a
//! transfer curve on it, so the thing worth checking is that it is a photograph and not a
//! misapplied gamma: a picture too dark by 2.2 is what a missing transfer looks like, and one too
//! light is what applying it twice looks like.

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next() else {
        eprintln!("srgb_check <out-dir> <raw>...");
        return;
    };
    std::fs::create_dir_all(&out).expect("the output directory");

    for path in args {
        let name = std::path::Path::new(&path)
            .file_stem()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());
        let Some(frame) = rawshim::decode_frame(&path, 8, false, 0) else {
            println!("{name}: declined");
            continue;
        };
        let Some(image) = frame.rgb8() else {
            println!("{name}: not an 8-bit decode");
            continue;
        };

        let mean = image.data.iter().map(|s| u64::from(*s)).sum::<u64>() as f64 / image.data.len() as f64;
        let small = rawshim::image::resize_to_fit(image, 1400);
        let jpeg = rawshim::jpeg::encode(small.as_ref(), 92).expect("the record encodes");
        std::fs::write(format!("{out}/{name}.jpg"), jpeg).expect("writing the record");
        println!("{name:>16}  {}x{}  mean {mean:.1}", image.width, image.height);
    }
}
