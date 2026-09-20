//! A world, and what a camera pointed at it would have recorded.
//!
//! **A fixture, and the only synthetic picture in the crate that is one.** Aligning a panorama
//! needs a set of photographs with real overlap and real structure, and no RAW fixture is a pan -
//! so the views are generated from a scene with content at every scale and no period to it, which
//! is what a correspondence search has to work against.
//!
//! Three things want the same six views and two of them are not tests: `composite_align`'s own suite,
//! an example that writes them to a directory, and the library the end-to-end suite opens a
//! composite out of. One scene, so a change to it cannot make the suite and the fixture disagree
//! about what they are looking at.

/// The views' size. A camera's proportions, small enough that six of them align in seconds.
pub const WIDE: usize = 1280;
pub const TALL: usize = 800;

/// Sixty degrees across, which is a normal lens and what a panorama is usually shot at.
pub const FOCAL: f64 = 1108.5;

fn hashed(ix: i64, iy: i64) -> f64 {
    let mut h = (ix.wrapping_mul(374_761_393) ^ iy.wrapping_mul(668_265_263)) as u64;
    h ^= h >> 13;
    h = h.wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    (h & 0xffff) as f64 / 65535.0
}

fn noise(x: f64, y: f64, cell: f64) -> f64 {
    let (u, v) = (x / cell, y / cell);
    let (ix, iy) = (u.floor(), v.floor());
    let ease = |t: f64| t * t * (3.0 - 2.0 * t);
    let (fx, fy) = (ease(u - ix), ease(v - iy));
    let (ix, iy) = (ix as i64, iy as i64);
    let across = |dy: i64| hashed(ix, iy + dy) * (1.0 - fx) + hashed(ix + 1, iy + dy) * fx;
    across(0) * (1.0 - fy) + across(1) * fy
}

/// A world with structure at every scale and no period to it, read along a ray.
pub fn scene(ray: [f64; 3]) -> f64 {
    let flat = (ray[0] * ray[0] + ray[2] * ray[2]).sqrt();
    let (lon, lat) = (ray[0].atan2(ray[2]), ray[1].atan2(flat));
    let (x, y) = (lon * 900.0, lat * 900.0);
    0.15 + 0.7 * (0.5 * noise(x, y, 60.0) + 0.3 * noise(x, y, 17.0) + 0.2 * noise(x, y, 5.0))
}

/// Box taps a pixel, per axis.
///
/// **Not decoration.** Point-sampling a scene with content near the grid's Nyquist aliases, and
/// two views sample it on grids that are a rotation apart - so the aliasing differs between
/// them and a correlation reads a displacement that is systematically wrong. A camera's own
/// aperture band-limits, and so must a fixture claiming to stand for one.
const SUPERSAMPLE: usize = 4;

/// What a camera pointed along `rotation` would have recorded of it, as 8-bit RGB.
pub fn shot(rotation: [f64; 4]) -> Vec<u8> {
    let step = 1.0 / SUPERSAMPLE as f64;
    let mut out = Vec::with_capacity(WIDE * TALL * 3);
    for pixel in 0..WIDE * TALL {
        let (x, y) = ((pixel % WIDE) as f64, (pixel / WIDE) as f64);
        let mut sum = 0.0;
        for tap in 0..SUPERSAMPLE * SUPERSAMPLE {
            let (dx, dy) = (
                ((tap % SUPERSAMPLE) as f64 + 0.5) * step,
                ((tap / SUPERSAMPLE) as f64 + 0.5) * step,
            );
            let ray = crate::composition::rotate(
                rotation,
                [
                    (x + dx - WIDE as f64 / 2.0) / FOCAL,
                    (y + dy - TALL as f64 / 2.0) / FOCAL,
                    1.0,
                ],
            );
            sum += scene(ray);
        }
        let level = ((sum / (SUPERSAMPLE * SUPERSAMPLE) as f64).clamp(0.0, 1.0) * 255.0).round();
        out.extend_from_slice(&[level as u8; 3]);
    }
    out
}

/// Writes one view as a PNG and answers where it went.
pub fn written(directory: &std::path::Path, name: &str, pixels: &[u8]) -> String {
    let path = directory.join(name);
    let file = std::fs::File::create(&path).expect("a fixture is writable");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), WIDE as u32, TALL as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().expect("a png header");
    writer.write_image_data(pixels).expect("a png body");
    path.to_string_lossy().into_owned()
}

/// Six across in one row, thirty-two degrees apart.
///
/// **A canvas with levels, which is what [`rig`]'s does not have.** Two rows twenty degrees apart
/// span a hundred degrees of world and compose to about 1950 pixels - inside the 4096 a whole
/// prepared level is bounded by, so there is no finer level of it for a reader to zoom into and
/// nothing that exercises a window. Swept the same way a person actually sweeps a pan, this one
/// spans 220 degrees and composes to about 4250, so its coarsest level is a halving and the rung
/// below it is the canvas's own pixels.
///
/// Still half a frame of overlap at a sixty-degree lens, which is what the correspondence search
/// needs. What it gives up is the second row, and so the vertical half of an alignment - which is
/// `rig`'s to answer, and does.
pub fn wide_rig() -> Vec<[f64; 4]> {
    (0..6)
        .map(|i| {
            let pan = (f64::from(i) - 2.5) * 32.0 * std::f64::consts::PI / 180.0;
            crate::composition::normalise(crate::composition::from_axis_angle([0.0, pan, 0.0]))
        })
        .collect()
}

/// Three columns by two rows, twenty degrees apart across and ten down.
///
/// What a person shooting a panorama on a sixty-degree lens actually does, which is a third to a
/// half of overlap.
pub fn rig() -> Vec<[f64; 4]> {
    [
        (-20.0, -10.0),
        (0.0, -10.0),
        (20.0, -10.0),
        (-20.0, 10.0),
        (0.0, 10.0),
        (20.0, 10.0),
    ]
    .iter()
    .map(|(pan, tilt)| {
        let d = std::f64::consts::PI / 180.0;
        crate::composition::normalise(crate::composition::multiply(
            crate::composition::from_axis_angle([0.0, pan * d, 0.0]),
            crate::composition::from_axis_angle([tilt * d, 0.0, 0.0]),
        ))
    })
    .collect()
}

/// The views of `rig` written into a directory, in the order the rig names them.
pub fn views(directory: &std::path::Path, rotations: &[[f64; 4]]) -> Vec<String> {
    std::fs::create_dir_all(directory).expect("a fixture directory");
    rotations
        .iter()
        .enumerate()
        .map(|(i, rotation)| written(directory, &format!("view{i}.png"), &shot(*rotation)))
        .collect()
}
