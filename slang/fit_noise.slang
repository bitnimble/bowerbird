// How far a pixel's chroma scatters about its neighbours', per level of the lattice, measured on
// the sharp plane the colour model has already run over.
//
// Each 2x2 of the sharp plane sits under one pixel of the fit grid, and where that pixel passed the
// mask's gradient gate the four are one flat colour: whatever spread they carry is noise. That is
// the spread a rendition reads the lattice through, pixel by pixel, where the fit grid averaged it
// away - `hdr_fit::LevelNoise` has what the lattice does with it.
//
// One thread per run of 2x2s, as `fit_moments` walks its pairs, so the host sums blocks in order and
// every adapter gets the same answer.

import prelude;

struct Params {
    /// The sharp plane.
    int width;
    int height;
    /// The fit grid the mask is on.
    int grid_width;
    int grid_height;
    int blocks;
    /// 2x2s one thread walks.
    int block;
    /// `ChromaMap::level_scale`: nodes per unit of the level's square root.
    float level_scale;
    /// The mask bits that say a grid pixel sits on no edge.
    uint flat;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per sharp pixel, what the model made of it: colour, then luma.
[vk::binding(0, 0)] StructuredBuffer<float4> evaluated;
/// Per grid pixel, `fit_pairs.slang`'s mask.
[vk::binding(1, 0)] StructuredBuffer<uint> bits;
/// Per block, `NOISE_WORDS` floats: for each level, the two chroma axes' variances summed, then
/// how many 2x2s gave them.
[vk::binding(2, 0)] RWStructuredBuffer<float> partial;

/// `hdr_fit::MAP_LEVEL`.
static const int MAP_LEVEL = 9;
static const int NOISE_WORDS = 3 * MAP_LEVEL;

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_noise(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let across = pc.width / 2;
    let quads = across * (pc.height / 2);
    let first = b * pc.block;
    let last = min(first + pc.block, quads);

    float sums[NOISE_WORDS];
    [ForceUnroll]
    for (int i = 0; i < NOISE_WORDS; i++) { sums[i] = 0.0; }

    for (int q = first; q < last; q++) {
        let qx = q % across;
        let qy = q / across;
        let gx = min(qx * 2 * pc.grid_width / pc.width, pc.grid_width - 1);
        let gy = min(qy * 2 * pc.grid_height / pc.height, pc.grid_height - 1);
        if ((bits[gy * pc.grid_width + gx] & pc.flat) == 0u) { continue; }

        float4 e[4];
        [ForceUnroll]
        for (int i = 0; i < 4; i++) {
            e[i] = evaluated[(2 * qy + (i >> 1)) * pc.width + 2 * qx + (i & 1)];
        }
        let mean = (e[0] + e[1] + e[2] + e[3]) * 0.25;
        var spread0 = 0.0;
        var spread2 = 0.0;
        [ForceUnroll]
        for (int i = 0; i < 4; i++) {
            let d0 = (e[i].x - e[i].w) - (mean.x - mean.w);
            let d2 = (e[i].z - e[i].w) - (mean.z - mean.w);
            spread0 += d0 * d0;
            spread2 += d2 * d2;
        }
        // Three degrees of freedom left after the mean.
        spread0 /= 3.0;
        spread2 /= 3.0;
        let level = clamp(int(round(sqrt(max(mean.w, 0.0)) * pc.level_scale)), 0, MAP_LEVEL - 1);
        // A select over every level rather than a subscript, which keeps `sums` in registers.
        [ForceUnroll]
        for (int z = 0; z < MAP_LEVEL; z++) {
            let here = z == level;
            sums[z * 3] = select(here, sums[z * 3] + spread0, sums[z * 3]);
            sums[z * 3 + 1] = select(here, sums[z * 3 + 1] + spread2, sums[z * 3 + 1]);
            sums[z * 3 + 2] = select(here, sums[z * 3 + 2] + 1.0, sums[z * 3 + 2]);
        }
    }

    let at = b * NOISE_WORDS;
    [ForceUnroll]
    for (int i = 0; i < NOISE_WORDS; i++) { partial[at + i] = sums[i]; }
}
