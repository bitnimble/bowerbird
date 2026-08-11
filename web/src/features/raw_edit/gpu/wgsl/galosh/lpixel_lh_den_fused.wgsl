// Phase 6: the sixteen transform phases averaged back into one picture.
//
// `o32_lpixel_lh_den_fused.comp`. Stride-1 blocks mean every pixel is covered by four of
// them; this averages the ones that exist, which is what makes the shrinkage look like a
// filter rather than a tiling. The half-res copy taken here is the guide the chroma
// upsample reads.

@group(0) @binding(0) var<storage, read> l_cs_den: array<f32>;
@group(0) @binding(1) var<storage, read_write> l_pixel: array<f32>;
@group(0) @binding(2) var<storage, read_write> l_h_den: array<f32>;

struct Push {
  width: i32,
  height: i32,
  halfwidth: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

@compute @workgroup_size(16, 16)
fn lpixel_lh_den_fused(@builtin(global_invocation_id) id: vec3u) {
  let fx = i32(id.x);
  let fy = i32(id.y);
  if (fx >= pc.width || fy >= pc.height) { return; }

  let own = l_cs_den[fy * pc.width + fx];
  var sum = own;
  var count = 1;
  if (fy > 0) {
    sum += l_cs_den[(fy - 1) * pc.width + fx];
    count++;
  }
  if (fx > 0) {
    sum += l_cs_den[fy * pc.width + (fx - 1)];
    count++;
  }
  if (fy > 0 && fx > 0) {
    sum += l_cs_den[(fy - 1) * pc.width + (fx - 1)];
    count++;
  }
  l_pixel[fy * pc.width + fx] = sum / f32(count);

  if ((fy & 1) == 0 && (fx & 1) == 0) {
    l_h_den[(fy >> 1u) * pc.halfwidth + (fx >> 1u)] = own;
  }
}
