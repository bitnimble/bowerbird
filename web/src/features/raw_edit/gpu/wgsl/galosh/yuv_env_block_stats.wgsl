// Each 8x8 block's own noise, as the median of the Laplacians inside it.
//
// The first half of the envelope estimator. Taking one median over the whole frame - the
// reference's simpler estimator, and what this replaced - counts fine texture as noise:
// measured against this on real frames it reads **2.6 to 4.6 times high**, because on a
// detailed photograph the median pixel is not a quiet one. Per block, the quiet blocks stay
// quiet and can be picked out afterwards.
//
// No array per invocation, and that is deliberate: a 96-element scratch array indexed by a
// selection sort is what put `pass12` in scratch memory and cost it an order of magnitude.
// The median comes out of a binary search over IEEE bit patterns instead, recomputing the
// Laplacians each round - exact, and it touches nothing but registers.

@group(0) @binding(0) var<storage, read> plane: array<f32>;
@group(0) @binding(1) var<storage, read_write> blocks: array<f32>;

struct Push {
  width: i32,
  height: i32,
  n_bx: i32,
  n_by: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const BLOCK: i32 = 8;
/// 8 rows of 6 horizontal, plus 6 rows of 8 vertical.
const TAPS: i32 = 96;

fn laplacian(x0: i32, y0: i32, at: i32) -> f32 {
  if (at < 48) {
    let y = y0 + at / 6;
    let x = x0 + at % 6;
    let row = y * pc.width;
    return abs(plane[row + x] - 2.0 * plane[row + x + 1] + plane[row + x + 2]);
  }
  let vertical = at - 48;
  let y = y0 + vertical / 8;
  let x = x0 + vertical % 8;
  return abs(
    plane[y * pc.width + x] - 2.0 * plane[(y + 1) * pc.width + x] + plane[(y + 2) * pc.width + x]
  );
}

@compute @workgroup_size(64)
fn yuv_env_block_stats(@builtin(global_invocation_id) id: vec3u) {
  let block = i32(id.x);
  if (block >= pc.n_bx * pc.n_by) { return; }

  let x0 = (block % pc.n_bx) * BLOCK;
  let y0 = (block / pc.n_bx) * BLOCK;

  let rank = TAPS / 2;
  var lo = 0u;
  var hi = 0x7f800000u;
  for (var round = 0; round < 32; round++) {
    if (lo >= hi) { break; }
    let mid = lo + (hi - lo) / 2u;
    var count = 0;
    for (var at = 0; at < TAPS; at++) {
      if (bitcast<u32>(laplacian(x0, y0, at)) <= mid) { count++; }
    }
    if (count > rank) { hi = mid; } else { lo = mid + 1u; }
  }
  // A three-tap Laplacian on iid noise has variance 6 sigma².
  blocks[block] = bitcast<f32>(lo) / 1.6521;
}
