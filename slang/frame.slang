// Sensor levels to what the canvas takes, in one pass.
//
// No graded frame in between - no compute pass writing `rgba32float` nits for the draw to
// read back. That is the CPU's shape, where every stage materialises because the next one is
// a separate loop over 30M samples, and on a GPU it buys nothing: the value is already in a
// register when the next stage wants it. What it costs is 158MB written and 158MB read per
// tick, measured as 5.2ms of a 15ms tick with the arithmetic in it barely visible either side.
//
// Such a frame also has to PQ-code on the way out and decode on the way in, six `pow` each
// way, because a rendition is a PQ file. The display is not a file, so that encoding happens
// only where a file is wanted, which is `encode` below.
//
// The other half of the win: this runs once per *canvas* pixel, and a canvas is the
// viewport. A 61MP frame fitted to a 2560x1707 stage costs 4.4MP of colour transform
// rather than 60, which is 7ms rather than 100.
import prelude;
import lanes;
import edit;
import colour;
import adjust;
import gamut_map;
import geometry;
import catmull_rom;
import light;
import px;
import primaries;
import print_scene;
import print_parameters;
import print_geometry;

[vk::binding(5, 0)] StructuredBuffer<float> peak_out;
// Two `u16` components to a word, which is what `encode` below says. `ceil(pixels * 3 / 2)`
// words, rounded up to a whole invocation's three.
[vk::binding(6, 0)] RWStructuredBuffer<uint> counts;
// Half resolution and down, so `lod` 0 is the frame and this holds every level above it.
[vk::binding(9, 0)] Texture2D<uint4> pyramid;

// `edit.output`'s values. Named here so the host and the shader cannot disagree by a
// literal, in the pattern `PEAK_BINS` and its neighbours use.
//
// `ROLLED` stops where the CPU's grade stopped: the frame after the roll-off and before
// any transfer, which is what every rendition path already passes around and encodes for
// itself. It exists so the grade can move here without moving the two encoders with it -
// the transfers above are the same arithmetic either way, and fusing them is an
// optimisation to take later rather than a prerequisite.
static const uint OUTPUT_PQ = 0;
static const uint OUTPUT_SRGB = 1;
static const uint OUTPUT_ROLLED = 2;

/// The roll-off leaves the display's peak alone when the scene already fits inside it, so
/// the clamp in `display_nits` is not redundant: a level past `source_level` comes back
/// untouched.
Colour<DisplayNits> rolled_off(Colour<SceneNits> nits, float2 at)
{
    if (edit.matched == 0) { return neutral_nits(nits, at); }
    // `peak.slang` writes this bin's centre already multiplied back by the reference, so it is
    // nits at the display and not the `Rendered` units the histogram is binned in.
    let scene_peak = measured<DisplayNits>(peak_out[0]);
    // Clamped to the scene peak before the roll-off, because the CPU's roll table spans
    // 0..scene_peak and reads the top bin for anything past it. Without the clamp the
    // brightest pixels get a curve the CPU never evaluates.
    let coloured = within(matched_nits(nits, at), scene_peak);
    return rolled(coloured, rolloff(scene_peak, measured<DisplayNits>(edit.peak), measured<DisplayNits>(edit.reference)));
}

Colour<DisplayNits> display_nits(Colour<SceneNits> nits, float2 at)
{
    return within(rolled_off(nits, at), measured<DisplayNits>(edit.peak));
}

/// The source nits one canvas pixel covers, averaged.
///
/// Fit-to-window on a 61MP frame is about eight source pixels to one along each axis, and
/// point-sampling that is aliasing rather than a picture. Averaged before the grade, not
/// after: these are scene-referred, which is the space the optics did their own averaging in,
/// where display-referred nits are past a tone curve and would not add up. Decoded before the
/// average and not after, for the same reason - the buffer's coding is not linear in light.
///
/// Most of that averaging already happened, at the open, in `reduce`. All that is
/// left here is the residual below the level the pyramid is read at, which is why four
/// taps is enough however far out the reader has zoomed: `floor(log2)` leaves a ratio in
/// [1, 2), and a 2x2 at that level covers it. Doing it with taps alone was measured and
/// is quadratic in the zoom - 9ms for one tap against 71ms for sixteen on the same frame,
/// because scattered gathers are latency rather than bandwidth.
///
/// At 1:1 both taps fall inside one texel and the average is that texel, so a
/// pixel-peeping view is not quietly blurred.
///
/// The pyramid starts at half resolution, so `lod` 0 is the frame itself and everything
/// above it is `pyramid` level `lod - 1`.
///
/// Which of the two a draw reads is a specialisation constant rather than a branch, so each
/// pipeline carries one path and not the other. As a runtime branch it cost the *zoomed-out*
/// case a third of its time - 6.9ms to 9.2 at 61MP - for a path those fragments never took,
/// which is the shape of a register-pressure problem: the dead half still has to be
/// allocated for. The host picks the pipeline off the same ratio the shader computes.
[vk::constant_id(0)]
const bool FROM_FRAME = true;

/// Whether a tap landed off the frame, where there is no photograph to read.
bool outside(float2 sample, float2 last)
{
    return sample.x < 0.0 || sample.y < 0.0 || floor(sample.x) > last.x || floor(sample.y) > last.y;
}

/// One point of the frame, through `catmull_rom`.
///
/// **The gather this draw stands in for is a Catmull-Rom one** (`warp.slang`'s `tap`, for the
/// frame and for a loupe tile alike), so a draw that point-sampled showed a straighten or a
/// keystone resampled differently from the file the same edit exports - softer or harder along an
/// edge, at every angle but zero, with nothing on either side saying which was meant.
///
/// Clamped at the border rather than skipped, as `image::sampled` clamps: a cubic reaches one
/// pixel back and two forward, so the outermost ring has no full neighbourhood and the nearest
/// sample stands in for what is off the edge. Whether the *point* is on the frame at all is the
/// caller's `outside`, which is the black wedge a straighten leaves.
float3 nits_cubic(float2 at, float2 last)
{
    let base = floor(at - float2(0.5));
    // **A tap that landed on a whole pixel is that pixel**, and this is where a rendition of an
    // uncropped photograph spends its grade. `cubic_weights(0)` is exactly `(0, 1, 0, 0)`, so the
    // sixteen taps below reduce to the one at `base` - and `geometry_at` returns an identity
    // geometry's position untouched, which makes every offset here a whole number. Sixteen
    // scattered gathers into a 256KB table for a value three of them can give, on every output
    // pixel of most photographs; identical arithmetic either way, so no fixture moves.
    if (at.x - 0.5 == base.x && at.y - 0.5 == base.y) {
        return nits_at(uint(clamp(base.x, 0.0, last.x)), uint(clamp(base.y, 0.0, last.y)));
    }
    let w = cubic_weights(at.x - 0.5 - base.x);
    let h = cubic_weights(at.y - 0.5 - base.y);
    var sum = float3(0.0);
    for (int j = 0; j < 4; j = j + 1) {
        let y = clamp(base.y + float(j - 1), 0.0, last.y);
        var row = float3(0.0);
        for (int i = 0; i < 4; i = i + 1) {
            let x = clamp(base.x + float(i - 1), 0.0, last.x);
            row = row + w[i] * nits_at(uint(x), uint(y));
        }
        sum = sum + h[j] * row;
    }
    return sum;
}

/// The same over a pyramid level, which holds the frame's own coding.
float3 pyramid_cubic(float2 at, float2 last, int level)
{
    let base = floor(at - float2(0.5));
    if (at.x - 0.5 == base.x && at.y - 0.5 == base.y) {
        let code = pyramid.Load(int3(
            int(clamp(base.x, 0.0, last.x)), int(clamp(base.y, 0.0, last.y)), level));
        return float3(nits_of_code[code.r], nits_of_code[code.g], nits_of_code[code.b]);
    }
    let w = cubic_weights(at.x - 0.5 - base.x);
    let h = cubic_weights(at.y - 0.5 - base.y);
    var sum = float3(0.0);
    for (int j = 0; j < 4; j = j + 1) {
        let y = clamp(base.y + float(j - 1), 0.0, last.y);
        var row = float3(0.0);
        for (int i = 0; i < 4; i = i + 1) {
            let x = clamp(base.x + float(i - 1), 0.0, last.x);
            // Decoded per tap: the levels the pyramid averaged are not linear in light, and neither
            // is a mean of them.
            let code = pyramid.Load(int3(int(x), int(y), level));
            row = row + w[i] * float3(
                nits_of_code[code.r],
                nits_of_code[code.g],
                nits_of_code[code.b]);
        }
        sum = sum + h[j] * row;
    }
    return sum;
}

/// Wrapped once, here, for all four taps: the stencil under it returns `float3` because
/// `no_struct_returns_under_a_loop` refuses anything else, and a mean of scene-linear taps is the
/// only mean in this file that means a light.
Colour<SceneNits> covered(float2 pos)
{
    let scale = edit.region_size / edit.canvas_size;
    let lod = clamp(floor(log2(max(max(scale.x, scale.y), 1.0))), 0.0, float(edit.max_lod));
    let shrink = exp2(lod);
    // The region is a window on the *output* - what the crop and the turn produce - so the taps
    // are laid out there and each is mapped into the frame. Mapped per tap rather than once at
    // the centre because a straighten rotates the footprint, and averaging four points that were
    // never rotated would soften an edge along one diagonal and not the other.
    let start = edit.region_origin + (pos - float2(0.5)) * scale;

    var sum = float3(0.0);
    if (FROM_FRAME) {
        let last = float2(float(edit.width) - 1.0, float(edit.height) - 1.0);
        for (uint ty = 0; ty < 2; ty = ty + 1) {
            for (uint tx = 0; tx < 2; tx = tx + 1) {
                let sample = geometry_at(start + (float2(float(tx), float(ty)) + 0.5) * 0.5 * scale) / shrink;
                // **Nothing, rather than the nearest edge.** The gather leaves an output pixel black
                // where its source falls outside the frame (`warp.slang`'s `gathered`), and a geometry
                // that reaches outside is not the exception: a straighten leaves wedges at the
                // corners and a keystone leaves them down whole sides. Clamping smears the edge row
                // across them, which is not what the rendition of the same edit shows.
                if (outside(sample, last)) {
                    continue;
                }
                sum = sum + nits_cubic(sample, last);
            }
        }
    } else {
        // At least 1: the host only selects this pipeline when the ratio calls for it, and a
        // level of -1 is not a thing to read.
        let level = max(int(lod) - 1, 0);
        uint pw;
        uint ph;
        uint levels;
        pyramid.GetDimensions(uint(level), pw, ph, levels);
        let last = float2(float(pw), float(ph)) - float2(1.0);
        for (uint ty = 0; ty < 2; ty = ty + 1) {
            for (uint tx = 0; tx < 2; tx = tx + 1) {
                let sample = geometry_at(start + (float2(float(tx), float(ty)) + 0.5) * 0.5 * scale) / shrink;
                if (outside(sample, last)) {
                    continue;
                }
                sum = sum + pyramid_cubic(sample, last, level);
            }
        }
    }
    return measured<SceneNits>(sum * 0.25);
}

/// Where in the frame a canvas pixel is looking, in the frame's own pixels.
///
/// The centre of what `covered` averages, not one of its taps: the presence sliders read a
/// blur whose finest band is a 512th of the frame, so a canvas pixel's own footprint is
/// inside one texel of it at any zoom the reader can reach.
float2 frame_at(float2 pos)
{
    let scale = edit.region_size / edit.canvas_size;
    let centre = edit.region_origin + (pos - float2(0.5)) * scale + 0.5 * scale;
    return geometry_at(centre);
}

[shader("vertex")]
float4 vs(uint i : SV_VertexID) : SV_Position
{
    float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    return float4(corners[i], 0.0, 1.0);
}

/// What an extended-range canvas takes: Display P3 over the browser's own reference white,
/// which is a constant rather than this target's peak (§7.1).
Colour<P3Linear> on_the_canvas(Colour<DisplayNits> nits)
{
    return measured<P3Linear>(mul(R2020_TO_P3, nits.v) / edit.sdr_white);
}

/// The same picture through what an sRGB rendition can hold, and back out to the canvas.
///
/// `Signal` then `SrgbLinear`, which is the pair `coded_at` crosses for the file itself, in that
/// order and against the same `edit.peak`: the clip below is where that file's gamut ends, so
/// normalising against anything else would draw a clip the file does not have.
///
/// Clamped rather than sign-carried, as the file is - what `transfer` keeps a sign for is the
/// unproofed draw, where an out-of-P3 component is better seen than folded back over zero.
Colour<P3Linear> proofed(float3 share)
{
    let signal = measured<Signal>(mapped(share, SrgbCube(), edit.intent));
    let linear = measured<SrgbLinear>(mul(R2020_TO_SRGB, signal.v));
    return measured<P3Linear>(mul(R2020_TO_P3, mul(SRGB_TO_R2020, saturate(linear.v))));
}

/// What an sRGB file holds of this pixel before its gamut is reached, as a share of its white: the
/// rendition's own roll-off for perceptual, and the grade unrolled for relative colorimetric.
float3 srgb_share(Colour<SceneNits> scene, float2 at)
{
    if (edit.intent == INTENT_PERCEPTUAL) { return display_nits(scene, at).v / edit.peak; }
    return print_signal(scene, at);
}

/// The display transform is the one stage with no CPU counterpart: a rendition is tagged
/// Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor
/// absolute luminance, so what the media path declares this has to compute (§7.1, §7.2).
[shader("fragment")]
float4 fs(float4 pos : SV_Position) : SV_Target
{
    let scene = covered(pos.xy);
    let at = frame_at(pos.xy);
    if (edit.output != OUTPUT_SRGB) { return float4(srgb_oetf_signed(on_the_canvas(display_nits(scene, at)).v), 1.0); }
    return float4(srgb_oetf_signed(proofed(srgb_share(scene, at)).v), 1.0);
}

float3 print_sample(float2 at, float lod)
{
    let shrink = exp2(lod);
    let source = at / shrink;
    if (lod < 1.0) {
        let last = float2(float(edit.width), float(edit.height)) - 1.0;
        return outside(source, last) ? float3(0.0) : nits_cubic(source, last);
    }
    uint width;
    uint height;
    uint levels;
    let level = int(lod) - 1;
    pyramid.GetDimensions(uint(level), width, height, levels);
    let last = float2(float(width), float(height)) - 1.0;
    return outside(source, last) ? float3(0.0) : pyramid_cubic(source, last, level);
}

float3 print_filtered(float2 source, float2 dx, float2 dy)
{
    let a = dx.x * dx.x + dy.x * dy.x;
    let b = dx.x * dx.y + dy.x * dy.y;
    let c = dx.y * dx.y + dy.y * dy.y;
    let eigenvalue = 0.5 * (a + c + sqrt((a - c) * (a - c) + 4.0 * b * b));
    let major = exactly<Drawn>(sqrt(max(eigenvalue, 1e-12)));
    let minor = exactly<Drawn>(abs(dx.x * dy.y - dx.y * dy.x) / major.d);
    let width = exactly<Drawn>(max(max(minor.d, major.d / 16.0), 1.0));
    let lod = clamp(log2(width.d), 0.0, float(edit.max_lod));
    let lower = floor(lod);
    let upper = min(lower + 1.0, float(edit.max_lod));
    let count = uint(clamp(ceil(major.d / width.d), 1.0, 16.0));
    let axis = a >= c ? float2(eigenvalue - c, b) : float2(b, eigenvalue - a);
    let direction = dot(axis, axis) > 1e-12 ? normalize(axis) : float2(1.0, 0.0);
    let reach = direction * major.d;
    var sum = float3(0.0);
    for (uint i = 0; i < count; i += 1) {
        let at = source + ((float(i) + 0.5) / float(count) - 0.5) * reach;
        let first = print_sample(at, lower);
        let second = lod == lower ? first : print_sample(at, upper);
        sum += lerp(first, second, lod - lower);
    }
    return sum / float(count);
}

/// The graded colour as a share of the target's white, its highlights brought under it as the
/// intent asks. Its gamut is the target's to reach: `mapped` for a file, the print's reflectance for paper.
float3 print_signal(Colour<SceneNits> nits, float2 at)
{
    let matched = edit.matched != 0;
    let exposure = gain_of(stops(edit.exposure));
    let scene_peak = matched ? measured<DisplayNits>(peak_out[0]) : measured<DisplayNits>(neutral_peak().v * exposure.g);
    // The neutral arm unrolled, as the matched arm arrives: `toned` is the roll-off.
    let graded = within(matched ? matched_nits(nits, at) : in_gamut(neutral_unrolled(nits, at)), scene_peak);
    return toned(graded, scene_peak, measured<DisplayNits>(edit.peak), edit.intent);
}

/// `step` lengthened to `reach` where it is shorter, keeping its direction.
float2 at_least(float2 step, float reach)
{
    let length_now = length(step);
    return length_now >= reach || length_now == 0.0 ? step : step * (reach / length_now);
}

/// The colour the print is sent at `pixel`, as a share of paper white in Rec.2020, averaged over
/// what the printer's own resolution and its ink's spread merge into one mark.
float3 print_ink(float2 pixel, float2 dx, float2 dy)
{
    let bounded = clamp(pixel, float2(0.0), float2(float(edit.output_width), float(edit.output_height)));
    let merged_dx = at_least(dx, edit.print_blur);
    let merged_dy = at_least(dy, edit.print_blur);
    let source = geometry_at(bounded);
    let source_dx = geometry_at(bounded + merged_dx) - source;
    let source_dy = geometry_at(bounded + merged_dy) - source;
    return print_signal(measured<SceneNits>(print_filtered(source, source_dx, source_dy)), source);
}

[shader("fragment")]
float4 fs_print_pigment(float4 pos : SV_Position) : SV_Target
{
    let scale = edit.region_size / edit.canvas_size;
    let pixel = edit.region_origin + pos.xy * scale;
    return float4(print_ink(pixel, float2(scale.x, 0.0), float2(0.0, scale.y)), 1.0);
}

/// The print as a soft proof rather than an object: the pigment laid on the paper and read under a
/// light that puts a perfect white reflector at diffuse white, with nothing of the room, the lamp
/// or the sheet's shape in it.
[shader("fragment")]
float4 fs_print_flat(float4 pos : SV_Position) : SV_Target
{
    let scale = edit.region_size / edit.canvas_size;
    let pixel = edit.region_origin + pos.xy * scale;
    let shape = float2(float(edit.output_width), float(edit.output_height));
    if (any(pixel < float2(0.0)) || any(pixel > shape)) { return float4(0.0, 0.0, 0.0, 1.0); }
    let reflectance = print_reflectance(print_ink(pixel, float2(scale.x, 0.0), float2(0.0, scale.y)), false);
    return float4(srgb_oetf_signed(on_the_canvas(measured<DisplayNits>(reflectance * edit.peak)).v), 1.0);
}

bool print_inked(PrintHit hit)
{
    return hit.normal.z > 0.5 && (print.framing.x < 0.5 || print.illumination.w > 0.5 || hit.material == PHOTO);
}

float3 print_hit_reflected(PrintHit hit, float3 inked, float2 footprint)
{
    let reflectance = print_inked(hit) ? inked : print_reflectance(float3(1.0), true);
    return reflected_print(reflectance, hit, footprint).v;
}

/// `uv` and a count of one where `sample` shows the photo, for averaging where the ink is read.
float3 print_inked_at(PrintHit sample)
{
    return sample.hit && print_inked(sample) ? float3(sample.uv, 1.0) : float3(0.0);
}

float3 print_edge_sample(PrintHit sample, float3 inked, float2 footprint, float3 background)
{
    if (!sample.hit) { return background; }
    return print_hit_reflected(sample, inked, footprint) * print_exposure().g;
}

bool print_near_frame_edge(float2 point, float2 half, float2 footprint)
{
    let reach = max(footprint, float2(1e-7));
    return all(abs(point) <= half + reach) && any(abs(abs(point) - half) <= reach);
}

bool print_internal_edge(PrintHit hit, float2 footprint)
{
    if (hit.material == BACK || hit.view.z <= 0.0) { return false; }
    let mat_point = hit.position.xy + hit.view.xy * ((frame_mat_depth() - hit.position.z) / hit.view.z);
    let rim_point = hit.position.xy + hit.view.xy * ((frame_front_depth() - hit.position.z) / hit.view.z);
    let aperture = frame_aperture(hit.half);
    return print_near_frame_edge(hit.position.xy, hit.half, footprint)
        || print_near_frame_edge(mat_point, hit.half, footprint)
        || print_near_frame_edge(hit.position.xy, aperture, footprint)
        || print_near_frame_edge(rim_point, aperture, footprint);
}

Colour<DisplayNits> print_nits(float2 pos)
{
    let scene = print_scene_nits(pos);
    if (print.illumination.w > 0.5) { return scene; }
    let shape = float2(float(edit.output_width), float(edit.output_height));
    return measured<DisplayNits>(scene.v + print_flare(pos, edit.canvas_size, shape) * print_exposure().g);
}

Colour<DisplayNits> print_scene_nits(float2 pos)
{
    let shape = float2(float(edit.output_width), float(edit.output_height));
    PrintHit hit;
    float2 paper_dx;
    float2 paper_dy;
    float2 pixel;
    float2 dx;
    float2 dy;
    var background = float3(0.0);
    if (print.illumination.w > 0.5) {
        let scale = edit.region_size / edit.canvas_size;
        pixel = edit.region_origin + pos * scale;
        hit = paper_surface_hit(pixel / shape, shape);
        dx = float2(scale.x, 0.0);
        dy = float2(0.0, scale.y);
        paper_dx = dx / shape;
        paper_dy = dy / shape;
    } else {
        hit = paper_covered(pos, edit.canvas_size, shape);
        background = print_background().v;
        if (hit.coverage == 0.0) { return measured<DisplayNits>(background); }
        let center_uv = paper_uv(pos, edit.canvas_size, shape, hit);
        paper_dx = paper_uv(pos + float2(1.0, 0.0), edit.canvas_size, shape, hit) - center_uv;
        paper_dy = paper_uv(pos + float2(0.0, 1.0), edit.canvas_size, shape, hit) - center_uv;
        pixel = hit.uv * shape;
        dx = paper_dx * shape;
        dy = paper_dy * shape;
    }
    var footprint = 2.0 * (abs(paper_dx) + abs(paper_dy)) * shape / max(shape.x, shape.y);
    let exposure = print_exposure().g;
    let edge = print.framing.x > 0.5 && print.illumination.w < 0.5 && hit.coverage == 1.0 && print_internal_edge(hit, footprint);
    if (edge) {
        var photo_plane = hit;
        photo_plane.normal = float3(0.0, 0.0, 1.0);
        photo_plane.position.z = 0.0;
        let center_uv = paper_uv(pos, edit.canvas_size, shape, photo_plane);
        dx =(paper_uv(pos + float2(1.0, 0.0), edit.canvas_size, shape, photo_plane) - center_uv) * shape;
        dy = (paper_uv(pos + float2(0.0, 1.0), edit.canvas_size, shape, photo_plane) - center_uv) * shape;
        footprint = 2.0 * (abs(dx) + abs(dy)) / max(shape.x, shape.y);
    }
    // Graded once for the pixel, not per edge sample: D3D12 compiles every inlined copy of the
    // grade, and four of them are a 20 second first draw.
    if (!edge) {
        let inked = print_inked(hit) ? print_reflectance(print_ink(pixel, dx, dy), true) : float3(1.0);
        return measured<DisplayNits>(lerp(background, print_hit_reflected(hit, inked, footprint) * exposure, hit.coverage));
    }
    let a = paper_hit(pos + float2(-0.25, -0.25), edit.canvas_size, shape);
    let b = paper_hit(pos + float2(0.25, -0.25), edit.canvas_size, shape);
    let c = paper_hit(pos + float2(-0.25, 0.25), edit.canvas_size, shape);
    let d = paper_hit(pos + float2(0.25, 0.25), edit.canvas_size, shape);
    let photo = print_inked_at(a) + print_inked_at(b) + print_inked_at(c) + print_inked_at(d);
    let inked = photo.z > 0.0 ? print_reflectance(print_ink(photo.xy / photo.z * shape, dx, dy), true) : float3(1.0);
    let sum = print_edge_sample(a, inked, footprint, background)
        + print_edge_sample(b, inked, footprint, background)
        + print_edge_sample(c, inked, footprint, background)
        + print_edge_sample(d, inked, footprint, background);
    return measured<DisplayNits>(sum * 0.25);
}

[shader("fragment")]
float4 fs_print(float4 pos : SV_Position) : SV_Target
{
    let nits = print_displayed(print_nits(pos.xy));
    return float4(srgb_oetf_signed(on_the_canvas(nits).v), 1.0);
}

[shader("fragment")]
uint4 fs_print_pq(float4 pos : SV_Position) : SV_Target
{
    let nits = print_displayed(print_nits(pos.xy));
    let codes = float3(pq(measured<DisplayNits>(nits.v.r)).v, pq(measured<DisplayNits>(nits.v.g)).v,
        pq(measured<DisplayNits>(nits.v.b)).v);
    return uint4(uint3(round(codes * 65535.0)), 65535);
}

/// One pixel of the frame as a rendition would hold it, in the `u16` counts every output
/// stage of this shader ends in.
///
/// **Through `geometry_at`, exactly as `fs` draws it**, which is what makes this the same picture
/// the reader was looking at rather than a cousin of it. `pixel` indexes the *output* - what the
/// crop and the turn produce - and the frame is read where that output pixel came from.
///
/// One tap set rather than `covered`'s four: this runs at 1:1, so a pixel's footprint is one
/// source pixel and averaging inside it would be a blur the gather it stands in for never applied.
/// On an identity geometry `geometry_at` returns the position untouched, and `nits_cubic` at a
/// pixel's own centre has weights `(0, 1, 0, 0)` - so an uncropped frame is the pixel itself, bit
/// for bit, and the parity fixtures do not move.
float3 coded_at(uint pixel)
{
    let out_width = max(edit.output_width, 1);
    let at = geometry_at(float2(float(pixel % out_width), float(pixel / out_width)) + float2(0.5));
    let last = float2(float(edit.width) - 1.0, float(edit.height) - 1.0);
    // Black where the output reaches off the frame, which is the wedge a straighten leaves at the
    // corners and the band a keystone leaves down a whole side. The gather this stands in for leaves
    // those pixels as they started (`warp.slang`'s `gathered`); clamping to the edge row instead
    // smears it across them.
    var scene = float3(0.0);
    if (!outside(at, last)) {
        scene = nits_cubic(at, last);
    }
    // An sRGB file's gamut is reached before the quantisation, since relative colorimetric's
    // unrolled highlights sit above what the `u16` holds.
    if (edit.output == OUTPUT_SRGB) {
        let signal = mapped(srgb_share(measured<SceneNits>(scene), at), SrgbCube(), edit.intent);
        let linear = measured<SrgbLinear>(mul(R2020_TO_SRGB, round(saturate(signal) * 65535.0) / 65535.0));
        let clamped = clamp(linear.v, 0.0, 1.0);
        return round(float3(srgb_oetf(clamped.r), srgb_oetf(clamped.g), srgb_oetf(clamped.b)) * 255.0);
    }
    let nits = display_nits(measured<SceneNits>(scene), at);
    // Through the `u16` the CPU writes between the grade and the transfer. Not incidental:
    // both of its output stages read that integer - the PQ one as a 65536-entry table keyed
    // by it, the sRGB one as the value it takes the primaries of - so a frame that skipped
    // the quantisation would not be the frame the fixture pins.
    //
    // **`Signal`, so 1.0 is the target's peak and not a brightness.** `job::peak_nits` puts an SDR
    // target's at diffuse white and a PQ target's at the mastering peak, which is why the branches
    // below multiply it back before coding rather than treating this as a light.
    let quantised =
        measured<Signal>(round(min(nits.v / edit.peak, float3(1.0)) * 65535.0) / 65535.0);

    if (edit.output == OUTPUT_ROLLED) {
        return quantised.v * 65535.0;
    }
    return round(float3(
        pq(measured<DisplayNits>(quantised.v.r * edit.peak)).v,
        pq(measured<DisplayNits>(quantised.v.g * edit.peak)).v,
        pq(measured<DisplayNits>(quantised.v.b * edit.peak)).v) * 65535.0);
}

/// The same frame as a rendition would hold it, at full resolution whatever the canvas is
/// showing, **two pixels to an invocation and packed two components to a word**.
///
/// Off the tick's path entirely - the display never wants this - and here rather than in
/// the harness that reads it so that ST 2084 keeps one implementation in this repo, and
/// so that what parity compares is the pixel `fs` draws rather than a cousin of it.
///
/// Every value this writes fits a `u16` - both output stages above end in a `round` into
/// 0..65535 or 0..255 - so a word per component spent half of the largest allocation in the
/// job on leading zeroes. It is the largest: `pixels * 3 * 4` for the output and the same
/// again for the buffer it is read back through, which is 732MB *each* at 61MP and is held
/// across the AVIF encode. Packed, that is 366MB each.
///
/// **Two pixels because three `u16` do not divide a word.** Per pixel, an invocation would
/// own one and a half words and have to read-modify-write the half its neighbour owns the
/// other half of, which is a race. Six halves is three whole words, owned outright, and no
/// atomics.
///
/// Dispatched over a linear index rather than over `x` and `y`: two adjacent pixels straddle
/// a row end freely, since the frame's buffer has no rows, and a 61MP frame needs 476k
/// workgroups where one dimension allows 65535.
[shader("compute")]
[numthreads(64, 1, 1)]
void encode(uint3 id : SV_DispatchThreadID)
{
    let first = linear(id) * 2;
    // The *output's* pixels, not the frame's: a crop writes fewer than it reads.
    let pixels = edit.output_width * edit.band_rows;
    if (first >= pixels) { return; }
    let skipped = edit.band_top * edit.output_width;

    let a = coded_at(skipped + first);
    // The odd pixel out of an odd frame writes zeroes into a half-word nothing reads. The
    // buffer is sized for it, so this is padding rather than an overrun.
    var b = float3(0.0);
    if (first + 1 < pixels) { b = coded_at(skipped + first + 1); }

    let base = first + first / 2;
    counts[base] = uint(a.r) | (uint(a.g) << 16);
    counts[base + 1] = uint(a.b) | (uint(b.r) << 16);
    counts[base + 2] = uint(b.g) | (uint(b.b) << 16);
}
