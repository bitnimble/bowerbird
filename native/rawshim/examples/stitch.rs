//! Two renders of one crop, side by side in a single picture.
//!
//! ```text
//! stitch [--long N] <first.jpg> <second.jpg> [more.jpg...] <out.jpg>
//! ```
//!
//! `--long` bounds each pane's long edge, for panes that are whole frames rather than 1:1 crops:
//! a colour or tone difference is a question about the picture and wants the picture in view,
//! where a noise difference wants the pixels and no bound at all.
//!
//! For the question a mean deviation cannot answer. `renders` writes one crop per invocation, so
//! comparing two builds means flipping between two files and trusting the eye's memory across the
//! switch - which is exactly the comparison an eye is worst at. Put the pair on one row and a real
//! difference stops needing to be remembered.
//!
//! The two are assumed to be the same size, which they are when they came from the same `--crop`.

fn main() {
    let mut paths: Vec<String> = std::env::args().skip(1).collect();
    let mut long = 0usize;
    if paths.first().is_some_and(|first| first == "--long") {
        paths.remove(0);
        long = paths.remove(0).parse().expect("a number");
    }
    let out = paths.pop().expect("out jpg");
    assert!(paths.len() >= 2, "stitch [--long N] <first.jpg> <second.jpg> [more.jpg...] <out.jpg>");

    let read = |path: &String| {
        let bytes = std::fs::read(path).unwrap_or_else(|why| panic!("{path}: {why}"));
        rawshim::jpeg::decode(&bytes, long).unwrap_or_else(|why| panic!("{path}: {why}"))
    };
    let panes: Vec<rawshim::rgb::Rgb> = paths.iter().map(read).collect();
    // Trimmed to the smallest rather than refused: two pictures of one scene bounded to the same
    // long edge land a pixel apart when their sources round differently, and a pane short by one
    // is not a reason to decline the comparison.
    let pane_w = panes.iter().map(|pane| pane.width).min().expect("a pane");
    let height = panes.iter().map(|pane| pane.height).min().expect("a pane");

    // A gutter between them, so a join is not read as an edge in the picture.
    const GUTTER: usize = 8;
    let width = panes.len() * pane_w + (panes.len() - 1) * GUTTER;
    let mut data = vec![32u8; width * height * 3];
    for (index, pane) in panes.iter().enumerate() {
        let left = index * (pane_w + GUTTER);
        for y in 0..height {
            let from = y * pane.width * 3;
            let into = (y * width + left) * 3;
            data[into..into + pane_w * 3].copy_from_slice(&pane.data[from..from + pane_w * 3]);
        }
    }

    let joined = rawshim::rgb::Rgb { data, width, height };
    let encoded = rawshim::jpeg::encode(joined.as_ref(), 95).expect("the pair encodes");
    std::fs::write(&out, encoded).unwrap_or_else(|why| panic!("{out}: {why}"));
    println!("wrote {out} ({width}x{height})");
}
