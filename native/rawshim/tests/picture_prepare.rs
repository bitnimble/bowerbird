#![cfg(feature = "renditions")]

use rawshim::job::Job;
use rawshim::px::Rect;

fn job(path: &str) -> Job {
    serde_json::from_value(serde_json::json!({
        "rawFilePath": path,
        "cameraMatch": "lensAndColour",
        "sharpen": 0.5,
        "defringe": 1.0,
        "grade": { "peakNits": 1000.0, "referenceWhiteNits": 203.0, "whiteQuantile": 0.99 },
        "targets": []
    })).expect("a prepare job")
}

fn check_window(job: &mut Job, level: u32, shape: (usize, usize)) {
    let whole = rawshim::picture::prepared(job, level, None, &[]).expect("the whole picture prepares");
    job.photo_analysis = whole.header.photo_analysis.clone();
    let window = rawshim::picture::prepared(job, level, Some(Rect::exact(3, 5, 31, 17)), &[])
        .expect("a single-photo window prepares");
    assert_eq!((whole.header.width, whole.header.height), shape);
    assert_eq!((window.header.width, window.header.height), (31, 17));
    assert_eq!(window.samples.len(), 31 * 17 * 3);
    let placed = window.header.window.as_ref().expect("the window names its place");
    assert_eq!(placed.canvas, shape);
    assert_eq!(placed.origin, (3, 5));
    assert_eq!(window.header.picture, whole.header.picture);
    assert_eq!(window.header.level, level);
    assert_eq!(window.header.finest, level == 0);
    assert_eq!(window.header.white, whole.header.white);
    assert_eq!(window.header.peak, whole.header.peak);
    assert_eq!(window.header.matched, whole.header.matched);
    assert_eq!(window.header.as_shot, whole.header.as_shot);
    for (row, actual) in window.samples.chunks_exact(31 * 3).enumerate() {
        let start = ((row + 5) * shape.0 + 3) * 3;
        assert_eq!(actual, &whole.samples[start..start + 31 * 3], "window row {row}");
    }
}

#[test]
fn single_photo_windows_match_whole_levels() {
    for (width, height, half_height) in [(323, 215, 106), (323, 214, 106), (322, 215, 108)] {
        check_photo(width, height, half_height);
    }
}

fn check_photo(width: usize, height: usize, half_height: usize) {
    let path = std::env::temp_dir().join(format!("bowerbird-picture-window-{}.png", std::process::id()));
    let pixels: Vec<u8> = (0..width * height).flat_map(|at| {
        let x = at % width;
        let y = at / width;
        [(x * 255 / width) as u8, (y * 255 / height) as u8, if x > width / 2 { 240 } else { 20 }]
    }).collect();
    let mut encoder = png::Encoder::new(std::fs::File::create(&path).expect("fixture file"), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().expect("PNG header").write_image_data(&pixels).expect("PNG pixels");
    let mut job = job(path.to_str().expect("fixture path"));
    for (level, shape) in [(0, (322, 214)), (1, (160, half_height)), (2, (80, 52))] {
        check_window(&mut job, level, shape);
    }
    std::fs::remove_file(path).expect("fixture removed");
}

#[cfg(feature = "fixtures")]
#[test]
fn raw_photo_windows_keep_whole_photo_calibration() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/DSC02981.ARW");
    let mut job = job(path.to_str().expect("fixture path"));
    let opened = rawshim::picture::prepared(&job, 2, None, &[]).expect("RAW prepares");
    assert!(opened.header.matched, "RAW carries its camera colour match");
    job.photo_analysis = opened.header.photo_analysis;
    let picture = opened.header.picture.expect("whole photograph dimensions");
    let shape = rawshim::composite_job::level_shape(&[picture.0, picture.1], 1);
    check_window(&mut job, 1, shape);
}
