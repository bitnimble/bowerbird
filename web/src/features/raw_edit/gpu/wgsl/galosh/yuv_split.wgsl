// The editor's denoise, part 1: the prepared frame into a luma and two chroma planes.
//
// The reference's sRGB front-end linearises its input before it does anything else, because
// the generalised Anscombe transform models a variance that is affine in the *signal* and
// that is a statement about photons. This one does not, and the reason is what the frame is:
// what the editor holds is `tone::encode_base`'s normalised PQ, a domain built to be
// perceptually uniform - and in a perceptually uniform domain sensor noise is close to
// *constant* variance, which the same affine model describes with a small slope and a
// larger intercept. The blind fit finds that pair on its own.
//
// What linearising would cost is worse than what it buys: the inverse table is built over
// [0, 1], ordinary content sits near a fiftieth of PQ's 10000-nit peak, and normalising by
// anything else puts a clip somewhere in the highlights. Coded, the round trip through this
// pair of kernels is exact.
//
// Rec.2020's luma weights, because that is what the frame is in.

@group(0) @binding(0) var<storage, read> frame: array<u32>;
@group(0) @binding(1) var<storage, read_write> y_out: array<f32>;
@group(0) @binding(2) var<storage, read_write> cb_out: array<f32>;
@group(0) @binding(3) var<storage, read_write> cr_out: array<f32>;

struct Push {
  npix: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const KR: f32 = 0.2627;
const KG: f32 = 0.6780;
const KB: f32 = 0.0593;
const CB_DEN: f32 = 1.8814;
const CR_DEN: f32 = 1.4746;

/// One `u16` of the stream, which is half of a word. Three samples to a pixel means no
/// pixel is word-aligned, so there is no reading one as a struct.
fn sample_at(index: u32) -> f32 {
  let word = frame[index / 2u];
  return f32(select(word & 0xffffu, word >> 16u, (index & 1u) == 1u));
}

@compute @workgroup_size(256)
fn yuv_split(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  if (i >= pc.npix) { return; }

  let base = u32(i) * 3u;
  let r = sample_at(base) / 65535.0;
  let g = sample_at(base + 1u) / 65535.0;
  let b = sample_at(base + 2u) / 65535.0;

  let y = KR * r + KG * g + KB * b;
  y_out[i] = y;
  cb_out[i] = (b - y) / CB_DEN;
  cr_out[i] = (r - y) / CR_DEN;
}
