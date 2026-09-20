// What a seam solve reads about each frame, one shrunk cell at a time: its light and its colour.
//
// **In log2 of light.** An exposure difference is a ratio, which is an offset here and nowhere
// else this pipeline works in. **The domain, since none of the types below carry it.** What
// crosses this file is a *level* - `log2` of a light - so a difference of two is a `Stops`. The
// lights themselves are whatever `light_of_code` decodes the planes to, which is the composite's
// own coding and not a domain a constant here could be written in.
import lanes;
import packed;
import prelude;

static const uint MOST_SOURCES = 12;
static const float NOT_REACHED = -1e30;

/// A luma floor standing in for a coverage flag, and it cannot tell the two apart: a genuinely dark
/// subject over dark ground reads under this floor exactly as an unreached pixel does. The
/// take-best-parts design spec's section 8 names this and defers the real fix, a sentinel the
/// gather writes rather than a luma test.
static const float UNCOVERED_UNDER = 1e-7;

struct Params {
    uint2 size;
    uint sources;
    /// Which frame `assembly_stack` and `assembly_tint` are reading; ignored by `assembly_level`.
    uint slot;
    /// The side of the block a cell averages, `assembly_seam::SHRINK`.
    uint shrink;
    uint pad0;
    uint2 pad;
};
[vk::binding(0, 0)] ConstantBuffer<Params> params;
/// This frame's coded PQ, two codes a word.
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
/// `pixels * sources`, frame-major: log2 of the frame's light, or `NOT_REACHED`.
[vk::binding(2, 0)] RWStructuredBuffer<float> stacked;
/// One bit a frame a pixel.
[vk::binding(3, 0)] RWStructuredBuffer<uint> clipped;
/// `sources * 2`: alpha, sigma_sq, **carried into this plane's own light** by
/// `assembly_levels::noise_in_plane_units` rather than as the mosaic fit states them.
[vk::binding(4, 0)] StructuredBuffer<float> noise;
/// The frame's coding undone: light, normalised so that the largest code is one, per code.
[vk::binding(5, 0)] StructuredBuffer<float> light_of_code;
/// `cells * sources * 2`, cell-major over the shrunk grid: log2 of red over green and of blue over
/// green, a `Stops` pair.
[vk::binding(6, 0)] RWStructuredBuffer<float> tint;
/// `cells * (sources + 1)`: each cell's mean log2 light, the consensus's first and then each frame's,
/// `NOT_REACHED` where nothing was averaged.
[vk::binding(7, 0)] RWStructuredBuffer<float> level;

uint code_at(uint at)
{
    return half_of(frame[at / 2], at);
}

uint cells_across()
{
    return (params.size.x + params.shrink - 1) / params.shrink;
}

uint cells()
{
    return cells_across() * ((params.size.y + params.shrink - 1) / params.shrink);
}

/// This frame's level at `pixel`, in log2 of light, or `NOT_REACHED` where it did not arrive.
///
/// **Decoded before it is weighed**, which is the failure `light.slang` opens on: a weighted sum of
/// PQ codes is a number no photograph has, so `light_of_code` undoes the coding first and the luma
/// is taken over lights. `prelude::LUMA` and not three literals: Rec.2020's coefficients, these
/// planes being in Rec.2020 primaries all the way to the encoder.
///
/// **No per-source gain here.** `composite_tile::taken` codes each source against the reference's
/// white divided by that source's gain, so the plane arrives gain-matched; applying it again
/// squares it.
float level_at(uint pixel)
{
    let base = pixel * 3;
    let rgb = float3(
        light_of_code[code_at(base)],
        light_of_code[code_at(base + 1)],
        light_of_code[code_at(base + 2)]);
    let y = dot(LUMA, rgb);
    if (y <= UNCOVERED_UNDER) { return NOT_REACHED; }
    // Chroma at half weight, as a second term rather than a second plane: what differs in
    // colour alone still has to count.
    let chroma = 0.5 * (abs(rgb.r - y) + abs(rgb.b - y));
    return log2(max(y + chroma, 1e-6));
}

bool is_clipped(uint pixel)
{
    let base = pixel * 3;
    return code_at(base) == 65535 || code_at(base + 1) == 65535 || code_at(base + 2) == 65535;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_stack(uint3 id : SV_DispatchThreadID)
{
    let pixels = params.size.x * params.size.y;
    let pixel = linear(id);
    if (pixel >= pixels) { return; }
    stacked[params.slot * pixels + pixel] = level_at(pixel);
    let bit = is_clipped(pixel) ? (1u << params.slot) : 0u;
    // The first frame assigns rather than folds in, so the buffer needs nothing in it beforehand.
    clipped[pixel] = (params.slot == 0) ? bit : (clipped[pixel] | bit);
}

/// This frame's colour over one shrunk cell: what the seam solve tells a white belly from the
/// snow `level_at` reads as bright as it.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_tint(uint3 id : SV_DispatchThreadID)
{
    let cell = linear(id);
    if (cell >= cells()) { return; }
    let x0 = (cell % cells_across()) * params.shrink;
    let y0 = (cell / cells_across()) * params.shrink;
    var sum = float3(0.0);
    var n = 0u;
    for (uint y = y0; y < min(y0 + params.shrink, params.size.y); y = y + 1) {
        for (uint x = x0; x < min(x0 + params.shrink, params.size.x); x = x + 1) {
            let base = (y * params.size.x + x) * 3;
            let rgb = float3(
                light_of_code[code_at(base)],
                light_of_code[code_at(base + 1)],
                light_of_code[code_at(base + 2)]);
            if (dot(LUMA, rgb) <= UNCOVERED_UNDER) { continue; }
            sum = sum + rgb;
            n = n + 1;
        }
    }
    let mean = sum / float(max(n, 1u));
    // The mean's own noise added to both sides, so a dark cell's grain reads as grey rather than
    // as colour.
    let light = dot(LUMA, mean);
    let sigma = sqrt(max(noise[2 * params.slot] * light + noise[2 * params.slot + 1], 0.0)
        / float(max(n, 1u)));
    let floor = max(sigma, 1e-7);
    let at = (cell * params.sources + params.slot) * 2;
    tint[at] = log2((mean.r + floor) / (mean.g + floor));
    tint[at + 1] = log2((mean.b + floor) / (mean.g + floor));
}

/// The median of the frames' levels at `pixel`, or `NOT_REACHED` where not every frame reached it
/// unclipped: the consensus is only stated where every frame has a say.
float consensus_at(uint pixel)
{
    let pixels = params.size.x * params.size.y;
    float v[MOST_SOURCES];
    uint n = 0;
    for (uint i = 0; i < params.sources; i = i + 1) {
        let s = stacked[i * pixels + pixel];
        if (s != NOT_REACHED) { v[n] = s; n = n + 1; }
    }
    if (n != params.sources || clipped[pixel] != 0) { return NOT_REACHED; }
    // Insertion sort: n is at most twelve.
    for (uint i = 1; i < n; i = i + 1) {
        let key = v[i];
        int j = int(i) - 1;
        while (j >= 0 && v[j] > key) { v[j + 1] = v[j]; j = j - 1; }
        v[j + 1] = key;
    }
    return (n % 2 == 1) ? v[n / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

/// Each cell's mean level, the consensus's and every frame's.
[shader("compute")]
[numthreads(64, 1, 1)]
void assembly_level(uint3 id : SV_DispatchThreadID)
{
    let cell = linear(id);
    if (cell >= cells()) { return; }
    let x0 = (cell % cells_across()) * params.shrink;
    let y0 = (cell / cells_across()) * params.shrink;
    let pixels = params.size.x * params.size.y;
    var consensus = 0.0;
    var agreed = 0u;
    var sums: float[MOST_SOURCES];
    var counts: uint[MOST_SOURCES];
    for (uint i = 0; i < MOST_SOURCES; i = i + 1) { sums[i] = 0.0; counts[i] = 0; }
    for (uint y = y0; y < min(y0 + params.shrink, params.size.y); y = y + 1) {
        for (uint x = x0; x < min(x0 + params.shrink, params.size.x); x = x + 1) {
            let pixel = y * params.size.x + x;
            let m = consensus_at(pixel);
            if (m != NOT_REACHED) {
                consensus = consensus + m;
                agreed = agreed + 1;
            }
            for (uint i = 0; i < params.sources; i = i + 1) {
                let here = stacked[i * pixels + pixel];
                if (here == NOT_REACHED) { continue; }
                sums[i] = sums[i] + here;
                counts[i] = counts[i] + 1;
            }
        }
    }
    let slots = params.sources + 1;
    level[cell * slots] = (agreed > 0) ? consensus / float(agreed) : NOT_REACHED;
    for (uint i = 0; i < params.sources; i = i + 1) {
        level[cell * slots + 1 + i] = (counts[i] > 0) ? sums[i] / float(counts[i]) : NOT_REACHED;
    }
}
