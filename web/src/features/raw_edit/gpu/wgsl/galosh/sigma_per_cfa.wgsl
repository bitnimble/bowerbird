// Phase 1(b): σ in the GAT domain, one workgroup per CFA channel.
//
// `o32_sigma_per_cfa.comp`. A histogram-MAD of the three-tap horizontal Laplacian inside
// each half-res view. The channel-to-offset encoding is transposed against
// `ne_block_stats` - `dy0` off the low bit here, off the high bit there - which is the
// reference's own and is left alone: both are self-consistent, and each channel's σ is
// unified away in the next dispatch anyway.

@group(0) @binding(0) var<storage, read> in_gat_full: array<f32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const NBINS: i32 = 4096;
const LAP_MAX: f32 = 16.0;
const WG: i32 = 256;

var<workgroup> hist: array<atomic<i32>, 4096>;
var<workgroup> total_count: atomic<i32>;

@compute @workgroup_size(256)
fn sigma_per_cfa(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_id) local: vec3u,
) {
  let ch = i32(group.x);
  let lid = i32(local.x);

  let dy0 = ch & 1;
  let dx0 = (ch >> 1u) & 1;
  let hw = (pc.width - dx0 + 1) / 2;
  let hh = (pc.height - dy0 + 1) / 2;

  for (var i = lid; i < NBINS; i += WG) { atomicStore(&hist[i], 0); }
  if (lid == 0) { atomicStore(&total_count, 0); }
  workgroupBarrier();

  let bin_scale = f32(NBINS) / LAP_MAX;
  var my_count = 0;
  for (var hr = lid; hr < hh; hr += WG) {
    let fr = 2 * hr + dy0;
    if (fr >= pc.height) { continue; }
    for (var hc = 0; hc < hw - 2; hc += 3) {
      let fc0 = 2 * hc + dx0;
      let fc1 = 2 * (hc + 1) + dx0;
      let fc2 = 2 * (hc + 2) + dx0;
      if (fc2 >= pc.width) { break; }
      let a = in_gat_full[fr * pc.width + fc0];
      let b = in_gat_full[fr * pc.width + fc1];
      let c = in_gat_full[fr * pc.width + fc2];
      let lap = abs(a - 2.0 * b + c);
      var bin = i32(lap * bin_scale);
      if (bin >= NBINS) { bin = NBINS - 1; }
      atomicAdd(&hist[bin], 1);
      my_count++;
    }
  }
  atomicAdd(&total_count, my_count);
  workgroupBarrier();

  if (lid == 0) {
    let median_target = atomicLoad(&total_count) / 2;
    var cum = 0;
    var median_bin = 0;
    for (var i = 0; i < NBINS; i++) {
      cum += atomicLoad(&hist[i]);
      if (cum >= median_target) { median_bin = i; break; }
    }
    let mad = (f32(median_bin) + 0.5) / bin_scale;
    // A three-tap Laplacian on iid noise has variance 6σ², so σ = MAD / (0.6745·√6).
    params[P_SIGMA_CH0 + ch] = max(mad / 1.6521, 0.01);
  }
}
