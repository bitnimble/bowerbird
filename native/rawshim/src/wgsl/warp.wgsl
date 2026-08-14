// The lens correction, as the gather it already is.
//
// `image::PlanarWarp::map_u16` reads each output pixel from a radius the lens moved it to, taps
// four by four through Catmull-Rom, and lifts the falloff back in on the way out. Every output
// pixel is independent and reads only the source, which is what makes it a compute dispatch
// rather than a strip loop - and why it is 639ms of a 61MP open that the CPU spends almost
// entirely on address arithmetic.
//
// `prelude.wgsl` is prepended by the host, for `PQ_M2` and its constants: the falloff is a
// multiplication of *light* folded into PQ's own intermediate (`tone::lift_in_pq`), so it reads
// the same five numbers the coding does.
//
// **A gather cannot run in place.** `frame` and `out` are two buffers, and every neighbour a tap
// reads is the source as it arrived.

struct Params {
  source: vec2u,
  size: vec2u,
  /// The source's centre, half a pixel back: `tap` reads a grid where an integer is a pixel's
  /// centre and the offsets below are continuous coordinates.
  centre: vec2f,
  /// Source pixels per output pixel, which the ratio multiplies into.
  scale: vec2f,
  edge: vec2f,
  /// `1 / half^2` of the output grid, since the table is indexed by r^2 and never needs r.
  inv_half2: f32,
  pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> frame: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
/// Three of `image::channel_ratio_table` end to end, red then green then blue.
@group(0) @binding(3) var<storage, read_write> ratios: array<f32>;
/// `tone::gain_in_y` per radius bucket, 1.0 where the falloff cannot move a 16-bit code.
@group(0) @binding(4) var<storage, read_write> lifts: array<f32>;

fn sample_at(at: u32) -> f32 {
  let word = frame[at / 2u];
  return f32(select(word >> 16u, word & 0xffffu, (at & 1u) == 0u));
}

fn level_of(value: f32) -> u32 {
  // Truncation, not `round`: `map_u16` quantises with `as u16`, and the editor's materialised
  // warp and the encode's gather are held to each other by that.
  return u32(clamp(value, 0.0, 65535.0));
}

/// Catmull-Rom, `image::cubic_weights`.
fn cubic_weights(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4f(
    0.5 * (-t3 + 2.0 * t2 - t),
    0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
    0.5 * (-3.0 * t3 + 4.0 * t2 + t),
    0.5 * (t3 - t2),
  );
}

/// One channel sampled at one point. The caller has checked the point is inside the source.
///
/// The stencil clamps at the border, as `image::tap_u16` does with its saturating indices: the
/// outermost ring has no full neighbourhood and the nearest sample stands in for what is off the
/// edge.
fn tap(px: f32, py: f32, channel: u32) -> f32 {
  let sw = params.source.x;
  let sh = params.source.y;
  let x0 = min(u32(px), sw - 2u);
  let y0 = min(u32(py), sh - 2u);
  let wx = cubic_weights(px - f32(x0));
  let wy = cubic_weights(py - f32(y0));
  let columns = vec4u(max(x0, 1u) - 1u, x0, min(x0 + 1u, sw - 1u), min(x0 + 2u, sw - 1u));
  let rows = vec4u(max(y0, 1u) - 1u, y0, min(y0 + 1u, sh - 1u), min(y0 + 2u, sh - 1u));

  var total = 0.0;
  for (var j = 0u; j < 4u; j++) {
    var across = 0.0;
    for (var i = 0u; i < 4u; i++) {
      across += wx[i] * sample_at((rows[j] * sw + columns[i]) * 3u + channel);
    }
    total += wy[j] * across;
  }
  return total;
}

/// `tone::lift_in_pq`: a gain in linear light applied to a PQ signal without leaving PQ.
fn lift_in_pq(signal: f32, gain_in_y: f32) -> f32 {
  let u = pow(clamp(signal, 0.0, 1.0), 1.0 / PQ_M2);
  let y = min((max(u - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * u)) * gain_in_y, 1.0);
  return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), PQ_M2);
}

/// One output pixel, read from where the lens put it.
fn gathered(pixel: u32) -> vec3f {
  let last = arrayLength(&ratios) / 3u - 1u;
  let x = pixel % params.size.x;
  let y = pixel / params.size.x;
  // Where this pixel sits relative to the frame's centre, in output pixels. `map_u16` divides
  // this by `half` and multiplies it back by `half * scale`; folding the pair away costs f32 an
  // error of a whole ulp at the frame's edge, which the taps below are steep enough to see.
  let ox = f32(x) + 0.5 - f32(params.size.x) * 0.5;
  let oy = f32(y) + 0.5 - f32(params.size.y) * 0.5;
  let r2 = (ox * ox + oy * oy) * params.inv_half2;

  let t = r2 * f32(last);
  var slot = u32(t);
  if (t >= f32(last)) { slot = last - 1u; }

  let bucket = min(u32(min(sqrt(r2) * 255.0, 255.0)), 255u);
  let gain = lifts[bucket];

  var pixel_out = vec3f(0.0);
  for (var c = 0u; c < 3u; c++) {
    let table = c * (last + 1u);
    let low = ratios[table + slot];
    let ratio = low + (ratios[table + slot + 1u] - low) * (t - f32(slot));
    let px = params.centre.x + ox * ratio * params.scale.x;
    let py = params.centre.y + oy * ratio * params.scale.y;
    // Outside the source the pixel keeps the black it started as, which is what the pair gate
    // downstream skips. Per channel, because a lateral aberration reads each at its own radius.
    if (px < 0.0 || py < 0.0 || px > params.edge.x || py > params.edge.y) { continue; }
    var value = tap(px, py, c);
    // A gain of 1 returns the tap rather than the round trip's answer to it: `lift_in_pq` is
    // `pq(pq_inv(u))` there, and that is a count out on some codes.
    if (gain != 1.0) { value = lift_in_pq(value / 65535.0, gain) * 65535.0; }
    pixel_out[c] = value;
  }
  return pixel_out;
}

/// A pair of output pixels at a time, for `defringe_apply`'s reason: three samples do not fill a
/// whole number of words and two pixels do, so a per-pixel invocation would share its last word
/// with its neighbour's first and one of the two writes would be lost.
@compute @workgroup_size(64)
fn warp_lens(@builtin(global_invocation_id) id: vec3u) {
  let pixels = params.size.x * params.size.y;
  let first = id.x * 2u;
  if (first >= pixels) { return; }

  let a = gathered(first);
  var b = vec3f(0.0);
  let paired = first + 1u < pixels;
  if (paired) {
    b = gathered(first + 1u);
  }

  let word = id.x * 3u;
  out[word] = level_of(a.r) | (level_of(a.g) << 16u);
  if (paired) {
    out[word + 1u] = level_of(a.b) | (level_of(b.r) << 16u);
    out[word + 2u] = level_of(b.g) | (level_of(b.b) << 16u);
  } else {
    out[word + 1u] = level_of(a.b);
  }
}
