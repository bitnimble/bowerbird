// The chroma lattice's kernels, evaluated into the volumes `colour.slang`'s `correct` samples.
//
// A kernel is a place in the lattice, how far it reaches along each axis, and an operator held as
// its generator: the matrix log of the 3x3 that acts on `(d0, d2, l)`, plus the two
// chroma-to-lightness terms. Generators add where kernels overlap and the sum is exponentiated
// per texel, so half of a hue rotation is half the angle rather than a straight line through
// grey. However many kernels there are, a pixel reads the same four texels.
import light;
import prelude;
import index_space;

struct Params {
    uint kernels;
    uint space;
    /// Texels along each axis: hue (one more than its bins, the last a copy of the first so the
    /// wrap needs no sampler of its own), chroma, lightness and surround.
    uint hue_texels;
    uint chroma_texels;
    uint level_texels;
    uint surround_texels;
    /// Lattice coordinate at the last texel of the chroma and surround axes, and the lightness
    /// span: `hdr_fit::LutAxes`.
    float chroma_top;
    float level_low;
    float level_top;
    float surround_top;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// `KERNEL_WORDS` floats a kernel: centre, reach, generator, chroma-to-lightness.
[vk::binding(0, 0)] StructuredBuffer<float> kernels;
/// `(a, b, c, d)`: the corrected chroma pair's 2x2.
[vk::image_format("rgba16f")]
[vk::binding(1, 0)] WTexture3D<float4> chroma_out;
/// `(e, f, g - 1, 0)`: the tint each chroma axis takes from lightness, and the lightness gain.
[vk::image_format("rgba16f")]
[vk::binding(2, 0)] WTexture3D<float4> luma_out;

/// `hdr_fit::KERNEL_WORDS`.
static const uint KERNEL_WORDS = 17;
static const uint CENTRE = 0;
static const uint REACH = 4;
static const uint GENERATOR = 8;
static const uint TO_LIGHTNESS = 15;

/// Perlin's smootherstep tent: one at the centre, nothing at the reach, and neighbours a reach
/// apart sum to one, so a grid of these interpolates as the multilinear tents the fit landed on.
float tent(float distance, float reach)
{
    if (reach <= 0.0) { return 1.0; }
    let u = 1.0 - min(abs(distance) / reach, 1.0);
    return u * u * u * (u * (u * 6.0 - 15.0) + 10.0);
}

/// How much of kernel `k` reaches lattice place `at`.
float weight_of(uint k, float4 at)
{
    let base = k * KERNEL_WORDS;
    let centre = float4(kernels[base], kernels[base + 1], kernels[base + 2], kernels[base + 3]);
    let reach = float4(
        kernels[base + REACH], kernels[base + REACH + 1], kernels[base + REACH + 2], kernels[base + REACH + 3]);
    let chroma = tent(at.y - centre.y, reach.y);
    let level = tent(at.z - centre.z, reach.z);
    let surround = tent(at.w - centre.w, reach.w);
    let rest = chroma * level * surround;
    if (rest <= 0.0) { return 0.0; }
    var turns = abs(at.x - centre.x);
    turns = min(turns, 1.0 - turns);
    // A kernel reaching grey would otherwise take a different value there from each hue: fading
    // its hue distance to nothing as chroma does makes grey one place again.
    if (centre.y < reach.y) { turns *= clamp(at.y / max(centre.y, 1e-6), 0.0, 1.0); }
    return rest * tent(turns, reach.x);
}

float3x3 exponential(float3x3 g)
{
    var norm = 0.0;
    for (int r = 0; r < 3; r++) { norm = max(norm, abs(g[r].x) + abs(g[r].y) + abs(g[r].z)); }
    let halvings = clamp(int(ceil(log2(max(norm, 1e-6)))) + 3, 0, 16);
    let x = g / float(1 << halvings);
    let identity = float3x3(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
    var term = identity;
    var sum = identity;
    for (int n = 1; n <= 6; n++) {
        term = mul(term, x) / float(n);
        sum += term;
    }
    for (int s = 0; s < halvings; s++) { sum = mul(sum, sum); }
    return sum;
}

/// A chroma difference over its luma, held to what a colour with no negative channel can have.
float chromaticity(float d, float level, float weight)
{
    if (level <= 0.0) { return 0.0; }
    return clamp(d / level, -1.0, 1.0 / weight - 1.0);
}

static const uint SIDE = 4;
static const uint LANES = SIDE * SIDE * SIDE;
/// Kernels one workgroup's texels can hold in their list; past it, the group reads every kernel.
static const uint LISTED = 1024;

groupshared uint lane_counts[LANES];
groupshared uint listed[LISTED];
groupshared uint listed_count;

/// The lattice place texel `id` stands for, its depth unpacked into lightness and surround.
float4 place_of(uint3 id)
{
    let level_at = id.z % pc.level_texels;
    let surround_at = id.z / pc.level_texels;
    return float4(
        float(id.x) / float(pc.hue_texels - 1),
        pc.chroma_top * float(id.y) / float(max(pc.chroma_texels - 1, 1u)),
        lerp(pc.level_low, pc.level_top, float(level_at) / float(max(pc.level_texels - 1, 1u))),
        pc.surround_top * float(surround_at) / float(max(pc.surround_texels - 1, 1u)));
}

bool spans(float centre, float reach, float low, float high)
{
    return reach <= 0.0 || (centre - reach < high && centre + reach > low);
}

/// Whether kernel `k` can reach anywhere in the box `low` to `high`: never false for one that
/// does, so a texel summing only these sums exactly what it would over every kernel.
bool touches(uint k, float4 low, float4 high)
{
    let base = k * KERNEL_WORDS;
    let centre = float4(kernels[base], kernels[base + 1], kernels[base + 2], kernels[base + 3]);
    let reach = float4(
        kernels[base + REACH], kernels[base + REACH + 1], kernels[base + REACH + 2], kernels[base + REACH + 3]);
    if (!spans(centre.y, reach.y, low.y, high.y)
        || !spans(centre.z, reach.z, low.z, high.z)
        || !spans(centre.w, reach.w, low.w, high.w)) {
        return false;
    }
    // Near grey `weight_of` shrinks the hue distance, so such a kernel is taken at every hue.
    if (reach.x <= 0.0 || centre.y < reach.y) { return true; }
    if (centre.x >= low.x && centre.x <= high.x) { return true; }
    let to_low = abs(centre.x - low.x);
    let to_high = abs(centre.x - high.x);
    let turns = min(min(to_low, 1.0 - to_low), min(to_high, 1.0 - to_high));
    return turns < reach.x;
}

[shader("compute")]
[numthreads(4, 4, 4)]
void bake(uint3 id: SV_DispatchThreadID, uint3 group: SV_GroupID, uint lane: SV_GroupIndex)
{
    let depth = pc.level_texels * pc.surround_texels;
    let inside = id.x < pc.hue_texels && id.y < pc.chroma_texels && id.z < depth;

    // The group's box, its depth taken whole along lightness where it straddles two surrounds.
    let first = group * SIDE;
    let last = min(first + uint3(SIDE - 1), uint3(pc.hue_texels, pc.chroma_texels, depth) - 1);
    var low = place_of(first);
    var high = place_of(last);
    if (first.z / pc.level_texels != last.z / pc.level_texels) {
        low.z = pc.level_low;
        high.z = pc.level_top;
    }

    // Each lane counts a run of kernels, a prefix over the lanes places each run, and each lane
    // writes its own: the list comes out in kernel order, so the sums below add in the same order
    // as over every kernel.
    let run = (pc.kernels + LANES - 1) / LANES;
    let from = min(lane * run, pc.kernels);
    let to = min(from + run, pc.kernels);
    var counted = 0u;
    for (uint k = from; k < to; k++) {
        if (touches(k, low, high)) { counted++; }
    }
    lane_counts[lane] = counted;
    GroupMemoryBarrierWithGroupSync();
    if (lane == 0) {
        var total = 0u;
        for (uint l = 0; l < LANES; l++) {
            let here = lane_counts[l];
            lane_counts[l] = total;
            total += here;
        }
        listed_count = total;
    }
    GroupMemoryBarrierWithGroupSync();
    var slot = lane_counts[lane];
    for (uint k = from; k < to; k++) {
        if (!touches(k, low, high)) { continue; }
        if (slot < LISTED) { listed[slot] = k; }
        slot++;
    }
    GroupMemoryBarrierWithGroupSync();
    if (!inside) { return; }

    let at = place_of(id);
    let culled = listed_count <= LISTED;
    let count = culled ? listed_count : pc.kernels;
    var g = float3x3(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    var to_lightness = float2(0.0);
    for (uint n = 0; n < count; n++) {
        let k = culled ? listed[n] : n;
        let w = weight_of(k, at);
        if (w <= 0.0) { continue; }
        let base = k * KERNEL_WORDS + GENERATOR;
        g += w * float3x3(
            kernels[base], kernels[base + 1], kernels[base + 4],
            kernels[base + 2], kernels[base + 3], kernels[base + 5],
            0.0, 0.0, kernels[base + 6]);
        to_lightness += w * float2(kernels[k * KERNEL_WORDS + TO_LIGHTNESS], kernels[k * KERNEL_WORDS + TO_LIGHTNESS + 1]);
    }
    let a = exponential(g);

    // The chroma-to-lightness pair is read off the colour this texel stands for, so it folds into
    // the lightness gain here rather than costing the grade a third volume.
    let colour = rendered_of(opponent_at(at), pc.space).v;
    let l = dot(LUMA, colour);
    let gain = a[2].z
        + to_lightness.x * chromaticity(colour.r - l, l, LUMA.r)
        + to_lightness.y * chromaticity(colour.b - l, l, LUMA.b);
    chroma_out.Store(id, float4(a[0].x, a[0].y, a[1].x, a[1].y));
    luma_out.Store(id, float4(a[0].z, a[1].z, gain - 1.0, 0.0));
}
