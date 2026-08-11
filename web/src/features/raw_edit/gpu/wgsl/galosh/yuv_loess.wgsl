// Chroma regressed on luma over a 15x15 window, both planes at once.
//
// `yuv_loess.comp`. The same degree-1 weighted least squares the mosaic path runs on its
// three transform terms, with two channels instead and no tiling: an editor's frame is
// stage-sized, so the gather costs less than the workgroup storage a tile would need.
//
// **The guide is the noisy stabilised luma, not the denoised one.** That looks like a bug
// and is not: the bilateral weight is asking which neighbours belong to the same surface,
// and a denoised guide has already made that decision - following it would apply the luma
// shrinkage's mistakes to the colour as well. The reference records finding this out.
//
// `blend` is the dry/wet the Colour slider's first third rides on. Below 1 the regression is
// mixed back towards the pixel's own chroma, which is what lets the control start at "none"
// rather than at "the whole filter".

@group(0) @binding(0) var<storage, read> y_guide: array<f32>;
@group(0) @binding(1) var<storage, read> cb_in: array<f32>;
@group(0) @binding(2) var<storage, read> cr_in: array<f32>;
@group(0) @binding(3) var<storage, read_write> cb_out: array<f32>;
@group(0) @binding(4) var<storage, read_write> cr_out: array<f32>;

struct Push {
  width: i32,
  height: i32,
  strength: f32,
  blend: f32,
  radius: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const BW: f32 = 3.0;

@compute @workgroup_size(16, 16)
fn yuv_loess(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x);
  let y = i32(id.y);
  if (x >= pc.width || y >= pc.height) { return; }

  let centre = y * pc.width + x;
  let y_c = y_guide[centre];
  let inv_2sigma_sq = 1.0 / (2.0 * BW * BW);

  var sum_w = 0.0;
  var sum_y = 0.0;
  var sum_yy = 0.0;
  var sum_c = vec2f(0.0);
  var sum_yc = vec2f(0.0);
  var cmin = vec2f(1e30);
  var cmax = vec2f(-1e30);

  for (var dy = -pc.radius; dy <= pc.radius; dy++) {
    var yi = y + dy;
    if (yi < 0) { yi = -yi; }
    if (yi >= pc.height) { yi = 2 * pc.height - yi - 2; }
    yi = clamp(yi, 0, pc.height - 1);
    for (var dx = -pc.radius; dx <= pc.radius; dx++) {
      var xi = x + dx;
      if (xi < 0) { xi = -xi; }
      if (xi >= pc.width) { xi = 2 * pc.width - xi - 2; }
      xi = clamp(xi, 0, pc.width - 1);
      let p = yi * pc.width + xi;
      let yv = y_guide[p];
      let cv = vec2f(cb_in[p], cr_in[p]);
      cmin = min(cmin, cv);
      cmax = max(cmax, cv);
      let dyv = yv - y_c;
      let w = exp(-dyv * dyv * inv_2sigma_sq);
      sum_w += w;
      sum_y += w * yv;
      sum_yy += w * yv * yv;
      sum_c += w * cv;
      sum_yc += w * yv * cv;
    }
  }

  let inv_w = 1.0 / max(sum_w, 1e-10);
  let mean_y = sum_y * inv_w;
  let mean_yy = sum_yy * inv_w;
  let mean_c = sum_c * inv_w;
  let mean_yc = sum_yc * inv_w;

  let var_y = max(mean_yy - mean_y * mean_y, 0.0);
  let denom = max(var_y + pc.strength * pc.strength, 1e-6);
  let a = (mean_yc - mean_y * mean_c) / denom;
  let b = mean_c - a * mean_y;

  var fitted = a * y_c + b;
  if (cmax.x >= cmin.x) { fitted.x = clamp(fitted.x, cmin.x, cmax.x); }
  if (cmax.y >= cmin.y) { fitted.y = clamp(fitted.y, cmin.y, cmax.y); }
  if (pc.blend < 1.0) {
    let w = max(pc.blend, 0.0);
    fitted = w * fitted + (1.0 - w) * vec2f(cb_in[centre], cr_in[centre]);
  }

  cb_out[centre] = fitted.x;
  cr_out[centre] = fitted.y;
}
