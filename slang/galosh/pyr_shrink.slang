// One level of the pyramid shrunk, as a soft-thresholded pilot and then a Wiener pass whose gains
// come off it: every 8x8 block at stride 4 through an orthonormal DCT, overlapped back under
// `WINDOW`. Gains off the noisy coefficients themselves pass noise that clears the bar whole, as
// isolated DCT ripples on flat ground.
import pyramid;

[vk::binding(0, 0)] StructuredBuffer<float> noisy;
[vk::binding(1, 0)] RWStructuredBuffer<float> shrunk;
[vk::binding(3, 0)] StructuredBuffer<float> pilot;

[vk::binding(20, 0)] ConstantBuffer<Level> pc;

/// The colour-to-luma slope's regulariser, in coefficients' worth of this plane's noise: unfloored,
/// a flat-luma block fits its noise as colour.
static const float GUIDE_FLOOR = 8.0;

/// A strength of zero has a flat block divide nothing by nothing.
static const float TINY = 1e-20;

/// Four windowed blocks of a level's few hundred noise deviations must fit an `int`.
static const float FIXED = 65536.0;

/// The pilot pass, which reads no pilot.
[vk::constant_id(0)]
const int PILOT = 0;

/// The hybrid's colour: guided by noisy plane 0's DCT thresholded at its bar, since its plane 0
/// arrives denoised.
[vk::constant_id(1)]
const int THRESHOLDED_GUIDE = 0;

/// Gains off this block's own pilot rather than the overlapped pilot plane.
[vk::constant_id(2)]
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

[shader("compute")]
[numthreads(64, 1, 1)]
void pyr_shrink(uint3 group : SV_GroupID, uint index : SV_GroupIndex)
{
    let lane = int(index);
    let column = int(group.x) / pc.tiles_x;
    let plane = pc.first + column;
    let x0 = (int(group.x) - column * pc.tiles_x) * TILE - pc.offset_x;
    let y0 = int(group.y) * TILE - pc.offset_y;

    let guided = PILOT == 0 && plane != 0;
    let residual = guided && THRESHOLDED_GUIDE == 0;
    for (int k = lane; k < TILE * TILE; k += 64) { sum[k].store(0); }
    GroupMemoryBarrierWithGroupSync();

    let bx = lane % BLOCK;
    let by = lane / BLOCK;
    let noise = pc.strength[plane] * pc.variance;
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
    var guide_mean = 0.0;
    if (residual) {
        var sum_l = 0.0;
        var sum_ll = 0.0;
        var sum_b = 0.0;
        var sum_bl = 0.0;
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            let l = shrunk[rows[i / 8] + columns[i % 8]];
            sum_l += l;
            sum_ll += l * l;
            sum_b += b[i];
            sum_bl += b[i] * l;
        }
        guide_mean = sum_l / 64.0;
        let along = sum_bl - guide_mean * sum_b;
        let power = GUIDE_FLOOR * noise + max(sum_ll - guide_mean * sum_l, 0.0);
        slope = along / max(power, TINY);
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            b[i] -= slope * (shrunk[rows[i / 8] + columns[i % 8]] - guide_mean);
        }
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
    } else if (guided && !residual) {
        // The same slope off the noisy guide's own transform, with only the structure past this
        // plane's bar kept: a luma noise spike would come back as colour speckle at the slope.
        float l[64];
        [ForceUnroll]
        for (int y = 0; y < 8; y++) {
            [ForceUnroll]
            for (int x = 0; x < 8; x++) { l[y * 8 + x] = noisy[rows[y] + columns[x]]; }
        }
        dct_forward(l);
        let bar = PILOT_THRESHOLD * PILOT_THRESHOLD * noise;
        var along = 0.0;
        var power = GUIDE_FLOOR * noise;
        [ForceUnroll]
        for (int i = 1; i < 64; i++) {
            if (l[i] * l[i] < bar) { l[i] = 0.0; }
            along += b[i] * l[i];
            power += l[i] * l[i];
        }
        let fitted = along / max(power, TINY);
        [ForceUnroll]
        for (int i = 1; i < 64; i++) { b[i] = g[i] * b[i] + (1.0 - g[i]) * fitted * l[i]; }
    } else {
        [ForceUnroll]
        for (int i = 1; i < 64; i++) { b[i] *= g[i]; }
    }
    dct_inverse(b);
    if (residual) {
        [ForceUnroll]
        for (int i = 0; i < 64; i++) {
            b[i] += slope * (shrunk[rows[i / 8] + columns[i % 8]] - guide_mean);
        }
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
