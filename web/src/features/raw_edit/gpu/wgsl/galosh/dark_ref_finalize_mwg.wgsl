// Phase 2(a): the four per-slot dark references, from every workgroup's partials.
//
// `o32_dark_ref_finalize_mwg.comp`.

@group(0) @binding(0) var<storage, read> partial_buf: array<f32>;
@group(0) @binding(1) var<storage, read_write> params: array<f32>;

struct Push {
  n_wg: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(256)
fn dark_ref_finalize_mwg(@builtin(global_invocation_id) id: vec3u) {
  if (id.x != 0u) { return; }

  var sw_s = 0.0;
  var sw_c = 0.0;
  var sw0_s = 0.0;
  var sw0_c = 0.0;
  var sw1_s = 0.0;
  var sw1_c = 0.0;
  var sw2_s = 0.0;
  var sw2_c = 0.0;
  var sw3_s = 0.0;
  var sw3_c = 0.0;
  for (var i = 0; i < pc.n_wg; i++) {
    kcombine(&sw_s, &sw_c, partial_buf[i * 10 + 0], partial_buf[i * 10 + 1]);
    kcombine(&sw0_s, &sw0_c, partial_buf[i * 10 + 2], partial_buf[i * 10 + 3]);
    kcombine(&sw1_s, &sw1_c, partial_buf[i * 10 + 4], partial_buf[i * 10 + 5]);
    kcombine(&sw2_s, &sw2_c, partial_buf[i * 10 + 6], partial_buf[i * 10 + 7]);
    kcombine(&sw3_s, &sw3_c, partial_buf[i * 10 + 8], partial_buf[i * 10 + 9]);
  }

  let inv_sw = 1.0 / max(sw_s + sw_c, 1e-20);
  params[P_DARK_REF0 + 0] = (sw0_s + sw0_c) * inv_sw;
  params[P_DARK_REF0 + 1] = (sw1_s + sw1_c) * inv_sw;
  params[P_DARK_REF0 + 2] = (sw2_s + sw2_c) * inv_sw;
  params[P_DARK_REF0 + 3] = (sw3_s + sw3_c) * inv_sw;
}
