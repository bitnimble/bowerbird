//! §5 on the device: the weight fields, the masked gather, the two bands, and a window rendered
//! from a recipe.
mod support;

use rawshim::assembly::Drawing;
use rawshim::assembly_blend::{Banding, NOT_REACHED};
use rawshim::assembly_render::{LAMBDA_SPLIT, Lowpass, lowpass};
use rawshim::assembly_tiles::W_MAX;
use rawshim::assembly_weight::{W_HIGH_PX, Weights, slots_of, weights};
use rawshim::composite_tile::{
    Blending, CompositeRequest, From, Layer, Mask, SourceFile, Weight, layers_of,
};
use rawshim::composition::{Composition, LensSpec, Projection, SourceSpec};
use rawshim::galosh::Detail;
use rawshim::image::Strengths;
use rawshim::light::{Gain, Light, SceneNits};
use rawshim::px::{Composite, Rect, Share, Span};
use rawshim::tone;
use support::{Rig, floats_of, rig, u32s_of, upload_f32};

/// A drawing over `sources` identical frames of `size`, with one square tile in the middle picking
/// `pick`. Identical sources, so the canvas is the frame and every source covers all of it -
/// which is what lets a test say what a weight should be without an alignment in the way.
fn one_tile(sources: usize, size: (usize, usize), pick: usize, corridor: f32) -> Drawing {
    let mut spec = Composition::of_one([size.0, size.1], LensSpec::none());
    let one = spec.sources[0].clone();
    spec.sources.extend(std::iter::repeat_n(one, sources - 1));
    let mut drawing = Drawing {
        spec,
        vertices: Vec::new(),
        tiles: Vec::new(),
        pick: Vec::new(),
        base: 0,
        corridor: Vec::new(),
        warp: Vec::new(),
        gain: Vec::new(),
        feather: W_MAX.raw() as f32,
    };
    let (w, h) = (size.0 as f32, size.1 as f32);
    with_tile(
        &mut drawing,
        [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75]].map(|[x, y]| [w * x, h * y]),
        pick,
        corridor,
    );
    drawing
}

/// `drawing` with a tile over `corners` appended, picking `pick` unwarped and at its own light.
fn with_tile(drawing: &mut Drawing, corners: [[f32; 2]; 4], pick: usize, corridor: f32) {
    let first = drawing.vertices.len() as u32;
    drawing.vertices.extend(corners);
    drawing.tiles.push((first..first + 4).collect());
    drawing.pick.push(pick);
    drawing.corridor.push(corridor);
    drawing
        .warp
        .push(rawshim::composition::no_warp().map(|at| at as f32));
    drawing.gain.push(Gain::ONE);
}

fn read(rig: &Rig, w: &Weights) -> (Vec<f32>, Vec<f32>) {
    (
        floats_of(rig, &w.signed, w.pixels * w.slots),
        floats_of(rig, &w.width, w.pixels),
    )
}

/// `seam_weight.slang`'s `smooth_between`, which is §5.2's `smoothstep(-W, W, x)`.
fn smoothstep(edge: f32, x: f32) -> f32 {
    let t = ((x + edge) / (2.0 * edge)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

const SIZE: (usize, usize) = (128, 128);

/// The sign, which is the whole of which frame a pixel takes: positive inside the union, negative
/// outside it, and the magnitude the distance to the loop in render pixels.
#[test]
fn the_distance_is_signed_by_which_union_holds_the_pixel() {
    let Some(rig) = rig() else { return };
    let recipe = one_tile(2, SIZE, 1, 0.1);
    let window = rawshim::px::Rect::exact(0, 0, SIZE.0, SIZE.1);
    let w = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let (signed, _) = read(&rig, &w);
    let at = |x: usize, y: usize, slot: usize| signed[(y * SIZE.0 + x) * w.slots + slot];

    // Slot 0 is the base, slot 1 the pick (`sources_used` puts the base first).
    assert!(
        at(64, 64, 1) > 25.0,
        "the tile's middle is deep inside the pick's union"
    );
    assert!(at(64, 64, 0) < -25.0, "and as deep outside the base's");
    assert!(at(4, 4, 0) > 25.0, "the corner is deep inside the base's");
    assert!(at(4, 4, 1) < -25.0, "and outside the pick's");
    // On the loop: 32 is `w * 0.25`.
    assert!(
        at(32, 64, 1).abs() < 1.5,
        "the seam reads zero, not a pixel and a half"
    );
}

/// The whole of the warp's plumbing, in the one place it could silently do nothing: every pixel is
/// told which tile the gather reads it through, so §3.7a varies *inside* one pass over the window.
///
/// **One slot a source, however many corrections its tiles make, and the count is what says so.**
/// Which tile's correction a pixel is read through is a field inside the one gather.
#[test]
fn every_pixel_names_the_tile_its_source_is_read_through() {
    let Some(rig) = rig() else { return };
    let mut recipe = one_tile(2, SIZE, 1, 0.1);
    // A shear as well as a shift, this being the term that exists to be carried: a rotation of the
    // source could have stood in for the shift alone.
    recipe.warp = vec![[1.0, 0.014, 0.0, 1.0, 6.0, -2.0]];

    let window = rawshim::px::Rect::exact(0, 0, SIZE.0, SIZE.1);
    let w = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    assert_eq!(w.slots, 2, "the base and the frame its one tile picked");

    let slots = slots_of(&recipe);
    let pick = slots[1].expect("the picked frame has a slot") as usize;
    let base = slots[0].expect("the base has a slot") as usize;
    let tile_of = u32s_of(&rig, &w.tile_of, w.pixels * w.slots);
    let at = |x: usize, y: usize, slot: usize| tile_of[(y * SIZE.0 + x) * w.slots + slot];

    assert_eq!(at(64, 64, pick), 0, "the tile's middle is read through it");
    // **The corridor outside a tile is still read through it**, which is the half that needs the
    // flood: a source blended in across a seam is being blended in *from* its own tile, so its
    // content has to arrive where that tile's correction puts it and not where the frame sat.
    assert_eq!(
        at(4, 4, pick),
        0,
        "the picked frame is read through its own tile wherever it is read at all",
    );
    assert_eq!(
        at(64, 64, base),
        rawshim::assembly_weight::NO_TILE,
        "the base has no tile here, so it takes the ground's own geometry",
    );
}

/// §5.2's symmetry, which is the reason `W` is a field: two unions meeting have distances that
/// are exact negatives and `smoothstep` is symmetric, so the pair sums to one at the seam - **only
/// if `W` agrees on both sides**. One field for every source is what makes it agree.
#[test]
fn two_unions_meeting_sum_to_one_across_the_seam() {
    let Some(rig) = rig() else { return };
    let recipe = one_tile(2, SIZE, 1, 0.1);
    let window = rawshim::px::Rect::exact(0, 0, SIZE.0, SIZE.1);
    let w = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let (signed, width) = read(&rig, &w);

    // Across the tile's left edge, through the feather and out the other side.
    for y in [40usize, 64, 88] {
        for x in 24..41 {
            let p = y * SIZE.0 + x;
            let (a, b) = (signed[p * w.slots], signed[p * w.slots + 1]);
            assert!(
                (a + b).abs() < 0.05,
                "at {x},{y} the two distances are {a} and {b}"
            );
            let sum = smoothstep(width[p], a) + smoothstep(width[p], b);
            assert!(
                (sum - 1.0).abs() < 1e-3,
                "at {x},{y} the weights sum to {sum}"
            );
        }
    }
}

/// Wide enough that either feather below clears the high band, which is what lets the rows be
/// different answers: a feather is a share of the long edge and `W_HIGH_PX` is pixels, so under a
/// 200px render the ceiling is *under* the floor and every corridor reads the high band.
const WIDTH_SIZE: (usize, usize) = (512, 512);

/// §5.2's `W`, capped and floored: never wider than the recipe's feather of the long edge, never
/// narrower than the high band, and half the corridor in between.
#[test]
fn the_width_is_half_the_corridor_between_its_two_bounds() {
    let Some(rig) = rig() else { return };
    let long = WIDTH_SIZE.0.max(WIDTH_SIZE.1) as f32;
    let feather = W_MAX.raw() as f32;
    for (corridor, feather, want) in [
        // A corridor of a hundredth of the long edge: half of it is under the feather, so it is used.
        (0.01f32, feather, 0.005 * long),
        // Far over: clamped at the recipe's feather, whichever it names.
        (0.5, feather, feather * long),
        (0.5, 0.006, 0.006 * long),
        // Far under: clamped up at the high band, so the tile takes the high band alone.
        (0.0001, feather, W_HIGH_PX),
    ] {
        let recipe = Drawing {
            feather,
            ..one_tile(2, WIDTH_SIZE, 1, corridor)
        };
        let window = rawshim::px::Rect::exact(0, 0, WIDTH_SIZE.0, WIDTH_SIZE.1);
        let w = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
        let (_, width) = read(&rig, &w);
        // The middle of the tile's left edge, which is where the seam is.
        let on_the_seam = width[(WIDTH_SIZE.1 / 2) * WIDTH_SIZE.0 + WIDTH_SIZE.0 / 4];
        assert!(
            (on_the_seam - want).abs() < 0.05,
            "a corridor of {corridor} gives a width of {on_the_seam}, not {want}",
        );
    }
}

/// §2.4's painter's stack: a hand-drawn tile is last in the list and is on top of whatever it
/// overlaps, so a pixel in both belongs to the later one.
#[test]
fn a_later_tile_owns_the_ground_it_overlaps() {
    let Some(rig) = rig() else { return };
    let mut recipe = one_tile(3, SIZE, 1, 0.1);
    // A second tile over the top-left quarter of the first, picking source 2.
    let (w, h) = (SIZE.0 as f32, SIZE.1 as f32);
    with_tile(
        &mut recipe,
        [[0.25, 0.25], [0.50, 0.25], [0.50, 0.50], [0.25, 0.50]].map(|[x, y]| [w * x, h * y]),
        2,
        0.1,
    );

    let window = rawshim::px::Rect::exact(0, 0, SIZE.0, SIZE.1);
    let weights_ = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let (signed, _) = read(&rig, &weights_);
    let slots = weights_.slots;
    let at = |x: usize, y: usize, slot: usize| signed[(y * SIZE.0 + x) * slots + slot];
    let of = slots_of(&recipe);
    let (first, second) = (of[1].unwrap() as usize, of[2].unwrap() as usize);
    assert!(
        at(40, 40, second) > 0.0,
        "the overlap belongs to the later tile"
    );
    assert!(at(40, 40, first) < 0.0, "not to the one under it");
    assert!(
        at(72, 72, first) > 0.0,
        "and the rest of the first tile is still its own"
    );
}

/// A window that does not start at the origin reads the canvas's own field: the polygons are
/// tested where they are on the canvas rather than where the window starts, so the same pixel
/// reads the same distance whichever window it arrived in.
///
/// **The window straddles the tile's left edge**, at x = 32, because that is the only place the
/// claim can be tested. A window with no owner change inside it seeds nothing and every pixel of it
/// saturates: the sign is still right, and every weight is still right, since saturating is only
/// reachable further than `W_MAX` from a seam and `smoothstep` is 1 by then - but the *distance* is
/// not the canvas's. That ceiling is `weights`' own `ponytail:` note.
#[test]
fn a_window_reads_the_same_field_as_the_whole_canvas() {
    let Some(rig) = rig() else { return };
    let recipe = one_tile(2, SIZE, 1, 0.1);
    let (left, top, side) = (16usize, 48usize, 32usize);
    let whole = pollster::block_on(weights(
        rig.gpu,
        &recipe,
        rawshim::px::Rect::exact(0, 0, SIZE.0, SIZE.1),
        1.0,
    ));
    let part = pollster::block_on(weights(
        rig.gpu,
        &recipe,
        rawshim::px::Rect::exact(left, top, side, side),
        1.0,
    ));
    let (a, _) = read(&rig, &whole);
    let (b, _) = read(&rig, &part);
    for y in 0..side {
        for x in 0..side {
            let there = ((top + y) * SIZE.0 + left + x) * whole.slots + 1;
            let here = (y * side + x) * part.slots + 1;
            assert!(
                (a[there] - b[here]).abs() < 0.05,
                "at {x},{y} the window reads {} and the canvas {}",
                b[here],
                a[there],
            );
        }
    }
}

// --- Task 7: the crop-wide lowpass (§5.2) ---

/// Large enough that the split's own wavelength - a share of the long edge - lands on a whole
/// number of pixels. At the 128px `SIZE` above it would be 2px, and "a quarter of it" is not a
/// thing a pixel grid can hold at all.
const BAND_SIZE: (usize, usize) = (1024, 1024);

/// Writes a greyscale PNG `composite_tile` can decode as one source, gamma 1.0 so the codes this
/// writes are read back as light directly rather than through sRGB's curve.
fn write_png(
    dir: &std::path::Path,
    name: &str,
    size: (usize, usize),
    pixel: impl Fn(usize, usize) -> u8,
) -> String {
    std::fs::create_dir_all(dir).expect("a fixture directory");
    // Keyed by the size as well as the name, because two tests asking for "the same" fixture at two
    // canvases are asking for two files - and written through a rename, because the suite runs its
    // tests in parallel and a reader that opens a fixture another test is part way through writing
    // fails as "could not be decoded".
    let (w, h) = size;
    let path = dir.join(format!("{w}x{h}-{name}"));
    let scratch = path.with_extension(format!("{}.tmp", next_scratch()));
    let mut data = vec![0u8; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let v = pixel(x, y);
            let at = (y * w + x) * 3;
            data[at] = v;
            data[at + 1] = v;
            data[at + 2] = v;
        }
    }
    let file = std::fs::File::create(&scratch).expect("a fixture is writable");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w as u32, h as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_source_gamma(png::ScaledFloat::new(1.0));
    let mut writer = encoder.write_header().expect("a png header");
    writer.write_image_data(&data).expect("a png body");
    drop(writer);
    std::fs::rename(&scratch, &path).expect("a fixture lands whole");
    path.to_string_lossy().into_owned()
}

fn next_scratch() -> usize {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// `composite_tile::prepared`'s own defaults for a source nothing has measured yet - no sharpen,
/// no defringe, no dust - the same ones `composite_align`'s own composite test uses.
fn asking<'a>(
    _spec: &Composition,
    paths: &'a [String],
    window: Rect<Composite>,
) -> CompositeRequest<'a> {
    let files: &'a [SourceFile<'a>] = Box::leak(
        paths
            .iter()
            .map(|path| SourceFile {
                path,
                analysis: None,
            })
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    CompositeRequest {
        window,
        parts: &[],
        scale: 1.0,
        white_quantile: 0.99,
        levels: None,
        reference_white_nits: Light::exactly(203.0),
        strengths: Strengths {
            sharpen: 0.0,
            defringe: 0.0,
        },
        detail: Detail::at(0.0, 0.0),
        sources: files,
        from: From::Original,
        weight: Weight::Feather,
    }
}

fn whole(size: (usize, usize)) -> Rect<Composite> {
    Rect::exact(0, 0, size.0, size.1)
}

/// `support::code_of_light`'s inverse, off the same PQ anchor: light 1 is PQ's own ceiling.
fn light_of_code(code: u16) -> f32 {
    let ceiling = tone::pq_inv::<SceneNits>(Light::measured(1.0));
    let nits: Light<SceneNits> =
        tone::pq_inv(Light::measured(f64::from(code) / f64::from(u16::MAX)));
    (nits.raw() / ceiling.raw()) as f32
}

/// The darkest and brightest light a band holds, over its whole grid.
///
/// A pair rather than the darkest alone, because the darkest is only meaningful against the
/// content: light 1 is PQ's ceiling, so diffuse white is about 0.02 of it and any absolute floor
/// would be a number about the coding rather than about the picture.
fn extremes(_rig: &Rig, held: &Lowpass, slot: usize) -> (f32, f32) {
    let codes = pollster::block_on(held.bands[slot].host()).expect("a readable band");
    (0..held.size.0 * held.size.1)
        .map(|p| light_of_code(codes[p * 3]))
        .fold((f32::INFINITY, 0.0f32), |(lo, hi), l| {
            (lo.min(l), hi.max(l))
        })
}

/// Two identical sources at `size`: the canvas is the frame and both cover all of it, which is
/// what `one_tile` already builds - reused here rather than a second geometry of the same shape.
fn two_identical_sources(size: (usize, usize)) -> (Composition, Vec<String>) {
    let spec = one_tile(2, size, 0, 0.1).spec;
    let dir = std::env::temp_dir().join("bowerbird-lowpass-identical");
    // Smooth texture, not flat: a broken crop or grid still has something to disagree about.
    let content = |x: usize, y: usize| -> u8 {
        (128.0 + 40.0 * (std::f32::consts::TAU * (x + y) as f32 / 64.0).sin()) as u8
    };
    let paths = (0..2)
        .map(|i| write_png(&dir, &format!("id{i}.png"), size, content))
        .collect();
    (spec, paths)
}

/// Two sources, each narrower than `size`'s canvas by a sixteenth on every side, so the strip
/// outside both is ground no source reaches at all.
fn two_sources_narrower_than_the_canvas(size: (usize, usize)) -> (Composition, Vec<String>) {
    let margin = size.0 / 16;
    let source_size = (size.0 - 2 * margin, size.1 - 2 * margin);
    const FOCAL: f64 = 4096.0;
    let source = || SourceSpec {
        photo_id: String::new(),
        size: [source_size.0, source_size.1],
        rotation: [1.0, 0.0, 0.0, 0.0],
        focal: FOCAL,
        lens: LensSpec::none(),
        gain: 1.0,
        warp: rawshim::composition::no_warp(),
    };
    let spec = Composition {
        version: rawshim::composition::VERSION,
        sources: vec![source(), source()],
        projection: Projection::Rectilinear,
        canvas: [size.0, size.1],
        centre: [size.0 as f64 / 2.0, size.1 as f64 / 2.0],
        radians_per_pixel: 1.0 / FOCAL,
        crop: [0.0, 0.0, 1.0, 1.0],
        reference: 0,
        seam_rms_px: None,
    };
    let dir = std::env::temp_dir().join("bowerbird-lowpass-narrow");
    let content = |x: usize, y: usize| -> u8 {
        (128.0 + 40.0 * (std::f32::consts::TAU * (x + y) as f32 / 64.0).sin()) as u8
    };
    let paths = (0..2)
        .map(|i| write_png(&dir, &format!("narrow{i}.png"), source_size, content))
        .collect();
    (spec, paths)
}

/// `share` of a canvas `size` long, in its pixels.
fn wavelength(share: Share, size: (usize, usize)) -> f32 {
    share.across(Span::<Composite>::exact(size.0.max(size.1))).raw() as f32
}

/// One source at `size`, banded across x with a sine four times the split's own wavelength and
/// one a quarter of it, both stated in canvas pixels.
fn banded_source(size: (usize, usize), lambda: Share) -> (Composition, Vec<String>) {
    let split = wavelength(lambda, size);
    let (coarse_wavelength, fine_wavelength) = (4.0 * split, split / 4.0);
    let spec = one_tile(1, size, 0, 0.1).spec;
    let dir = std::env::temp_dir().join("bowerbird-lowpass-banded");
    let content = |x: usize, _y: usize| -> u8 {
        let phase = |wavelength: f32| (std::f32::consts::TAU * x as f32 / wavelength).sin();
        let light = 0.35 + 0.12 * phase(coarse_wavelength) + 0.12 * phase(fine_wavelength);
        (light.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    let paths = vec![write_png(&dir, "banded.png", size, content)];
    (spec, paths)
}

/// The amplitude of a sine at `wavelength` canvas pixels, correlated out of a row of light
/// samples the two components are superposed in, and what is left once that sine is subtracted
/// back out - the RMS of everything a fit at `wavelength` alone does not explain.
///
/// **The residual, not a second correlation, is what the fine component is measured by.** The
/// grid this runs on samples every `cell` canvas pixels - the split's own wavelength - so a
/// signal a quarter of that wavelength is far below the grid's own Nyquist limit and a basis
/// function at its exact frequency is unmeasurable there: evaluated only at the grid's sparse
/// points it aliases to some other apparent frequency, and correlating against the frequency it
/// was *written* at reads whatever that aliasing happened to produce rather than what survived.
/// The residual after the coarse fit has no such basis to alias against - it is just "how far
/// from a pure `coarse_wavelength` sine is this row", which a properly built lowpass answers
/// "barely" and a leaking fine component answers "measurably".
fn fit_and_residual(row: &[(f32, f32)], wavelength: f32) -> (f32, f32) {
    let n = row.len() as f32;
    let mean = row.iter().map(|&(_, l)| l).sum::<f32>() / n;
    let (mut sin_sum, mut cos_sum) = (0.0f32, 0.0f32);
    for &(x, light) in row {
        let phase = std::f32::consts::TAU * x / wavelength;
        sin_sum += (light - mean) * phase.sin();
        cos_sum += (light - mean) * phase.cos();
    }
    let (a, b) = (2.0 * sin_sum / n, 2.0 * cos_sum / n);
    let amplitude = (a * a + b * b).sqrt();
    let residual_sq: f32 = row
        .iter()
        .map(|&(x, light)| {
            let phase = std::f32::consts::TAU * x / wavelength;
            let fit = mean + a * phase.sin() + b * phase.cos();
            (light - fit).powi(2)
        })
        .sum();
    (amplitude, (residual_sq / n).sqrt())
}

/// A row of `(canvas x, light)` off one source's own layer, decoded at native resolution: the
/// scale the fine wavelength is actually resolvable at, which the final grid is not.
fn native_row(spec: &Composition, paths: &[String], size: (usize, usize)) -> Vec<(f32, f32)> {
    let mut layer: Option<rawshim::resident::Resident> = None;
    pollster::block_on(layers_of(
        spec,
        &asking(spec, paths, whole(size)),
        |_, taken, _| {
            let Layer { rgb, weight } = taken;
            drop(weight);
            layer = Some(rgb);
            Ok(())
        },
    ))
    .expect("a native decode");
    let native = pollster::block_on(layer.take().expect("one source decoded").into_host())
        .expect("a readable layer");
    let y = size.1 / 2;
    (0..size.0)
        .map(|x| (x as f32 + 0.5, light_of_code(native[(y * size.0 + x) * 3])))
        .collect()
}

/// A row of `(canvas x, light)` off the lowpass's own grid.
fn final_row(held: &Lowpass, slot: usize) -> Vec<(f32, f32)> {
    let codes = pollster::block_on(held.bands[slot].host()).expect("a readable band");
    let (left, _, w, _) = held.crop.raw();
    let cell = w as f32 / held.size.0 as f32;
    let y = held.size.1 / 2;
    (0..held.size.0)
        .map(|gx| {
            (
                left as f32 + (gx as f32 + 0.5) * cell,
                light_of_code(codes[(y * held.size.0 + gx) * 3]),
            )
        })
        .collect()
}

/// How much of each of [`banded_source`]'s two components survives the lowpass, against how much
/// of it is in the source to begin with - a ratio, so the composite's own exposure normalisation
/// (a scale common to every frequency) cancels out of it rather than needing to be predicted.
fn band_amplitudes(spec: &Composition, paths: &[String], held: &Lowpass) -> (f32, f32) {
    let split = wavelength(LAMBDA_SPLIT, BAND_SIZE);
    let (coarse_wavelength, fine_wavelength) = (4.0 * split, split / 4.0);

    let native = native_row(spec, paths, BAND_SIZE);
    let (native_coarse, _) = fit_and_residual(&native, coarse_wavelength);
    let (native_fine, _) = fit_and_residual(&native, fine_wavelength);

    let final_ = final_row(held, 0);
    let (final_coarse, residual) = fit_and_residual(&final_, coarse_wavelength);
    // The RMS of a pure sine of amplitude A is A / sqrt(2); the residual is compared back to an
    // amplitude on that footing, against the amplitude the fine component was actually written
    // with (measured natively, since the source's own exposure scale is not assumed).
    let leftover = residual * std::f32::consts::SQRT_2;

    (
        final_coarse / native_coarse.max(1e-6),
        leftover / native_fine.max(1e-6),
    )
}

/// What a lowpass is: the split's own wavelength survives and everything finer is gone.
#[test]
fn the_lowpass_keeps_what_is_longer_than_the_split_and_drops_what_is_finer() {
    let Some(_rig) = rig() else { return };
    let (spec, paths) = banded_source(BAND_SIZE, LAMBDA_SPLIT);
    let recipe = one_tile(1, BAND_SIZE, 0, 0.1);
    let held = pollster::block_on(lowpass(&recipe, &asking(&spec, &paths, whole(BAND_SIZE))))
        .expect("a lowpass");
    let (coarse, fine) = band_amplitudes(&spec, &paths, &held);
    assert!(
        coarse > 0.5,
        "four times the split survives at {coarse} of its amplitude"
    );
    assert!(fine < 0.1, "a quarter of it is down to {fine}");
}

/// The crop, not the canvas: every source reaches every pixel of the frames' intersection, and a
/// box mean that reached past it would pull in the black outside one source's own frame.
#[test]
fn the_lowpass_is_built_over_the_crop() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_sources_narrower_than_the_canvas(SIZE);
    let mut recipe = one_tile(2, SIZE, 1, 0.1);
    // `one_tile`'s own geometry is full-frame sources; this test's whole point is the narrower
    // ones written above, so the recipe is pointed at their composition instead.
    recipe.spec = spec.clone();
    recipe.spec.crop = [0.1, 0.1, 0.8, 0.8];
    let held = pollster::block_on(lowpass(&recipe, &asking(&spec, &paths, whole(SIZE))))
        .expect("a lowpass");
    let outside = held.crop.raw();
    assert_eq!(
        outside.0,
        (0.1 * SIZE.0 as f64).round() as usize,
        "the crop's own left"
    );
    // The source's own trough is half its crest, so a band built over the crop stays well inside a
    // quarter of it. A band that reached past the crop averages the black outside a frame into its
    // outer cells and one of them goes to nothing.
    let (darkest, brightest) = extremes(&rig, &held, 1);
    assert!(
        darkest > 0.25 * brightest,
        "the darkest cell is {darkest} against a brightest of {brightest}, so the black outside a \
         source's frame got into it",
    );
}

// --- Task 6: the gather's weight read from a mask (§5.2) ---

/// One tile taking the canvas from `left` rightwards. At `left` of zero the mask says "take this
/// source everywhere", and what is left to decide a weight is the source's own reach.
fn tile_from(
    sources: usize,
    size: (usize, usize),
    left: f32,
    pick: usize,
    corridor: f32,
) -> Drawing {
    let mut recipe = one_tile(sources, size, pick, corridor);
    let (w, h) = (size.0 as f32, size.1 as f32);
    recipe.vertices = vec![[left, 0.0], [w, 0.0], [w, h], [left, h]];
    recipe
}

/// The weight `composite_gather` wrote for one source of a masked render, over the whole window.
fn gathered_weight(
    rig: &Rig,
    spec: &Composition,
    paths: &[String],
    window: Rect<Composite>,
    fields: &Weights,
    of: &[Option<u32>],
    source: usize,
) -> Vec<f32> {
    let request = CompositeRequest {
        weight: Weight::Mask(Mask {
            signed: &fields.signed,
            tile_of: &fields.tile_of,
            warps: &fields.warps,
            tile_warps: &[],
            tile_slot: &[],
            slots: fields.slots,
            slot_of: of,
        }),
        ..asking(spec, paths, window)
    };
    weight_of(rig, spec, &request, window, source)
}

/// The same with no mask at all, which is the panorama's own path.
fn gathered_weight_unmasked(
    rig: &Rig,
    spec: &Composition,
    paths: &[String],
    window: Rect<Composite>,
    source: usize,
) -> Vec<f32> {
    weight_of(rig, spec, &asking(spec, paths, window), window, source)
}

fn weight_of(
    rig: &Rig,
    spec: &Composition,
    request: &CompositeRequest<'_>,
    window: Rect<Composite>,
    source: usize,
) -> Vec<f32> {
    let mut held: Option<rawshim::gpu::Buffer> = None;
    pollster::block_on(layers_of(spec, request, |i, layer, _| {
        let Layer { rgb, weight } = layer;
        if i == source {
            held = Some(weight);
        }
        rgb.reclaim();
        Ok(())
    }))
    .expect("the layers of a window");
    let (_, _, w, h) = window.raw();
    floats_of(rig, &held.expect("the source reached the window"), w * h)
}

/// The mask decides the weight where the source reaches, which is the whole of §5.2's first line.
#[test]
fn the_gather_takes_its_weight_from_the_mask() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_identical_sources(SIZE);
    let recipe = one_tile(2, SIZE, 1, 0.1);
    let window = Rect::exact(0, 0, SIZE.0, SIZE.1);
    let fields = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let of = slots_of(&recipe);

    let got = gathered_weight(&rig, &spec, &paths, window, &fields, &of, 1);
    let at = |x: usize, y: usize| got[y * SIZE.0 + x];
    assert!(
        at(64, 64) > 25.0,
        "deep inside the tile the mask's own distance came through"
    );
    assert!(at(4, 4) < -25.0, "and outside it, the negative one");
    // Not the feather: `FEATHER_POWER` would put the frame's own centre at 1.0 and its edge near 0.
    assert!(
        at(64, 64) != 1.0,
        "the panorama's feather is not what was written"
    );

    // The base's own slot, so a mask indexed without `mask_slot` reads the same sign for both.
    let base = gathered_weight(&rig, &spec, &paths, window, &fields, &of, 0);
    assert!(
        base[64 * SIZE.0 + 64] < -25.0,
        "the base is as deep outside the tile as the pick is in"
    );
}

/// **The other site.** A pixel the source's own frame does not cover is weightless whatever the
/// mask says - and `0.0` is not weightless, it is a pixel exactly on the seam, which is half
/// weight. So the sentinel has to be written at both places the shader decides a weight.
#[test]
fn a_pixel_the_source_never_reached_is_not_a_pixel_on_the_seam() {
    let Some(rig) = rig() else { return };
    // A canvas wider than the sources, so the right-hand strip is ground neither frame covers.
    let (spec, paths) = two_sources_narrower_than_the_canvas(SIZE);
    // One tile over the whole canvas picking source 1, so the mask says "take this everywhere".
    let recipe = tile_from(2, SIZE, 0.0, 1, 0.1);
    let window = Rect::exact(0, 0, SIZE.0, SIZE.1);
    let fields = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let of = slots_of(&recipe);

    let got = gathered_weight(&rig, &spec, &paths, window, &fields, &of, 1);
    let outside = got[64 * SIZE.0 + SIZE.0 - 2];
    assert!(
        outside < -1e20,
        "ground the source never reached reads {outside}, where the mask asked for a positive \
         distance - a zero there is half weight and a source taken over nothing",
    );
    assert!(
        got[64 * SIZE.0 + 16] > 0.0,
        "and ground it did reach still takes the mask's word"
    );
}

/// **The first of the two sites, which the test above cannot reach.** `two_sources_narrower_than_
/// the_canvas` is rectilinear with both sources facing forward, so `asked_for` is true at every
/// pixel of it and only the edge test ever refuses - which means a `0.0` left at the *first* site
/// is invisible to it. This is the geometry where the first site decides: a pixel more than ninety
/// degrees off a source's own axis, which the source is not looking at at all.
///
/// A half-turn of canvas across a cylinder, with the second source turned 45 degrees into it: its
/// own axis is at canvas x = 96, so everything left of x = 32 is at or past a right angle to it and
/// refused before a frame is read.
fn a_cylinder_of_two(size: (usize, usize)) -> (Composition, Vec<String>) {
    let (mut spec, paths) = two_identical_sources(size);
    spec.projection = Projection::Cylindrical;
    spec.radians_per_pixel = std::f64::consts::PI / size.0 as f64;
    // Half the frame, so each source subtends a right angle and the two overlap over the middle.
    for source in &mut spec.sources {
        source.focal = size.0 as f64 / 2.0;
    }
    spec.sources[1].rotation =
        rawshim::composition::from_axis_angle([0.0, std::f64::consts::FRAC_PI_4, 0.0]);
    (spec, paths)
}

#[test]
fn a_pixel_the_source_is_not_looking_at_is_not_a_pixel_on_the_seam() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = a_cylinder_of_two(SIZE);
    let recipe = tile_from(2, SIZE, 0.0, 1, 0.1);
    let window = Rect::exact(0, 0, SIZE.0, SIZE.1);
    let fields = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let of = slots_of(&recipe);

    let got = gathered_weight(&rig, &spec, &paths, window, &fields, &of, 1);
    let behind = got[64 * SIZE.0 + 2];
    assert!(
        behind < -1e20,
        "a pixel the source does not look at reads {behind}, where the mask asked for a positive \
         distance - the first of the two sites wrote a distance rather than an absence",
    );
}

// --- Task 8: the two bands, in log2 light (§5.2) ---

/// Which blend a test is rendering through. Only [`Bands::Two`] ships; the other two are the
/// alternatives §6 asks each claim to be asserted against, and live here rather than in the crate.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bands {
    /// §5.2's: the lowpass at `W(x)`, the detail at `W_HIGH_PX`.
    Two,
    /// One feather at the high band's width - narrow enough to hide a doubled edge, and what §3.10
    /// says cannot hide a 7% step.
    OneFeather,
    /// One feather at `W(x)`, which spreads the step and the detail alike.
    OneWideFeather,
}

/// Wide enough that `W_MAX` of the long edge clears the high band, and then some: at 1024 the low
/// band is 10.24 render pixels against the high band's 2, where at [`SIZE`] the ceiling (1.28) is
/// *under* the floor and the two bands are one number. A test of the split at 128px pins nothing.
const TWO_BAND_SIZE: (usize, usize) = (1024, 1024);

/// Where `one_tile`'s left edge falls on a canvas: the seam every measurement below is taken at.
fn seam_of(size: (usize, usize)) -> usize {
    size.0 / 4
}

/// Two flat frames `stops` apart, which is §3.10's reading of one burst shot at identical settings -
/// 0.045 to 0.105 stops, and per-source gains structurally 1.0 whatever the light did.
///
/// Flat, so what crosses the seam is the ratio and nothing else: a lowpass of a flat field is the
/// field, so the high band carries zero and the low band is the whole answer.
fn two_sources_a_ratio_apart(size: (usize, usize), stops: f32) -> (Composition, Vec<String>) {
    let spec = one_tile(2, size, 0, 0.1).spec;
    let dir = std::env::temp_dir().join("bowerbird-band-ratio");
    let paths = (0..2)
        .map(|i| {
            let level = 100.0 * (stops * i as f32).exp2();
            write_png(&dir, &format!("ratio{i}-{stops}.png"), size, move |_, _| {
                level as u8
            })
        })
        .collect();
    (spec, paths)
}

/// The same ratio with texture in both frames, **in antiphase**: the second frame's sine is half a
/// wavelength along, which is what a burst's ~1 analysis pixel of registration error looks like at
/// the frequencies the high band carries. Antiphase rather than a nudge because it is the case a
/// single wide feather actually loses - mixed half and half, two antiphase sines cancel.
fn two_sources_a_ratio_apart_with_texture(
    size: (usize, usize),
    stops: f32,
) -> (Composition, Vec<String>) {
    const WAVELENGTH: f32 = 8.0;
    let spec = one_tile(2, size, 0, 0.1).spec;
    let dir = std::env::temp_dir().join("bowerbird-band-texture");
    let paths = (0..2)
        .map(|i| {
            let level = 140.0 * (stops * i as f32).exp2();
            let phase = WAVELENGTH / 2.0 * i as f32;
            write_png(&dir, &format!("texture{i}.png"), size, move |x, _| {
                let wave = (std::f32::consts::TAU * (x as f32 + phase) / WAVELENGTH).sin();
                (level + 40.0 * wave).clamp(0.0, 255.0) as u8
            })
        })
        .collect();
    (spec, paths)
}

/// One window, rendered from a recipe through one of the three blends, as light per pixel.
fn rendered(
    rig: &Rig,
    recipe: &Drawing,
    spec: &Composition,
    paths: &[String],
    size: (usize, usize),
    bands: Bands,
) -> Vec<f32> {
    let window = whole(size);
    let fields = pollster::block_on(weights(rig.gpu, recipe, window, 1.0));
    let of = slots_of(recipe);
    let held =
        pollster::block_on(lowpass(recipe, &asking(spec, paths, window))).expect("a lowpass");
    let request = CompositeRequest {
        weight: Weight::Mask(Mask {
            signed: &fields.signed,
            tile_of: &fields.tile_of,
            warps: &fields.warps,
            tile_warps: &[],
            tile_slot: &[],
            slots: fields.slots,
            slot_of: &of,
        }),
        ..asking(spec, paths, window)
    };
    let width = floats_of(rig, &fields.width, fields.pixels);

    let out = match bands {
        Bands::Two => {
            let mut banding = Banding::over(rig.gpu, rig.base, window, &fields.width, &held, 1.0);
            pollster::block_on(layers_of(spec, &request, |i, layer, _| {
                banding.add(layer, of[i].expect("a gathered source has a slot") as usize);
                Ok(())
            }))
            .expect("the layers of a window");
            banding.resolve()
        }
        _ => {
            // The alternative: one feather, so the mask's signed distance is turned into a single
            // weight here and `composite_blend` mixes the whole picture over it.
            let mut blending = Blending::over(rig.gpu, rig.base, window);
            pollster::block_on(layers_of(spec, &request, |_, layer, _| {
                let Layer { rgb, weight } = layer;
                let signed = floats_of(rig, &weight, fields.pixels);
                let feathered: Vec<f32> = signed
                    .iter()
                    .enumerate()
                    .map(|(p, &d)| match d <= NOT_REACHED * 0.5 {
                        true => 0.0,
                        false => smoothstep(
                            match bands {
                                Bands::OneWideFeather => width[p],
                                _ => W_HIGH_PX,
                            },
                            d,
                        ),
                    })
                    .collect();
                drop(weight);
                blending.add(Layer {
                    rgb,
                    weight: upload_f32(rig, &feathered),
                });
                Ok(())
            }))
            .expect("the layers of a window");
            blending.resolve().0
        }
    };
    let codes = pollster::block_on(out.host()).expect("a readable window");
    (0..size.0 * size.1)
        .map(|p| light_of_code(codes[p * 3]))
        .collect()
}

/// The light one source's own layer arrived with, which is what the two bands have to add back up
/// to wherever that source owns the ground alone.
fn layer_light(
    spec: &Composition,
    paths: &[String],
    size: (usize, usize),
    source: usize,
) -> Vec<f32> {
    let mut held: Option<rawshim::resident::Resident> = None;
    pollster::block_on(layers_of(
        spec,
        &asking(spec, paths, whole(size)),
        |i, layer, _| {
            let Layer { rgb, weight } = layer;
            drop(weight);
            match i == source {
                true => held = Some(rgb),
                false => rgb.reclaim(),
            }
            Ok(())
        },
    ))
    .expect("the layers of a window");
    let codes = pollster::block_on(held.expect("the source reached the window").host())
        .expect("a readable layer");
    (0..size.0 * size.1)
        .map(|p| light_of_code(codes[p * 3]))
        .collect()
}

fn row(light: &[f32], size: (usize, usize), y: usize) -> Vec<f32> {
    light[y * size.0..(y + 1) * size.0].to_vec()
}

/// The steepest step, **in stops**, between two adjacent pixels within `reach` of the seam.
///
/// A feather too narrow for an exposure difference does not leave a smaller difference, it leaves
/// the same difference as an edge - so what a band is measured by is the gradient, not the plateaus
/// either side, which every blend gets right.
fn step_across(row: &[f32], seam: usize, reach: usize) -> f32 {
    (seam - reach..seam + reach)
        .map(|x| (row[x + 1].max(1e-9) / row[x].max(1e-9)).log2().abs())
        .fold(0.0f32, f32::max)
}

/// The RMS of a three-tap Laplacian along a row, in log2 light, over `at` and `reach` either side.
///
/// In log2 so that the exposure ramp the low band lays across the seam - locally straight - reads
/// as nothing and only the texture is measured.
fn texture_near(row: &[f32], at: usize, reach: usize) -> f32 {
    let l = |i: usize| row[i].max(1e-9).log2();
    let sq: f32 = (at - reach..=at + reach)
        .map(|x| (l(x) - 0.5 * (l(x - 1) + l(x + 1))).powi(2))
        .sum();
    (sq / (2 * reach + 1) as f32).sqrt()
}

fn under_gain(spec: &Composition, paths: &[String], size: (usize, usize), gain: Gain) -> Vec<f32> {
    let mut recipe = one_tile(2, size, 1, 0.1);
    recipe.gain[0] = gain;
    let request = asking(spec, paths, whole(size));
    let held = pollster::block_on(lowpass(&recipe, &request)).expect("a lowpass");
    let (out, _) = pollster::block_on(rawshim::assembly_render::prepared(&recipe, &held, &request))
        .expect("a render");
    let codes = pollster::block_on(out.host()).expect("a readable window");
    (0..size.0 * size.1)
        .map(|p| light_of_code(codes[p * 3]))
        .collect()
}

/// §2.8's per-piece exposure reaches the picture, and reaches only the piece.
///
/// **Through `prepared`, which is the only path that carries `Drawing::gain` at all**: it is
/// `prepared` that builds the mask's `tile_warps` out of the recipe, so a render assembled by hand
/// - as every other test in this file assembles one - passes an empty list and never asks a piece
/// what its own light is. The editor and every rendition go through `prepared`.
///
/// Two flat frames a stop apart, the darker one picked: at a gain of one the tile is that stop
/// below the ground it sits in, and a gain of two puts it exactly back, while the ground itself
/// does not move. A gain folded in twice, or in the wrong domain, misses both.
#[test]
fn a_piece_is_drawn_under_its_own_gain() {
    let Some(_rig) = rig() else { return };
    let size = (512, 512);
    let (spec, paths) = two_sources_a_ratio_apart(size, -1.0);
    let at = |light: &[f32], x: usize, y: usize| light[y * size.0 + x];
    let stops = |light: f32, against: f32| (light.max(1e-9) / against.max(1e-9)).log2();

    let plain = under_gain(&spec, &paths, size, Gain::ONE);
    let (tile, ground) = (at(&plain, size.0 / 2, size.1 / 2), at(&plain, 4, 4));
    let below = stops(tile, ground);
    assert!(
        (below + 1.0).abs() < 0.02,
        "the darker frame is a stop down before any gain: {below:.4} stops",
    );

    let lifted = under_gain(&spec, &paths, size, Gain::of_ratio(2.0));
    let (tile, lifted_ground) = (at(&lifted, size.0 / 2, size.1 / 2), at(&lifted, 4, 4));
    let step = stops(tile, ground);
    assert!(
        step.abs() < 0.02,
        "a gain of two has to land the tile on the ground's own light: {step:.4} stops",
    );
    let moved = stops(lifted_ground, ground);
    assert!(moved.abs() < 0.001, "the ground outside took {moved:.4} stops of it");
}

/// §3.10's brightness step, which is the thing this exists for: 0.045 to 0.105 stops between two
/// frames of one burst shot at identical settings, and per-source gains structurally 1.0 whatever
/// the light did.
///
/// A feather narrow enough to hide the ~1 analysis pixel of doubled edge cannot hide a 7% step; the
/// low band is what spreads the step over `2 * W_low`. Asserted against the single-feather
/// alternative, because "the seam is smooth" is true of both and only the comparison says which.
#[test]
fn the_low_band_removes_an_exposure_ratio_a_single_feather_would_leave() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_sources_a_ratio_apart(TWO_BAND_SIZE, 0.1);
    let recipe = one_tile(2, TWO_BAND_SIZE, 1, 0.1);
    let seam = seam_of(TWO_BAND_SIZE);

    let banded = rendered(&rig, &recipe, &spec, &paths, TWO_BAND_SIZE, Bands::Two);
    let single = rendered(
        &rig,
        &recipe,
        &spec,
        &paths,
        TWO_BAND_SIZE,
        Bands::OneFeather,
    );
    let middle = TWO_BAND_SIZE.1 / 2;
    let (wide, narrow) = (
        step_across(&row(&banded, TWO_BAND_SIZE, middle), seam, 16),
        step_across(&row(&single, TWO_BAND_SIZE, middle), seam, 16),
    );
    assert!(
        wide < 0.25 * narrow,
        "two bands leave {wide:.5} stops a pixel where one feather leaves {narrow:.5}",
    );
}

/// And it must not buy that by mixing the detail over the same width: the high band is two render
/// pixels, so a texture crossing the seam is not averaged with a copy of itself.
///
/// Measured over half the low band's reach rather than all of it. Out at `W_low` a single wide
/// feather is already back to one frame alone and has lost nothing, so a window that wide dilutes
/// the very thing being measured; inside `W_low / 2` the mix is between 15 and 85 percent, which is
/// where a feather either doubles the texture or does not.
#[test]
fn the_bands_do_not_double_the_detail_the_low_band_spreads() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_sources_a_ratio_apart_with_texture(TWO_BAND_SIZE, 0.1);
    let recipe = one_tile(2, TWO_BAND_SIZE, 1, 0.1);
    let seam = seam_of(TWO_BAND_SIZE);
    let middle = TWO_BAND_SIZE.1 / 2;
    // Half of `W_MAX * long`, which is what a corridor of 0.1 is capped to at this canvas.
    let reach = (W_MAX.raw() as f32 * TWO_BAND_SIZE.0 as f32 / 2.0).round() as usize;
    let away = seam + 8 * reach;

    for (bands, inside_is) in [(Bands::Two, true), (Bands::OneWideFeather, false)] {
        let out = rendered(&rig, &recipe, &spec, &paths, TWO_BAND_SIZE, bands);
        let there = row(&out, TWO_BAND_SIZE, middle);
        let (in_feather, off_it) = (
            texture_near(&there, seam, reach),
            texture_near(&there, away, reach),
        );
        match inside_is {
            true => assert!(
                in_feather > 0.8 * off_it,
                "the detail survives the seam: {in_feather:.5} against {off_it:.5}",
            ),
            false => assert!(
                in_feather < 0.6 * off_it,
                "and a single wide feather is what loses it, which is the alternative being \
                 rejected: {in_feather:.5} against {off_it:.5}",
            ),
        }
    }
}

/// §5.2's "in log2 light", stated where the two spaces differ enough to tell apart: at the seam
/// both bands weigh the two frames equally, so the answer is the *geometric* mean of them where
/// mixing in light would give the arithmetic one.
///
/// A stop apart rather than §3.10's tenth of one, deliberately: the two means of a 7% ratio differ
/// by 0.06%, which is a test that cannot fail. What the space is chosen for is the same either way
/// (§5.2: a gain is an offset in log2 and a multiply in light), and a stop is where the choice is
/// visible.
#[test]
fn the_seam_takes_the_geometric_mean_of_the_two_frames() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_sources_a_ratio_apart(TWO_BAND_SIZE, 1.0);
    let recipe = one_tile(2, TWO_BAND_SIZE, 1, 0.1);
    let seam = seam_of(TWO_BAND_SIZE);

    let out = rendered(&rig, &recipe, &spec, &paths, TWO_BAND_SIZE, Bands::Two);
    let there = row(&out, TWO_BAND_SIZE, TWO_BAND_SIZE.1 / 2);
    // Far either side of the seam each frame owns the ground alone, so the row *is* the two frames.
    let (a, b) = (there[seam / 4], there[TWO_BAND_SIZE.0 / 2]);
    // The two pixels either side of the edge carry weights that are exact complements - smoothstep
    // is symmetric and the two distances are exact negatives - so their log2 mean is half of each
    // frame whatever the feather's width did.
    let at_the_seam = (0.5 * there[seam - 1].log2() + 0.5 * there[seam].log2()).exp2();
    let geometric = (a * b).sqrt();
    let arithmetic = 0.5 * (a + b);
    assert!(
        (at_the_seam - geometric).abs() < 0.02 * geometric,
        "the seam reads {at_the_seam} where the geometric mean of {a} and {b} is {geometric} and \
         the arithmetic one is {arithmetic}",
    );
    assert!(
        arithmetic - geometric > 0.04 * geometric,
        "the two means are {arithmetic} and {geometric}, too close for this to be a test",
    );
}

/// Where one source owns the ground, the two bands add back up to exactly that source: the lowpass
/// is subtracted from the detail and put back, so what a reader picked is what a reader gets.
#[test]
fn a_pixel_one_source_owns_comes_back_as_that_source() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_sources_a_ratio_apart_with_texture(TWO_BAND_SIZE, 0.1);
    let recipe = one_tile(2, TWO_BAND_SIZE, 1, 0.1);
    let out = rendered(&rig, &recipe, &spec, &paths, TWO_BAND_SIZE, Bands::Two);
    let mine = layer_light(&spec, &paths, TWO_BAND_SIZE, 1);

    // The middle of the tile, which is 246 pixels from the nearest seam and so all one source's.
    let middle = TWO_BAND_SIZE.1 / 2;
    for x in [
        TWO_BAND_SIZE.0 / 2,
        TWO_BAND_SIZE.0 / 2 + 3,
        TWO_BAND_SIZE.0 / 2 + 5,
    ] {
        let p = middle * TWO_BAND_SIZE.0 + x;
        let stops = (out[p].max(1e-9) / mine[p].max(1e-9)).log2().abs();
        assert!(
            stops < 0.002,
            "at {x} the render reads {} where the source it picked holds {}, {stops:.5} stops off",
            out[p],
            mine[p],
        );
    }
}

/// The low band is normalised by **its own** total, which is only visible where the two bands do
/// not have the same contributors.
///
/// Everywhere two unions meet, both totals are one - `smooth_between` is symmetric and the two
/// distances are exact negatives - so dividing the low band by the high band's total is the same
/// number and no seam test can see it. Where they differ is a pixel inside a tile **no other source
/// reaches at all**, nearer the tile's edge than `W(x)` but further than the high band: there the
/// low band is taken at 0.87 and the high at 1, and the two normalisations are half a stop apart.
///
/// Turned far enough apart that the right-hand end of the canvas is the second source's alone,
/// with the tile's edge inside that end.
#[test]
fn the_low_band_is_normalised_by_its_own_total() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = a_cylinder_of_two(TWO_BAND_SIZE);
    let edge = 850.0f32;
    let recipe = tile_from(2, TWO_BAND_SIZE, edge, 1, 0.1);
    let (x, y) = (edge as usize + 5, TWO_BAND_SIZE.1 / 2);
    let p = y * TWO_BAND_SIZE.0 + x;

    // The claim rests on where this pixel sits, so it is measured rather than assumed: inside the
    // tile, past the high band's reach, and short of the low band's.
    let fields = pollster::block_on(weights(rig.gpu, &recipe, whole(TWO_BAND_SIZE), 1.0));
    let (signed, width) = read(&rig, &fields);
    let of = slots_of(&recipe);
    let distance = signed[p * fields.slots + of[1].expect("the pick has a slot") as usize];
    assert!(
        distance > W_HIGH_PX && distance < width[p],
        "the pixel is {distance} from the seam, where the bands are {} and {W_HIGH_PX} wide",
        width[p],
    );

    let out = rendered(&rig, &recipe, &spec, &paths, TWO_BAND_SIZE, Bands::Two);
    let mine = layer_light(&spec, &paths, TWO_BAND_SIZE, 1);
    let stops = (out[p].max(1e-9) / mine[p].max(1e-9)).log2().abs();
    assert!(
        stops < 0.01,
        "the render reads {} where the only source covering it holds {}, {stops:.5} stops off",
        out[p],
        mine[p],
    );
}

// --- Task 9: a window, and then a canvas (§5) ---

/// Flat sources at the codes given, one a source, so which frame a pixel came from is readable off
/// it. Flat, so the lowpass of one is the frame itself and the two bands add back up to it exactly.
fn flat_sources(size: (usize, usize), codes: &[u8]) -> (Composition, Vec<String>) {
    let spec = one_tile(codes.len(), size, 0, 0.1).spec;
    let dir = std::env::temp_dir().join("bowerbird-assembly-flat");
    let paths = codes
        .iter()
        .enumerate()
        .map(|(i, &code)| write_png(&dir, &format!("flat{i}-{code}.png"), size, move |_, _| code))
        .collect();
    (spec, paths)
}

/// A tile `across` canvas pixels wide down the middle of the canvas, full height - so its inradius
/// is exactly half of `across` and nothing else bounds it.
fn thin_tile(
    sources: usize,
    size: (usize, usize),
    pick: usize,
    corridor: f32,
    across: f32,
) -> Drawing {
    let mut recipe = one_tile(sources, size, pick, corridor);
    let (w, h) = (size.0 as f32, size.1 as f32);
    recipe.vertices = vec![
        [(w - across) / 2.0, 0.0],
        [(w + across) / 2.0, 0.0],
        [(w + across) / 2.0, h],
        [(w - across) / 2.0, h],
    ];
    recipe
}

/// A canvas rendered through `prepared` in columns `wide` pixels across, as the render's own codes.
///
/// **Columns rather than rows**, where §5.2's own windows are a render's full-width strips: the
/// seam these recipes carry is vertical, so a window's x origin is the one a misread would move the
/// tile by, and a row of full width exercises nothing but the y.
///
/// The lowpass is built once for the whole render, which is what `prepared` takes it as an argument
/// for.
fn render_in_strips(
    recipe: &Drawing,
    spec: &Composition,
    paths: &[String],
    size: (usize, usize),
    wide: usize,
) -> Vec<u16> {
    let held =
        pollster::block_on(lowpass(recipe, &asking(spec, paths, whole(size)))).expect("a lowpass");
    let mut canvas = vec![0u16; size.0 * size.1 * 3];
    let mut left = 0;
    while left < size.0 {
        let across = wide.min(size.0 - left);
        let window = Rect::exact(left, 0, across, size.1);
        let (out, _) = pollster::block_on(rawshim::assembly_render::prepared(
            recipe,
            &held,
            &asking(spec, paths, window),
        ))
        .expect("a window of the assembly");
        let codes = pollster::block_on(out.into_host()).expect("a readable window");
        for y in 0..size.1 {
            let from = y * across * 3;
            let to = (y * size.0 + left) * 3;
            canvas[to..to + across * 3].copy_from_slice(&codes[from..from + across * 3]);
        }
        left += across;
    }
    canvas
}

fn render_whole(
    recipe: &Drawing,
    spec: &Composition,
    paths: &[String],
    size: (usize, usize),
) -> Vec<u16> {
    render_in_strips(recipe, spec, paths, size, size.0)
}

fn light_at(codes: &[u16], size: (usize, usize), x: usize, y: usize) -> f32 {
    light_of_code(codes[(y * size.0 + x) * 3])
}

fn stops_between(a: f32, b: f32) -> f32 {
    (a.max(1e-9) / b.max(1e-9)).log2().abs()
}

/// The whole of §5 in one claim: a tile takes the frame it picked and the ground outside every
/// tile takes the base, which is what the reader asked for.
///
/// Against each source's own layer rather than against a light: a source is coded against the
/// composite's own white, so what a flat frame reads is a number about the coding and not about
/// which frame it came from.
///
/// **Three sources, the middle one unused**, so that `sources_used`'s order and the list's order
/// are different lists: with two, the base is 0 and the pick is 1 either way and a render that
/// strode the mask by the source index would draw the same picture.
#[test]
fn every_tile_takes_the_frame_it_picked() {
    let Some(_rig) = rig() else { return };
    let (spec, paths) = flat_sources(SIZE, &[60, 30, 180]);
    let recipe = one_tile(3, SIZE, 2, 0.1);
    let out = render_whole(&recipe, &spec, &paths, SIZE);
    let picked = layer_light(&spec, &paths, SIZE, 2);
    let base = layer_light(&spec, &paths, SIZE, 0);

    let middle = 64 * SIZE.0 + 64;
    let corner = 4 * SIZE.0 + 4;
    assert!(
        stops_between(picked[middle], base[middle]) > 1.0,
        "the two frames are {} stops apart, too close to tell which one a pixel came from",
        stops_between(picked[middle], base[middle]),
    );
    assert!(
        stops_between(light_at(&out, SIZE, 64, 64), picked[middle]) < 0.02,
        "the tile's middle reads {} where the frame it picked holds {}",
        light_at(&out, SIZE, 64, 64),
        picked[middle],
    );
    assert!(
        stops_between(light_at(&out, SIZE, 4, 4), base[corner]) < 0.02,
        "the ground outside the tile reads {} where the base holds {}",
        light_at(&out, SIZE, 4, 4),
        base[corner],
    );
}

/// A tile's gain reaches the pixels it takes, and only those: a stop on the picked frame is a stop
/// in the tile's middle, and the ground outside is the base as it was.
#[test]
fn a_tiles_gain_multiplies_the_light_it_takes() {
    let Some(_rig) = rig() else { return };
    let (spec, paths) = flat_sources(SIZE, &[90, 40]);
    let mut recipe = one_tile(2, SIZE, 1, 0.1);
    let plain = render_whole(&recipe, &spec, &paths, SIZE);
    recipe.gain[0] = Gain::of_ratio(2.0);
    let lifted = render_whole(&recipe, &spec, &paths, SIZE);

    let middle = stops_between(
        light_at(&lifted, SIZE, 64, 64),
        light_at(&plain, SIZE, 64, 64),
    );
    assert!(
        (middle - 1.0).abs() < 0.02,
        "a gain of two moved the tile's middle {middle} stops"
    );
    let ground = stops_between(light_at(&lifted, SIZE, 4, 4), light_at(&plain, SIZE, 4, 4));
    assert!(
        ground < 0.01,
        "and moved the ground outside it {ground} stops"
    );
}

/// The feather is where the reader's pick stops applying, and nowhere else: full weight at the
/// tile's deepest point, which is what §5.2's inradius cap buys.
///
/// **At 1024 rather than [`SIZE`]**, because `W_MAX * long` is under `W_HIGH_PX` on any canvas
/// under 200px and every corridor there is one number. The corridor a tile eight pixels across
/// carries is the cap - twice its own inradius over the long edge - and the rejected alternative is
/// the uncapped 0.1 the same tile would otherwise hold, which feathers 10.24 pixels either side of
/// a seam only 4 pixels from the middle.
#[test]
fn a_thin_tile_still_reaches_full_weight_in_its_middle() {
    let Some(_rig) = rig() else { return };
    let size = TWO_BAND_SIZE;
    let (spec, paths) = flat_sources(size, &[60, 180]);
    let across = 8.0f32;
    let middle = (size.1 / 2) * size.0 + size.0 / 2;
    let picked = layer_light(&spec, &paths, size, 1);

    let capped = across / size.0.max(size.1) as f32;
    let out = render_whole(&thin_tile(2, size, 1, capped, across), &spec, &paths, size);
    let read = light_at(&out, size, size.0 / 2, size.1 / 2);
    assert!(
        stops_between(read, picked[middle]) < 0.02,
        "the middle of a thin tile reads {read}, not the {} it picked",
        picked[middle],
    );

    let uncapped = render_whole(&thin_tile(2, size, 1, 0.1, across), &spec, &paths, size);
    let leaked = light_at(&uncapped, size, size.0 / 2, size.1 / 2);
    assert!(
        stops_between(leaked, picked[middle]) > 0.1,
        "and a corridor wider than the tile is deep is what the cap exists for: {leaked} against \
         the {} it picked",
        picked[middle],
    );
}

/// The canvas is the windows, and the windows are the canvas: a render taken in strips is the
/// same picture as one taken whole. This is what §5.2's whole-crop lowpass and render-pixel weight
/// fields exist for, and the only test that can say they work.
#[test]
fn a_canvas_taken_in_strips_is_the_canvas_taken_whole() {
    let Some(_rig) = rig() else { return };
    let (spec, paths) = flat_sources(SIZE, &[60, 180]);
    let recipe = one_tile(2, SIZE, 1, 0.1);
    let whole_canvas = render_whole(&recipe, &spec, &paths, SIZE);
    let stripped = render_in_strips(&recipe, &spec, &paths, SIZE, 24);
    let (mean, worst, at) = support::drift(&stripped, &whole_canvas);
    assert!(
        mean < 1.0 && worst < 64,
        "strips differ from the whole by {mean:.3} on average, worst {worst} at {at}",
    );
}

/// **Two tiles of one frame, two different warps, one gather.** The whole of what the per-pixel
/// correction buys, in the picture rather than in the field that drives it.
///
/// A ramp across the source, so a translation is readable as a light: shifting the canvas point a
/// tile asks for by `dx` reads the ramp `dx` further along, and the two tiles are asked for
/// displacements of opposite sign. The two tiles pick one source, so they share its slot, and only
/// the per-pixel field can give them different corrections.
#[test]
fn two_tiles_of_one_frame_take_their_own_warps_out_of_one_gather() {
    let Some(_rig) = rig() else { return };
    let dir = std::env::temp_dir().join("bowerbird-assembly-ramp");
    // Shallow enough to stay inside eight bits over the canvas, steep enough that the shift below
    // is many codes rather than rounding.
    let ramp = write_png(&dir, "ramp.png", SIZE, |x, _| 40 + (x as u8));
    let spec = one_tile(2, SIZE, 0, 0.1).spec;
    let paths = vec![ramp.clone(), ramp];

    // Two tiles side by side, both picking source 1, each asked for the canvas a few pixels either
    // side of where it sits.
    let flat = {
        let mut drawing = one_tile(2, SIZE, 1, 0.1);
        drawing.vertices.clear();
        (drawing.tiles, drawing.pick, drawing.corridor, drawing.warp, drawing.gain) =
            Default::default();
        for [left, right] in [[0.0, 0.5], [0.5, 1.0]] {
            let corners = [[left, 0.0], [right, 0.0], [right, 1.0], [left, 1.0]];
            let (w, h) = (SIZE.0 as f32, SIZE.1 as f32);
            with_tile(&mut drawing, corners.map(|[x, y]| [w * x, h * y]), 1, 0.1);
        }
        drawing
    };
    let shifted = |dx: f32| [1.0, 0.0, 0.0, 1.0, dx, 0.0];
    let recipe = Drawing {
        warp: vec![shifted(12.0), shifted(-12.0)],
        ..flat.clone()
    };

    let warped = render_whole(&recipe, &spec, &paths, SIZE);
    let plain = render_whole(&flat, &spec, &paths, SIZE);
    // Well inside each tile and clear of the corridor. Each tile reads the unwarped ramp 12 along
    // in its own direction, which a pair of warps swapped between the tiles would not.
    let y = SIZE.1 / 2;
    let (left, right) = (SIZE.0 / 4, SIZE.0 - SIZE.0 / 4);
    for (x, from) in [(left, left + 12), (right, right - 12)] {
        let (read, meant, unmoved) = (
            light_at(&warped, SIZE, x, y),
            light_at(&plain, SIZE, from, y),
            light_at(&plain, SIZE, x, y),
        );
        assert!(
            stops_between(read, meant) < 0.01,
            "at {x} the tile reads {read} where the ramp {from} holds {meant}",
        );
        assert!(
            stops_between(read, unmoved) > 0.05,
            "at {x} the shift is too small to read: {read} against {unmoved}",
        );
    }
}

/// A source no tile picked and which is not the base is never decoded, which is what makes a
/// twelve-frame recipe with two picks cost two decodes a window rather than twelve.
#[test]
fn a_source_no_tile_picked_is_never_decoded() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = flat_sources(SIZE, &[60, 180, 30]);
    let recipe = one_tile(3, SIZE, 1, 0.1);
    let window = whole(SIZE);
    let fields = pollster::block_on(weights(rig.gpu, &recipe, window, 1.0));
    let of = slots_of(&recipe);
    let request = CompositeRequest {
        weight: Weight::Mask(Mask {
            signed: &fields.signed,
            tile_of: &fields.tile_of,
            warps: &fields.warps,
            tile_warps: &[],
            tile_slot: &[],
            slots: fields.slots,
            slot_of: &of,
        }),
        ..asking(&spec, &paths, window)
    };

    let mut touched = vec![false; spec.sources.len()];
    pollster::block_on(layers_of(&spec, &request, |i, layer, _| {
        touched[i] = true;
        let Layer { rgb, weight } = layer;
        drop(weight);
        rgb.reclaim();
        Ok(())
    }))
    .expect("the layers of a window");
    assert_eq!(
        touched,
        vec![true, true, false],
        "source 2 is neither the base nor a pick"
    );
}

/// §2.5: the base is the frame a composite is graded as, where a panorama's is its reference. The
/// two are different sources here, so the match the window carries says which one was read.
#[test]
fn a_recipe_whose_base_is_not_its_reference_carries_the_bases_own_match() {
    let Some(_rig) = rig() else { return };
    let (spec, paths) = flat_sources(SIZE, &[60, 180]);
    let mut recipe = one_tile(2, SIZE, 0, 0.1);
    recipe.base = 1;
    recipe.spec.reference = 0;

    let matched = rawshim::photo_analysis::PhotoAnalysis {
        from_raw: rawshim::photo_analysis::FromRaw {
            matched: Some(rawshim::hdr_fit::HdrMatch {
                lens: rawshim::fit::Lens::none(),
                colour: Some(rawshim::hdr_fit::HdrColour::identity()),
            }),
            ..Default::default()
        },
        ..Default::default()
    };
    let files = [
        SourceFile {
            path: &paths[0],
            analysis: None,
        },
        SourceFile {
            path: &paths[1],
            analysis: Some(&matched),
        },
    ];
    let window = whole(SIZE);
    let request = CompositeRequest {
        sources: &files,
        ..asking(&spec, &paths, window)
    };
    let held = pollster::block_on(lowpass(&recipe, &request)).expect("a lowpass");
    let (_, prepared) =
        pollster::block_on(rawshim::assembly_render::prepared(&recipe, &held, &request))
            .expect("a window of the assembly");
    assert!(
        prepared.matched.is_some(),
        "the window carries the reference's match rather than the base's",
    );
}

/// A window is stated in the render's own pixels, as `CompositeRequest::window` is, so a render at
/// a scale puts a seam where the canvas does divided by that scale.
///
/// **At scale 2 and away from the origin**, which is the only place the claim is testable: at scale
/// 1 a window read as canvas pixels and one read as the render's are the same number, and a window
/// at the origin is zero either way.
#[test]
fn a_window_at_a_scale_puts_the_seam_where_the_canvas_does() {
    let Some(rig) = rig() else { return };
    const CANVAS: (usize, usize) = (256, 256);
    let recipe = one_tile(2, CANVAS, 1, 0.1);
    // The tile spans canvas 64..192, which at two canvas pixels an output pixel is render 32..96 -
    // so its left edge is eight columns into this window and its rows are all interior.
    let window = Rect::exact(24, 40, 32, 32);
    let w = pollster::block_on(weights(rig.gpu, &recipe, window, 2.0));
    let (signed, _) = read(&rig, &w);
    let at = |x: usize, y: usize| signed[(y * 32 + x) * w.slots + 1];

    assert!(
        at(8, 16).abs() < 1.5,
        "eight columns in is the seam, reading {}",
        at(8, 16)
    );
    assert!(
        at(24, 16) > 12.0,
        "and sixteen pixels past it is sixteen pixels inside the tile, not {}",
        at(24, 16),
    );
}

/// A panorama is unchanged: no mask, and the feather is what it always was.
#[test]
fn a_gather_with_no_mask_still_feathers() {
    let Some(rig) = rig() else { return };
    let (spec, paths) = two_identical_sources(SIZE);
    let window = Rect::exact(0, 0, SIZE.0, SIZE.1);
    let got = gathered_weight_unmasked(&rig, &spec, &paths, window, 0);
    assert!(
        got[64 * SIZE.0 + 64] > got[2 * SIZE.0 + 2],
        "deeper inside is worth more"
    );
    assert!(
        got.iter().all(|&w| w >= 0.0),
        "an unmasked weight is never negative"
    );
}
