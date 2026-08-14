// Longitudinal chromatic aberration, taken off the frame where it already is.
//
// `image::defringe` subtracts a multiple of luma's curvature from the two chroma differences, and
// `recombine` solves the luma equation for green so the correction cannot move brightness. Both
// of those are per-pixel, so composing them algebraically leaves one add per channel:
//
//   R -= k_red  * lap * FULL
//   B -= k_blue * lap * FULL
//   G += (LUMA.r * k_red + LUMA.b * k_blue) / LUMA.g * lap * FULL
//
// which is the whole stage. What the CPU spends its time on is not this arithmetic - it is
// splitting an interleaved frame into three `f32` planes, filtering them in strips with a halo
// each, and interleaving them back. A shader reads the frame where it lies, so none of that
// exists here: no planes, no strips, no carry, no seam to get wrong.
//
// `LUMA` arrives as a uniform rather than being written out again. It is one rule and the host
// already holds it; a second copy here is the kind that stays right until somebody retunes one.

struct Params {
  width: u32,
  height: u32,
  k_red: f32,
  k_blue: f32,
  /// `image::LUMA`, and `full` is what a sample's range is - 65535 for the `u16` frame.
  luma: vec3f,
  full: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> frame: array<u32>;
@group(0) @binding(2) var<storage, read_write> luma: array<f32>;

fn sample_at(at: u32) -> f32 {
  let word = frame[at / 2u];
  return f32(select(word >> 16u, word & 0xffffu, (at & 1u) == 0u));
}

fn level_of(value: f32) -> u32 {
  return u32(round(clamp(value, 0.0, params.full)));
}

/// Phase 1: luma, into a plane of its own.
///
/// **Its own pass, and its own plane, because the correction reads neighbours.** The transform is
/// luma-preserving in exact arithmetic, so reading luma back out of a half-written frame would
/// almost work - but the frame is `u16` and every write rounds, so the curvature would be taken
/// from a mixture of rounded and unrounded neighbours and the answer would depend on which
/// invocation ran first. The CPU takes every Laplacian from one unmodified plane; so does this.
@compute @workgroup_size(64)
fn defringe_luma(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let at = linear(id, groups);
  if (at >= params.width * params.height) { return; }
  let p = at * 3u;
  let rgb = vec3f(sample_at(p), sample_at(p + 1u), sample_at(p + 2u));
  luma[at] = dot(params.luma, rgb) / params.full;
}

/// One pixel's three samples, corrected.
///
/// The stencil clamps at the frame's edge, as `image::laplacian` does with its saturating
/// indices - a border pixel reads itself for the neighbour it does not have, which makes the
/// second difference zero there rather than a step.
fn corrected(pixel: u32) -> vec3f {
  let x = pixel % params.width;
  let y = pixel / params.width;

  let here = luma[pixel];
  let left = luma[y * params.width + max(x, 1u) - 1u];
  let right = luma[y * params.width + min(x + 1u, params.width - 1u)];
  let up = luma[(max(y, 1u) - 1u) * params.width + x];
  let down = luma[min(y + 1u, params.height - 1u) * params.width + x];
  let curvature = left + right + up + down - 4.0 * here;

  // Green moves the other way, and by the amount that holds luma still: `recombine` solves
  // `LUMA . (dr, dg, db) = 0` for green, so whatever the other two lose it takes on.
  let green = (params.luma.r * params.k_red + params.luma.b * params.k_blue) / params.luma.g;
  let shift = vec3f(-params.k_red, green, -params.k_blue) * curvature * params.full;

  let p = pixel * 3u;
  return vec3f(sample_at(p), sample_at(p + 1u), sample_at(p + 2u)) + shift;
}

/// Phase 2: the correction, a pair of pixels at a time.
///
/// **A pair, because three samples do not fill a whole number of words and two pixels do.** A
/// sample is sixteen bits and the smallest thing a shader can address is thirty-two, so a
/// per-pixel invocation would have to read a word, replace one half and write it back - and the
/// word holding a pixel's last sample also holds its neighbour's first. Two invocations would
/// race on it, and the loser's correction would be dropped. Six samples are exactly three words,
/// owned by nobody else.
@compute @workgroup_size(64)
fn defringe_apply(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let pair = linear(id, groups);
  let pixels = params.width * params.height;
  let first = pair * 2u;
  if (first >= pixels) { return; }

  let a = corrected(first);
  // The odd tail: a frame with an odd pixel count leaves the last pair half empty, and the three
  // samples that are not there must not be written over the ones that are.
  var b = vec3f(0.0);
  let paired = first + 1u < pixels;
  if (paired) {
    b = corrected(first + 1u);
  }

  let word = pair * 3u;
  frame[word] = level_of(a.r) | (level_of(a.g) << 16u);
  if (paired) {
    frame[word + 1u] = level_of(a.b) | (level_of(b.r) << 16u);
    frame[word + 2u] = level_of(b.g) | (level_of(b.b) << 16u);
  } else {
    frame[word + 1u] = (frame[word + 1u] & 0xffff0000u) | level_of(a.b);
  }
}
