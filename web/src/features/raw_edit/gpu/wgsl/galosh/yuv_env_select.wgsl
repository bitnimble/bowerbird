// The frame's noise, as the quietest tenth of its blocks.
//
// The second half of the envelope estimator. Every block carries noise; only some of them
// carry a picture as well, and those can only read *higher*. So the low end of the
// distribution is the noise floor, and the tenth percentile is far enough in to be robust
// against a few dead-black blocks reading zero while still excluding anything textured.
//
// This is what the mosaic path's Phase 0 does with its 5th-to-20th percentile envelope,
// reduced to what a single plane needs.

@group(0) @binding(0) var<storage, read> blocks: array<f32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  count: i32,
  result_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const WG: i32 = 256;

var<workgroup> counted: array<i32, 256>;

@compute @workgroup_size(256)
fn yuv_env_select(@builtin(local_invocation_id) local: vec3u) {
  let lid = i32(local.x);
  let rank = max(pc.count / 10, 1);

  var lo = 0u;
  var hi = 0x7f800000u;
  // Fixed trip count, which is what keeps the barriers in uniform control flow.
  for (var round = 0; round < 32; round++) {
    let mid = lo + (hi - lo) / 2u;
    var mine = 0;
    for (var at = lid; at < pc.count; at += WG) {
      if (bitcast<u32>(blocks[at]) <= mid) { mine++; }
    }
    counted[lid] = mine;
    workgroupBarrier();
    for (var s = WG >> 1u; s > 0; s >>= 1u) {
      if (lid < s) { counted[lid] += counted[lid + s]; }
      workgroupBarrier();
    }
    let total = counted[0];
    workgroupBarrier();
    if (lo < hi) {
      if (total > rank) { hi = mid; } else { lo = mid + 1u; }
    }
  }

  if (lid == 0) {
    // Floored, because a frame of solid black measures zero and the shrinkage divides by
    // this. The floor is far below anything a photograph reads.
    params[pc.result_slot] = max(bitcast<f32>(lo), 1e-5);
  }
}
