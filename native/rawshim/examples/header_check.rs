//! What the catalogue would store for a file.
//!
//! ```text
//! header_check <raw>...
//! ```
//!
//! Every field a row is built from, so the read that replaced LibRaw's can be held against what the
//! catalogue used to show.

fn main() {
    for path in std::env::args().skip(1) {
        let name = std::path::Path::new(&path)
            .file_name()
            .map_or_else(String::new, |s| s.to_string_lossy().into_owned());
        let Some(header) = rawshim::header::read_path(&path) else {
            println!("{name}: no header");
            continue;
        };
        println!("== {name}");
        println!("   {}x{}  orientation {}", header.width, header.height, header.orientation);
        println!(
            "   iso {}  shutter {}  f/{}  {}mm",
            header.iso, header.shutter, header.aperture, header.focal
        );
        println!("   timestamp {}  gps {},{}", header.timestamp, header.latitude, header.longitude);
        println!(
            "   {} {} / {}",
            rawshim::header::name(&header.camera_make),
            rawshim::header::name(&header.camera_model),
            rawshim::header::name(&header.lens_model)
        );
    }
}
