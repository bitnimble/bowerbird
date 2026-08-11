// Phase 0(c): where "dark" starts, as a histogram of the mosaic's own levels.
//
// `o32_ne_dark_thresh_hist.comp`. Sub-sampled at stride 3 per CFA channel; the finalize
// takes the 10th percentile off it.

@group(0) @binding(0) var<storage, read> raw: array<f32>;
@group(0) @binding(1) var<storage, read_write> dark_thresh_hist: array<atomic<i32>>;

struct Push {
  width: i32,
  height: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const HIST_BINS: i32 = 4096;

@compute @workgroup_size(16, 16)
fn ne_dark_thresh_hist(@builtin(global_invocation_id) id: vec3u) {
  let gid_x = i32(id.x);
  let gid_y = i32(id.y);
  let halfwidth = (pc.width + 1) / 2;
  let halfheight = (pc.height + 1) / 2;
  if (gid_x * 3 >= halfwidth || gid_y * 3 >= halfheight) { return; }

  let scale = f32(HIST_BINS);
  for (var ch = 0; ch < 4; ch++) {
    let dy0 = (ch >> 1u) & 1;
    let dx0 = ch & 1;
    let hr = gid_y * 3;
    let hc = gid_x * 3;
    if (hr >= halfheight || hc >= halfwidth) { continue; }
    let fr = 2 * hr + dy0;
    let fc = 2 * hc + dx0;
    if (fr >= pc.height || fc >= pc.width) { continue; }
    let v = raw[fr * pc.width + fc];
    let bin = clamp(i32(v * scale), 0, HIST_BINS - 1);
    atomicAdd(&dark_thresh_hist[bin], 1);
  }
}
