// One merge for every stack of frames onto the same place: each frame's photosites, less the
// reference's demosaic where they land, are splatted onto the output grid through a kernel the
// reference's own structure shapes, narrow across an edge, long along it and wide where there is
// only noise, and weighted by how far that frame agrees with the reference about the light there.
// The mean residual goes back on the demosaic. The output grid is the reference's photosites or a
// finer one; the arithmetic is the same.

import px;
import light;
import clipped;

struct Params {
    uint width;
    uint height;
    uint frame_width;
    uint frame_height;
    int reference_left;
    int reference_top;
    int frame_left;
    int frame_top;
    int grid_left;
    int grid_top;
    uint grid_width;
    uint grid_height;
    uint tile;
    uint scale;
    uint output_width;
    uint output_height;
    int output_left;
    int output_top;
    uint colour0;
    uint colour1;
    uint colour2;
    uint colour3;
    float gain;
    float ceiling0;
    float ceiling1;
    float ceiling2;
    float ceiling3;
    float alpha;
    float sigma_sq;
    float reference_alpha;
    float reference_sigma_sq;
    uint is_reference;
    uint frames;
    int window_left;
    int window_top;
    uint window_width;
    uint window_height;
    float sharpness_power;
    float sharpest;
    int robust_reach;
    float reference_ceiling0;
    float reference_ceiling1;
    float reference_ceiling2;
    float reference_ceiling3;
    uint averages;
    uint pad0;
    uint pad1;
    uint pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> mosaic;
[vk::binding(2, 0)] StructuredBuffer<float> field;
[vk::binding(3, 0)] StructuredBuffer<float> luma;
[vk::binding(4, 0)] RWStructuredBuffer<float> kernels;
[vk::binding(5, 0)] StructuredBuffer<float> reference_half;
[vk::binding(6, 0)] StructuredBuffer<float> frame_half;
[vk::binding(7, 0)] RWStructuredBuffer<float> robustness;
// Twelve floats an output pixel, here and in `wide_sums`: each channel's weighed residual and its
// weight from the other frames, then the same from the reference.
[vk::binding(8, 0)] RWStructuredBuffer<float> sums;
[vk::binding(9, 0)] RWStructuredBuffer<float> eroded;
[vk::binding(10, 0)] RWStructuredBuffer<float> rgb;
[vk::binding(18, 0)] StructuredBuffer<float> prior;
[vk::binding(11, 0)] RWStructuredBuffer<float> merged;
[vk::binding(12, 0)] RWStructuredBuffer<float> half;
[vk::binding(13, 0)] RWStructuredBuffer<float> wide_sums;
[vk::binding(14, 0)] RWStructuredBuffer<float> reference_detail;
[vk::binding(21, 0)] RWStructuredBuffer<float> period_terms;
[vk::binding(22, 0)] RWStructuredBuffer<float> row_sums;
// `detail_columns`' answer: the reference's when it is measuring the reference, the frame's in
// `robust`.
[vk::binding(23, 0)] RWStructuredBuffer<float> detail;
// `residuals`' answers, a residual and its weight as two halves of a word: one word a frame
// photosite, and one a channel of a frame period.
[vk::binding(24, 0)] RWStructuredBuffer<uint> photosite_residuals;
[vk::binding(25, 0)] RWStructuredBuffer<uint> period_residuals;
[vk::binding(15, 0)] RWStructuredBuffer<float> low_band;
[vk::binding(16, 0)] RWStructuredBuffer<float> blurred;
[vk::binding(17, 0)] RWStructuredBuffer<float> banded;
[vk::binding(19, 0)] RWStructuredBuffer<float> clipped_light;
[vk::binding(20, 0)] RWStructuredBuffer<float> remosaiced;

// The kernel's spread in photosites: across a detailed edge in a frame merged alone, shrinking
// with the square root of the frames, which is how far apart their samples fall; how much longer
// it runs along an edge; and over noise alone.
static const Extent<Sensor> DETAIL_ALONE = { 0.6 };
static const float STRETCH = 2.0;
static const Extent<Sensor> DENOISE = { 1.3 };
// An edge this many deviations of its gradient's noise above nothing is detail.
static const float FLAT_AT = 1.0;
static const float DETAILED_AT = 4.0;
// A binomial 1-4-6-4-1 site luma keeps this share of a photosite's variance, and its central
// difference this share of that.
static const float LUMA_VARIANCE = 0.0748;
static const float GRADIENT_VARIANCE = 0.3;
// How far a frame's local light may stray from the reference's, in combined deviations, before
// it stops counting, and where it has stopped.
static const float MOVED_FROM = 2.5;
static const float MOVED_AT = 5.0;
// A share of the reference's own local variance allowed on top of the noise: aliasing and the
// last hundredth of a site of registration move a textured patch's mean by more than noise does.
static const float ALIASING = 0.25;
// A period with a saturated photosite this near a pixel, in the wide kernel's weight, says its light
// is at least the clip.
static const float CLIP_NEAR = 0.5;
// A frame's period this far under where the reference saturated, in the reference's light, cannot
// be the light that saturated it.
static const float BELOW_CLIP = 0.75;
// How far over its bound a channel still counts as held by it.
static const float HELD_TO = 1.1;
// The low band: every frame trusted, through one wide kernel over Bayer periods, whose own 2x2
// aperture the band split adds back. A blur takes nothing from it, so every frame counts.
static const Extent<Sensor> WIDE = { 1.5 };
static const Extent<Sensor> PERIOD_APERTURE = { 0.577 };
// The high band weighs each frame by its detail against the reference's raised to
// `params.sharpness_power`, capped at `params.sharpest` (`merge::Weights`).
// Half-resolution periods either side whose detail is compared.
static const int SHARPNESS_REACH = 4;
// A Laplacian's five taps hold twenty times its input's variance, and the period luma averages
// a red, two greens and a blue.
static const float LAPLACIAN_VARIANCE = 20.0;
static const float PERIOD_LUMA_VARIANCE = 0.278;
// The share of the noise's Laplacian energy both sides of a sharpness ratio are floored at.
static const float DETAIL_FLOOR = 0.5;

uint colour_at(int x, int y)
{
    let at = (y & 1) * 2 + (x & 1);
    return at == 0 ? params.colour0 : at == 1 ? params.colour1 : at == 2 ? params.colour2 : params.colour3;
}

// A channel as a mask, so per-channel sums stay in registers rather than a runtime-indexed array.
float3 one_hot(uint channel)
{
    return float3(channel == 0 ? 1.0 : 0.0, channel == 1 ? 1.0 : 0.0, channel == 2 ? 1.0 : 0.0);
}

float ceiling_at(int x, int y)
{
    let at = (y & 1) * 2 + (x & 1);
    return at == 0 ? params.ceiling0 : at == 1 ? params.ceiling1 : at == 2 ? params.ceiling2 : params.ceiling3;
}

float channel_ceiling(uint channel)
{
    float ceiling = 0.0;
    [ForceUnroll]
    for (int at = 0; at < 4; at++) {
        if (colour_at(at & 1, at >> 1) == channel) { ceiling = max(ceiling, ceiling_at(at & 1, at >> 1)); }
    }
    return ceiling;
}

float reference_ceiling(uint channel)
{
    let ceilings = float4(params.reference_ceiling0, params.reference_ceiling1, params.reference_ceiling2, params.reference_ceiling3);
    float ceiling = 0.0;
    [ForceUnroll]
    for (int at = 0; at < 4; at++) {
        if (colour_at(at & 1, at >> 1) == channel) { ceiling = max(ceiling, ceilings[at]); }
    }
    return ceiling;
}

bool saturated(int x, int y, float value)
{
    return at_ceiling(value, ceiling_at(x, y));
}

float variance_of(float level, float alpha, float sigma_sq)
{
    return max(alpha * level + sigma_sq, 0.0);
}

// What a sample of `light`, in the reference's light, counts for against the reference's own: the
// inverse of its noise there. One for every frame of an equal exposure.
float exposure_weight(float light)
{
    let ours = variance_of(max(light, 0.0), params.reference_alpha, params.reference_sigma_sq);
    let theirs = params.gain * params.gain
        * variance_of(max(light / params.gain, 0.0), params.alpha, params.sigma_sq);
    return theirs > 0.0 ? ours / theirs : 1.0;
}

// Where a frame sees what the reference sees at sensor `(x, y)`: the field between tile centres.
float2 displacement(float x, float y)
{
    if (params.is_reference != 0) { return float2(0.0, 0.0); }
    let tile_size = float(measured<Sensor>(params.tile).n);
    let gx = (x - float(params.grid_left)) / tile_size - 0.5;
    let gy = (y - float(params.grid_top)) / tile_size - 0.5;
    let ix = int(floor(gx));
    let iy = int(floor(gy));
    let fx = gx - float(ix);
    let fy = gy - float(iy);
    let x0 = clamp(ix, 0, int(params.grid_width) - 1);
    let x1 = clamp(ix + 1, 0, int(params.grid_width) - 1);
    let y0 = clamp(iy, 0, int(params.grid_height) - 1);
    let y1 = clamp(iy + 1, 0, int(params.grid_height) - 1);
    let a = (y0 * int(params.grid_width) + x0) * 4;
    let b = (y0 * int(params.grid_width) + x1) * 4;
    let c = (y1 * int(params.grid_width) + x0) * 4;
    let d = (y1 * int(params.grid_width) + x1) * 4;
    let top = lerp(float2(field[a], field[a + 1]), float2(field[b], field[b + 1]), fx);
    let bottom = lerp(float2(field[c], field[c + 1]), float2(field[d], field[d + 1]), fx);
    return lerp(top, bottom, fy);
}

float luma_at(int x, int y)
{
    return luma[clamp(y, 0, int(params.height) - 1) * int(params.width) + clamp(x, 0, int(params.width) - 1)];
}

// Each reference photosite's kernel, as the inverse covariance's three distinct entries.
[shader("compute")]
[numthreads(8, 8, 1)]
void shape(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    let x = int(gid.x);
    let y = int(gid.y);
    float a = 0.0;
    float b = 0.0;
    float c = 0.0;
    float level = 0.0;
    bool blown = false;
    [ForceUnroll]
    for (int j = -1; j <= 1; j++) {
        [ForceUnroll]
        for (int i = -1; i <= 1; i++) {
            let w = (i == 0 ? 0.5 : 0.25) * (j == 0 ? 0.5 : 0.25);
            let here = luma_at(x + i, y + j);
            let left = luma_at(x + i - 1, y + j);
            let right = luma_at(x + i + 1, y + j);
            let above = luma_at(x + i, y + j - 1);
            let below = luma_at(x + i, y + j + 1);
            blown = blown || !usable(here) || !usable(left) || !usable(right) || !usable(above) || !usable(below);
            let gx = 0.5 * (right - left);
            let gy = 0.5 * (below - above);
            a += w * gx * gx;
            b += w * gx * gy;
            c += w * gy * gy;
            level += w * here;
        }
    }
    let gradient_noise = GRADIENT_VARIANCE * LUMA_VARIANCE
        * variance_of(max(level, 0.0), params.reference_alpha, params.reference_sigma_sq);
    let middle = 0.5 * (a + c);
    let reach = sqrt(max(0.25 * (a - c) * (a - c) + b * b, 0.0));
    let strong = middle + reach;
    let weak = max(middle - reach, 0.0);
    let edge = sqrt(max(strong - gradient_noise, 0.0) / max(gradient_noise, 1e-12));
    let detailed = blown ? 1.0 : smoothstep(FLAT_AT, DETAILED_AT, edge);
    let anisotropy = strong + weak > 1e-12 ? sqrt(max(strong - weak, 0.0) / (strong + weak)) : 0.0;
    let detail = DETAIL_ALONE.d * rsqrt(float(max(params.frames, 1)));
    let across = lerp(DENOISE.d, detail, detailed);
    let along = lerp(DENOISE.d, detail * (1.0 + (STRETCH - 1.0) * anisotropy), detailed);
    // atan2(0, 0) is NaN on some drivers, and a blown highlight's tensor is all zeros
    let angle = strong + weak > 1e-12 ? 0.5 * atan2(2.0 * b, a - c) : 0.0;
    let e1 = float2(cos(angle), sin(angle));
    let e2 = float2(-e1.y, e1.x);
    let inverse_across = 1.0 / (across * across);
    let inverse_along = 1.0 / (along * along);
    let at = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(params.width)) * 3;
    kernels[at] = inverse_across * e1.x * e1.x + inverse_along * e2.x * e2.x;
    kernels[at + 1] = inverse_across * e1.x * e1.y + inverse_along * e2.x * e2.y;
    kernels[at + 2] = inverse_across * e1.y * e1.y + inverse_along * e2.y * e2.y;
}

// Each Bayer period as one red, the mean green and one blue, in the reference's light; a channel
// with a saturated photosite is marked rather than averaged.
[shader("compute")]
[numthreads(8, 8, 1)]
void halve(uint3 gid : SV_DispatchThreadID)
{
    let half_width = params.frame_width / 2;
    if (gid.x >= half_width || gid.y >= params.frame_height / 2) { return; }
    float3 sum = float3(0.0);
    float3 count = float3(0.0);
    float3 blown = float3(0.0);
    [ForceUnroll]
    for (int j = 0; j < 2; j++) {
        [ForceUnroll]
        for (int i = 0; i < 2; i++) {
            let x = int(gid.x) * 2 + i;
            let y = int(gid.y) * 2 + j;
            let value = mosaic[y * int(params.frame_width) + x];
            let mask = one_hot(colour_at(x, y));
            sum += mask * value;
            count += mask;
            blown = max(blown, saturated(x, y, value) ? mask : float3(0.0));
        }
    }
    let at = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(half_width)) * 3;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        half[at + channel] = blown[channel] > 0.0 || count[channel] == 0.0 ? CLIPPED
            : params.gain * sum[channel] / count[channel];
    }
}

// Where a channel's value in a period sits within it: its photosite, or the middle of two greens.
float2 period_offset(uint channel)
{
    float2 sum = float2(0.0);
    float count = 0.0;
    [ForceUnroll]
    for (int at = 0; at < 4; at++) {
        if (colour_at(at & 1, at >> 1) == channel) {
            sum += float2(float(at & 1), float(at >> 1));
            count += 1.0;
        }
    }
    return count > 0.0 ? sum / count : float2(0.5, 0.5);
}

float frame_half_at(int x, int y, uint channel)
{
    let half_width = int(params.frame_width / 2);
    let cx = clamp(x, 0, half_width - 1);
    let cy = clamp(y, 0, int(params.frame_height / 2) - 1);
    return frame_half[wide_at<Sensor>(uint(cx), uint(cy), measured<Sensor>(uint(half_width))) * 3 + channel];
}

float frame_half_bilinear(float x, float y, uint channel)
{
    let ix = int(floor(x));
    let iy = int(floor(y));
    let fx = x - float(ix);
    let fy = y - float(iy);
    let a = frame_half_at(ix, iy, channel);
    let b = frame_half_at(ix + 1, iy, channel);
    let c = frame_half_at(ix, iy + 1, channel);
    let d = frame_half_at(ix + 1, iy + 1, channel);
    if (!usable(a) || !usable(b) || !usable(c) || !usable(d)) { return CLIPPED; }
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

float period_luma(int x, int y)
{
    let width = params.frame_width / 2;
    let at = wide_at<Sensor>(uint(clamp(x, 0, int(width) - 1)), uint(clamp(y, 0, int(params.frame_height / 2) - 1)), measured<Sensor>(width)) * 3;
    float sum = 0.0;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        let value = frame_half[at + channel];
        if (!usable(value)) { return CLIPPED; }
        sum += value;
    }
    return sum / 3.0;
}

// A frame's detail, over its own periods, in three passes: each period's squared Laplacian of
// period luma, its luma and whether all five taps read; their sums over `SHARPNESS_REACH` periods
// along a row; then down a column, as the mean energy less what the noise alone gives, beside that
// noise, or negative where nothing was read.
[shader("compute")]
[numthreads(8, 8, 1)]
void detail_terms(uint3 gid : SV_DispatchThreadID)
{
    let half_width = params.frame_width / 2;
    if (gid.x >= half_width || gid.y >= params.frame_height / 2) { return; }
    let x = int(gid.x);
    let y = int(gid.y);
    let c = period_luma(x, y);
    let l = period_luma(x - 1, y);
    let r = period_luma(x + 1, y);
    let u = period_luma(x, y - 1);
    let d = period_luma(x, y + 1);
    let read = usable(c) && usable(l) && usable(r) && usable(u) && usable(d);
    let laplacian = 4.0 * c - l - r - u - d;
    let at = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(half_width)) * 3;
    period_terms[at] = read ? laplacian * laplacian : 0.0;
    period_terms[at + 1] = read ? c : 0.0;
    period_terms[at + 2] = read ? 1.0 : 0.0;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void detail_rows(uint3 gid : SV_DispatchThreadID)
{
    let half_width = params.frame_width / 2;
    if (gid.x >= half_width || gid.y >= params.frame_height / 2) { return; }
    float3 sum = float3(0.0);
    for (int i = -SHARPNESS_REACH; i <= SHARPNESS_REACH; i++) {
        let x = clamp(int(gid.x) + i, 0, int(half_width) - 1);
        let at = wide_at<Sensor>(uint(x), gid.y, measured<Sensor>(half_width)) * 3;
        sum += float3(period_terms[at], period_terms[at + 1], period_terms[at + 2]);
    }
    let at = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(half_width)) * 3;
    row_sums[at] = sum.x;
    row_sums[at + 1] = sum.y;
    row_sums[at + 2] = sum.z;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void detail_columns(uint3 gid : SV_DispatchThreadID)
{
    let half_width = params.frame_width / 2;
    let half_height = params.frame_height / 2;
    if (gid.x >= half_width || gid.y >= half_height) { return; }
    float3 sum = float3(0.0);
    for (int j = -SHARPNESS_REACH; j <= SHARPNESS_REACH; j++) {
        let y = clamp(int(gid.y) + j, 0, int(half_height) - 1);
        let at = wide_at<Sensor>(gid.x, uint(y), measured<Sensor>(half_width)) * 3;
        sum += float3(row_sums[at], row_sums[at + 1], row_sums[at + 2]);
    }
    let at = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(half_width)).n * 2;
    if (sum.z < 1.0) {
        detail[at] = -1.0;
        detail[at + 1] = 0.0;
        return;
    }
    let mean = sum.y / sum.z;
    let noise = LAPLACIAN_VARIANCE * PERIOD_LUMA_VARIANCE * params.gain * params.gain
        * variance_of(max(mean / params.gain, 0.0), params.alpha, params.sigma_sq);
    detail[at] = max(sum.x / sum.z - noise, 0.0);
    detail[at + 1] = noise;
}

// How far one frame may be trusted at each of the reference's periods, then how much of its
// detail survived its exposure against the reference's: its local light against the reference's,
// measured in the deviations their noise and the reference's texture allow, and the ratio of their
// Laplacian energies.
[shader("compute")]
[numthreads(8, 8, 1)]
void robust(uint3 gid : SV_DispatchThreadID)
{
    let half_width = params.width / 2;
    let half_height = params.height / 2;
    if (gid.x >= half_width || gid.y >= half_height) { return; }
    let here = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(half_width));
    if (params.is_reference != 0) {
        robustness[here.n * 2] = 1.0;
        robustness[here.n * 2 + 1] = 1.0;
        return;
    }
    let sensor_x = float(params.reference_left) + float(gid.x) * 2.0 + 0.5;
    let sensor_y = float(params.reference_top) + float(gid.y) * 2.0 + 0.5;
    let moved = displacement(sensor_x, sensor_y);
    let qx = (sensor_x + moved.x - float(params.frame_left) - 0.5) * 0.5;
    let qy = (sensor_y + moved.y - float(params.frame_top) - 0.5) * 0.5;
    const float per_channel[3] = { 1.0, 2.0, 1.0 };
    let reach = params.robust_reach;
    let side = float(2 * reach + 1);
    float worst = 0.0;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        float n = 0.0;
        float ours = 0.0;
        float ours_squared = 0.0;
        float theirs = 0.0;
        float seen = 0.0;
        float visible = 0.0;
        float contradicted = 0.0;
        let saturates = reference_ceiling(channel);
        for (int j = -reach; j <= reach; j++) {
            for (int i = -reach; i <= reach; i++) {
                let rx = clamp(int(gid.x) + i, 0, int(half_width) - 1);
                let ry = clamp(int(gid.y) + j, 0, int(half_height) - 1);
                let r = reference_half[wide_at<Sensor>(uint(rx), uint(ry), measured<Sensor>(half_width)) * 3 + channel];
                let f = frame_half_bilinear(qx + float(i), qy + float(j), channel);
                if (usable(r)) { visible += 1.0; }
                if (!usable(r) && usable(f) && f < BELOW_CLIP * saturates) { contradicted += 1.0; }
                if (!usable(r) || !usable(f)) { continue; }
                n += 1.0;
                ours += r;
                ours_squared += r * r;
                theirs += f;
                seen += 1.0;
            }
        }
        // the reference saturated, so its light is at least the clip: a frame reading well under
        // it is placed somewhere else, which a field filled across a blown highlight often is
        if (contradicted >= side * side / 3.0) { worst = MOVED_AT * MOVED_AT; }
        if (n < side * side / 3.0) {
            // the reference sees here and the frame can't be checked against it, so the frame's few
            // unsaturated photosites may come from anywhere its field strayed in its clipped tiles
            if (visible >= side * side / 3.0) { worst = MOVED_AT * MOVED_AT; }
            continue;
        }
        let mean = ours / n;
        let texture = max(ours_squared / n - mean * mean, 0.0);
        let mean_theirs = theirs / seen;
        let gain_sq = params.gain * params.gain;
        let noise = (variance_of(max(mean, 0.0), params.reference_alpha, params.reference_sigma_sq)
            + gain_sq * variance_of(max(mean_theirs / params.gain, 0.0), params.alpha, params.sigma_sq))
            / (per_channel[channel] * n);
        let spread = noise + ALIASING * texture + 1e-12;
        let apart = mean_theirs - mean;
        worst = max(worst, apart * apart / spread);
    }
    robustness[here.n * 2] = 1.0 - smoothstep(MOVED_FROM, MOVED_AT, sqrt(worst));

    let ours = float2(reference_detail[here.n * 2], reference_detail[here.n * 2 + 1]);
    let frame_half_width = params.frame_width / 2;
    let tx = clamp(int(round(qx)), 0, int(frame_half_width) - 1);
    let ty = clamp(int(round(qy)), 0, int(params.frame_height / 2) - 1);
    let their_at = wide_at<Sensor>(uint(tx), uint(ty), measured<Sensor>(frame_half_width)).n * 2;
    let theirs = float2(detail[their_at], detail[their_at + 1]);
    // Where each place takes one frame, floored at a share of the noise so a reference with nothing
    // left to read still hands over to a frame holding detail there. Where frames average, a floor
    // lets a darker, noisier frame into the high band wherever only the reference reads detail.
    let floor = params.averages != 0 ? 0.0 : DETAIL_FLOOR * ours.y;
    let ratio = ours.x >= 0.0 && theirs.x >= 0.0 && ours.x + floor > 0.0
        ? (theirs.x + floor) / (ours.x + floor) : 1.0;
    let sharpness = pow(clamp(ratio, 0.0, params.sharpest), params.sharpness_power);
    // where each place takes one frame, one no sharper than the reference adds only its noise
    robustness[here.n * 2 + 1] = params.averages != 0 ? sharpness : max(sharpness - 1.0, 0.0);
}

// Per period, the least trust within one period, the period's own sharpness, and the least trust
// within two: what `accumulate` reads at each output pixel and each wide tap.
[shader("compute")]
[numthreads(8, 8, 1)]
void erode(uint3 gid : SV_DispatchThreadID)
{
    let half_width = int(params.width / 2);
    let half_height = int(params.height / 2);
    if (int(gid.x) >= half_width || int(gid.y) >= half_height) { return; }
    float near = 1.0;
    float far = 1.0;
    for (int j = -2; j <= 2; j++) {
        for (int i = -2; i <= 2; i++) {
            let x = clamp(int(gid.x) + i, 0, half_width - 1);
            let y = clamp(int(gid.y) + j, 0, half_height - 1);
            let trust = robustness[wide_at<Sensor>(uint(x), uint(y), measured<Sensor>(uint(half_width))).n * 2];
            far = min(far, trust);
            if (abs(i) <= 1 && abs(j) <= 1) { near = min(near, trust); }
        }
    }
    let here = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(uint(half_width)));
    eroded[here * 3] = near;
    eroded[here * 3 + 1] = robustness[here.n * 2 + 1];
    eroded[here * 3 + 2] = far;
}

// Where `erode`'s three for the period under `(sx, sy)` start.
uint eroded_at(float sx, float sy)
{
    let half_width = int(params.width / 2);
    let hx = clamp(int(floor(sx * 0.5)), 0, half_width - 1);
    let hy = clamp(int(floor(sy * 0.5)), 0, int(params.height / 2) - 1);
    return wide_at<Sensor>(uint(hx), uint(hy), measured<Sensor>(uint(half_width))) * 3;
}

float prior_site(int x, int y, uint channel)
{
    let cx = clamp(x, 0, int(params.width) - 1);
    let cy = clamp(y, 0, int(params.height) - 1);
    return prior[wide_at<Sensor>(uint(cx), uint(cy), measured<Sensor>(params.width)) * 3 + channel];
}

// The reference's demosaic at `(x, y)` in its photosites, between their centres.
float prior_at(float x, float y, uint channel)
{
    let ix = int(floor(x));
    let iy = int(floor(y));
    let fx = x - float(ix);
    let fy = y - float(iy);
    return lerp(
        lerp(prior_site(ix, iy, channel), prior_site(ix + 1, iy, channel), fx),
        lerp(prior_site(ix, iy + 1, channel), prior_site(ix + 1, iy + 1, channel), fx),
        fy);
}

// Where a place in the frame's region sits in the reference's, in its photosites: the field is
// stated at the reference's places, so read once where the frame's own place would be and again
// where that lands.
float2 in_reference(float2 at)
{
    let sensor = float2(float(params.frame_left), float(params.frame_top)) + at;
    let first = sensor - displacement(sensor.x, sensor.y);
    let landed = sensor - displacement(first.x, first.y);
    return landed - float2(float(params.reference_left), float(params.reference_top));
}

// Scaled up before it is halved: a shadow's residuals sit among a half's denormals, which Vulkan
// lets an adapter flush to zero, and one flushed hands its place the reference's own noise.
static const float RESIDUAL_SCALE = 256.0;
static const float HALF_SMALLEST_NORMAL = 6.103515625e-5;
static const float HALF_LARGEST = 65504.0;

uint packed_residual(float residual, float weight)
{
    // Held inside a half's normals, the weight too: past the largest is inf and NaNs the sums, and
    // a denormal flushes on some adapters and not others. -1 and 0 are exact and pass.
    let held = weight > 0.0 ? clamp(weight, HALF_SMALLEST_NORMAL, HALF_LARGEST) : weight;
    return packHalf2x16(float2(clamp(residual * RESIDUAL_SCALE, -HALF_LARGEST, HALF_LARGEST), held));
}

// A residual and its weight, off `packed_residual`'s word.
float2 unpacked_residual(uint word)
{
    let sample = unpackHalf2x16ToFloat(word);
    return float2(sample.x / RESIDUAL_SCALE, sample.y);
}

// Each of one frame's photosites, and each channel of each of its periods, as its residual against
// the reference's demosaic where it lands and the weight it carries there, once for every output
// pixel it reaches: `accumulate` lays only the kernels over them. A weight of -1 marks a sample at
// its ceiling.
[shader("compute")]
[numthreads(8, 8, 1)]
void residuals(uint3 gid : SV_DispatchThreadID)
{
    let half_width = params.frame_width / 2;
    if (gid.x >= half_width || gid.y >= params.frame_height / 2) { return; }
    let corner = float2(float(gid.x) * 2.0, float(gid.y) * 2.0);
    let shift = in_reference(corner + 0.5) - (corner + 0.5);
    [ForceUnroll]
    for (int j = 0; j < 2; j++) {
        [ForceUnroll]
        for (int i = 0; i < 2; i++) {
            let x = int(gid.x) * 2 + i;
            let y = int(gid.y) * 2 + j;
            let value = mosaic[y * int(params.frame_width) + x];
            let landed = float2(float(x), float(y)) + shift;
            photosite_residuals[y * int(params.frame_width) + x] = saturated(x, y, value)
                ? packed_residual(0.0, -1.0)
                : packed_residual(
                    params.gain * value - prior_at(landed.x, landed.y, colour_at(x, y)),
                    exposure_weight(params.gain * value));
        }
    }
    let base = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(half_width)) * 3;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        let value = frame_half[base + channel];
        let landed = corner + period_offset(channel) + shift;
        if (!usable(value)) {
            period_residuals[base + channel] = packed_residual(0.0, -1.0);
            continue;
        }
        // The wide kernel reaches past the periods an output pixel's trust is read over, so each
        // period answers for itself and its wider neighbourhood, or a subject's edge, which its
        // own texture lets pass, spreads a halo.
        let own = eroded[eroded_at(landed.x, landed.y) + 2];
        period_residuals[base + channel] =
            packed_residual(value - prior_at(landed.x, landed.y, channel), own * exposure_weight(value));
    }
}

// One frame's photosites gathered onto each output pixel twice, each as its residual against the
// reference's demosaic where it lands: through the reference's kernels weighed by the frame's
// sharpness for the high band, and through one wide kernel over its periods for the low. A frame
// on the reference's own photosites then leaves the demosaic's reading of the missing channels
// standing, which sparse samples of one channel alone cannot match.
[shader("compute")]
[numthreads(8, 8, 1)]
void accumulate(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let scale = float(params.scale);
    let sx = float(params.output_left) + (float(gid.x) + 0.5) / scale - 0.5;
    let sy = float(params.output_top) + (float(gid.y) + 0.5) / scale - 0.5;
    let near = eroded_at(sx, sy);
    let trust = eroded[near];
    let sharpness = eroded[near + 1];
    if (trust <= 0.0) { return; }
    let kx = clamp(int(round(sx)), 0, int(params.width) - 1);
    let ky = clamp(int(round(sy)), 0, int(params.height) - 1);
    let k = wide_at<Sensor>(uint(kx), uint(ky), measured<Sensor>(params.width)) * 3;
    let inverse = float3(kernels[k], kernels[k + 1], kernels[k + 2]);
    let sensor_x = float(params.reference_left) + sx;
    let sensor_y = float(params.reference_top) + sy;
    let moved = displacement(sensor_x, sensor_y);
    let qx = sensor_x + moved.x - float(params.frame_left);
    let qy = sensor_y + moved.y - float(params.frame_top);
    let x0 = int(floor(qx)) - 1;
    let y0 = int(floor(qy)) - 1;
    let wide_spread = WIDE.d;
    float3 sum = float3(0.0);
    float3 weight = float3(0.0);
    float3 clip = float3(0.0);
    for (int j = 0; j < 4; j++) {
        for (int i = 0; i < 4; i++) {
            let x = x0 + i;
            let y = y0 + j;
            if (x < 0 || y < 0 || x >= int(params.frame_width) || y >= int(params.frame_height)) { continue; }
            let sample = unpacked_residual(photosite_residuals[y * int(params.frame_width) + x]);
            let exposure = sample.y;
            if (exposure < 0.0) { continue; }
            let mask = one_hot(colour_at(x, y));
            let dx = float(x) - qx;
            let dy = float(y) - qy;
            let kernel = exp(-0.5 * (inverse.x * dx * dx + 2.0 * inverse.y * dx * dy + inverse.z * dy * dy));
            let w = trust * sharpness * kernel * exposure;
            sum += mask * (w * sample.x);
            weight += mask * w;
        }
    }
    float3 wide_sum = float3(0.0);
    float3 wide_weight = float3(0.0);
    let px0 = int(floor((qx - 0.5) * 0.5)) - 1;
    let py0 = int(floor((qy - 0.5) * 0.5)) - 1;
    let half_width = int(params.frame_width / 2);
    let half_height = int(params.frame_height / 2);
    float2 offsets[3] = { period_offset(0), period_offset(1), period_offset(2) };
    float4 across[3];
    float4 down[3];
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        let dx = float4(0.0, 2.0, 4.0, 6.0) + (float(px0) * 2.0 + offsets[channel].x - qx);
        let dy = float4(0.0, 2.0, 4.0, 6.0) + (float(py0) * 2.0 + offsets[channel].y - qy);
        across[channel] = exp(-0.5 * dx * dx / (wide_spread * wide_spread));
        down[channel] = exp(-0.5 * dy * dy / (wide_spread * wide_spread));
    }
    [ForceUnroll]
    for (int j = 0; j < 4; j++) {
        [ForceUnroll]
        for (int i = 0; i < 4; i++) {
            let x = px0 + i;
            let y = py0 + j;
            if (x < 0 || y < 0 || x >= half_width || y >= half_height) { continue; }
            let base = wide_at<Sensor>(uint(x), uint(y), measured<Sensor>(uint(half_width))) * 3;
            [ForceUnroll]
            for (uint channel = 0; channel < 3; channel++) {
                let spread = across[channel][i] * down[channel][j];
                let sample = unpacked_residual(period_residuals[base + channel]);
                let carried = sample.y;
                // A period, not the photosite kernel: a blown highlight's kernel is narrower than a
                // channel's spacing, so whether a clipped site landed inside it would follow each
                // frame's sub-photosite phase and draw moire across the highlight.
                if (carried < 0.0) {
                    if (spread >= CLIP_NEAR) {
                        clip = max(clip, one_hot(channel) * (params.gain * channel_ceiling(channel)));
                    }
                    continue;
                }
                let w = spread * carried;
                let mask = one_hot(channel);
                wide_sum += mask * (w * sample.x);
                wide_weight += mask * w;
            }
        }
    }
    let at = wide_at<Output>(gid.x, gid.y, measured<Output>(params.output_width)) * 3;
    let summed = at * 4 + (params.is_reference != 0 ? 6 : 0);
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        sums[summed + channel] += sum[channel];
        sums[summed + 3 + channel] += weight[channel];
        wide_sums[summed + channel] += wide_sum[channel];
        wide_sums[summed + 3 + channel] += wide_weight[channel];
        clipped_light[at + channel] = max(clipped_light[at + channel], clip[channel]);
    }
}

float summed_at(bool wide, uint at)
{
    return wide ? wide_sums[at] : sums[at];
}

// One band's mean residual at the output pixel whose sums start at `summed`. The reference's own
// residual counts only as far as other frames weigh in beside it: its demosaic already holds its
// samples, with the noise their colour differences smoothed away, which alone its residual would
// put back.
float3 residual_of(bool wide, uint summed)
{
    float others = 0.0;
    float ours = 0.0;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        others += summed_at(wide, summed + 3 + channel);
        ours += summed_at(wide, summed + 9 + channel);
    }
    let share = ours > 0.0 ? min(others / ours, 1.0) : 1.0;
    float3 residual;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        let weight = summed_at(wide, summed + 3 + channel) + summed_at(wide, summed + 9 + channel);
        let sum = summed_at(wide, summed + channel) + share * summed_at(wide, summed + 6 + channel);
        residual[channel] = weight > 0.0 ? sum / weight : 0.0;
    }
    return residual;
}

// Each band's mean residual: the sharpness-weighed one into `merged`, the wide one into `low_band`.
[shader("compute")]
[numthreads(8, 8, 1)]
void settle(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let at = wide_at<Output>(gid.x, gid.y, measured<Output>(params.output_width)) * 3;
    let high = residual_of(false, at * 4);
    let low = residual_of(true, at * 4);
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        merged[at + channel] = high[channel];
        low_band[at + channel] = low[channel];
    }
}

// The merged bands over a demosaic window of the reference, one pixel a photosite.
[shader("compute")]
[numthreads(8, 8, 1)]
void paste(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.window_width || gid.y >= params.window_height) { return; }
    let gx = int(gid.x) + params.window_left;
    let gy = int(gid.y) + params.window_top;
    if (gx < 0 || gy < 0 || gx >= int(params.output_width) || gy >= int(params.output_height)) { return; }
    let from = wide_at<Output>(uint(gx), uint(gy), measured<Output>(params.output_width)) * 3;
    let to = wide_at<Sensor>(gid.x, gid.y, measured<Sensor>(params.window_width)) * 3;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) { rgb[to + channel] = merged[from + channel]; }
}

// The merge as a mosaic over the reference's region at the grid's scale, in its pattern, and the
// reference's demosaic around it: what the colour pass demosaics again and measures how full the
// wells are on.
[shader("compute")]
[numthreads(8, 8, 1)]
void remosaic(uint3 gid : SV_DispatchThreadID)
{
    let width = params.width * params.scale;
    if (gid.x >= width || gid.y >= params.height * params.scale) { return; }
    let channel = colour_at(int(gid.x), int(gid.y));
    let ox = int(gid.x) - params.output_left * int(params.scale);
    let oy = int(gid.y) - params.output_top * int(params.scale);
    let inside = ox >= 0 && oy >= 0 && ox < int(params.output_width) && oy < int(params.output_height);
    remosaiced[wide_at<Output>(gid.x, gid.y, measured<Output>(width)).n] = inside
        ? merged[wide_at<Output>(uint(ox), uint(oy), measured<Output>(params.output_width)) * 3 + channel]
        : prior_site(int(gid.x / params.scale), int(gid.y / params.scale), channel);
}

// The low band the wide kernel stands for, in output pixels: its spread on top of a period's own
// aperture.
float band_sigma()
{
    return float(params.scale) * sqrt(WIDE.d * WIDE.d + PERIOD_APERTURE.d * PERIOD_APERTURE.d);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void blur_rows(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let sigma = band_sigma();
    let reach = int(ceil(3.0 * sigma));
    float3 sum = float3(0.0);
    float total = 0.0;
    for (int k = -reach; k <= reach; k++) {
        let x = uint(clamp(int(gid.x) + k, 0, int(params.output_width) - 1));
        let w = exp(-0.5 * float(k * k) / (sigma * sigma));
        let at = wide_at<Output>(x, gid.y, measured<Output>(params.output_width)) * 3;
        sum += w * float3(merged[at], merged[at + 1], merged[at + 2]);
        total += w;
    }
    let at = wide_at<Output>(gid.x, gid.y, measured<Output>(params.output_width)) * 3;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) { blurred[at + channel] = sum[channel] / total; }
}

// The reference's demosaic, with the high band of the sharpness-weighed residual on the low band of
// the wide one. Where every frame saturated, the brightest light one of them could still have read,
// so the colour pass finds it clipped against the merge's ceiling rather than the reference's.
[shader("compute")]
[numthreads(8, 8, 1)]
void combine(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let scale = float(params.scale);
    let sx = float(params.output_left) + (float(gid.x) + 0.5) / scale - 0.5;
    let sy = float(params.output_top) + (float(gid.y) + 0.5) / scale - 0.5;
    let sigma = band_sigma();
    let reach = int(ceil(3.0 * sigma));
    float3 low = float3(0.0);
    float total = 0.0;
    for (int k = -reach; k <= reach; k++) {
        let y = uint(clamp(int(gid.y) + k, 0, int(params.output_height) - 1));
        let w = exp(-0.5 * float(k * k) / (sigma * sigma));
        let at = wide_at<Output>(gid.x, y, measured<Output>(params.output_width)) * 3;
        low += w * float3(blurred[at], blurred[at + 1], blurred[at + 2]);
        total += w;
    }
    let at = wide_at<Output>(gid.x, gid.y, measured<Output>(params.output_width)) * 3;
    Colour<Level> value;
    Colour<Level> clip;
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) {
        value.v[channel] = prior_at(sx, sy, channel) + merged[at + channel] - low[channel] / total
            + low_band[at + channel];
        clip.v[channel] = clipped_light[at + channel];
    }
    let held = unclipped_light(value, clip);
    [ForceUnroll]
    for (uint channel = 0; channel < 3; channel++) { banded[at + channel] = held.v[channel]; }
}

// A channel held by its bound is a lower limit, and the bounds as a colour are magenta where green's
// is lowest; under the merge's ceiling the colour pass can't see them, so the neutralising is here.
// Only up to the highest bound: past it the raise is a guess at a colour no frame read.
// A clip of zero is "none seen", not a floor: a shadow's noise reads below it.
Colour<Level> unclipped_light(Colour<Level> value, Colour<Level> clip)
{
    let bounded = max(value.v, clip.v);
    let held = float3(
        clip.v.x > 0.0 ? 1.0 - smoothstep(1.0, HELD_TO, value.v.x / clip.v.x) : 0.0,
        clip.v.y > 0.0 ? 1.0 - smoothstep(1.0, HELD_TO, value.v.y / clip.v.y) : 0.0,
        clip.v.z > 0.0 ? 1.0 - smoothstep(1.0, HELD_TO, value.v.z / clip.v.z) : 0.0);
    let reach = max(clip.v.x, max(clip.v.y, clip.v.z));
    let zero_tint = min(float3(
        bounded.y * bounded.y / max(bounded.z, 1e-6),
        sqrt(max(bounded.x * bounded.z, 0.0)),
        bounded.y * bounded.y / max(bounded.x, 1e-6)), float3(reach));
    let raised = lerp(bounded, max(bounded, zero_tint), held);
    Colour<Level> light;
    light.v = lerp(raised, max(raised, float3(reach)), min(held.x, min(held.y, held.z)));
    return light;
}
