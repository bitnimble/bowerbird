// The camera match's weighted least squares, accumulated where the pairs already are.
//
// **What this replaces is a picture-sized readback for eighteen numbers.** `fitted_matrix_for`
// evaluated the tone stage on the device and then read a value back *per pair* - 150k of them,
// three times a fit - so the host could fold them into a 3x3's normal equations. The solve is
// eighteen floats wide and stays on the host, where it costs nothing; what was worth moving is
// the fold in front of it.
//
// **One thread per block, walking its own pairs in order.** Float addition is not associative, so
// the blocking is the answer's shape rather than an optimisation: the host sums the blocks in
// index order afterwards and gets the same terms in the same groups whatever adapter ran this.
// `fit_score.slang` and `fit_objective.slang` do the same for the same reason.

import prelude;

struct Params {
    int pairs;
    int blocks;
    /// Pairs one thread walks. `hdr_fit::MEASURE_BLOCK`.
    int block;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per pair, the colour the tone stage left, in the render's own linear Rec.2020.
[vk::binding(0, 0)] StructuredBuffer<float4> below;
/// Per pair, the camera's rendering in that same space, with the hue balance in `w`.
[vk::binding(1, 0)] StructuredBuffer<float4> target;
/// Per block, `MOMENT_WORDS` floats: `ata` then `atb`, both row-major.
[vk::binding(2, 0)] RWStructuredBuffer<float> partial;

/// Nine for `A^T A` and nine for `A^T b`, which is `Moments` exactly.
static const int MOMENT_WORDS = 18;

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_moments(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let first = b * pc.block;
    let last = min(first + pc.block, pc.pairs);

    float ata[9];
    float atb[9];
    for (int i = 0; i < 9; i++) { ata[i] = 0.0; atb[i] = 0.0; }

    for (int k = first; k < last; k++) {
        let v = below[k].xyz;
        let t = target[k];
        // The weight the host used: a pair's hue balance over its own brightness, so a dark pair
        // is not drowned by a bright one. The floor is what stops a black pair carrying the fit.
        let camera = dot(LUMA, t.xyz);
        // `abs` before the power, not a clamp: the host takes a real cube root and squares it, and
        // a cube root keeps its sign - so an out-of-gamut target with a negative luma weighs the
        // same either side of zero. Clamped to zero instead, such a pair would come back with the
        // floor's full weight, which is a thousand times its neighbours'.
        let w = t.w / (pow(abs(camera), 2.0 / 3.0) + 1e-3);
        for (int a = 0; a < 3; a++) {
            for (int c = 0; c < 3; c++) {
                ata[a * 3 + c] += w * v[a] * v[c];
            }
            for (int o = 0; o < 3; o++) {
                atb[o * 3 + a] += w * v[a] * t[o];
            }
        }
    }

    let at = b * MOMENT_WORDS;
    for (int i = 0; i < 9; i++) {
        partial[at + i] = ata[i];
        partial[at + 9 + i] = atb[i];
    }
}
