// The editor's denoise, last: the three planes back into a frame the grade can read.
//
// Writes a *copy* of the prepared frame rather than over it. The original is what the next
// move of a Detail slider denoises again - noise cannot be put back once it is gone - and it
// is also what the picture falls back to at zero.
//
// Two pixels per invocation, which is what makes the pack race-free: three samples do not
// fill a whole number of words, but six do, so a pair of pixels owns three words outright
// and no two invocations touch the same one. `gpu.rs`'s encode is paired for the same
// reason.

@group(0) @binding(0) var<storage, read> y_in: array<f32>;
@group(0) @binding(1) var<storage, read> cb_in: array<f32>;
@group(0) @binding(2) var<storage, read> cr_in: array<f32>;
@group(0) @binding(3) var<storage, read_write> frame: array<u32>;

struct Push {
  npix: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const KR: f32 = 0.2627;
const KG: f32 = 0.6780;
const KB: f32 = 0.0593;
const CB_DEN: f32 = 1.8814;
const CR_DEN: f32 = 1.4746;

/// One pixel's three codes. The green is solved out of the luma equation with the other two
/// known, which is what makes the round trip exact where nothing moved.
fn codes_of(at: i32) -> vec3f {
  let y = y_in[at];
  let r = y + cr_in[at] * CR_DEN;
  let b = y + cb_in[at] * CB_DEN;
  let g = (y - KR * r - KB * b) / KG;
  return clamp(round(vec3f(r, g, b) * 65535.0), vec3f(0.0), vec3f(65535.0));
}

@compute @workgroup_size(256)
fn yuv_join(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let pair = flat_index(id, groups, 256u);
  let first = pair * 2;
  if (first >= pc.npix) { return; }

  let a = codes_of(first);
  // An odd last pixel has no partner; its half of the third word is padding nothing reads.
  var b = vec3f(0.0);
  if (first + 1 < pc.npix) {
    b = codes_of(first + 1);
  }

  let word = u32(pair) * 3u;
  frame[word] = u32(a.x) | (u32(a.y) << 16u);
  frame[word + 1u] = u32(a.z) | (u32(b.x) << 16u);
  frame[word + 2u] = u32(b.y) | (u32(b.z) << 16u);
}
