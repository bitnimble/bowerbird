// Phase 0(d): the 10th percentile of that histogram, into the scratch slot.
//
// `o32_ne_dark_thresh_finalize.comp`. One invocation does the scan; the rest idle, which is
// what the reference's null local size amounts to.

@group(0) @binding(0) var<storage, read> dark_thresh_hist: array<i32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  dark_thresh_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const HIST_BINS: i32 = 4096;

@compute @workgroup_size(256)
fn ne_dark_thresh_finalize(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }

  var total = 0;
  for (var i = 0; i < HIST_BINS; i++) { total += dark_thresh_hist[i]; }
  if (total < 100) {
    params[pc.dark_thresh_slot] = 0.01;
    return;
  }

  let rank = total / 10;
  var cum = 0;
  var dark_bin = 0;
  for (var i = 0; i < HIST_BINS; i++) {
    cum += dark_thresh_hist[i];
    if (cum >= rank) { dark_bin = i; break; }
  }
  params[pc.dark_thresh_slot] = (f32(dark_bin) + 0.5) / f32(HIST_BINS);
}
