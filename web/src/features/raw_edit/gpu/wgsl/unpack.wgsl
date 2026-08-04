// The prepared frame's interleaved RGB into the RGBA texture every pass reads.
//
// A texture takes four components and a frame has three, and something has to add the
// fourth. Doing it in JS was the obvious place and the wrong one: it is a loop over every
// sample - 119ms at 24MP, and a 61MP frame would be nearer 300 - and it needs a second
// array two thirds larger than the one that just arrived, so a 366MB open peaks at 850.
// Here it is one dispatch over a buffer that was going to be uploaded anyway, and the
// padding never crosses the wire.

@group(0) @binding(1) var<storage, read> packed: array<u32>;
@group(0) @binding(2) var unpacked: texture_storage_2d<rgba16uint, write>;

/// One `u16` of the stream, which is half of a word. The samples are three to a pixel, so
/// no pixel is word-aligned and there is no reading them as a struct.
fn sample_at(index: u32) -> u32 {
  let word = packed[index / 2u];
  return select(word & 0xffffu, word >> 16u, (index & 1u) == 1u);
}

@compute @workgroup_size(8, 8)
fn unpack(@builtin(global_invocation_id) id: vec3u) {
  if (!in_frame(id)) { return; }
  let base = at(id.x, id.y) * 3u;
  textureStore(unpacked, vec2i(i32(id.x), i32(id.y)), vec4u(
    sample_at(base), sample_at(base + 1u), sample_at(base + 2u), 65535u,
  ));
}
