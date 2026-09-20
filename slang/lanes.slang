// One index out of a two-dimensional dispatch, for kernels whose work is a flat list.
//
// **A dispatch dimension stops at 65535.** At 64 invocations a group that is 4.19M of them in one
// dimension, and a 61MP frame is fourteen times that - so a per-pixel kernel dispatched as a line
// is refused outright by the driver, with the whole command buffer. The kernels that take this
// index a flat array, so the second dimension carries the overflow and means nothing else.
//
// Beside `prelude.slang` rather than in it: a module wanting this is one dispatched over a list,
// which most of the draw's are not.
module lanes;

/// Workgroups to a row of the dispatch, which the host splits at and this folds back in.
///
/// **The host must dispatch `x` at exactly this when it dispatches `y` above one**, which
/// `base::ROW_GROUPS` does and `the_shaders_split_a_dispatch_where_the_host_does` holds it to. A
/// row narrower than the host's leaves every row after the first reading another row's samples,
/// which is a picture assembled out of the wrong pixels rather than a failure.
public static const uint ROW_GROUPS = 32768;

public uint linear(uint3 id)
{
    return id.x + id.y * ROW_GROUPS * 64;
}
