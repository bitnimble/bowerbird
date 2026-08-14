// The base frame's own stages, the ones between the demosaic and the grade.
//
// `prelude.wgsl` is prepended by the host, so `pq` here is the same curve `colour.wgsl` reads
// back through - the coding and its inverse are one pair of constants rather than two.
//
// **The frame is `u16` packed two to a word**, which is the layout the editor already uploads
// (`edit_pipeline.ts`'s `frameBytes`) and the one a rendition reads back. Kept rather than
// widened to `f32` because these stages are pointwise or local and none of them needs the range:
// widening doubles a 361MB frame at 61MP for arithmetic that rounds back to `u16` anyway.

struct Params {
  /// Words in the frame, which is `samples` rounded up.
  words: u32,
  /// Samples in the frame, three per pixel. The last word holds one of them when this is odd.
  samples: u32,
  /// Reference white over the frame's own diffuse white: what turns a level into nits.
  scale: f32,
  pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> frame: array<u32>;

/// One level, coded.
///
/// `round` rather than a truncation because the CPU this replaces rounds, and the two differ by a
/// whole count on exactly half the levels otherwise.
fn coded(level: u32) -> u32 {
  let nits = f32(level) * params.scale;
  return u32(round(clamp(pq(nits) * 65535.0, 0.0, 65535.0)));
}

/// Phase 1: scene-linear levels to normalised PQ, in place.
///
/// One invocation per word rather than per sample, so the read and the write are one each: a
/// sample is sixteen bits and the smallest thing a shader can address is thirty-two, so per-sample
/// invocations would each read a word, modify a half and write it back - two invocations racing
/// on every word.
@compute @workgroup_size(64)
fn encode_base(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let at = linear(id, groups);
  if (at >= params.words) { return; }

  let word = frame[at];
  let low = coded(word & 0xffffu);
  // The odd tail. A frame with an odd sample count leaves half of the last word unused, and it
  // has to stay as it was rather than being coded as though it were a sample - it is read back
  // as bytes, and a frame whose length is odd would come back with a coded zero after its end.
  var high = word >> 16u;
  if (at * 2u + 1u < params.samples) {
    high = coded(high);
  }
  frame[at] = low | (high << 16u);
}
