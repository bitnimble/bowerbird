// The camera match's weighted least squares, accumulated where the pairs already are.
//
// **What this replaces is a picture-sized readback for a few dozen numbers.** `fitted_matrix_for`
// evaluated the tone stage on the device and then read a value back *per pair* - 150k of them,
// three times a fit - so the host could fold them into a 3x3's normal equations. The solve is
// thirty-six floats wide and stays on the host, where it costs nothing; what was worth moving is
// the fold in front of it.
//
// **One thread per (matrix, block), walking its block's pairs in order.** Float addition is not
// associative, so the blocking is the answer's shape rather than an optimisation: the host sums
// the blocks in index order afterwards and gets the same terms in the same groups whatever adapter
// ran this. `fit_score.slang` and `fit_objective.slang` do the same for the same reason.
//
// **Each output row has its own normal equations**, because a channel the camera crushed is a
// bound on that row alone: the camera says the colour had at most that much of it, and nothing
// about the other two. So a row counts a pair by its own channel's trust, and a crushed channel
// counts as well wherever the matrix it is asked about puts more than the bound there - the
// squared hinge, solved by the host re-asking with each solve until the set it overshoots settles.
// A pair dropped from every row instead leaves the blue row taught only where blue is lit, and it
// puts blue on every red whose bound would have held it down.

import prelude;

struct Params {
    int pairs;
    int blocks;
    /// Pairs one thread walks. `hdr_fit::MEASURE_BLOCK`.
    int block;
    /// `hdr_fit::CAMERA_CRUSHED`.
    float crushed;
    /// Matrices in `matrices`.
    int probes;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per pair, the colour the tone stage left, in the render's own linear Rec.2020.
[vk::binding(0, 0)] StructuredBuffer<float4> below;
/// Per pair, the camera's rendering in that same space, with the hue balance in `w`.
[vk::binding(1, 0)] StructuredBuffer<float4> target;
/// Per (matrix, block), `MOMENT_WORDS` floats: each row's `A^T A`, then `A^T b`, row-major.
[vk::binding(2, 0)] RWStructuredBuffer<float> partial;
/// Per matrix asked about, nine floats row-major: where each row's overshoot is measured from.
[vk::binding(3, 0)] StructuredBuffer<float> matrices;

/// Twenty-seven for the three rows' `A^T A` and nine for `A^T b`, which is `Moments` exactly.
static const int MOMENT_WORDS = 36;

/// `hdr_fit::trust`: nothing at the floor, all of it by twice `crushed`, smoothly between.
float trust(float level)
{
    let x = clamp(level / (2.0 * pc.crushed), 0.0, 1.0);
    return x * x * (3.0 - 2.0 * x);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_moments(uint3 id: SV_DispatchThreadID)
{
    let unit = int(id.x);
    let probe = unit / pc.blocks;
    let b = unit - probe * pc.blocks;
    if (probe >= pc.probes) { return; }
    let first = b * pc.block;
    let last = min(first + pc.block, pc.pairs);
    let m = probe * 9;

    float ata[27];
    float atb[9];
    for (int i = 0; i < 27; i++) { ata[i] = 0.0; }
    for (int i = 0; i < 9; i++) { atb[i] = 0.0; }

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
        for (int o = 0; o < 3; o++) {
            let predicted = matrices[m + o * 3] * v.x + matrices[m + o * 3 + 1] * v.y
                + matrices[m + o * 3 + 2] * v.z;
            let measured = trust(t[o]);
            let over = predicted > t[o] ? 1.0 : 0.0;
            let wo = w * (measured + (1.0 - measured) * over);
            for (int a = 0; a < 3; a++) {
                for (int c = 0; c < 3; c++) {
                    ata[o * 9 + a * 3 + c] += wo * v[a] * v[c];
                }
                atb[o * 3 + a] += wo * v[a] * t[o];
            }
        }
    }

    let at = unit * MOMENT_WORDS;
    for (int i = 0; i < 27; i++) {
        partial[at + i] = ata[i];
    }
    for (int i = 0; i < 9; i++) {
        partial[at + 27 + i] = atb[i];
    }
}
