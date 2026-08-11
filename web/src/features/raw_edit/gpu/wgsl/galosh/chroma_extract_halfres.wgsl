// Phase 4: the three chroma terms of the same transform, one per 2x2 site.
//
// `o32_chroma_extract_halfres.comp`. Half resolution because a Bayer site has one of each,
// so this is the natural rate for colour and nothing is thrown away by working at it.

@group(0) @binding(0) var<storage, read> in_gat_full: array<f32>;
@group(0) @binding(1) var<storage, read_write> c1_h: array<f32>;
@group(0) @binding(2) var<storage, read_write> c2_h: array<f32>;
@group(0) @binding(3) var<storage, read_write> c3_h: array<f32>;

struct Push {
  width: i32,
  height: i32,
  halfwidth: i32,
  halfheight: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn chroma_extract_halfres(@builtin(global_invocation_id) id: vec3u) {
  let hx = i32(id.x);
  let hy = i32(id.y);
  if (hx >= pc.halfwidth || hy >= pc.halfheight) { return; }

  let fr = 2 * hy;
  let fc = 2 * hx;
  let hp = hy * pc.halfwidth + hx;

  if (fr + 1 >= pc.height || fc + 1 >= pc.width) {
    c1_h[hp] = 0.0;
    c2_h[hp] = 0.0;
    c3_h[hp] = 0.0;
    return;
  }

  let r = in_gat_full[fr * pc.width + fc];
  let gb = in_gat_full[(fr + 1) * pc.width + fc];
  let gr = in_gat_full[fr * pc.width + (fc + 1)];
  let b = in_gat_full[(fr + 1) * pc.width + (fc + 1)];

  c1_h[hp] = 0.5 * (r - gb + gr - b);
  c2_h[hp] = 0.5 * (r + gb - gr - b);
  c3_h[hp] = 0.5 * (r - gb - gr + b);
}
