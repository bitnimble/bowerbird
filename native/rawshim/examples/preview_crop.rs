//! The camera's own embedded JPEG, cropped where `renders` crops the render.
//!
//! ```text
//! preview_crop <raw> <render-width> <x,y,side> <out.jpg>
//! ```
//!
//! **The reference the camera match is fitted against, so the one thing that can say which of two
//! renders is closer.** Comparing two of our own renders answers "did this change anything"; it
//! cannot answer "and which is right". The preview can, for colour and for level, because it is
//! what the fit is trying to reproduce.
//!
//! `render-width` is the long side of the frame the crop coordinates were taken in, since the
//! preview is its own size and the two only correspond through that ratio.

fn main() {
    let mut args = std::env::args().skip(1);
    let raw = args.next().expect("raw path");
    let render_width: usize = args.next().expect("render width").parse().expect("a number");
    let crop = args.next().expect("x,y,side");
    let out = args.next().expect("out jpg");

    let parts: Vec<usize> =
        crop.split(',').map(|v| v.parse().expect("x,y,side are numbers")).collect();
    let (x, y, side) = (parts[0], parts[1], parts[2]);

    let preview = rawshim::decode_embedded_rgb(&raw, 0).expect("the file embeds a preview");
    println!("preview {}x{}", preview.width, preview.height);
    // **What the reference can and cannot show.** A camera's JPEG subsamples chroma, so comparing a
    // render's colour detail against it is comparing against something that was resampled on the way
    // in - and at 4:2:0 a chroma sample covers two of its own pixels each way, which over the ratio
    // to the sensor is several photosites. A chroma structure finer than that is not in the file to
    // disagree with, and reading one as a fault in the render is reading the container.
    if let Some(jpeg) = rawshim::decode_rawler::upright_preview_jpeg(
        &raw,
        rawshim::decode_rawler::Preview::Largest,
    ) {
        let mut at = 2usize;
        while at + 9 < jpeg.len() {
            if jpeg[at] != 0xff {
                at += 1;
                continue;
            }
            let marker = jpeg[at + 1];
            // Any of the SOF shapes, which all carry the component table in the same place.
            if (0xc0..=0xcf).contains(&marker) && marker != 0xc4 && marker != 0xc8 && marker != 0xcc
            {
                let components = usize::from(jpeg[at + 9]);
                let factors: Vec<String> = (0..components)
                    .filter_map(|c| jpeg.get(at + 11 + c * 3))
                    .map(|byte| format!("{}x{}", byte >> 4, byte & 0xf))
                    .collect();
                println!("preview sampling {}", factors.join(" "));
                break;
            }
            let length = usize::from(u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]));
            at += 2 + length.max(2);
        }
    }

    // The preview is the whole picture at its own size, so one ratio maps both axes.
    let scale = preview.width as f64 / render_width as f64;
    let at = |v: usize| (v as f64 * scale).round() as usize;
    let (px, py) = (at(x).min(preview.width), at(y).min(preview.height));
    let pw = at(side).min(preview.width - px);
    let ph = at(side).min(preview.height - py);
    println!("taking {pw}x{ph} at {px},{py} (scale {scale:.3})");

    let mut data = vec![0u8; pw * ph * 3];
    for row in 0..ph {
        let from = ((py + row) * preview.width + px) * 3;
        let into = row * pw * 3;
        data[into..into + pw * 3].copy_from_slice(&preview.data[from..from + pw * 3]);
    }

    let cropped = rawshim::rgb::Rgb { data, width: pw, height: ph };
    let encoded = rawshim::jpeg::encode(cropped.as_ref(), 95).expect("the crop encodes");
    std::fs::write(&out, encoded).unwrap_or_else(|why| panic!("{out}: {why}"));
    println!("wrote {out}");
}
