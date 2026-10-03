//! A window of a RAW's conditioned mosaic, written as a fixture that carries no metadata, and the
//! numbers a test needs to demosaic it as the file would be.
//!
//! ```text
//! mosaic_crop <raw> <out.f32> <x,y,w,h>
//! ```
//!
//! Coordinates are the sensor's own, as `photosites` reports them; the origin must align to the CFA
//! period. Row-major little-endian f32, undenoised.

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("mosaic_crop <raw> <out.f32> <x,y,w,h>");
    let out = args.next().expect("an output path");
    let rect: Vec<usize> = args
        .next()
        .expect("x,y,w,h")
        .split(',')
        .map(|v| v.parse().expect("a number"))
        .collect();
    let (x, y, w, h) = (rect[0], rect[1], rect[2], rect[3]);

    let bytes = std::fs::read(&path).expect("read the raw");
    let held = pollster::block_on(rawshim::decode_rawler::hold_bytes(&bytes)).expect("held");
    let gpu = rawshim::gpu::device().expect("an adapter");
    let cfa = held.cfa();
    assert!(
        cfa.aligned(x, y),
        "the window origin must align to the CFA period"
    );
    let mosaic = held.device_mosaic();
    let stride = mosaic.width;
    assert!(
        x + w <= stride && y + h <= mosaic.height,
        "the window is inside the mosaic"
    );
    let values = pollster::block_on(mosaic.read(gpu)).expect("reads back");
    let window: Vec<u8> = (0..h)
        .flat_map(|row| values[(y + row) * stride + x..][..w].iter())
        .flat_map(|v| v.to_le_bytes())
        .collect();
    std::fs::write(&out, window).expect("wrote the window");

    let source = rawler::rawsource::RawSource::new(std::path::Path::new(&path)).expect("the file");
    let decoder = rawler::get_decoder(&source).expect("a decoder");
    let image = decoder
        .raw_image(&source, &rawler::decoders::RawDecodeParams::default(), true)
        .expect("the tags");
    println!("wrote {out}: {w}x{h} from {x},{y}");
    println!(
        "cfa {:?} at the window's origin",
        [0, 1, 2, 3].map(|k| cfa.colour_at(k / 2, k % 2))
    );
    println!("upright {:?}", held.upright());
    println!(
        "ceiling {:?}",
        rawshim::decode_rawler::channel_ceilings(&image)
    );
    println!(
        "matrix {:?}",
        rawshim::decode_rawler::camera_to_rec2020(&image).expect("a camera matrix")
    );
}
