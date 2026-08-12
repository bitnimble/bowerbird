//! The shape behind the one number a frame crosses the wire with.
//!
//! `crate::noise` bins the estimate by level and then collapses it, and this prints the bins so
//! the collapse can be judged. A dash is a level the frame has no pixels at.
//!
//! **The samples have to be coded first.** What `edit::prepare` measures is `tone::encode_base`'s
//! normalised PQ, not the linear decode, and the two are not close: an earlier version of this
//! skipped the coding and reported a curve that was nearly flat, which is what a linear frame's
//! is. In PQ it falls by orders of magnitude from the low midtones to white, and that difference
//! was the whole question.

fn main() {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    // Every second bin: 32 columns does not fit a terminal and the shape is smooth.
    let shown: Vec<usize> = (0..rawshim::noise::BINS).step_by(2).collect();
    print!("{:>6}  ", "iso");
    for bin in &shown {
        print!("{:>7.2}", (*bin as f32 + 0.5) / rawshim::noise::BINS as f32);
    }
    println!("{:>9}  file", "shipped");

    for path in &paths {
        let Some(header) = rawshim::header::read_path(path) else { continue };
        let Some(frame) = rawshim::decode_frame(path, 16, true, 0) else { continue };
        let Some(samples) = frame.samples16() else { continue };

        // The coding `edit::open` applies before any of this is measured.
        let mut coded = samples.to_vec();
        let levels = rawshim::tone::levels(&coded, 0.995);
        rawshim::tone::encode_base(&mut coded, levels.anchored(), 203.0);

        let (binned, _, _) = rawshim::noise::sample(&coded, frame.width, frame.height);
        let shipped = rawshim::noise::measure(&coded, frame.width, frame.height);
        print!("{:>6.0}  ", header.iso);
        for bin in &shown {
            match binned[*bin].sigma {
                Some(sigma) => print!("{sigma:>7.3}"),
                None => print!("{:>7}", "-"),
            }
        }
        println!("{:>9.3}  {}", shipped.stabilised, path.rsplit('/').next().unwrap_or(path));
    }
}
