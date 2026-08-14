// One index out of a two-dimensional dispatch, for kernels whose work is a flat list.
//
// **A dispatch dimension stops at 65535.** At 64 invocations a group that is 4.19M of them in one
// dimension, and a 61MP frame is fourteen times that - so a per-pixel kernel dispatched as a line
// is refused outright by the driver, with the whole command buffer. Every kernel here indexes a
// flat array, so the second dimension carries the overflow and means nothing else.
//
// Prepended to each native shader by `base.rs` rather than living in `prelude.wgsl`, which is the
// browser's too and has no dispatches of its own to size.

fn linear(id: vec3u, groups: vec3u) -> u32 {
  return id.x + id.y * groups.x * 64u;
}
