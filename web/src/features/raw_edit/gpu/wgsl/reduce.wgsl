// The pyramid the draw averages with, built once at the open, 2x2 at a time.
//
// Because the draw has to average whatever the reader has zoomed out to, and doing that
// with taps alone is quadratic in the zoom: measured at 9ms for one tap and 71ms for
// sixteen on the same 61MP frame, which is not the sixteen-fold the sample count
// suggests. Scattered gathers are latency, not bandwidth, and the loop cannot hide it. A
// pyramid moves the work to the open, where it is one linear pass over 1.33 frames, and
// leaves every draw sampling at a level where four taps is the whole answer.
//
// It starts at half resolution, so the frame itself is not stored twice. That costs a
// third of half a frame rather than a third of a whole one - 160MB against 481 at 61MP -
// and the level it leaves out is the one the draw reads straight from the buffer anyway.
//
// Averaged in scene-linear levels, which is the space the optics averaged in, and rounded
// rather than truncated so a flat field does not drift down a count per level.

@group(0) @binding(1) var<storage, read> frame: array<u32>;
@group(0) @binding(2) var coarser: texture_2d<u32>;
@group(0) @binding(3) var finer: texture_storage_2d<rgba16uint, write>;

fn sample_at(index: u32) -> u32 {
  let word = frame[index / 2u];
  return select(word & 0xffffu, word >> 16u, (index & 1u) == 1u);
}

/// The frame's levels at a pixel, held inside it.
fn level_at(x: u32, y: u32) -> vec4u {
  let cx = min(x, tick.width - 1u);
  let cy = min(y, tick.height - 1u);
  let base = (cy * tick.width + cx) * 3u;
  return vec4u(sample_at(base), sample_at(base + 1u), sample_at(base + 2u), 65535u);
}

/// The pyramid's own first level, from the frame's buffer.
@compute @workgroup_size(8, 8)
fn halve(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(finer);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let sum = level_at(id.x * 2u, id.y * 2u)
    + level_at(id.x * 2u + 1u, id.y * 2u)
    + level_at(id.x * 2u, id.y * 2u + 1u)
    + level_at(id.x * 2u + 1u, id.y * 2u + 1u);
  textureStore(finer, vec2i(i32(id.x), i32(id.y)), (sum + vec4u(2u)) / 4u);
}

/// Every level after it, from the one above.
///
/// No uniform needed: `textureDimensions` of the two views says which level this is, so
/// the pass is the same code however deep the chain goes.
@compute @workgroup_size(8, 8)
fn reduce(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(finer);
  if (id.x >= size.x || id.y >= size.y) { return; }

  // Clamped rather than assumed even: an odd level halves to one whose last row and
  // column have a single parent, and reading past the edge is a zero that darkens it.
  let edge = textureDimensions(coarser) - vec2u(1u);
  let lo = min(id.xy * 2u, edge);
  let hi = min(id.xy * 2u + vec2u(1u), edge);
  let sum = textureLoad(coarser, vec2u(lo.x, lo.y), 0)
    + textureLoad(coarser, vec2u(hi.x, lo.y), 0)
    + textureLoad(coarser, vec2u(lo.x, hi.y), 0)
    + textureLoad(coarser, vec2u(hi.x, hi.y), 0);
  textureStore(finer, vec2i(i32(id.x), i32(id.y)), (sum + vec4u(2u)) / 4u);
}
