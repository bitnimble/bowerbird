//! A RAW with nothing in it but the things a pipeline can get wrong.
//!
//! ```text
//! synth_raw <out.dng> [--width N] [--height N] [--imbalance F] [--noise F]
//!           [--shift dx,dy] [--object x,y,side] [--preview <out.jpg>]
//!           [--burst <dir>] [--grid] [--square] [--frames N]
//! ```
//!
//! `--square` replaces the panels with one green square on mid grey: an exact step, for reading a
//! render's own edge against a scene that has no width to its. Inside it, a ramp, texture and fine
//! lines, for what a filter loses without widening the edge; beside it, a bright disc and a shaded
//! ball, for a halo and a crosshatch.
//!
//! The last three make a **burst**: the same scene from a camera that moved, with something in it
//! that moved differently. A burst written this way has no parallax at all - the scene is a picture
//! at infinity - so what it isolates is the pipeline, which is the half of a registration failure a
//! real handheld burst cannot separate out.
//!
//! Writes an uncompressed Bayer DNG whose scene is known exactly, so anything the render shows
//! that the scene does not have is the pipeline's. A photograph cannot answer that question: there
//! is no ground truth behind it, so a crosshatch on a twig is either the demosaic, the denoise, the
//! warp, the sharpen, or the twig.
//!
//! Eight panels, each aimed at one failure:
//!
//! | Panel | What it catches |
//! |---|---|
//! | zone plate | frequency beyond the per-colour sampling limit, as coloured moire |
//! | siemens star | every angle at once, at every frequency up to the limit |
//! | gratings | a single frequency, so a beat has a period you can read off |
//! | flats | anything the pipeline adds to a picture with no detail at all |
//! | colour stripes | chroma reconstruction, where the luma is nearly flat |
//! | twigs | thin dark lines on a smooth sky, which is the picture that provoked this |
//! | gate spill | how far a chroma filter reaches past what provoked it |
//! | chroma star | a filter taking colour the scene really had |
//!
//! The last two are for a filter rather than for the demosaic, and they are a pair: one holds
//! chroma the reconstruction invented next to chroma it did not, the other is invented nowhere at
//! all. A filter judged only on the first four looks free.
//!
//! The scene is built at 4x4 per pixel and box-averaged down, which is the band limit a lens and a
//! sensor's aperture would impose. That leaves nothing above the *pixel* grid's Nyquist and plenty
//! above each *colour's*, which is the demosaic's actual problem and not a straw one.
//!
//! The camera matrix is XYZ to sRGB and the as-shot neutral is unity, so camera RGB is linear sRGB
//! and the scene's numbers survive to the grade. Read the render back against `--imbalance 0
//! --noise 0` first: with an exact scene, a clean pipeline and no noise to denoise, every panel
//! should come back as what went in.

use rawler::decoders::{CFAConfig, Camera, RawPhotometricInterpretation, WhiteLevel};
use rawler::dng::writer::DngWriter;
use rawler::dng::{CropMode, DNG_VERSION_V1_4, DngCompression, DngPhotometricConversion};
use rawler::imgop::xyz::Illuminant;
use rawler::pixarray::PixU16;

/// Rows and columns of panels. The scene is laid out on this grid and nothing else knows the count.
const PANELS: (usize, usize) = (4, 2);

/// Box taps per pixel per axis.
const SUPERSAMPLE: usize = 4;

/// Sensor levels. Sixteen bits with no black pedestal, so a sample is the scene's own number.
const WHITE: f32 = 65535.0;

/// The mid grey every panel sits on, in linear light. Low enough that a modulation on top of it
/// stays inside the scene's range and high enough to be well above the noise floor.
const GREY: f32 = 0.18;

/// How far a panel's pattern swings either side of [`GREY`].
const SWING: f32 = 0.14;

/// Frames a `--burst` writes without `--frames`. Four: enough that a median has a majority to be
/// the consensus of (§3.3 reads a disturbance against the frames that agree), and few enough to
/// stay a fixture.
const BURST: usize = 4;

/// Figures across, and rows of them deep.
const CROWD: (usize, usize) = (7, 2);

/// A torso's width as a share of its column.
///
/// **Past one, so shoulders overlap.** A row of people standing apart is the easy case and not the
/// one a group photo is: a seed has to grow over one person in a crowd whose disturbances *touch*,
/// and a field with ground between every pair never asks it that.
const SHOULDER: f64 = 1.15;

/// Supersamples per axis inside a figure's own rasteriser.
///
/// Higher than [`SUPERSAMPLE`] because a figure is mostly edge, and an edge is what the whole burst
/// is measured by: the align matches corners, and §3.3 divides by the gradient at one. A staircase
/// here would be a fixture whose own aliasing is the signal.
const EDGE_SAMPLES: usize = 8;

struct Args {
    out: String,
    width: usize,
    height: usize,
    imbalance: f32,
    noise: f32,
    shift: (f64, f64),
    object: Option<(f64, f64, f64)>,
    preview: Option<String>,
    burst: Option<String>,
    grid: bool,
    square: bool,
    frames: usize,
}

fn args() -> Args {
    let mut args = std::env::args().skip(1);
    let out = args
        .next()
        .expect("synth_raw <out.dng> [--width N] [--height N]");
    let mut parsed = Args {
        out,
        width: 3000,
        height: 2000,
        imbalance: 0.0,
        noise: 0.0,
        shift: (0.0, 0.0),
        object: None,
        preview: None,
        burst: None,
        grid: false,
        square: false,
        frames: BURST,
    };
    while let Some(flag) = args.next() {
        // A lattice instead of a crowd, for the same `--burst` directory: it takes no value, so it
        // is read before the pair below rather than through it.
        if flag == "--grid" {
            parsed.grid = true;
            continue;
        }
        // One hard edge and nothing else, for watching what the chain does to it.
        if flag == "--square" {
            parsed.square = true;
            continue;
        }
        let value = args.next().expect("a number");
        match flag.as_str() {
            "--width" => parsed.width = value.parse().expect("a number"),
            "--height" => parsed.height = value.parse().expect("a number"),
            // Where the camera was, in pixels of this frame. The whole scene moves together, which
            // is what a distant subject does under a hand-held camera's translation.
            "--shift" => {
                let (dx, dy) = value.split_once(',').expect("dx,dy");
                parsed.shift = (dx.parse().expect("a number"), dy.parse().expect("a number"));
            }
            // Something that moved on its own, drawn in the frame's own pixels after the shift: the
            // one thing in the picture a registration cannot bring into agreement.
            "--object" => {
                let n: Vec<f64> = value
                    .split(',')
                    .map(|v| v.parse().expect("a number"))
                    .collect();
                parsed.object = Some((n[0], n[1], n[2]));
            }
            // The scene as a camera would have rendered it, which is the plane an alignment reads:
            // nothing here embeds a preview in the DNG, and the search has no other way in.
            "--preview" => parsed.preview = Some(value),
            // Four frames of one scene into a directory, each with its own camera and its own
            // movers, and each carrying an embedded JPEG so `composite_align` can open it.
            "--burst" => parsed.burst = Some(value),
            // How many, for a question that is about the count itself: what a carve does to the
            // picture as the set grows.
            "--frames" => parsed.frames = value.parse().expect("a number"),
            // The two greens of a Bayer site do not always answer a photon alike, and the
            // difference is a checkerboard at the sampling grid's own pitch - which is what a
            // crosshatch in a render looks like. Injected here so a render can be compared with
            // and without one.
            "--imbalance" => parsed.imbalance = value.parse().expect("a number"),
            // Shot noise, as a multiple of a 20k-electron well. Zero is the isolating case; a
            // denoiser handed a frame with no noise in it is being asked a question it was not
            // built for, so a finding that only appears at zero is worth checking against one.
            "--noise" => parsed.noise = value.parse().expect("a number"),
            other => panic!("unknown flag {other}"),
        }
    }
    // Both axes even, or the CFA does not tile the frame.
    parsed.width &= !1;
    parsed.height &= !1;
    parsed
}

fn main() {
    let args = args();
    let (width, height) = (args.width, args.height);

    if let Some(dir) = args.burst.clone() {
        burst(&args, &dir);
        return;
    }

    let scene = match args.square {
        true => square_scene(width, height),
        false => scene(width, height, args.shift, args.object),
    };
    if let Some(path) = &args.preview {
        write_preview(&scene, width, height, path);
    }
    let mosaic = mosaic(&scene, width, height, &args);
    write_dng(&args.out, &mosaic, (width, height), None);
    eprintln!("wrote {} at {width}x{height}", args.out);
}

/// Four frames of one field into a directory, each with the camera and the movers this frame has.
///
/// **Each carries an embedded JPEG**, which is not a convenience: `composite_align` opens a source
/// through `upright_preview_rgb`, which reads `preview_jpegs` and has no other way in, so a burst
/// written without one is a burst the align refuses before §3 begins.
fn burst(args: &Args, dir: &str) {
    let size = (args.width, args.height);
    std::fs::create_dir_all(dir).expect("the output directory");
    let frames = args.frames.max(2);
    for frame in 0..frames {
        let scene = match args.grid {
            true => grid_frame(size, frame),
            false => crowd_frame(size, frame),
        };
        let mosaic = mosaic(&scene, size.0, size.1, args);
        let path = format!("{dir}/frame-{frame}.dng");
        write_dng(&path, &mosaic, size, Some(&scene));
        // Beside the DNG, so the fixture can be looked at without decoding one. Not what the align
        // reads - that is the JPEG embedded above - just the same scene for a person.
        write_preview(&scene, size.0, size.1, &format!("{dir}/frame-{frame}.jpg"));
    }
    // What the fixture did, so a run can be read against it rather than eyeballed. The movers are
    // stated as the affine each applied *by the last frame*, about its own centre.
    eprintln!("\n{frames} frames of {}x{} at {dir}", size.0, size.1);
    eprintln!(
        "  camera, frame {}: {:?}",
        frames - 1,
        camera_motion(frames - 1, size).map(round)
    );
    let metered: Vec<String> = (0..frames).map(|f| format!("{:.4}", metering(f))).collect();
    eprintln!(
        "  metering, per frame, against frame 0: {}",
        metered.join(" ")
    );
    // **Where each mover is, not just what it did.** A run's pieces are reported as boxes on the
    // canvas, and matching those to the movers by doing the grid arithmetic in one's head is how a
    // reader talks themselves into believing the wrong one fired. Stated here, in the frame's own
    // pixels, with how far the motion carries a corner of that torso - which is the number that
    // decides whether §3.3 should have seen it at all.
    let crowd = crowd(size);
    for which in 0..4 {
        let what = ["translation", "rotation", "shear", "anisotropic scale"][which];
        let Some(figure) = crowd.iter().find(|s| s.moves == Some(which)) else {
            continue;
        };
        let at = mover_motion(which, frames - 1);
        let (half, tall) = (figure.torso[0] / 2.0, figure.torso[1] / 2.0);
        let mut corner = 0.0f64;
        for (dx, dy) in [(-half, -tall), (half, -tall), (half, tall), (-half, tall)] {
            let [a, b, c, d, tx, ty] = at;
            corner = corner.max((a * dx + b * dy + tx - dx).hypot(c * dx + d * dy + ty - dy));
        }
        eprintln!(
            "  mover {which} ({what}) at [{:.0}, {:.0}], {:.0}x{:.0}: frame {} {:?}, corner moves {corner:.1}px",
            figure.centre[0],
            figure.centre[1],
            figure.torso[0],
            figure.torso[1],
            frames - 1,
            at.map(round),
        );
    }
    // Everyone else, because a run that answers eleven tiles is answering the sway - and which
    // tile is which is not readable from a box on the canvas without this.
    eprintln!("  the rest of the crowd, who only sway:");
    for figure in crowd.iter().filter(|it| it.moves.is_none()) {
        eprintln!(
            "    at [{:.0}, {:.0}], {:.0}x{:.0}",
            figure.centre[0], figure.centre[1], figure.torso[0], figure.torso[1],
        );
    }
}

fn round(at: f64) -> f64 {
    (at * 10_000.0).round() / 10_000.0
}

/// One mosaic as an uncompressed Bayer DNG, with `preview` embedded where one was given.
fn write_dng(to: &str, mosaic: &[u16], size: (usize, usize), preview: Option<&[[f32; 3]]>) {
    let (width, height) = size;
    let camera = camera();
    let photometric = RawPhotometricInterpretation::Cfa(CFAConfig::new_from_camera(&camera));
    let image = rawler::RawImage::new(
        camera,
        PixU16::new_with(mosaic.to_vec(), width, height),
        1,
        // Unity, so the conditioning applies no gain and camera RGB reaches the matrix as it left
        // the scene. The fourth is the emerald a Bayer sensor does not have.
        [1.0, 1.0, 1.0, f32::NAN],
        photometric,
        None,
        Some(WhiteLevel::new([WHITE as u32])),
        false,
    );

    let file = std::fs::File::create(to).expect("the output file");
    let mut dng =
        DngWriter::new(std::io::BufWriter::new(file), DNG_VERSION_V1_4).expect("the DNG opens");
    let mut raw = dng.subframe_on_root(0);
    raw.raw_image(
        &image,
        CropMode::None,
        DngCompression::Uncompressed,
        DngPhotometricConversion::Original,
        1,
    )
    .expect("the mosaic writes");
    raw.finalize().expect("the subframe closes");
    // A subframe of its own, as `rawler`'s own converter writes one: this is what
    // `decoder.preview_jpegs` finds, and so the only way `composite_align` can open the file.
    if let Some(scene) = preview {
        let coded: Vec<u8> = scene.iter().flat_map(|rgb| (*rgb).map(srgb8)).collect();
        let buffer = image::RgbImage::from_raw(width as u32, height as u32, coded)
            .expect("the preview is the frame's own size");
        let mut into = dng.subframe(1);
        into.preview(&image::DynamicImage::ImageRgb8(buffer), 0.9)
            .expect("the preview writes");
        into.finalize().expect("the preview subframe closes");
    }
    dng.load_base_tags(&image).expect("the base tags");
    dng.close().expect("the DNG closes");
}

/// sRGB's transfer over the scene's own light, diffuse white at 1.0.
fn srgb8(v: f32) -> u8 {
    (rawshim::hdr_fit::srgb_oetf(f64::from(v)) * 255.0).round() as u8
}

/// A camera that is a straight window onto the scene: linear sRGB primaries, no black pedestal, no
/// balance to undo.
fn camera() -> Camera {
    // XYZ (D65) to linear sRGB. As the camera matrix, this makes the sensor's native primaries the
    // scene's own, so a grey panel reaches the grade grey and a red stripe reaches it red.
    let xyz_to_srgb: Vec<f32> = vec![
        3.240_454_2,
        -1.537_138_5,
        -0.498_531_4,
        -0.969_266,
        1.876_010_8,
        0.041_556,
        0.055_643_4,
        -0.204_025_9,
        1.057_225_2,
    ];
    Camera {
        make: "Bowerbird".to_string(),
        model: "Synth".to_string(),
        clean_make: "Bowerbird".to_string(),
        clean_model: "Synth".to_string(),
        cfa: rawler::CFA::new("RGGB"),
        color_matrix: [(Illuminant::D65, xyz_to_srgb)].into_iter().collect(),
        whitelevel: Some(vec![WHITE as u32]),
        blacklevel: Some(vec![0]),
        real_bps: 16,
        ..Default::default()
    }
}

/// The scene in linear light, one RGB triple per pixel.
/// A green square on mid grey, and nothing else.
///
/// **The edge is exact, not band-limited like [`scene`]'s panels.** A step that lands on a whole
/// pixel is the only reference a reader can hold a render against by eye: whatever width the
/// boundary comes back with, and whatever sits either side of it, the scene had neither. That is
/// the opposite of what the panels are for - they carry frequency past each colour's sampling
/// limit on purpose - so the two do not belong in one frame.
///
/// Green because the CFA samples it at twice the rate of the others, so a softness here is not the
/// sampling being thin; and against grey rather than black because a step out of a flat the
/// conditioning has clamped is a different measurement.
fn square_scene(width: usize, height: usize) -> Vec<[f32; 3]> {
    const SIDE: f64 = 0.3;
    // Well under [`GREY`], because the grade lifts a mid grey a long way: at the panels' own level
    // the square's green leaves the SDR range entirely and the one channel a Bayer sensor samples
    // densely is a flat 255 on both sides of the edge, which is the edge this exists to read.
    const LEVEL: f32 = GREY * 0.4;
    let side = (width.min(height) as f64 * SIDE) as usize;
    let (left, top) = ((width - side) / 2, (height - side) / 2);
    let mut out = vec![[LEVEL, LEVEL, LEVEL]; width * height];
    for y in top..top + side {
        for x in left..left + side {
            let lit = inside_square((x - left) as f64 / side as f64, (y - top) as f64 / side as f64, x, y);
            out[y * width + x] = [LEVEL * 0.3 * lit, LEVEL * 1.8 * lit, LEVEL * 0.3 * lit];
        }
    }
    // Left of the square, clear of it: a bright disc, whose curved rim puts a strong step into
    // every block orientation at once (a halo), and a shaded skin-toned ball with pores, a gradient
    // under texture a few sigma deep, which is where the denoise's phases disagree (a crosshatch).
    let radius = width.min(height) as f64 * 0.125;
    let column = width as f64 * 0.175;
    shade(&mut out, width, (column, height as f64 * 0.175), radius, |_, _| [LEVEL * 3.0; 3]);
    shade(&mut out, width, (column, height as f64 * 0.825), radius, |lit, (x, y)| {
        let lit = ((0.35 + 0.65 * lit) * (1.0 + 0.12 * (pores(x, y) - 0.5))) as f32;
        [LEVEL * 1.3 * lit, LEVEL * 0.95 * lit, LEVEL * 0.75 * lit]
    });
    out
}

/// The square's shading at `(u, v)` across it, in thirds: what a denoise loses without widening an
/// edge. Each third is a gain about one, so the outer step is the one [`square_scene`] describes.
///
/// | third | holds | what losing it looks like |
/// |---|---|---|
/// | left | a ramp from 1 to 0.6 | a gradient come back in steps |
/// | middle | value noise, ±4% above, ±12% below | texture smoothed flat |
/// | right | 1px dark lines every 5px, 3/6/12/25% deep by band | fine detail gone |
///
/// A margin of a tenth around the middle and right thirds stays flat, so the square's own edge is
/// read against plain colour as before.
fn inside_square(u: f64, v: f64, x: usize, y: usize) -> f32 {
    let margin = !(0.1..0.9).contains(&v);
    let gain = match u {
        u if u < 1.0 / 3.0 => 1.0 - 0.4 * u * 3.0,
        _ if margin => 1.0,
        u if u < 2.0 / 3.0 => {
            let depth = if v < 0.5 { 0.08 } else { 0.24 };
            1.0 + depth * (texture(x as f64, y as f64) - 0.5)
        }
        _ if x % 5 == 0 => 1.0 - [0.03, 0.06, 0.12, 0.25][((v - 0.1) / 0.2).clamp(0.0, 3.0) as usize],
        _ => 1.0,
    };
    gain as f32
}

/// Value noise at two pitches, two and four pixels, in [0, 1].
fn texture(x: f64, y: f64) -> f64 {
    0.5 * value_noise(x, y, 2.0, 11) + 0.5 * value_noise(x, y, 4.0, 13)
}

/// Value noise on a three-pixel lattice, in [0, 1].
fn pores(x: f64, y: f64) -> f64 {
    value_noise(x, y, 3.0, 0)
}

/// Bilinear value noise on a lattice of `pitch` pixels, in [0, 1].
fn value_noise(x: f64, y: f64, pitch: f64, salt: u64) -> f64 {
    let (u, v) = (x / pitch, y / pitch);
    let (i, j) = (u.floor(), v.floor());
    let (fu, fv) = (u - i, v - j);
    let at = |di: f64, dj: f64| hashed((salt << 56) ^ (((i + di) as u64) << 32) | (j + dj) as u64);
    let top = at(0.0, 0.0) + (at(1.0, 0.0) - at(0.0, 0.0)) * fu;
    let bottom = at(0.0, 1.0) + (at(1.0, 1.0) - at(0.0, 1.0)) * fu;
    top + (bottom - top) * fv
}

/// A disc of `colour`, anti-aliased on [`SUPERSAMPLE`] taps, handed how squarely a ball of that
/// radius faces a light over the viewer's upper left, and where.
fn shade(
    out: &mut [[f32; 3]],
    width: usize,
    centre: (f64, f64),
    radius: f64,
    colour: impl Fn(f64, (f64, f64)) -> [f32; 3],
) {
    let rows = (centre.1 - radius) as usize..=(centre.1 + radius) as usize;
    let columns = (centre.0 - radius) as usize..=(centre.0 + radius) as usize;
    let taps = SUPERSAMPLE * SUPERSAMPLE;
    for y in rows {
        for x in columns.clone() {
            let mut covered = 0;
            for tap in 0..taps {
                let dx = x as f64 + ((tap % SUPERSAMPLE) as f64 + 0.5) / SUPERSAMPLE as f64;
                let dy = y as f64 + ((tap / SUPERSAMPLE) as f64 + 0.5) / SUPERSAMPLE as f64;
                covered += usize::from((dx - centre.0).hypot(dy - centre.1) < radius);
            }
            if covered == 0 {
                continue;
            }
            let (u, v) = ((x as f64 - centre.0) / radius, (y as f64 - centre.1) / radius);
            let facing = (1.0 - u * u - v * v).max(0.0).sqrt();
            let lit = (-0.4 * u - 0.4 * v + 0.82 * facing).clamp(0.0, 1.0);
            let share = covered as f32 / taps as f32;
            let pixel = &mut out[y * width + x];
            for (channel, value) in pixel.iter_mut().zip(colour(lit, (x as f64, y as f64))) {
                *channel += (value - *channel) * share;
            }
        }
    }
}

fn scene(
    width: usize,
    height: usize,
    shift: (f64, f64),
    object: Option<(f64, f64, f64)>,
) -> Vec<[f32; 3]> {
    let (columns, rows) = PANELS;
    let (panel_width, panel_height) = (width / columns, height / rows);
    let taps = SUPERSAMPLE * SUPERSAMPLE;
    let step = 1.0 / SUPERSAMPLE as f64;

    let mut out = vec![[0f32; 3]; width * height];
    for y in 0..height {
        for x in 0..width {
            let mut sum = [0f64; 3];
            for sy in 0..SUPERSAMPLE {
                for sx in 0..SUPERSAMPLE {
                    let wx = x as f64 + (sx as f64 + 0.5) * step + shift.0;
                    let wy = y as f64 + (sy as f64 + 0.5) * step + shift.1;
                    // The panels tile the world rather than the frame, so a shifted camera walks
                    // across them instead of dragging them along with it.
                    let column = wx.div_euclid(panel_width as f64);
                    let row = wy.div_euclid(panel_height as f64);
                    let panel = (row.rem_euclid(rows as f64) as usize) * columns
                        + (column.rem_euclid(columns as f64) as usize);
                    // Local to the panel, in the unit square, so a panel's own arithmetic never
                    // sees the frame's size.
                    let u = (wx - column * panel_width as f64) / panel_width as f64;
                    let v = (wy - row * panel_height as f64) / panel_height as f64;
                    let colour = panel_at(panel, u, v, (panel_width, panel_height));
                    for channel in 0..3 {
                        sum[channel] += f64::from(colour[channel]);
                    }
                }
            }
            for channel in 0..3 {
                out[y * width + x][channel] = (sum[channel] / taps as f64) as f32;
            }
        }
    }
    if let Some((ox, oy, side)) = object {
        // Flat and dark, so what a difference picks up here is the object and not its texture.
        for y in (oy.max(0.0) as usize)..((oy + side) as usize).min(height) {
            for x in (ox.max(0.0) as usize)..((ox + side) as usize).min(width) {
                out[y * width + x] = [GREY * 0.30, GREY * 0.17, GREY * 0.15];
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The burst: a crowd of figures, four frames, and four of them moving more than the rest.
//
// **Why figures rather than shapes on open ground.** Everything the assembly does is measured at an
// edge - the align matches corners, and §3.3 divides a difference by the gradient beside it - so
// the scene is edge at every angle and nothing else, with ground truth known exactly: what it did
// between two frames is a number this file chose, and what the pipeline reports can be subtracted
// from it.
//
// What the *arrangement* adds is the question a seed's growth actually has to answer on a
// photograph anybody takes. Shapes with ground between every pair make one piece per shape easy and
// never ask whether two touching disturbances are one thing; a group photo is people overlapping at
// the shoulder, where every silhouette runs into its neighbour's and the whole crowd is one
// connected boundary. Everybody sways and everybody's head moves, because in a real burst nobody
// holds still, so the right answer is a piece per person over a picture that is disturbed nearly
// everywhere.
//
// **Why an affine and not a shift.** The point of the fixture is the motion no rotation can stand
// in for. Each mover below takes one term of the affine - a translation, a turn, a shear, an
// anisotropic scale - so a pipeline that quietly handles only the first still fails three of them.
// ---------------------------------------------------------------------------------------------

/// A 2x3 affine, `[a, b, c, d, tx, ty]` of `[a b; c d] p + t`, as `Assembly::warp` is.
type Affine = [f64; 6];

const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn compose(outer: Affine, inner: Affine) -> Affine {
    let [a, b, c, d, tx, ty] = outer;
    let [e, f, g, h, ux, uy] = inner;
    [
        a * e + b * g,
        a * f + b * h,
        c * e + d * g,
        c * f + d * h,
        a * ux + b * uy + tx,
        c * ux + d * uy + ty,
    ]
}

fn applied(at: Affine, p: [f64; 2]) -> [f64; 2] {
    [
        at[0] * p[0] + at[1] * p[1] + at[4],
        at[2] * p[0] + at[3] * p[1] + at[5],
    ]
}

/// The inverse, or `None` where the affine collapses the plane.
fn inverse(at: Affine) -> Option<Affine> {
    let [a, b, c, d, tx, ty] = at;
    let det = a * d - b * c;
    if det.abs() < 1e-12 {
        return None;
    }
    let (ia, ib, ic, id) = (d / det, -b / det, -c / det, a / det);
    Some([ia, ib, ic, id, -(ia * tx + ib * ty), -(ic * tx + id * ty)])
}

/// An affine about a point rather than about the origin, which is what every motion here is: a
/// person turns about themselves, not about the corner of the sensor.
fn about(centre: [f64; 2], at: Affine) -> Affine {
    let to = [1.0, 0.0, 0.0, 1.0, centre[0], centre[1]];
    let back = [1.0, 0.0, 0.0, 1.0, -centre[0], -centre[1]];
    compose(to, compose(at, back))
}

/// One figure of the crowd: a torso with a head on it.
struct Figure {
    /// Centre of the torso, in world pixels.
    centre: [f64; 2],
    /// The torso's width and height.
    torso: [f64; 2],
    /// The head's side, and how far above [`Figure::centre`] its own centre sits.
    head: f64,
    neck: f64,
    /// Its own resting lean and shear, so the crowd presents edges at every angle instead of a rank
    /// of axis-aligned boxes - a fit whose only gradients were horizontal and vertical would have
    /// nothing to say about the off-diagonal terms.
    shape: Affine,
    colour: [f32; 3],
    skin: [f32; 3],
    /// Which mover this is, if any. A mover takes an extra affine of its own per frame, and is what
    /// a seed on it should grow over.
    moves: Option<usize>,
    seed: u64,
}

/// A hash, so the field is the same field on every machine and every run without holding one.
fn hashed(seed: u64) -> f64 {
    let mut h = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    h ^= h >> 29;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 32;
    (h % 100_000) as f64 / 100_000.0
}

/// The crowd, in world pixels of a frame of `size`.
///
/// Rows, jittered: neither a lattice (which a correlation can match to the wrong period) nor a heap
/// (which leaves bare ground the align has no corners in). The front row stands lower, larger and
/// half a column over, so it overlaps the back one the way a group photo's does - what a seed grows
/// into is one connected mass of people rather than a set of islands.
fn crowd(size: (usize, usize)) -> Vec<Figure> {
    let (across, rows) = CROWD;
    let column = size.0 as f64 / across as f64;
    // Four movers, one per quadrant, so each has room to become a tile of its own - and two of them
    // shoulder-to-shoulder with a neighbour who is only swaying, which is the pair a run has to
    // tell apart.
    let movers = [(0usize, 1usize), (0, 5), (1, 1), (1, 4)];

    let mut out = Vec::new();
    for row in 0..rows {
        let depth = row as f64 / (rows - 1).max(1) as f64;
        let scale = 0.86 + 0.30 * depth;
        // One fewer in front, because the stagger would carry the last of them off the edge.
        for standing in 0..(across - row) {
            let seed = (row * across + standing) as u64;
            let jitter = |at: u64, span: f64| (hashed(seed * 7 + at) - 0.5) * span;
            let width = column * SHOULDER * scale * (0.92 + 0.16 * hashed(seed * 7 + 8));
            let torso = [width, width * 1.8];
            // Deep jitter, not shallow: people are different heights and stand at different
            // distances, so a row's hems and shoulders land all over. A row that shares a hem
            // shares one long horizontal edge, and a fixture whose figures happen to line up is
            // measuring its own layout.
            let centre = [
                (standing as f64 + 0.5 + 0.5 * row as f64) * column + jitter(1, column * 0.12),
                size.1 as f64 * (0.345 + 0.335 * depth) + jitter(2, torso[1] * 0.10),
            ];
            // Its own lean and shear, small enough that a person still reads as standing.
            let turn = (hashed(seed * 7 + 3) - 0.5) * 0.22;
            let shear = (hashed(seed * 7 + 4) - 0.5) * 0.18;
            let (cos, sin) = (turn.cos(), turn.sin());
            let shape = compose(
                [cos, -sin, sin, cos, 0.0, 0.0],
                [1.0, shear, 0.0, 1.0, 0.0, 0.0],
            );
            // Coloured, not grey: §3.3 weighs a chroma difference as well as a luma one, and a
            // crowd of greys would leave that half of the residual untested. The head is a warmer
            // tone than the shirt, so a seam that crosses the neck is a seam a reader would see.
            let tone = hashed(seed * 7 + 5) as f32;
            let other = hashed(seed * 7 + 6) as f32;
            let head = width * 0.44;
            out.push(Figure {
                centre,
                torso,
                head,
                neck: torso[1] / 2.0 + head * 0.40,
                shape,
                colour: [
                    GREY + SWING * (0.3 + 0.7 * tone),
                    GREY + SWING * (0.9 - 0.6 * tone),
                    GREY + SWING * (0.5 + 0.4 * other),
                ],
                skin: [
                    GREY + SWING * (1.15 + 0.2 * other),
                    GREY + SWING * (0.78 + 0.2 * other),
                    GREY + SWING * (0.58 + 0.2 * other),
                ],
                moves: movers
                    .iter()
                    .position(|&(mr, ms)| mr == row && ms == standing),
                seed,
            });
        }
    }
    out
}

/// A rock about the feet and a shift, both drawn afresh for every frame.
///
/// **Independent per frame, not a ramp in it.** A ramp makes frame 0 the extreme of the burst for
/// *everybody*, so the median follows the late frames and the whole crowd reads as disturbed in the
/// same one - which is a fixture that has quietly arranged for every person to have the same label
/// and cannot then be used to ask whether labels tell people apart. Nobody sways monotonically;
/// what a hand-held burst catches is each person somewhere else in their own wobble each time.
fn wobble(seed: u64, frame: usize, turn_span: f64, shift_span: f64) -> Affine {
    let at = seed.wrapping_mul(97).wrapping_add(frame as u64);
    let turn = (hashed(at) - 0.5) * turn_span;
    let (cos, sin) = (turn.cos(), turn.sin());
    let shift = (hashed(at.wrapping_add(524_287)) - 0.5) * shift_span;
    compose(
        [1.0, 0.0, 0.0, 1.0, shift, 0.0],
        [cos, -sin, sin, cos, 0.0, 0.0],
    )
}

/// What a figure does on its own: nobody in a group photo holds still.
///
/// About the feet, because a person standing rocks about the floor rather than about their middle -
/// so the shoulders travel several pixels where the waist travels one, which is the gradient of
/// displacement a real crowd has and a rigid jitter does not.
fn sway(seed: u64, frame: usize) -> Affine {
    wobble(seed * 11, frame, 0.008, 3.0)
}

/// And what their head does on top of it, about the neck.
///
/// Several times the body's turn, because a head is what actually moves in a group photo - the
/// reason a tile that takes a torso and leaves the head on it is the wrong answer.
fn nod(seed: u64, frame: usize) -> Affine {
    wobble(seed * 13, frame, 0.07, 5.0)
}

/// What the camera did between frame 0 and frame `frame`, in world pixels.
///
/// **A turn, a shift and a scale, and deliberately no shear.** Those three are what a camera that
/// turned, panned and breathed produces, and they are exactly what §3.1's rotation-and-focal model
/// can absorb - so the global align should take all of this out and leave the movers behind. A
/// global shear would be a scene no camera could have photographed, and would only test that the
/// align fails.
///
/// The scale stays well inside `SCALE_LEASH`, and the whole thing stays small enough that
/// `NEAR_IDENTITY` finds the set aligned.
fn camera_motion(frame: usize, size: (usize, usize)) -> Affine {
    if frame == 0 {
        return IDENTITY;
    }
    let step = frame as f64;
    let turn = 0.0022 * step;
    let scale = 1.0 + 0.004 * step;
    let (cos, sin) = (turn.cos(), turn.sin());
    let centre = [size.0 as f64 / 2.0, size.1 as f64 / 2.0];
    let spun = about(
        centre,
        [
            scale * cos,
            -scale * sin,
            scale * sin,
            scale * cos,
            0.0,
            0.0,
        ],
    );
    compose([1.0, 0.0, 0.0, 1.0, 5.0 * step, -3.5 * step], spun)
}

/// What mover `which` did on its own by frame `frame`, about its own centre.
///
/// One term of the affine each, which is the fixture's whole argument: a per-piece correction that
/// only translates passes the first of these and fails the other three, and on a photograph that
/// reads as "the seam still shows" with nothing to say why.
fn mover_motion(which: usize, frame: usize) -> Affine {
    if frame == 0 {
        return IDENTITY;
    }
    let step = frame as f64;
    match which {
        // Straight translation, the case a rotation of the source could have stood in for.
        0 => [1.0, 0.0, 0.0, 1.0, 9.0 * step, -6.0 * step],
        // A turn in the plane.
        1 => {
            let turn = 0.030 * step;
            let (cos, sin) = (turn.cos(), turn.sin());
            [cos, -sin, sin, cos, 0.0, 0.0]
        }
        // A shear: the term no camera motion and no focal can produce.
        2 => [1.0, 0.045 * step, 0.0, 1.0, 0.0, 0.0],
        // An anisotropic scale, which a focal cannot express either.
        _ => [1.0 + 0.020 * step, 0.0, 0.0, 1.0 - 0.014 * step, 0.0, 0.0],
    }
}

/// What this frame was metered at, as a multiple of frame 0's light.
///
/// **A burst is not shot at one exposure.** Metering drifts frame to frame under any auto mode, and
/// nothing in the file says by how much: the header states what the *camera asked for*, which is
/// what `composite_solve::gains` reads, and what came out is a different number. That gap is a step
/// at a seam, so a fixture with every frame at one exposure cannot show one.
///
/// A twelfth of a stop a frame, which is small enough to be invisible in the residual and plainly
/// visible as a step at a seam - which is the failure it exists to reproduce.
fn metering(frame: usize) -> f32 {
    (frame as f32 / 12.0).exp2()
}

/// One frame of a **grid** burst: this file's own resolution panels, still, with one square moving.
///
/// **A ruler for sharpness, which the crowd is not.** A figure is flat colour inside a soft edge,
/// so a render that lost half its detail still looks like the scene. The panels are the instrument
/// already built for this question - a zone plate, a siemens star and gratings, every frequency up
/// to each colour's own sampling limit - and reading a burst's output against a single-frame render
/// of the same scene says whether §3 and §5.2 cost anything the decode did not.
///
/// **Not a one-pixel lattice, which was tried and answers nothing.** Alternating pixels are far
/// past what a Bayer sensor records in any one colour, so the demosaic returns flat colour with a
/// cast - which it would for a real camera too. A fixture has to ask for detail the sensor could
/// have carried, or every answer is "gone" whatever the pipeline does.
fn grid_frame(size: (usize, usize), frame: usize) -> Vec<[f32; 3]> {
    let (width, height) = size;
    // **A shear a frame, which is the point.** §3.1 fits a camera that turned, so a pan or a roll
    // comes straight back out and a seed's seams run over ground the frames agree on, which is a
    // blend that touches almost nothing and a fixture that cannot be asked what blending costs. A
    // shear is the term that model has no room for, so what is left after the align is a
    // disagreement *everywhere*, and every seam crosses it.
    let step = frame as f64;
    let centre = [width as f64 / 2.0, height as f64 / 2.0];
    let skew = about(centre, [1.0, 0.0018 * step, 0.0009 * step, 1.0, 0.0, 0.0]);
    let mut out = warped(&scene(width, height, (0.0, 0.0), None), size, skew);
    // And one square moving over the top of it, so there is a mover as well as the residue.
    let side = width as f64 / 8.0;
    let shift = 12.0 * step;
    let at = compose(
        [1.0, 0.0, 0.0, 1.0, centre[0] + shift, centre[1]],
        [side, 0.0, 0.0, side, 0.0, 0.0],
    );
    draw(&mut out, size, at, [GREY * 0.5, GREY * 0.5, GREY * 0.6]);
    out
}

/// A whole frame through an affine, bilinear, sampling the source at `at⁻¹` of each output pixel.
///
/// Bilinear and not better, deliberately: the fixture's own resampling has to be at least as good
/// as the pipeline's or the thing being measured is this function. What it costs is measured with
/// it - a frame warped by the identity comes back unchanged, and the shears here are small enough
/// that one tap dominates every pixel.
fn warped(from: &[[f32; 3]], size: (usize, usize), at: Affine) -> Vec<[f32; 3]> {
    let (width, height) = size;
    let Some(back) = inverse(at) else {
        return from.to_vec();
    };
    let mut out = vec![[0f32; 3]; width * height];
    for y in 0..height {
        for x in 0..width {
            let [u, v] = applied(back, [x as f64 + 0.5, y as f64 + 0.5]);
            let (u, v) = (u - 0.5, v - 0.5);
            let (x0, y0) = (u.floor(), v.floor());
            let (tx, ty) = (u - x0, v - y0);
            let tap = |sx: f64, sy: f64| -> [f32; 3] {
                let cx = (sx.max(0.0) as usize).min(width - 1);
                let cy = (sy.max(0.0) as usize).min(height - 1);
                from[cy * width + cx]
            };
            let (a, b) = (tap(x0, y0), tap(x0 + 1.0, y0));
            let (c, d) = (tap(x0, y0 + 1.0), tap(x0 + 1.0, y0 + 1.0));
            let mix = |p: f32, q: f32, t: f64| p + (q - p) * t as f32;
            for channel in 0..3 {
                let top = mix(a[channel], b[channel], tx);
                let bottom = mix(c[channel], d[channel], tx);
                out[y * width + x][channel] = mix(top, bottom, ty);
            }
        }
    }
    out
}

/// One frame of the burst, in linear light.
fn crowd_frame(size: (usize, usize), frame: usize) -> Vec<[f32; 3]> {
    let (width, height) = size;
    // A ground that is not flat: §3.3 reads a difference against the gradient beside it, and a
    // perfectly flat background divides by nothing at all.
    let mut out = vec![[0f32; 3]; width * height];
    for y in 0..height {
        for x in 0..width {
            let ramp = 0.86 + 0.22 * (x as f32 / width as f32) + 0.10 * (y as f32 / height as f32);
            let level = GREY * 0.55 * ramp;
            out[y * width + x] = [level, level * 0.98, level * 1.06];
        }
    }

    let camera = camera_motion(frame, size);
    // Back to front, so the front row occludes the one behind it rather than showing through.
    for figure in crowd(size) {
        // What the whole figure does: its resting lean about its middle, this frame's sway about
        // its feet, and its planted affine if it is a mover.
        let feet = [figure.centre[0], figure.centre[1] + figure.torso[1] / 2.0];
        let body = compose(
            about(feet, sway(figure.seed, frame)),
            about(figure.centre, figure.shape),
        );
        let body = match figure.moves {
            None => body,
            Some(which) => compose(body, about(figure.centre, mover_motion(which, frame))),
        };

        let at = |centre: [f64; 2], span: [f64; 2]| {
            compose(
                [1.0, 0.0, 0.0, 1.0, centre[0], centre[1]],
                [span[0], 0.0, 0.0, span[1], 0.0, 0.0],
            )
        };
        draw(
            &mut out,
            size,
            compose(camera, compose(body, at(figure.centre, figure.torso))),
            figure.colour,
        );
        let neck = [figure.centre[0], figure.centre[1] - figure.neck];
        let head = compose(
            about(neck, nod(figure.seed, frame)),
            at(neck, [figure.head, figure.head]),
        );
        draw(
            &mut out,
            size,
            compose(camera, compose(body, head)),
            figure.skin,
        );
    }
    // Last, over everything: the meter is the camera's, so it moves the whole frame including the
    // ground the figures stand on. Applied to the scene rather than to a header, because a header
    // that said so is exactly what `composite_solve::gains` would have taken out already.
    let stop = metering(frame);
    for pixel in &mut out {
        for channel in pixel {
            *channel *= stop;
        }
    }
    out
}

/// One quad onto the frame, antialiased, by inverse-mapping each supersample back into the unit
/// square it came from.
///
/// Coverage rather than a hard test, because the edge is the measurement: a hard edge would put the
/// fixture's own quantisation into every gradient §3.3 divides by.
fn draw(out: &mut [[f32; 3]], size: (usize, usize), at: Affine, colour: [f32; 3]) {
    let (width, height) = size;
    let Some(back) = inverse(at) else { return };
    let corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(|p| applied(at, p));
    let low = |axis: usize| corners.iter().fold(f64::INFINITY, |m, c| m.min(c[axis]));
    let high = |axis: usize| {
        corners
            .iter()
            .fold(f64::NEG_INFINITY, |m, c| m.max(c[axis]))
    };
    let x0 = (low(0).floor().max(0.0)) as usize;
    let y0 = (low(1).floor().max(0.0)) as usize;
    let x1 = ((high(0).ceil() + 1.0).min(width as f64)) as usize;
    let y1 = ((high(1).ceil() + 1.0).min(height as f64)) as usize;

    let step = 1.0 / EDGE_SAMPLES as f64;
    let taps = (EDGE_SAMPLES * EDGE_SAMPLES) as f64;
    for y in y0..y1 {
        for x in x0..x1 {
            let mut inside = 0.0f64;
            for sy in 0..EDGE_SAMPLES {
                for sx in 0..EDGE_SAMPLES {
                    let p = [
                        x as f64 + (sx as f64 + 0.5) * step,
                        y as f64 + (sy as f64 + 0.5) * step,
                    ];
                    let u = applied(back, p);
                    if u[0] >= -0.5 && u[0] <= 0.5 && u[1] >= -0.5 && u[1] <= 0.5 {
                        inside += 1.0;
                    }
                }
            }
            if inside == 0.0 {
                continue;
            }
            let coverage = (inside / taps) as f32;
            let held = &mut out[y * width + x];
            for channel in 0..3 {
                held[channel] = held[channel] * (1.0 - coverage) + colour[channel] * coverage;
            }
        }
    }
}

/// The scene as the camera's own rendering of it, which is the plane an alignment searches.
fn write_preview(scene: &[[f32; 3]], width: usize, height: usize, to: &str) {
    let data: Vec<u8> = scene.iter().flat_map(|rgb| (*rgb).map(srgb8)).collect();
    let picture = rawshim::rgb::RgbRef {
        width,
        height,
        data: &data,
    };
    let jpeg = rawshim::jpeg::encode(picture, 95).expect("the preview encodes");
    std::fs::write(to, jpeg).expect("a writable path");
    eprintln!("wrote {to}");
}

/// One panel's colour at a point of its unit square. `size` is the panel in pixels, which is what
/// lets a pattern be specified in cycles per pixel rather than in cycles per panel.
fn panel_at(panel: usize, u: f64, v: f64, size: (usize, usize)) -> [f32; 3] {
    match panel {
        0 => grey(zone_plate(u, v, size)),
        1 => grey(siemens_star(u, v)),
        2 => grey(gratings(u, v, size)),
        3 => grey(flats(u, v)),
        4 => colour_stripes(u, v, size),
        5 => twigs(u, v, size),
        6 => gate_spill(u, v, size),
        _ => chroma_star(u, v),
    }
}

/// Chroma at a fixed luminance, so a filter that touches it cannot hide behind a brightness change.
///
/// The split is the CFA's own achromatic combination - a quarter red, half green, a quarter blue -
/// so `swing` moves the two chroma carriers of the mosaic and leaves the baseband exactly alone.
fn chroma_only(swing: f64) -> [f32; 3] {
    [
        (f64::from(GREY) + swing) as f32,
        GREY,
        (f64::from(GREY) - swing) as f32,
    ]
}

/// **How far the gate spills, read straight off the picture.**
///
/// A bed of genuine fine chroma - period six pixels, well inside the quarter-cycle limit red and
/// blue are sampled at, so it is chroma the reconstruction is entitled to keep - punched with a
/// sparse grid of small grey squares at the pixel grid's own limit. Each square manufactures false
/// colour and opens the gate; the bed around it did not and should not.
///
/// So the desaturated ring around each square is the gate's spatial reach and nothing else, and its
/// radius is `(w-1)/2`. That is the cost of a wider window made visible: measuring the artefact
/// alone would make every increase of `w` look free.
fn gate_spill(u: f64, v: f64, size: (usize, usize)) -> [f32; 3] {
    let (x, y) = (u * size.0 as f64, v * size.1 as f64);
    let square = 8.0;
    let pitch = 64.0;
    let inside = |t: f64| (t % pitch) < square;
    if inside(x) && inside(y) {
        // Two-pixel period on both axes: the finest thing the grid carries, and above the limit of
        // red and blue, so every scrap of colour it comes back with was invented.
        let checker = ((x.floor() + y.floor()) as i64 & 1) == 0;
        return grey(f64::from(GREY) + f64::from(SWING) * if checker { 1.0 } else { -1.0 });
    }
    let bed = (std::f64::consts::TAU * x / 6.0).cos() * (std::f64::consts::TAU * y / 6.0).cos();
    chroma_only(f64::from(SWING) * bed)
}

/// The star again, in colour at a flat luminance: every angle, frequency rising to the centre.
///
/// Its whole area is chroma the scene really has, so wherever the gate opens on it the gate is
/// wrong - §8.2.2's failure mode, which is a step's energy at the carriers, drawn as a picture.
fn chroma_star(u: f64, v: f64) -> [f32; 3] {
    let (dx, dy) = (u - 0.5, v - 0.5);
    let spokes = 96.0;
    chroma_only(f64::from(SWING) * (spokes * dy.atan2(dx)).cos())
}

fn grey(level: f64) -> [f32; 3] {
    [level as f32; 3]
}

/// Frequency rising with radius, to just past the pixel grid's own limit at the corners.
///
/// Grey on purpose: every channel carries the same signal, so any colour in the render is the
/// reconstruction's and nothing else's.
fn zone_plate(u: f64, v: f64, size: (usize, usize)) -> f64 {
    let short = size.0.min(size.1) as f64;
    let (dx, dy) = ((u - 0.5) * size.0 as f64, (v - 0.5) * size.1 as f64);
    let radius = (dx * dx + dy * dy).sqrt();
    // Instantaneous frequency is the phase's derivative: `pi.a.r^2` differentiates to `a.r` cycles
    // per pixel, so `a` set from the half-diagonal puts Nyquist a little inside the corner.
    let slope = 0.5 / (short * 0.45);
    let phase = std::f64::consts::PI * slope * radius * radius;
    f64::from(GREY) + f64::from(SWING) * phase.cos()
}

/// Every angle, with the frequency rising towards the centre. What a fan of twigs is, abstracted.
fn siemens_star(u: f64, v: f64) -> f64 {
    let (dx, dy) = (u - 0.5, v - 0.5);
    let spokes = 96.0;
    f64::from(GREY) + f64::from(SWING) * (spokes * dy.atan2(dx)).cos()
}

/// Six bands, each one frequency at one angle. A beat here has a period a reader can measure, which
/// a chirp's does not.
fn gratings(u: f64, v: f64, size: (usize, usize)) -> f64 {
    let bands = [
        (2.0, 0.0),
        (3.0, 0.0),
        (4.0, 45.0),
        (2.5, 90.0),
        (6.0, 22.5),
        (2.0, 45.0),
    ];
    let band = ((v * bands.len() as f64) as usize).min(bands.len() - 1);
    let (period, degrees) = bands[band];
    let angle = degrees * std::f64::consts::PI / 180.0;
    let (x, y) = (u * size.0 as f64, v * size.1 as f64);
    let along = x * angle.cos() + y * angle.sin();
    f64::from(GREY) + f64::from(SWING) * (2.0 * std::f64::consts::PI * along / period).cos()
}

/// Nine levels of nothing at all. A pipeline that puts a pattern here invented it.
fn flats(u: f64, v: f64) -> f64 {
    let patch = ((u * 3.0) as usize).min(2) + 3 * ((v * 3.0) as usize).min(2);
    // Two stops either side of mid grey, so a level-dependent artefact shows which levels.
    f64::from(GREY) * 2f64.powf(patch as f64 * 0.5 - 2.0)
}

/// Nearly-flat luma carried by chroma alone, on a slant so no stripe lands on the CFA's own grid.
fn colour_stripes(u: f64, v: f64, size: (usize, usize)) -> [f32; 3] {
    let angle = 7.0 * std::f64::consts::PI / 180.0;
    let (x, y) = (u * size.0 as f64, v * size.1 as f64);
    let along = x * angle.cos() + y * angle.sin();
    // Three periods down the panel, coarse to fine, so the failure has a scale.
    let period = [12.0, 6.0, 3.0][((v * 3.0) as usize).min(2)];
    let wave = (2.0 * std::f64::consts::PI * along / period).cos();
    let level = f64::from(GREY);
    // Red up and blue down together: the luma barely moves and the chroma swings the whole way.
    [
        (level * (1.0 + 0.6 * wave)) as f32,
        level as f32,
        (level * (1.0 - 0.6 * wave)) as f32,
    ]
}

/// The picture that provoked this: thin dark lines fanned across a smooth sky.
///
/// Widths from one pixel to four, at every angle, on a gradient with no detail of its own - so
/// anything textured in the sky is the pipeline's, and anything crosshatched on a line is what a
/// reader would call aliasing.
fn twigs(u: f64, v: f64, size: (usize, usize)) -> [f32; 3] {
    let sky = f64::from(GREY) * (1.2 - 0.35 * v);
    let mut colour = [(sky * 0.80) as f32, (sky * 0.92) as f32, sky as f32];

    let (x, y) = (u * size.0 as f64, v * size.1 as f64);
    // Radiating from below the panel, which is what puts every angle in one picture and keeps the
    // lines from ever running parallel to the sampling grid for long.
    let (ox, oy) = (size.0 as f64 * 0.5, size.1 as f64 * 1.15);
    let (dx, dy) = (x - ox, y - oy);
    let radius = (dx * dx + dy * dy).sqrt().max(1.0);
    let theta = dy.atan2(dx);
    for branch in 0..24 {
        let spread = 0.9;
        let aim = -std::f64::consts::FRAC_PI_2 + spread * (branch as f64 / 23.0 - 0.5) * 2.0;
        // Widths cycle one to four pixels, so each angle is present at each thickness.
        let width = 1.0 + (branch % 4) as f64;
        let across = (theta - aim).abs() * radius;
        if across < width * 0.5 {
            // Dark and warm against a cool sky, as bark is.
            let bark = [0.30f32, 0.17, 0.15];
            for channel in 0..3 {
                colour[channel] = f64::from(GREY) as f32 * bark[channel];
            }
        }
    }
    colour
}

/// The scene sampled through a Bayer filter, as sensor levels.
fn mosaic(scene: &[[f32; 3]], width: usize, height: usize, args: &Args) -> Vec<u16> {
    // RGGB, matching the camera above. The 2x2 read as [top-left, top-right, bottom-left,
    // bottom-right].
    let colour_at = |row: usize, col: usize| [0usize, 1, 1, 2][(row & 1) * 2 + (col & 1)];
    let mut random = 0x2545_f491_4f6c_dd1du64;
    let mut out = vec![0u16; width * height];
    for row in 0..height {
        for col in 0..width {
            let channel = colour_at(row, col);
            let mut value = f64::from(scene[row * width + col][channel]);
            if channel == 1 {
                // One green up and the other down, so the pair's mean is the scene's and only the
                // difference between them is injected.
                let sign = if row & 1 == 0 { 1.0 } else { -1.0 };
                value *= 1.0 + sign * f64::from(args.imbalance) * 0.5;
            }
            if args.noise > 0.0 {
                let well = 20_000.0 / f64::from(args.noise) / f64::from(args.noise);
                value += (value.max(0.0) / well).sqrt() * gaussian(&mut random);
            }
            out[row * width + col] = (value * f64::from(WHITE)).clamp(0.0, f64::from(WHITE)) as u16;
        }
    }
    out
}

/// One standard normal, from a counter-based generator so a given size and seed produce the same
/// frame on every machine.
fn gaussian(state: &mut u64) -> f64 {
    let mut next = || {
        *state ^= *state << 13;
        *state ^= *state >> 7;
        *state ^= *state << 17;
        (*state >> 11) as f64 / (1u64 << 53) as f64
    };
    let (first, second) = (next().max(f64::MIN_POSITIVE), next());
    (-2.0 * first.ln()).sqrt() * (2.0 * std::f64::consts::PI * second).cos()
}
