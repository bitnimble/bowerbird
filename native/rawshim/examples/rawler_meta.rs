//! What rawler says about a file, for when the decode comes out wrong and the question is which
//! coefficient it believed.

fn main() {
    for path in std::env::args().skip(1) {
        let Ok(image) = rawler::decode_file(&path) else {
            println!("{path}: would not decode");
            continue;
        };
        let name = std::path::Path::new(&path).file_name().map_or_else(String::new, |s| s.to_string_lossy().into_owned());
        println!("== {name}  {}x{}  cpp {}", image.width, image.height, image.cpp);
        println!("   camera      {} {}", image.camera.make, image.camera.model);
        println!("   cfa         {:?} {}", image.camera.cfa.name, image.camera.cfa.width);
        println!("   wb_coeffs   {:?}", image.wb_coeffs);
        println!("   blacklevel  {:?}", image.blacklevel);
        println!("   whitelevel  {:?}", image.whitelevel);
        println!("   xyz_to_cam  {:?}", image.xyz_to_cam);
        let mut illuminants: Vec<_> = image.color_matrix.keys().collect();
        illuminants.sort_by_key(|i| **i as u16);
        println!("   illuminants {illuminants:?}");
        println!("   cam_to_xyz  {:?}", image.cam_to_xyz_normalized());
        println!("   crop_area   {:?}", image.crop_area);
        println!("   active_area {:?}", image.active_area);
        println!("   orientation {:?}", image.orientation);

        if let rawler::RawImageData::Integer(samples) = &image.data {
            let n = samples.len().min(image.width * image.height);
            let total: u64 = samples[..n].iter().map(|s| u64::from(*s)).sum();
            let peak = samples[..n].iter().copied().max().unwrap_or(0);
            println!("   samples     mean {:.1}  peak {}  sum {total}", total as f64 / n as f64, peak);
            // How much of the frame the stated white level would discard. A handful of samples is
            // hot pixels; a real fraction is highlight the metadata is wrong about.
            let stated = image.whitelevel.0.iter().copied().max().unwrap_or(65535) as u16;
            let over = samples[..n].iter().filter(|s| **s > stated).count();
            println!("   above white {over} of {n} ({:.4}%)", over as f64 / n as f64 * 100.0);
        }
    }
}
