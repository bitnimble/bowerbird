// Phase 0(f): σ², from the median of the dark Laplacians with α's share taken back out.
//
// `o32_ne_dark_finalize.comp`. Too few dark triplets and it writes nothing, which leaves the
// α-only σ² of zero `ne_finalize` put there.

@group(0) @binding(0) var<storage, read> dark_lap_hist: array<i32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  dark_thresh_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const HIST_BINS: i32 = 4096;
const LAP_MAX: f32 = 0.1;

@compute @workgroup_size(256)
fn ne_dark_finalize(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }

  var total = 0;
  for (var i = 0; i < HIST_BINS; i++) { total += dark_lap_hist[i]; }
  if (total < 100) { return; }

  let rank = total / 2;
  var cum = 0;
  var med_bin = 0;
  for (var i = 0; i < HIST_BINS; i++) {
    cum += dark_lap_hist[i];
    if (cum >= rank) { med_bin = i; break; }
  }

  let mad = (f32(med_bin) + 0.5) / (f32(HIST_BINS) / LAP_MAX);
  let sigma_lap = mad / 0.6745;
  let dark_var = (sigma_lap * sigma_lap) / 6.0;
  let dark_mean = params[pc.dark_thresh_slot] * 0.5;
  params[P_SIGMA_SQ] = max(dark_var - params[P_ALPHA] * dark_mean, 0.0);
}
