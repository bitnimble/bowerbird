// The samples a probe of the colour model reads: one plane's colour at each of a list of pixels,
// with the neighbourhood's brightness the lattice reads beside it.
//
// A pass of its own because of how often it is asked. A fit evaluates its model dozens of times -
// six ridge candidates at each of three rounds, the saturation sweep and its refinement, every rung
// of the chroma ladder - and every one of them wants the same four floats a pair off the same
// plane. Gathered here they never leave the device; gathered on the host they were a two megabyte
// upload each time.

struct Params {
    int count;
    /// Pixels across the plane, which the indices are into.
    int pixels;
    /// Zero where the caller wants a surround of zero rather than the plane beside it - every
    /// probe below the lattice, which never reads the fourth component.
    int surrounded;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Interleaved f32 RGB.
[vk::binding(0, 0)] StructuredBuffer<float> plane;
/// One pixel index a sample.
[vk::binding(1, 0)] StructuredBuffer<uint> at;
/// One float a pixel of the plane, or a stub where `pc.surrounded` is zero.
[vk::binding(2, 0)] StructuredBuffer<float> surround;
/// Four floats a sample: the colour, then the surround.
[vk::binding(3, 0)] RWStructuredBuffer<float> samples;

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_gather(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    if (k >= pc.count) { return; }
    let p = int(at[k]);
    // A caller cannot index past the plane, but the read is a gather and a wrong list would
    // otherwise walk off the end of it rather than say so.
    if (p >= pc.pixels) { return; }

    samples[k * 4] = plane[p * 3];
    samples[k * 4 + 1] = plane[p * 3 + 1];
    samples[k * 4 + 2] = plane[p * 3 + 2];
    samples[k * 4 + 3] = pc.surrounded != 0 ? surround[p] : 0.0;
}
