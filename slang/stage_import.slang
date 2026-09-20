// The viewer stage's other pipeline: a frame WebGPU has already imported, copied onto the canvas.
//
// **Only the vertex is here, and the fragment is appended as WGSL.** That fragment samples a
// `texture_external`, which is WebGPU's own type for a video frame and which Slang cannot name - so
// it is written by hand in `stage_gpu.ts`. It carries no arithmetic to disagree about: the import
// has already converted into the canvas's primaries and left the value on the canvas's own curve,
// so there is nothing left to do to it and any transform here would be a second one on top of a
// picture that was already finished.

import stage_shared;

[shader("vertex")]
Drawn vertex(uint at: SV_VertexID)
{
    return drawn_at(at);
}
