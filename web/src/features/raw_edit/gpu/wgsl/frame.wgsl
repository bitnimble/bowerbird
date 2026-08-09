// Sensor levels to what the canvas takes, in one pass.
//
// There used to be a graded frame between the two: a compute pass wrote `rgba32float`
// nits and the draw read them back. That is the CPU's shape, where every stage
// materialises because the next one is a separate loop over 30M samples, and on a GPU it
// bought nothing - the value is already in a register when the next stage wants it. What
// it cost was 158MB written and 158MB read per tick, which measured as 5.2ms of a 15ms
// tick with the arithmetic in it barely visible either side.
//
// It also PQ-coded the frame on the way out and decoded it on the way in, six `pow` each
// way, because a rendition is a PQ file. The display is not a file. That encoding now
// happens only where a file is wanted, which is `encode` below.
//
// The other half of the win: this runs once per *canvas* pixel, and a canvas is the
// viewport. A 61MP frame fitted to a 2560x1707 stage costs 4.4MP of colour transform
// rather than 60, which is 7ms rather than 100.

@group(0) @binding(5) var<storage, read> peak_out: array<f32>;
// Two `u16` components to a word, which is what `encode` below says. `ceil(pixels * 3 / 2)`
// words, rounded up to a whole invocation's three.
@group(0) @binding(6) var<storage, read_write> counts: array<u32>;
// Half resolution and down, so `lod` 0 is the frame and this holds every level above it.
@group(0) @binding(9) var pyramid: texture_2d<u32>;

// Rec.2020 to Display P3, both D65, applied in linear light. Rows sum to 1.
const R2020_TO_P3 = mat3x3f(
  vec3f( 1.343354, -0.065295,  0.002821),
  vec3f(-0.282219,  1.075589, -0.019598),
  vec3f(-0.061397, -0.010491,  1.016761),
);

// `tick.output`'s values. Named here so the host and the shader cannot disagree by a
// literal, in the pattern `PEAK_BINS` and its neighbours use.
//
// `ROLLED` stops where the CPU's grade stopped: the frame after the roll-off and before
// any transfer, which is what every rendition path already passes around and encodes for
// itself. It exists so the grade can move here without moving the two encoders with it -
// the transfers above are the same arithmetic either way, and fusing them is an
// optimisation to take later rather than a prerequisite.
const OUTPUT_PQ: u32 = 0u;
const OUTPUT_SRGB: u32 = 1u;
const OUTPUT_ROLLED: u32 = 2u;

// Rec.2020 to sRGB, for an SDR *rendition* rather than for the canvas. The draw targets
// P3 because that is what a display is; a file targets sRGB because that is what everything
// reads it as. `hdr_fit::rec2020_to_srgb` derives the same matrix at runtime and
// `the_srgb_primaries_match_the_host` pins these against it, in the pattern the rest of the
// shared constants use - written out here so the file stays valid WGSL on its own.
//
// Column-major, as `mat3x3f` takes it: each `vec3f` is a column, so this transposes the
// row-major form the Rust side holds.
const R2020_TO_SRGB = mat3x3f(
  vec3f(  1.663467,  -0.125523,  -0.018099),
  vec3f( -0.587548,   1.132926,  -0.100603),
  vec3f( -0.072838,  -0.008350,   1.118998),
);

fn display_nits(nits: vec3f, uv: vec2f) -> vec3f {
  return min(max(rolled_off(nits, uv), vec3f(0.0)), vec3f(tick.peak));
}

/// The roll-off leaves the display's peak alone when the scene already fits inside it, so
/// the clamp above is not redundant: a level past `source_level` comes back untouched.
fn rolled_off(nits: vec3f, uv: vec2f) -> vec3f {
  if (tick.matched == 0u) { return neutral_nits(nits, uv); }
  let scene_peak = peak_out[0];
  // Clamped to the scene peak before the roll-off, because the CPU's roll table spans
  // 0..scene_peak and reads the top bin for anything past it. Without the clamp the
  // brightest pixels get a curve the CPU never evaluates.
  let coloured = min(max(matched_nits(nits, uv), vec3f(0.0)), vec3f(scene_peak));
  return rolled(coloured, rolloff(scene_peak, tick.peak));
}

/// The sRGB transfer with the sign carried, so an out-of-P3 component survives as a
/// negative rather than folding back over zero.
fn transfer(v: f32) -> f32 {
  let a = abs(v);
  let e = select(1.055 * pow(a, 1.0 / 2.4) - 0.055, a * 12.92, a <= 0.0031308);
  return sign(v) * e;
}

/// The source nits one canvas pixel covers, averaged.
///
/// Fit-to-window on a 61MP frame is about eight source pixels to one along each axis, and
/// point-sampling that is aliasing rather than a picture. Averaged before the grade, not
/// after: these are scene-referred, which is the space the optics did their own averaging in,
/// where display-referred nits are past a tone curve and would not add up. Decoded before the
/// average and not after, for the same reason - the buffer's coding is not linear in light.
///
/// Most of that averaging already happened, at the open, in `reduce.wgsl`. All that is
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
/// Which of the two a draw reads is an override rather than a branch, so each pipeline
/// carries one path and not the other. As a runtime branch it cost the *zoomed-out* case
/// a third of its time - 6.9ms to 9.2 at 61MP - for a path those fragments never took,
/// which is the shape of a register-pressure problem: the dead half still has to be
/// allocated for. The host picks the pipeline off the same ratio the shader computes.
override FROM_FRAME: bool = true;

fn covered(pos: vec2f) -> vec3f {
  let scale = tick.region_size / tick.canvas_size;
  let lod = clamp(floor(log2(max(max(scale.x, scale.y), 1.0))), 0.0, f32(tick.max_lod));
  let shrink = exp2(lod);
  let step = scale / shrink;
  let start = (tick.region_origin + (pos - vec2f(0.5)) * scale) / shrink;

  var sum = vec3f(0.0);
  if (FROM_FRAME) {
    let last = vec2f(f32(tick.width) - 1.0, f32(tick.height) - 1.0);
    for (var ty = 0u; ty < 2u; ty = ty + 1u) {
      for (var tx = 0u; tx < 2u; tx = tx + 1u) {
        let sample = start + (vec2f(f32(tx), f32(ty)) + 0.5) * 0.5 * step;
        let coord = vec2u(clamp(floor(sample), vec2f(0.0), last));
        sum = sum + nits_at(coord.x, coord.y);
      }
    }
  } else {
    // At least 1: the host only selects this pipeline when the ratio calls for it, and a
    // level of -1 is not a thing to read.
    let level = max(i32(lod) - 1, 0);
    let last = vec2f(textureDimensions(pyramid, level)) - vec2f(1.0);
    for (var ty = 0u; ty < 2u; ty = ty + 1u) {
      for (var tx = 0u; tx < 2u; tx = tx + 1u) {
        let sample = start + (vec2f(f32(tx), f32(ty)) + 0.5) * 0.5 * step;
        let coord = vec2u(clamp(floor(sample), vec2f(0.0), last));
        // The pyramid holds the frame's own coding, so this is decoded per tap too - the
        // levels it averaged are not linear in light and neither is a mean of them.
        let code = textureLoad(pyramid, coord, level);
        sum = sum + vec3f(
          nits_of_code[code.r],
          nits_of_code[code.g],
          nits_of_code[code.b],
        );
      }
    }
  }
  return sum * 0.25;
}

/// Where in the frame a canvas pixel is looking, normalised.
///
/// The centre of what `covered` averages, not one of its taps: the presence sliders read a
/// blur whose finest band is a 512th of the frame, so a canvas pixel's own footprint is
/// inside one texel of it at any zoom the reader can reach.
fn frame_uv(pos: vec2f) -> vec2f {
  let scale = tick.region_size / tick.canvas_size;
  return (tick.region_origin + (pos - vec2f(0.5)) * scale + 0.5 * scale)
    / vec2f(f32(tick.width), f32(tick.height));
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

/// The display transform is the one stage with no CPU counterpart: a rendition is tagged
/// Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor
/// absolute luminance, so what the media path declares this has to compute (§7.1, §7.2).
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p3 = (R2020_TO_P3 * display_nits(covered(pos.xy), frame_uv(pos.xy))) / tick.sdr_white;
  return vec4f(transfer(p3.r), transfer(p3.g), transfer(p3.b), 1.0);
}

/// One pixel of the frame as a rendition would hold it, in the `u16` counts every output
/// stage of this shader ends in.
fn coded_at(pixel: u32) -> vec3f {
  let uv = (vec2f(f32(pixel % tick.width), f32(pixel / tick.width)) + vec2f(0.5))
    / vec2f(f32(tick.width), f32(tick.height));
  let nits = display_nits(nits_of_index(pixel), uv);
  // Through the `u16` the CPU writes between the grade and the transfer. Not incidental:
  // both of its output stages read that integer - the PQ one as a 65536-entry table keyed
  // by it, the sRGB one as the value it takes the primaries of - so a frame that skipped
  // the quantisation would not be the frame the fixture pins.
  let quantised = round(min(nits / tick.peak, vec3f(1.0)) * 65535.0) / 65535.0;

  if (tick.output == OUTPUT_ROLLED) {
    return quantised * 65535.0;
  }
  if (tick.output == OUTPUT_SRGB) {
    // The primaries first, in the normalised graded domain, then the transfer at 8 bits.
    // Clamped rather than sign-carried - `transfer` keeps the sign for
    // the *draw*, where an out-of-P3 component is better seen than folded, but a file has
    // nowhere to put a negative.
    let linear = R2020_TO_SRGB * quantised;
    return round(vec3f(
      transfer(clamp(linear.r, 0.0, 1.0)),
      transfer(clamp(linear.g, 0.0, 1.0)),
      transfer(clamp(linear.b, 0.0, 1.0)),
    ) * 255.0);
  }
  return round(vec3f(
    pq(quantised.r * tick.peak),
    pq(quantised.g * tick.peak),
    pq(quantised.b * tick.peak),
  ) * 65535.0);
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
/// workgroups where one dimension allows 65535. `num_workgroups` carries the width the host
/// chose so nothing has to travel in the uniform.
@compute @workgroup_size(64)
fn encode(@builtin(global_invocation_id) id: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let first = (id.y * groups.x * 64u + id.x) * 2u;
  let pixels = tick.width * tick.height;
  if (first >= pixels) { return; }

  let a = coded_at(first);
  // The odd pixel out of an odd frame writes zeroes into a half-word nothing reads. The
  // buffer is sized for it, so this is padding rather than an overrun.
  var b = vec3f(0.0);
  if (first + 1u < pixels) { b = coded_at(first + 1u); }

  let base = first + first / 2u;
  counts[base] = u32(a.r) | (u32(a.g) << 16u);
  counts[base + 1u] = u32(a.b) | (u32(b.r) << 16u);
  counts[base + 2u] = u32(b.g) | (u32(b.b) << 16u);
}
