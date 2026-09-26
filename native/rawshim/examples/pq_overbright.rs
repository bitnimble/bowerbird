//! How a browser shows a PQ still brighter than the display, and whether its `clli` moves that.
//!
//! ```text
//! pq_overbright <out-dir>
//! ```
//!
//! Writes one neutral ladder, 203 to 10000 nits, three times - declaring a MaxCLL of 10000, a
//! MaxCLL of 1000 that the pixels exceed, and no `clli` at all - and `index.html` showing them one
//! under the next. A browser that tone maps by the metadata draws the three differently; one that
//! clips at the panel draws them alike, every patch past the panel's peak merged into one block.

use std::borrow::Cow;

use rawshim::avif;
use rawshim::hdr_args::{Chroma, ContentLight};
use rawshim::light::{DisplayNits, Light};

const LADDER_NITS: [f64; 12] = [203.0, 400.0, 600.0, 800.0, 1000.0, 1200.0, 1600.0, 2000.0, 3000.0, 4000.0, 6000.0, 10000.0];
const PATCH: usize = 160;

fn main() {
    let out = std::env::args().nth(1).expect("usage: pq_overbright <out-dir>");
    std::fs::create_dir_all(&out).expect("the output directory");
    let (width, height) = (PATCH * LADDER_NITS.len(), PATCH);
    let mut pq = vec![0u16; width * height * 3];
    for (x, pixel) in (0..width * height).map(|at| at % width).zip(pq.chunks_exact_mut(3)) {
        let nits: Light<DisplayNits> = Light::exactly(LADDER_NITS[x / PATCH]);
        let code = (rawshim::tone::pq(nits).raw() * 65535.0).round() as u16;
        pixel.fill(code);
    }
    let files = [
        ("declared-10000.avif", Some(ContentLight { max_cll: 10000, max_fall: 2567 })),
        ("declared-1000.avif", Some(ContentLight { max_cll: 1000, max_fall: 1000 })),
        ("undeclared.avif", None),
    ];
    let (primaries, transfer, matrix) = rawshim::hdr_args::cicp();
    for (name, light) in files {
        let options = avif::StillOptions {
            cicp: avif::Cicp { primaries, transfer, matrix },
            format: Chroma::Yuv444.avif_format(),
            quantizer: 0,
            speed: 6,
            light,
        };
        avif::save_still(Cow::Borrowed(&pq), width, height, &options, &format!("{out}/{name}"), 0, None)
            .expect("the still");
    }
    let labels: String = LADDER_NITS.iter().map(|nits| format!("<span>{nits}</span>")).collect();
    let rows: String = files
        .iter()
        .map(|(name, _)| format!("<h2>{name}</h2><img src=\"{name}\" width=\"{width}\" height=\"{height}\"><div class=\"labels\">{labels}</div>"))
        .collect();
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>PQ past the display</title>\
         <style>body{{background:#000;color:#aaa;font:14px system-ui;margin:24px}}\
         img{{display:block;image-rendering:pixelated}}\
         .labels{{display:flex;width:{width}px}}.labels span{{flex:1;text-align:center}}\
         h2{{font-size:14px;margin:24px 0 8px}}</style>\
         <p>Each row is the same pixels. Where the rows differ, the browser read the <code>clli</code>.</p>{rows}"
    );
    std::fs::write(format!("{out}/index.html"), page).expect("the page");
    println!("{out}/index.html");
}
