// Phases 7 and 9: chroma upsampled 2x, steered by the denoised luma.
//
// `o32_k16_jbu_3p.comp`. A jinc (EWA-JL3) kernel for the geometry and a bilateral term on
// the luma difference for the edges, so colour follows a boundary it cannot see itself.
//
// Two details are load-bearing and look removable. The hull clamp holds the output inside
// the nearest 2x2 source samples, which is what stops the jinc side lobes ringing into
// magenta at a high-contrast edge; and the `sum_w` floor preserves the sign, because a
// positive floor over a negative sum flips the chroma and produces exactly that spike.
//
// **The phases are co-sited, and that is a half-pixel bias this kernel cannot be talked out of.**
// A 2x2 box average's centroid is at full-resolution `2k + 1`, which is where low-resolution
// sample `k` sits, so output pixel `j` belongs at low-resolution `(j + 0.5) / 2` - a quarter of a
// sample either side, not the 0.0 and +0.5 below. Measured on a linear ramp, whose reconstruction
// through a normalised kernel is exact up to a displacement, the committed table is off by 0.5
// full-resolution pixels uniformly: a translation of chroma against luma, per level.
//
// Swapping the phases to -0.25/+0.25 makes it **worse**, which is why they are still here. The
// kernel is `r = 2*hypot` truncated at `r < 3`, so it reaches only 1.5 samples and was tuned for
// taps landing on 0 and +-1, or +-0.5 and +-1.5 at the half phase; at a quarter phase the negative
// lobes stop cancelling and the normalised centroid swings to +-1.27 pixels, alternating sign
// between the two phases - a zigzag where there was a translation. Correcting the siting means a
// wider kernel renormalised for quarter phases, not an edit to this table.
//
// `examples/jinc_table.rs` regenerates either set and reports the displacement; it reproduces the
// table below digit for digit first, which is the only reason to believe the other one.
//
// The output is always twice the input, both axes - the caller crops the guide and pads the
// result where a level is odd.

@group(0) @binding(0) var<storage, read> c1_in: array<f32>;
@group(0) @binding(1) var<storage, read> c2_in: array<f32>;
@group(0) @binding(2) var<storage, read> c3_in: array<f32>;
@group(0) @binding(3) var<storage, read> l_pixel: array<f32>;
@group(0) @binding(4) var<storage, read_write> c1_out: array<f32>;
@group(0) @binding(5) var<storage, read_write> c2_out: array<f32>;
@group(0) @binding(6) var<storage, read_write> c3_out: array<f32>;

struct Push {
  in_w: i32,
  in_h: i32,
  bw: f32,
};
@group(0) @binding(20) var<uniform> pc: Push;

// jinc(x) = 2·J1(pi·x)/(pi·x) sampled offline, per sub-pixel phase and 5x5 tap: for each
// `si` the offsets are (ry, rx) = (dy - oy, dx - ox), r = 2·hypot, and the weight is
// jinc(r)·jinc(r/3) inside r < 3. The negative side lobes are the point; `sum_w` normalises.
const K16_W = array<f32, 100>(
  // si = 0 (oy 0.00, ox 0.00)
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 1.3804738955e-02, -3.6724216895e-02, 1.3804738955e-02, 0.0,
  0.0, -3.6724216895e-02, 1.0, -3.6724216895e-02, 0.0,
  0.0, 1.3804738955e-02, -3.6724216895e-02, 1.3804738955e-02, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  // si = 1 (oy 0.00, ox 0.50)
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 3.5811194091e-04, 3.5811194091e-04, 0.0,
  0.0, 0.0, 1.5746368940e-01, 1.5746368940e-01, 0.0,
  0.0, 0.0, 3.5811194091e-04, 3.5811194091e-04, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  // si = 2 (oy 0.50, ox 0.00)
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 3.5811194091e-04, 1.5746368940e-01, 3.5811194091e-04, 0.0,
  0.0, 3.5811194091e-04, 1.5746368940e-01, 3.5811194091e-04, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  // si = 3 (oy 0.50, ox 0.50)
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, -7.2646353170e-02, -7.2646353170e-02, 0.0,
  0.0, 0.0, -7.2646353170e-02, -7.2646353170e-02, 0.0,
  0.0, 0.0, 0.0, 0.0, 0.0,
);

@compute @workgroup_size(16, 16)
fn k16_jbu_3p(@builtin(global_invocation_id) id: vec3u) {
  let out_w = 2 * pc.in_w;
  let out_h = 2 * pc.in_h;
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= out_w || fy >= out_h) { return; }

  let hx = fx >> 1u;
  let hy = fy >> 1u;
  let sub_x = fx & 1;
  let sub_y = fy & 1;
  let si = sub_y * 2 + sub_x;

  let l_c = l_pixel[fy * out_w + fx];
  let inv_2bw_sq = 1.0 / (2.0 * pc.bw * pc.bw);

  var sum_w = 0.0;
  var sum_c = vec3f(0.0);
  var cmin = vec3f(1e30);
  var cmax = vec3f(-1e30);

  for (var dy = -2; dy <= 2; dy++) {
    let hyi = clamp(hy + dy, 0, pc.in_h - 1);
    for (var dx = -2; dx <= 2; dx++) {
      let hxi = clamp(hx + dx, 0, pc.in_w - 1);
      let hi = hyi * pc.in_w + hxi;

      if ((dy == 0 || (sub_y != 0 && dy == 1)) && (dx == 0 || (sub_x != 0 && dx == 1))) {
        let iv = vec3f(c1_in[hi], c2_in[hi], c3_in[hi]);
        cmin = min(cmin, iv);
        cmax = max(cmax, iv);
      }

      let w_jinc = K16_W[si * 25 + (dy + 2) * 5 + (dx + 2)];
      if (w_jinc == 0.0) { continue; }

      // The guide, at the full-res top-left of this half-res chroma sample.
      let fri = min(2 * hyi, out_h - 1);
      let fci = min(2 * hxi, out_w - 1);
      let dl = l_pixel[fri * out_w + fci] - l_c;
      let w = w_jinc * exp(-dl * dl * inv_2bw_sq);

      sum_w += w;
      sum_c += w * vec3f(c1_in[hi], c2_in[hi], c3_in[hi]);
    }
  }

  var safe_w = sum_w;
  if (abs(sum_w) <= 1e-6) {
    safe_w = select(1e-6, -1e-6, sum_w < 0.0);
  }
  var upsampled = sum_c / safe_w;
  if (cmax.x >= cmin.x) { upsampled.x = clamp(upsampled.x, cmin.x, cmax.x); }
  if (cmax.y >= cmin.y) { upsampled.y = clamp(upsampled.y, cmin.y, cmax.y); }
  if (cmax.z >= cmin.z) { upsampled.z = clamp(upsampled.z, cmin.z, cmax.z); }

  let op = fy * out_w + fx;
  c1_out[op] = upsampled.x;
  c2_out[op] = upsampled.y;
  c3_out[op] = upsampled.z;
}
