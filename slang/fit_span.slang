// How far the frame's own chroma reaches, on each of the lattice's two axes, taken over every pixel
// of the sharp plane where the plane already is.
//
// The gather is a sample per pixel with the lens's falloff lifted in - `hdr_fit::chroma_span` has
// why the sharp plane rather than the pairs, and why the falloff has to be on. Building those
// samples on the host and reading the whole evaluated plane back to take two percentiles of it is
// 27MB each way on a 1616x1077 plane, to answer with four numbers.
//
// The percentiles are selected rather than binned, as `fit_pairs.slang`'s ceiling is and for the
// same reason - they size the lattice a stored match carries. A chroma difference is signed, so the
// bit patterns need one more step than the ceiling's did: a float's sign bit makes its pattern sort
// backwards, and `ordered` flips the negatives whole and sets the positives' top bit so the two
// halves land either side of each other in unsigned order.
//
// Both of an axis's percentiles come off one histogram, which is why the passes carry two ranks: the
// distribution is the same one, and only where a walk of it stops differs.

struct Params {
    int width;
    int height;
    /// Zero where the lens has no falloff; otherwise `gains` holds one per radius bucket.
    int falloff;
    /// Half the plane's diagonal, which the radius bucket is a fraction of.
    float half;
    /// Which of the two chroma axes this dispatch ranks: 0 is a*, 1 is b*.
    int axis;
    /// The two ranks being looked for, as whole samples.
    int low_rank;
    int high_rank;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Interleaved f32 RGB, the plane the samples are taken from.
[vk::binding(0, 0)] StructuredBuffer<float> plane;
/// `fit::Gain::at` per radius bucket, 256 of them.
[vk::binding(1, 0)] StructuredBuffer<float> gains;
/// Four floats a sample, as `fit_model.slang` reads them: the colour, then a surround of zero.
[vk::binding(2, 0)] RWStructuredBuffer<float> samples;
/// What the model made of them: chroma, luma, chroma, luma per sample.
[vk::binding(3, 0)] StructuredBuffer<float> evaluated;
/// Per axis: the high half's buckets, then a low half for each of the two ranks.
[vk::binding(4, 0)] RWStructuredBuffer<Atomic<uint> > histogram;
/// Per axis and rank: the bucket it fell in, how many sat below it, and the answer's bits.
[vk::binding(5, 0)] RWStructuredBuffer<uint> marks;

static const uint HALF_BINS = 65536;
/// One high half and one low half per rank.
static const uint AXIS_BINS = 3 * HALF_BINS;
/// A bucket, a running count, and the picked value.
static const uint PER_RANK = 3;
static const uint MARKS_PER_AXIS = 2 * PER_RANK;

/// The chroma this sample carries on the axis being ranked: what the model made of it, less the
/// luma it was measured against.
float spread_of(int k)
{
    let at = k * 4;
    return pc.axis == 0 ? evaluated[at] - evaluated[at + 3] : evaluated[at + 2] - evaluated[at + 3];
}

/// A float's bits, reordered so that unsigned comparison is the float's own.
///
/// A negative float's pattern grows as the value falls, so the whole word is flipped; a positive
/// one only needs its sign bit set, to put it above every negative.
uint ordered(float value)
{
    let bits = asuint(value);
    return (bits & 0x80000000u) != 0 ? ~bits : (bits | 0x80000000u);
}

/// `ordered` undone, which is what the host reads.
uint unordered(uint word)
{
    return (word & 0x80000000u) != 0 ? (word & 0x7fffffffu) : ~word;
}

/// One sample per pixel of the plane, with the falloff the plane does not carry.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_span_gather(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }
    let p = y * pc.width + x;

    var v = float3(plane[p * 3], plane[p * 3 + 1], plane[p * 3 + 2]);
    // Without it a corner's darkness reads as a chroma of its own, exactly as the pair loop has it.
    if (pc.falloff != 0) {
        let dx = float(x) - float(pc.width) * 0.5;
        let dy = float(y) - float(pc.height) * 0.5;
        v *= gains[int(min(sqrt(dx * dx + dy * dy) / pc.half * 255.0, 255.0))];
    }
    samples[p * 4] = v.x;
    samples[p * 4 + 1] = v.y;
    samples[p * 4 + 2] = v.z;
    samples[p * 4 + 3] = 0.0;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_span_high(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    if (k >= pc.width * pc.height) { return; }
    histogram[uint(pc.axis) * AXIS_BINS + (ordered(spread_of(k)) >> 16)].add(1);
}

/// Which bucket each rank fell in, and how many samples sat below it.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_span_pick()
{
    let bins = uint(pc.axis) * AXIS_BINS;
    let base = uint(pc.axis) * MARKS_PER_AXIS;
    let ranks = uint2(uint(pc.low_rank), uint(pc.high_rank));
    var found = uint2(0, 0);
    var seen = 0u;
    for (uint bucket = 0u; bucket < HALF_BINS; bucket++) {
        let count = histogram[bins + bucket].load();
        for (uint r = 0; r < 2; r++) {
            if (found[r] == 0 && seen + count > ranks[r]) {
                marks[base + r * PER_RANK] = bucket;
                marks[base + r * PER_RANK + 1] = seen;
                found[r] = 1;
            }
        }
        seen += count;
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_span_low(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    if (k >= pc.width * pc.height) { return; }
    let bins = uint(pc.axis) * AXIS_BINS;
    let base = uint(pc.axis) * MARKS_PER_AXIS;
    let word = ordered(spread_of(k));
    for (uint r = 0; r < 2; r++) {
        if ((word >> 16) == marks[base + r * PER_RANK]) {
            histogram[bins + (r + 1) * HALF_BINS + (word & 0xffffu)].add(1);
        }
    }
}

[shader("compute")]
[numthreads(1, 1, 1)]
void fit_span_finish()
{
    let bins = uint(pc.axis) * AXIS_BINS;
    let base = uint(pc.axis) * MARKS_PER_AXIS;
    let ranks = uint2(uint(pc.low_rank), uint(pc.high_rank));
    for (uint r = 0; r < 2; r++) {
        var seen = marks[base + r * PER_RANK + 1];
        for (uint low = 0u; low < HALF_BINS; low++) {
            let count = histogram[bins + (r + 1) * HALF_BINS + low].load();
            if (seen + count > ranks[r]) {
                marks[base + r * PER_RANK + 2] =
                    unordered((marks[base + r * PER_RANK] << 16) | low);
                break;
            }
            seen += count;
        }
    }
}
