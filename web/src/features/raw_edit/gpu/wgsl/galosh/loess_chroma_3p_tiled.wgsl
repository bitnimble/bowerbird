// Phase 7: chroma regressed on luma over a 15x15 window, at one pyramid level.
//
// `o32_loess_chroma_3p_tiled.comp`. A degree-1 weighted least squares of each chroma term
// against the luma guide, the weights bilateral on the guide - so the colour is smoothed
// along whatever the luma says is one surface, and stops at the edge rather than bleeding
// across it. The clamp holds the regression inside the window's own chroma range, which is
// what a degree-1 fit will otherwise extrapolate past.
//
// The tile is 16 rather than the reference file's 24: 24x24 is 576 invocations, over the
// 256 a portable workgroup is allowed, and the reference itself moved to 16 when an AMD
// driver refused the larger one. The answer does not depend on it - every read is a gather
// with a reflected boundary - only the halo's share of the work does.

@group(0) @binding(0) var<storage, read> y_guide: array<f32>;
@group(0) @binding(1) var<storage, read> c1_in: array<f32>;
@group(0) @binding(2) var<storage, read> c2_in: array<f32>;
@group(0) @binding(3) var<storage, read> c3_in: array<f32>;
@group(0) @binding(4) var<storage, read_write> c1_out: array<f32>;
@group(0) @binding(5) var<storage, read_write> c2_out: array<f32>;
@group(0) @binding(6) var<storage, read_write> c3_out: array<f32>;

struct Push {
  width: i32,
  height: i32,
  strength_c: f32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const R: i32 = 7;
const BW: f32 = 3.0;
const TILE_DIM: i32 = 16;
const TILE_W: i32 = TILE_DIM + 2 * R;
const TILE_PIX: i32 = TILE_W * TILE_W;

var<workgroup> t_y: array<f32, 900>;
var<workgroup> t_c1: array<f32, 900>;
var<workgroup> t_c2: array<f32, 900>;
var<workgroup> t_c3: array<f32, 900>;

@compute @workgroup_size(16, 16)
fn loess_chroma_3p_tiled(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_id) local: vec3u,
) {
  let tile_x = i32(group.x) * TILE_DIM;
  let tile_y = i32(group.y) * TILE_DIM;
  let lx = i32(local.x);
  let ly = i32(local.y);
  let lid = ly * TILE_DIM + lx;
  let wg_size = TILE_DIM * TILE_DIM;

  for (var i = lid; i < TILE_PIX; i += wg_size) {
    let tx = i % TILE_W;
    let ty = i / TILE_W;
    var gx = tile_x - R + tx;
    var gy = tile_y - R + ty;
    if (gx < 0) { gx = -gx; }
    if (gx >= pc.width) { gx = 2 * pc.width - gx - 2; }
    gx = clamp(gx, 0, pc.width - 1);
    if (gy < 0) { gy = -gy; }
    if (gy >= pc.height) { gy = 2 * pc.height - gy - 2; }
    gy = clamp(gy, 0, pc.height - 1);
    let gp = gy * pc.width + gx;
    t_y[i] = y_guide[gp];
    t_c1[i] = c1_in[gp];
    t_c2[i] = c2_in[gp];
    t_c3[i] = c3_in[gp];
  }
  workgroupBarrier();

  let ox = tile_x + lx;
  let oy = tile_y + ly;
  if (ox >= pc.width || oy >= pc.height) { return; }

  let cx_lds = R + lx;
  let cy_lds = R + ly;
  let y_c = t_y[cy_lds * TILE_W + cx_lds];
  let inv_2sigma_sq = 1.0 / (2.0 * BW * BW);

  var sum_w = 0.0;
  var sum_y = 0.0;
  var sum_yy = 0.0;
  var sum_c = vec3f(0.0);
  var sum_yc = vec3f(0.0);
  var cmin = vec3f(1e30);
  var cmax = vec3f(-1e30);

  for (var dy = -R; dy <= R; dy++) {
    let ty_lds = cy_lds + dy;
    for (var dx = -R; dx <= R; dx++) {
      let p = ty_lds * TILE_W + (cx_lds + dx);
      let yi = t_y[p];
      let ci = vec3f(t_c1[p], t_c2[p], t_c3[p]);
      cmin = min(cmin, ci);
      cmax = max(cmax, ci);
      let dy_g = yi - y_c;
      let w = exp(-dy_g * dy_g * inv_2sigma_sq);
      sum_w += w;
      sum_y += w * yi;
      sum_yy += w * yi * yi;
      sum_c += w * ci;
      sum_yc += w * yi * ci;
    }
  }

  let inv_w = 1.0 / max(sum_w, 1e-10);
  let mean_y = sum_y * inv_w;
  let mean_yy = sum_yy * inv_w;
  let mean_c = sum_c * inv_w;
  let mean_yc = sum_yc * inv_w;

  let var_y = max(mean_yy - mean_y * mean_y, 0.0);
  let eps = pc.strength_c * pc.strength_c;
  let inv_denom = 1.0 / max(var_y + eps, 1e-6);

  let a = (mean_yc - mean_y * mean_c) * inv_denom;
  let b = mean_c - a * mean_y;

  var fitted = a * y_c + b;
  if (cmax.x >= cmin.x) { fitted.x = clamp(fitted.x, cmin.x, cmax.x); }
  if (cmax.y >= cmin.y) { fitted.y = clamp(fitted.y, cmin.y, cmax.y); }
  if (cmax.z >= cmin.z) { fitted.z = clamp(fitted.z, cmin.z, cmax.z); }

  let op = oy * pc.width + ox;
  c1_out[op] = fitted.x;
  c2_out[op] = fitted.y;
  c3_out[op] = fitted.z;
}
