// How far the frame's own chroma reaches, taken over every pixel of the sharp plane where the plane
// already is.
//
// The gather is a sample per pixel with the lens's falloff lifted in - `hdr_fit::chroma_span` has
// why the sharp plane rather than the pairs, and why the falloff has to be on. Building those
// samples on the host and reading the whole evaluated plane back to take a percentile of it is
// 27MB each way on a 1616x1077 plane, to answer with one number.
//
// The percentile is selected rather than binned, as `fit_pairs.slang`'s ceiling is and for the same
// reason - it sizes the lattice a stored match carries. `ordered` maps a float's bits to a word whose
// unsigned order is the float's own, so the selection walks bit patterns.

import px;
import light;
import index_space;

struct Params {
    int width;
    int height;
    /// Zero where the lens has no falloff; otherwise `gains` holds one per radius bucket.
    int falloff;
    /// Half the plane's diagonal, which the radius bucket is a fraction of.
    float half;
    /// The rank being looked for, as whole samples.
    int rank;
    /// `index_space`'s space the lattice is indexed in.
    uint space;
    int pad0;
    int pad1;
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
/// The high half's buckets, then the low half of the one bucket the rank fell in.
[vk::binding(4, 0)] RWStructuredBuffer<Atomic<uint> > histogram;
/// The bucket the rank fell in, how many sat below it, and the answer's bits.
[vk::binding(5, 0)] RWStructuredBuffer<uint> marks;

static const uint HALF_BINS = 65536;

/// This sample's opponent chroma, in the space the lattice is indexed in.
float chroma_of(int k)
{
    let at = k * 4;
    let colour = measured<Rendered>(float3(evaluated[at], evaluated[at + 1], evaluated[at + 2]));
    return length(opponent_of(colour, pc.space).v.yz);
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

    let i = wide<FitPlane>(p) * 3;
    var v = float3(plane[i], plane[i + 1], plane[i + 2]);
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
    histogram[ordered(chroma_of(k)) >> 16].add(1);
}

/// Lanes that walk a half's buckets together, each a contiguous share of them.
static const uint WALKERS = 256;
static const uint SHARE = HALF_BINS / WALKERS;
groupshared uint shares[WALKERS];

/// Where a walk of the `HALF_BINS` buckets from `from`, its count begun at `seen`, first passes
/// `rank`: the bucket, and the count below it. Every lane of the group calls it, and the one whose
/// share holds the answer is the one it returns true to.
bool passed(uint lane, uint from, uint seen, uint rank, out uint bucket, out uint below)
{
    bucket = 0u;
    below = 0u;
    let first = from + lane * SHARE;
    var total = 0u;
    for (uint b = 0u; b < SHARE; b++) { total += histogram[first + b].load(); }
    shares[lane] = total;
    GroupMemoryBarrierWithGroupSync();
    if (lane == 0u) {
        var run = seen;
        for (uint s = 0u; s < WALKERS; s++) {
            let n = shares[s];
            shares[s] = run;
            run += n;
        }
    }
    GroupMemoryBarrierWithGroupSync();
    var run = shares[lane];
    if (rank < run || run + total <= rank) { return false; }
    for (uint b = 0u; b < SHARE; b++) {
        let count = histogram[first + b].load();
        if (run + count > rank) {
            bucket = lane * SHARE + b;
            below = run;
            return true;
        }
        run += count;
    }
    return false;
}

/// Which bucket the rank fell in, and how many samples sat below it.
[shader("compute")]
[numthreads(WALKERS, 1, 1)]
void fit_span_pick(uint3 id: SV_GroupThreadID)
{
    uint bucket;
    uint below;
    if (passed(id.x, 0u, 0u, uint(pc.rank), bucket, below)) {
        marks[0] = bucket;
        marks[1] = below;
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_span_low(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    if (k >= pc.width * pc.height) { return; }
    let word = ordered(chroma_of(k));
    if ((word >> 16) == marks[0]) {
        histogram[HALF_BINS + (word & 0xffffu)].add(1);
    }
}

[shader("compute")]
[numthreads(WALKERS, 1, 1)]
void fit_span_finish(uint3 id: SV_GroupThreadID)
{
    uint low;
    uint below;
    if (passed(id.x, HALF_BINS, marks[1], uint(pc.rank), low, below)) {
        marks[2] = unordered((marks[0] << 16) | low);
    }
}
