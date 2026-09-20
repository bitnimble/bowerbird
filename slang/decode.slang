// The frame's coding, undone: nits for every `u16` code a sample can hold.
//
// The frame arrives in normalised PQ (`tone::encode_base`) rather than in scene-linear
// levels, because every stage between the decode and here reads a difference against a blur
// and so needs a perceptual domain of its own. Coded once rather than borrowed and given back
// per pass, those stages are pointwise, and this is where the coding is undone.
//
// A table rather than `pq_inv` per sample: the grade evaluates it three times per pixel and
// `measure` three times more, where this is 65536 entries filled once. It is also the same
// table for every photograph and every session - `encode_base` anchors the frame to the
// reference white before coding it, so what comes back out is nits and nothing about it
// depends on the frame. Built at the device rather than at the open for exactly that reason.
//
// Its own module, and that is the reason for the file: `colour` binds this read-only, and a
// module cannot declare one binding twice with two access modes.
import prelude;
import light;

[vk::binding(12, 0)] RWStructuredBuffer<float> nits_of_code;

/// One entry per code, so `id.x` is the code.
///
/// `SceneNits`, and that is the whole reason `pq_inv` makes its caller say so: the same absolute
/// curve carries the *display's* nits in `roll`, and the frame these codes belong to was coded
/// against its own diffuse white long before any display was chosen.
[shader("compute")]
[numthreads(64, 1, 1)]
void pq_table(uint3 id : SV_DispatchThreadID)
{
    if (id.x > 65535) { return; }
    nits_of_code[id.x] = pq_inv<SceneNits>(measured<Pq>(float(id.x) / 65535.0)).v;
}
