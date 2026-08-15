// `decode_rawler::normalise` as a kernel: the sensor's samples become the mosaic every later stage
// reads.
//
// **The samples arrive packed two to a `u32`, which is the whole point.** WGSL has no `u16`, so
// the alternative is conditioning on the host and uploading the mosaic as `f32` - twice the
// transfer for a subtract, a divide and a multiply. Packed flat rather than row by row: a frame of
// odd width then has rows straddling word boundaries, and only the frame's own last word is half
// full, where a per-row stride would leave one in every row and shear the picture.
//
// **The conditioning is a table and not the expression, which is not an optimisation.** Vulkan
// requires only 2.5 ULP of `OpFDiv` and RADV takes it, lowering the divide to a reciprocal and a
// multiply - so a shader spelling `(raw - floor) / range * gain` disagrees with the CPU in the last
// bit, and this frame is what every rendition and every later stage is built from. A conditioned
// sample is a function of sixteen bits and a position in the 2x2, so `decode_rawler::curve`
// evaluates its own expression over the whole of that domain and nothing is computed twice.

struct Params {
  /// Samples to the row, which is what turns a flat index back into a CFA position.
  width: u32,
  /// Samples in the frame, `words * 2` less the odd tail.
  count: u32,
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> words: array<u32>;
@group(0) @binding(2) var<storage, read> curve: array<f32>;
@group(0) @binding(3) var<storage, read_write> mosaic: array<f32>;

@compute @workgroup_size(64)
fn condition(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let at = linear(id, groups);
  if (at >= params.count) { return; }

  let word = words[at >> 1u];
  let raw = (word >> ((at & 1u) * 16u)) & 0xffffu;

  let row = at / params.width;
  let position = (row & 1u) * 2u + ((at - row * params.width) & 1u);

  mosaic[at] = curve[(position << 16u) | raw];
}
