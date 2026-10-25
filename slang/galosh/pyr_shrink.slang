// One level of the pyramid shrunk, as a soft-thresholded pilot and then a Wiener pass whose gains
// come off it: every 8x8 block at stride 4 through an orthonormal DCT, overlapped back under
// `WINDOW`. Gains off the noisy coefficients themselves pass noise that clears the bar whole, as
// isolated DCT ripples on flat ground.
import pyramid;
import prelude;
import "../times.slang";

[vk::binding(0, 0)] StructuredBuffer<float> noisy;
[vk::binding(1, 0)] RWStructuredBuffer<float> shrunk;
[vk::binding(3, 0)] StructuredBuffer<float> pilot;
/// `galosh::colour_basis`: planes 0 to 2 of a flat colour, the colours back out of them, and each
/// colour's share of the four dark references.
[vk::binding(4, 0)] StructuredBuffer<float> basis;
[vk::binding(5, 0)] StructuredBuffer<float> params;

[vk::binding(20, 0)] ConstantBuffer<Level> pc;

/// The colour-to-luma slope's regulariser, in coefficients' worth of this plane's noise: unfloored,
/// a flat-luma block fits its noise as colour.
static const float GUIDE_FLOOR = 8.0;

/// How far, in this level's noise deviations, a coarse level's colour may move a sample. Removing
/// noise moves one by about a deviation; the rest is colour smoothed in from across an edge, which a
/// block a coarse level wide always spans.
static const float COARSE_REACH = 4.0;

/// A strength of zero has a flat block divide nothing by nothing.
static const float TINY = 1e-20;

/// Four windowed blocks of a level's few hundred noise deviations must fit an `int`.
static const float FIXED = 65536.0;

/// The pilot pass, which reads no pilot.
[vk::constant_id(0)]
const int PILOT = 0;

/// Gains off this block's own pilot rather than the overlapped pilot plane.
[vk::constant_id(1)]
const int OWN_PILOT = 0;

groupshared Atomic<int> sum[TILE * TILE];

/// The pilot's bar, raised to the block's BayesShrink threshold: on a flat block that is past every
/// coefficient, so a noise spike over the fixed bar is not drawn as a lone DCT stroke.
float pilot_cut(float b[64], float noise)
{
    var power = 0.0;
    [ForceUnroll]
    for (int i = 1; i < 64; i++) { power += b[i] * b[i]; }
    let signal = max(power / 63.0 - noise, max(0.01 * noise, TINY));
    return sqrt(max(PILOT_THRESHOLD * PILOT_THRESHOLD * noise, noise * noise / signal));
}

float pilot_of(float b, float cut)
{
    return sign(b) * max(abs(b) - cut, 0.0);
}

/// How far colour plane `plane` moves per unit of luma when the block's light moves without
/// changing colour.
///
/// Equal noise on every colour in the GAT is not grey: the GAT is near a square root, so a dim
/// channel of a saturated colour swings further in proportion than a bright one. Colour shrunk to
/// a slope of 0 leaves exactly that, and the stronger the shrink the more of it.
float colourless_slope(int plane, int rows[8], int columns[8])
{
    float mean[3];
    [ForceUnroll]
    for (int p = 0; p < 3; p++) {
        let at = p * pc.w * pc.h;
        var total = 0.0;
        [ForceUnroll]
        for (int i = 0; i < 64; i++) { total += noisy[at + rows[i / 8] + columns[i % 8]]; }
        mean[p] = total / 64.0;
    }
    let a = max(params[P_ALPHA], ALPHA_MIN);
    let at_black = gat_sigma_at_black(a, params[P_SIGMA_SQ]);
    let unified = params[P_UNIFIED_SIGMA];
    let row = times(plane, 3);
    var luma = 0.0;
    var colour = 0.0;
    [ForceUnroll]
    for (int c = 0; c < 3; c++) {
        var level = 0.0;
        [ForceUnroll]
        for (int p = 0; p < 3; p++) { level += basis[9 + c * 3 + p] * mean[p]; }
        [ForceUnroll]
        for (int slot = 0; slot < 4; slot++) {
            level += basis[18 + c * 4 + slot] * params[P_DARK_REF0 + slot];
        }
        let root = 0.5 * a * max(level, 0.0) * unified;
        let lift = max(root * root - at_black * at_black, 0.0) / (a * max(root, TINY) * unified);
        luma += basis[c] * lift;
        colour += basis[row + c] * lift;
    }
    return luma > TINY ? colour / luma : 0.0;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void pyr_shrink(uint3 group : SV_GroupID, uint index : SV_GroupIndex)
{
    let lane = int(index);
    let column = int(group.x) / pc.tiles_x;
    let plane = pc.first + column;
    let x0 = (int(group.x) - column * pc.tiles_x) * TILE - pc.offset_x;
    let y0 = int(group.y) * TILE - pc.offset_y;

    let residual = PILOT == 0 && plane != 0;
    for (int k = lane; k < TILE * TILE; k += 64) { sum[k].store(0); }
    GroupMemoryBarrierWithGroupSync();

    let bx = lane % BLOCK;
    let by = lane / BLOCK;
    let noise = (plane == 0 ? pc.luma_strength : pc.colour_strength) * pc.variance;
    int rows[8];
    int columns[8];
    [ForceUnroll]
    for (int i = 0; i < 8; i++) {
        rows[i] = mirrored(y0 - STRIDE + by * STRIDE + i, pc.h) * pc.w;
        columns[i] = mirrored(x0 - STRIDE + bx * STRIDE + i, pc.w);
    }
    let own = plane * pc.w * pc.h;

    float g[64];
    float b[64];
    if (PILOT == 0 && OWN_PILOT == 0) {
        [ForceUnroll]
        for (int y = 0; y < 8; y++) {
            [ForceUnroll]
            for (int x = 0; x < 8; x++) { b[y * 8 + x] = pilot[own + rows[y] + columns[x]]; }
        }
        dct_forward(b);
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            let power = b[i] * b[i];
            g[i] = power / max(power + noise, TINY);
        }
    }

    [ForceUnroll]
    for (int y = 0; y < 8; y++) {
        [ForceUnroll]
        for (int x = 0; x < 8; x++) { b[y * 8 + x] = noisy[own + rows[y] + columns[x]]; }
    }
    // Colour is shrunk as its residual after one colour-to-luma slope per block: a thin coloured
    // feature too faint to clear the noise survives through the slope, which carries a 63rd of
    // the noise. The guide less its mean, so the block's mean is untouched.
    var slope = 0.0;
    if (residual) {
        // The guide in `g`, which only plane 0 reads as gains. Centred before squaring: a luma
        // plane sits thousands of deviations from zero, where raw sums cancel to noise in f32.
        var guide_mean = 0.0;
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            g[i] = shrunk[rows[i / 8] + columns[i % 8]];
            guide_mean += g[i];
        }
        guide_mean /= 64.0;
        var along = 0.0;
        var energy = 0.0;
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            g[i] -= guide_mean;
            along += b[i] * g[i];
            energy += g[i] * g[i];
        }
        // Toward the colourless slope by as much of the guide as is noise, which no fit can see:
        // this plane's noise and the luma's are independent, so on flat ground the fit reads 0.
        var prior = 0.0;
        if (plane < 3) { prior = colourless_slope(plane, rows, columns); }
        let floor = GUIDE_FLOOR * noise;
        let guide_noise = min(energy, 63.0 * pc.variance);
        slope = (along + prior * (guide_noise + floor)) / max(energy + floor, TINY);
        [ForceUnroll]
        for (int i = 0; i < 64; i++) { b[i] -= slope * g[i]; }
    }
    dct_forward(b);
    // The block's mean is the level below's to decide, so it passes untouched.
    if (PILOT != 0) {
        let cut = pilot_cut(b, noise);
        [ForceUnroll]
        for (int i = 1; i < 64; i++) { b[i] = pilot_of(b[i], cut); }
    } else if (OWN_PILOT != 0) {
        let cut = pilot_cut(b, noise);
        [ForceUnroll]
        for (int i = 1; i < 64; i++) {
            let p = pilot_of(b[i], cut);
            b[i] *= p * p / max(p * p + noise, TINY);
        }
    } else {
        [ForceUnroll]
        for (int i = 1; i < 64; i++) { b[i] *= g[i]; }
    }
    dct_inverse(b);
    if (residual && pc.variance < 1.0) {
        let reach = COARSE_REACH * sqrt(pc.variance * (1.0 + slope * slope));
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            let before = noisy[own + rows[i / 8] + columns[i % 8]] - slope * g[i];
            b[i] = before - reach * tanh((before - b[i]) / reach);
        }
    }
    if (residual) {
        [ForceUnroll]
        for (int i = 0; i < 64; i++) { b[i] += slope * g[i]; }
    }

    [ForceUnroll]
    for (int y = 0; y < 8; y++) {
        let ty = by * STRIDE + y - STRIDE;
        [ForceUnroll]
        for (int x = 0; x < 8; x++) {
            let tx = bx * STRIDE + x - STRIDE;
            if (tx >= 0 && tx < TILE && ty >= 0 && ty < TILE) {
                sum[ty * TILE + tx].add(int(round(WINDOW[x] * WINDOW[y] * b[y * 8 + x] * FIXED)));
            }
        }
    }
    GroupMemoryBarrierWithGroupSync();

    for (int k = lane; k < TILE * TILE; k += 64) {
        let x = x0 + k % TILE;
        let y = y0 + k / TILE;
        if (x < 0 || y < 0 || x >= pc.w || y >= pc.h) { continue; }
        let at = at_plane(plane, x, y, pc.w, pc.h);
        let value = float(sum[k].load()) / FIXED;
        shrunk[at] = (pc.accumulate != 0 ? shrunk[at] : 0.0) + pc.share * value;
    }
}
