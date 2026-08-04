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
@group(0) @binding(6) var<storage, read_write> counts: array<u32>;

// Rec.2020 to Display P3, both D65, applied in linear light. Rows sum to 1.
const R2020_TO_P3 = mat3x3f(
  vec3f( 1.343354, -0.065295,  0.002821),
  vec3f(-0.282219,  1.075589, -0.019598),
  vec3f(-0.061397, -0.010491,  1.016761),
);

fn display_nits(level: vec3f) -> vec3f {
  return min(max(rolled_off(level), vec3f(0.0)), vec3f(tick.peak));
}

/// The roll-off leaves the display's peak alone when the scene already fits inside it, so
/// the clamp above is not redundant: a level past `source_level` comes back untouched.
fn rolled_off(level: vec3f) -> vec3f {
  if (tick.matched == 0u) { return neutral_nits(level); }
  let scene_peak = peak_out[0];
  // Clamped to the scene peak before the roll-off, because the CPU's roll table spans
  // 0..scene_peak and reads the top bin for anything past it. Without the clamp the
  // brightest pixels get a curve the CPU never evaluates.
  let coloured = min(max(matched_nits(level), vec3f(0.0)), vec3f(scene_peak));
  return rolled(coloured, rolloff(scene_peak, tick.peak));
}

/// The sRGB transfer with the sign carried, so an out-of-P3 component survives as a
/// negative rather than folding back over zero.
fn transfer(v: f32) -> f32 {
  let a = abs(v);
  let e = select(1.055 * pow(a, 1.0 / 2.4) - 0.055, a * 12.92, a <= 0.0031308);
  return sign(v) * e;
}

fn level_at(x: i32, y: i32) -> vec3f {
  let code = textureLoad(source, vec2i(x, y), 0);
  return vec3f(f32(code.r), f32(code.g), f32(code.b));
}

/// The source levels one canvas pixel covers, averaged.
///
/// Fit-to-window on a 61MP frame is about eight source pixels to one along each axis, and
/// point-sampling that is aliasing rather than a picture. Averaged before the grade, not
/// after: the levels are scene-linear, which is the space the optics did their own
/// averaging in, where display-referred nits are past a tone curve and would not add up.
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
fn covered(pos: vec2f) -> vec3f {
  let scale = tick.region_size / tick.canvas_size;
  let lod = clamp(floor(log2(max(max(scale.x, scale.y), 1.0))), 0.0, f32(tick.max_lod));
  let shrink = exp2(lod);
  let level = i32(lod);
  let last = vec2f(textureDimensions(source, level)) - vec2f(1.0);

  let step = scale / shrink;
  let start = (tick.region_origin + (pos - vec2f(0.5)) * scale) / shrink;

  var sum = vec3f(0.0);
  for (var ty = 0u; ty < 2u; ty = ty + 1u) {
    for (var tx = 0u; tx < 2u; tx = tx + 1u) {
      let sample = start + (vec2f(f32(tx), f32(ty)) + 0.5) * 0.5 * step;
      let coord = vec2u(clamp(floor(sample), vec2f(0.0), last));
      let code = textureLoad(source, coord, level);
      sum = sum + vec3f(f32(code.r), f32(code.g), f32(code.b));
    }
  }
  return sum * 0.25;
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(corners[i], 0.0, 1.0);
}

/// The display transform is the one stage with no CPU counterpart: a rendition is tagged
/// Rec.2020 PQ and handed to a compositor, where a canvas has neither Rec.2020 nor
/// absolute luminance, so what the media path declares this has to compute (§7.1, §7.2).
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p3 = (R2020_TO_P3 * display_nits(covered(pos.xy))) / tick.sdr_white;
  return vec4f(transfer(p3.r), transfer(p3.g), transfer(p3.b), 1.0);
}

/// The same frame as a rendition would hold it: `u16` counts of PQ, at full resolution
/// whatever the canvas is showing.
///
/// Off the tick's path entirely - the display never wants this - and here rather than in
/// the harness that reads it so that ST 2084 keeps one implementation in this repo, and
/// so that what parity compares is the pixel `fs` draws rather than a cousin of it.
@compute @workgroup_size(8, 8)
fn encode(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let nits = display_nits(level_at(i32(id.x), i32(id.y)));
  // Through the `u16` the CPU writes between the grade and the PQ. Not incidental: its PQ
  // stage is a 65536-entry table keyed by that integer, so a frame that skipped the
  // quantisation would not be the frame the fixture pins.
  let quantised = round(min(nits / tick.peak, vec3f(1.0)) * 65535.0) / 65535.0;
  let coded = round(vec3f(
    pq(quantised.r * tick.peak),
    pq(quantised.g * tick.peak),
    pq(quantised.b * tick.peak),
  ) * 65535.0);

  let base = at(id.x, id.y) * 3u;
  counts[base] = u32(coded.r);
  counts[base + 1u] = u32(coded.g);
  counts[base + 2u] = u32(coded.b);
}
