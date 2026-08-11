// Phase 0(e): Laplacians of the dark pixels only, histogrammed.
//
// `o32_ne_dark_lap_hist.comp`. A triplet counts only where all three samples are dark, so
// what the median of this measures is the read noise with the shot noise held near zero.

@group(0) @binding(0) var<storage, read> raw: array<f32>;
@group(0) @binding(1) var<storage, read> params: array<f32>;
@group(0) @binding(2) var<storage, read_write> dark_lap_hist: array<atomic<i32>>;

struct Push {
  width: i32,
  height: i32,
  dark_thresh_slot: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const HIST_BINS: i32 = 4096;
const LAP_MAX: f32 = 0.1;

@compute @workgroup_size(16, 16)
fn ne_dark_lap_hist(@builtin(global_invocation_id) id: vec3u) {
  let gid_x = i32(id.x);
  let gid_y = i32(id.y);
  let halfwidth = (pc.width + 1) / 2;
  let halfheight = (pc.height + 1) / 2;
  if (gid_x >= halfwidth || gid_y >= halfheight) { return; }

  let dark_max = params[pc.dark_thresh_slot] + 0.02;
  let scale = f32(HIST_BINS) / LAP_MAX;

  for (var ch = 0; ch < 4; ch++) {
    let dy0 = (ch >> 1u) & 1;
    let dx0 = ch & 1;
    let hr = gid_y;
    let hc = gid_x;
    if (hc < halfwidth - 2) {
      let fr = 2 * hr + dy0;
      if (fr < pc.height) {
        let row = fr * pc.width;
        let v0 = raw[row + (2 * hc + dx0)];
        let v1 = raw[row + (2 * (hc + 1) + dx0)];
        let v2 = raw[row + (2 * (hc + 2) + dx0)];
        if (!(v0 > dark_max || v1 > dark_max || v2 > dark_max)) {
          let bin = clamp(i32(abs(v0 - 2.0 * v1 + v2) * scale), 0, HIST_BINS - 1);
          atomicAdd(&dark_lap_hist[bin], 1);
        }
      }
    }
    if (hr < halfheight - 2) {
      let fc = 2 * hc + dx0;
      if (fc < pc.width) {
        let v0 = raw[(2 * hr + dy0) * pc.width + fc];
        let v1 = raw[(2 * (hr + 1) + dy0) * pc.width + fc];
        let v2 = raw[(2 * (hr + 2) + dy0) * pc.width + fc];
        if (!(v0 > dark_max || v1 > dark_max || v2 > dark_max)) {
          let bin = clamp(i32(abs(v0 - 2.0 * v1 + v2) * scale), 0, HIST_BINS - 1);
          atomicAdd(&dark_lap_hist[bin], 1);
        }
      }
    }
  }
}
