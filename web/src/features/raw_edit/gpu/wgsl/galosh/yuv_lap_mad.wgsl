// A plane's noise, as the median of its horizontal Laplacians.
//
// `yuv_lap_mad.comp`. Run twice: once on the luma to seed the noise model, and again on the
// stabilised luma to find the scale the shrinkage works in.
//
// The reference writes every sample to a scratch buffer and then runs a *serial* Hoare
// quickselect on one invocation, because bit-faithfulness to its CPU twin is the point
// there. One lane partitioning two hundred thousand floats is not something to put in a
// browser's frame budget, so this asks the same question a different way: binary search on
// the IEEE bit patterns, which are monotonic in the value for non-negative floats, with the
// whole workgroup counting each round. The answer is the same k-th smallest magnitude - it
// is exact, not sampled - and nothing has to be stored.

@group(0) @binding(0) var<storage, read> plane: array<f32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
  x_stride: i32,
  result_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const WG: i32 = 256;

var<workgroup> counted: array<i32, 256>;

/// The reference's sampling grid, kept exactly: a three-tap Laplacian every `x_stride`
/// columns, over as many rows as it takes to reach the sample budget.
fn laplacian_at(n_per_row: i32, at: i32) -> f32 {
  let y = at / n_per_row;
  let x = (at % n_per_row) * pc.x_stride;
  let row = y * pc.width + x;
  return abs(plane[row] - 2.0 * plane[row + 2] + plane[row + 4]);
}

@compute @workgroup_size(256)
fn yuv_lap_mad(@builtin(local_invocation_id) local: vec3u) {
  let lid = i32(local.x);
  let n_per_row = (pc.width - 4 + pc.x_stride - 1) / pc.x_stride;
  var n_samples = 0;
  if (n_per_row > 0) {
    // Bounded to the rows that exist, which the reference's row loop does implicitly.
    n_samples = min(min((pc.width * pc.height) / 6, 200000), n_per_row * pc.height);
  }

  let rank = n_samples / 2;
  var lo = 0u;
  var hi = 0x7f800000u;
  // Thirty-two halvings of a 32-bit range settle it, and a fixed trip count is what keeps
  // the barriers below in uniform control flow - a `while (lo < hi)` whose bound comes out
  // of workgroup memory does not.
  for (var round = 0; round < 32; round++) {
    let mid = lo + (hi - lo) / 2u;
    var mine = 0;
    for (var at = lid; at < n_samples; at += WG) {
      if (bitcast<u32>(laplacian_at(n_per_row, at)) <= mid) {
        mine++;
      }
    }
    counted[lid] = mine;
    workgroupBarrier();
    for (var s = WG >> 1u; s > 0; s >>= 1u) {
      if (lid < s) {
        counted[lid] += counted[lid + s];
      }
      workgroupBarrier();
    }
    let total = counted[0];
    workgroupBarrier();
    if (lo < hi) {
      if (total > rank) { hi = mid; } else { lo = mid + 1u; }
    }
  }

  if (lid == 0) {
    if (n_samples < 1) {
      params[pc.result_slot] = 0.01;
      return;
    }
    // A three-tap Laplacian on iid noise has variance 6 sigma², so sigma = MAD/(0.6745·√6).
    params[pc.result_slot] = max(bitcast<f32>(lo) / 1.6521, 0.01);
  }
}
