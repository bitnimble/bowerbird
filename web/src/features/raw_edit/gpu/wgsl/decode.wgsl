// The frame's coding, undone: nits for every `u16` code a sample can hold.
//
// The frame arrives in normalised PQ (`tone::encode_base`) rather than in scene-linear
// levels, because every stage between the decode and here reads a difference against a blur
// and so needed a perceptual domain of its own. They used to borrow one per pass and give it
// back; coded once, they are pointwise and this is where it is undone.
//
// A table rather than `pq_inv` per sample: the grade evaluates it three times per pixel and
// `measure` three times more, where this is 65536 entries filled once. It is also the same
// table for every photograph and every session - `encode_base` anchors the frame to the
// reference white before coding it, so what comes back out is nits and nothing about it
// depends on the frame. Built at the device rather than at the open for exactly that reason.
//
// Its own module, and that is the reason for the file: `colour.wgsl` binds this read-only,
// and a module cannot declare one binding twice with two access modes.

@group(0) @binding(12) var<storage, read_write> nits_of_code: array<f32>;

/// One entry per code, so `id.x` is the code.
@compute @workgroup_size(64)
fn pq_table(@builtin(global_invocation_id) id: vec3u) {
  if (id.x > 65535u) { return; }
  nits_of_code[id.x] = pq_inv(f32(id.x) / 65535.0);
}
