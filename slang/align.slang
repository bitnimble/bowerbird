// Search a sensor-anchored field coarse to fine over 2x2-block luma, then refine each tile with
// Lucas-Kanade on full-resolution site luma.
// Each block contains every Bayer filter, so odd-photosite motion can be compared; the recipe's
// prior resolves repeated texture at the coarsest level. Saturated windows are never compared.

import px;
import clipped;

static const float MIN_MATCH = 0.35;
static const Extent<Sensor> OUTLIER = { 2.0 };
static const int REFINE_ITERATIONS = 8;
static const float REFINE_REACH = 3.0;
// Less of a search patch than this left unsaturated cannot place it.
static const float MIN_COMPARED = 0.5;
// The refinement's own floor is lower: its Hessian already says whether what is left has the
// texture to place it, and a half-saturated tile left at the search's precision is half a site out.
static const float MIN_REFINED = 0.1;

struct Params {
    uint reference_width;
    uint reference_height;
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
    uint step;
    int reach;
    int patch;
    uint has_previous;
    uint tile;
    float penalty;
    uint pad1;
    uint pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> reference;
[vk::binding(2, 0)] StructuredBuffer<float> frame;
[vk::binding(3, 0)] StructuredBuffer<float> previous;
[vk::binding(4, 0)] RWStructuredBuffer<float> found;
[vk::binding(5, 0)] StructuredBuffer<float> priors;

// Zero-mean normalised cross-correlation over the pairs both planes can vouch for.
float score_at(int rx, int ry, int fx, int fy)
{
    if (fx - params.patch < 0 || fy - params.patch < 0
        || fx + params.patch >= int(params.frame_width)
        || fy + params.patch >= int(params.frame_height)) { return -2.0; }
    let reference_centre = reference[ry * int(params.reference_width) + rx];
    let frame_centre = frame[fy * int(params.frame_width) + fx];
    let a0 = usable(reference_centre) ? reference_centre : 0.0;
    let b0 = usable(frame_centre) ? frame_centre : 0.0;
    float n = 0.0;
    float sa = 0.0;
    float sb = 0.0;
    float saa = 0.0;
    float sbb = 0.0;
    float sab = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            let a = reference[(ry + y) * int(params.reference_width) + rx + x];
            let b = frame[(fy + y) * int(params.frame_width) + fx + x];
            if (!usable(a) || !usable(b)) { continue; }
            let da = a - a0;
            let db = b - b0;
            n += 1.0;
            sa += da;
            sb += db;
            saa += da * da;
            sbb += db * db;
            sab += da * db;
        }
    }
    let side = float(2 * params.patch + 1);
    if (n < MIN_COMPARED * side * side) { return -2.0; }
    let va = saa - sa * sa / n;
    let vb = sbb - sb * sb / n;
    return va > 1e-8 && vb > 1e-8 ? (sab - sa * sb / n) * rsqrt(va * vb) : -2.0;
}

// Where a parabola through three scores about a peak tops out, within half a step.
float vertex(float before, float peak, float after)
{
    if (before < -1.5 || after < -1.5) { return 0.0; }
    let curve = before - 2.0 * peak + after;
    return curve < 0.0 ? clamp(0.5 * (before - after) / curve, -0.5, 0.5) : 0.0;
}

float frame_at(int x, int y)
{
    let cx = clamp(x, 0, int(params.frame_width) - 1);
    let cy = clamp(y, 0, int(params.frame_height) - 1);
    return frame[cy * int(params.frame_width) + cx];
}

float4 catmull_rom(float t)
{
    let t2 = t * t;
    let t3 = t2 * t;
    return float4(
        -0.5 * t3 + t2 - 0.5 * t,
        1.5 * t3 - 2.5 * t2 + 1.0,
        -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        0.5 * t3 - 0.5 * t2);
}

// Bicubic rather than bilinear: a bilinear sample's error is periodic in the fraction, which
// pulls every estimate towards a whole photosite.
float frame_cubic(float x, float y)
{
    let ix = int(floor(x));
    let iy = int(floor(y));
    let wx = catmull_rom(x - float(ix));
    let wy = catmull_rom(y - float(iy));
    float sum = 0.0;
    [ForceUnroll]
    for (int j = 0; j < 4; j++) {
        let a = frame_at(ix - 1, iy - 1 + j);
        let b = frame_at(ix, iy - 1 + j);
        let c = frame_at(ix + 1, iy - 1 + j);
        let d = frame_at(ix + 2, iy - 1 + j);
        if (!usable(a) || !usable(b) || !usable(c) || !usable(d)) { return CLIPPED; }
        sum += wy[j] * (wx.x * a + wx.y * b + wx.z * c + wx.w * d);
    }
    return sum;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void align(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.grid_width || gid.y >= params.grid_height) { return; }
    let tile_size = measured<Sensor>(params.tile).n;
    let tile = gid.y * params.grid_width + gid.x;
    let out = tile * 4;
    let sensor_x = params.grid_left + int(gid.x * tile_size + tile_size / 2);
    let sensor_y = params.grid_top + int(gid.y * tile_size + tile_size / 2);
    let rx = int(round(float(sensor_x - params.reference_left) / float(params.step)));
    let ry = int(round(float(sensor_y - params.reference_top) / float(params.step)));
    let prior_x = priors[tile * 2];
    let prior_y = priors[tile * 2 + 1];
    let predicted_x = params.has_previous != 0 ? previous[out] : prior_x;
    let predicted_y = params.has_previous != 0 ? previous[out + 1] : prior_y;
    found[out] = predicted_x;
    found[out + 1] = predicted_y;
    found[out + 2] = 0.0;
    found[out + 3] = 0.0;
    if (rx - params.patch < 0 || ry - params.patch < 0
        || rx + params.patch >= int(params.reference_width)
        || ry + params.patch >= int(params.reference_height)) { return; }

    float n = 0.0;
    float sum = 0.0;
    float squares = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            let value = reference[(ry + y) * int(params.reference_width) + rx + x];
            if (!usable(value)) { continue; }
            n += 1.0;
            sum += value;
            squares += value * value;
        }
    }
    let side = float(2 * params.patch + 1);
    if (n < MIN_COMPARED * side * side || squares - sum * sum / n < 1e-6 * n) { return; }

    let base_x = int(round(float(sensor_x - params.frame_left + int(round(predicted_x))) / float(params.step)));
    let base_y = int(round(float(sensor_y - params.frame_top + int(round(predicted_y))) / float(params.step)));
    float peak = -2.0;
    float best_utility = -3.0;
    int best_x = 0;
    int best_y = 0;
    for (int y = -params.reach; y <= params.reach; y++) {
        for (int x = -params.reach; x <= params.reach; x++) {
            let score = score_at(rx, ry, base_x + x, base_y + y);
            let candidate_x = float(params.frame_left - params.reference_left + (base_x + x - rx) * int(params.step));
            let candidate_y = float(params.frame_top - params.reference_top + (base_y + y - ry) * int(params.step));
            let from_prior_x = candidate_x - prior_x;
            let from_prior_y = candidate_y - prior_y;
            let utility = score - params.penalty * (from_prior_x * from_prior_x + from_prior_y * from_prior_y);
            if (utility > best_utility || (utility == best_utility && abs(x) + abs(y) < abs(best_x) + abs(best_y))) {
                best_utility = utility;
                peak = score;
                best_x = x;
                best_y = y;
            }
        }
    }
    if (peak < MIN_MATCH) { return; }
    let fx = base_x + best_x;
    let fy = base_y + best_y;
    let sub = float2(
        vertex(score_at(rx, ry, fx - 1, fy), peak, score_at(rx, ry, fx + 1, fy)),
        vertex(score_at(rx, ry, fx, fy - 1), peak, score_at(rx, ry, fx, fy + 1)));
    found[out] = float(params.frame_left - params.reference_left + (fx - rx) * int(params.step))
        + sub.x * float(params.step);
    found[out + 1] = float(params.frame_top - params.reference_top + (fy - ry) * int(params.step))
        + sub.y * float(params.step);
    found[out + 2] = peak;
    found[out + 3] = 1.0;
}

static const uint REFINE_LANES = 64;
static const uint REFINE_SUMS = 15;
groupshared float refine_sums[REFINE_SUMS * REFINE_LANES];

// Lucas-Kanade on full-resolution site luma from the search's answer, over the pairs neither
// side saturated. The frame's contrast is matched to the reference's each iteration, which takes
// up an exposure gain the header stated slightly wrong. One workgroup a tile, its lanes splitting
// the window.
[shader("compute")]
[numthreads(64, 1, 1)]
void refine(uint3 group : SV_GroupID, uint lane : SV_GroupIndex)
{
    let tile_size = measured<Sensor>(params.tile).n;
    let tile = min(group.y * params.grid_width + group.x, params.grid_width * params.grid_height - 1);
    let out = tile * 4;
    let rx = params.grid_left + int(group.x * tile_size + tile_size / 2) - params.reference_left;
    let ry = params.grid_top + int(group.y * tile_size + tile_size / 2) - params.reference_top;
    let radius = params.patch;
    let side = 2 * radius + 1;
    let inside = group.x < params.grid_width && group.y < params.grid_height
        && rx - radius - 1 >= 0 && ry - radius - 1 >= 0
        && rx + radius + 1 < int(params.reference_width)
        && ry + radius + 1 < int(params.reference_height);
    let refining = inside && previous[out + 3] != 0.0;
    bool running = refining;
    bool failed = false;

    let spread = 2.0 * pow(float(radius) * 0.5, 2.0);
    let width = int(params.reference_width);
    let start = float2(previous[out], previous[out + 1]);
    float2 d = start;
    let to_frame = float2(float(params.reference_left - params.frame_left),
        float(params.reference_top - params.frame_top));
    // Every lane meets every barrier: a finished tile's lanes keep stepping through the iterations.
    for (int iteration = 0; iteration < REFINE_ITERATIONS; iteration++) {
        float sums[REFINE_SUMS];
        [ForceUnroll]
        for (uint k = 0; k < REFINE_SUMS; k++) { sums[k] = 0.0; }
        for (int t = running ? int(lane) : side * side; t < side * side; t += int(REFINE_LANES)) {
            let y = t / side - radius;
            let x = t % side - radius;
            let w = exp(-float(x * x + y * y) / spread);
            sums[0] += w;
            let at = (ry + y) * width + rx + x;
            let r = reference[at];
            let left = reference[at - 1];
            let right = reference[at + 1];
            let above = reference[at - width];
            let below = reference[at + width];
            if (!usable(r) || !usable(left) || !usable(right) || !usable(above) || !usable(below)) { continue; }
            let f = frame_cubic(float(rx + x) + to_frame.x + d.x, float(ry + y) + to_frame.y + d.y);
            if (!usable(f)) { continue; }
            let g = 0.5 * float2(right - left, below - above);
            sums[1] += w;
            sums[2] += w * r;
            sums[3] += w * f;
            sums[4] += w * r * r;
            sums[5] += w * f * f;
            sums[6] += w * g.x;
            sums[7] += w * g.y;
            sums[8] += w * g.x * r;
            sums[9] += w * g.y * r;
            sums[10] += w * g.x * f;
            sums[11] += w * g.y * f;
            sums[12] += w * g.x * g.x;
            sums[13] += w * g.x * g.y;
            sums[14] += w * g.y * g.y;
        }
        [ForceUnroll]
        for (uint k = 0; k < REFINE_SUMS; k++) { refine_sums[k * REFINE_LANES + lane] = sums[k]; }
        GroupMemoryBarrierWithGroupSync();
        for (uint stride = REFINE_LANES / 2; stride > 0; stride >>= 1) {
            if (lane < stride) {
                [ForceUnroll]
                for (uint k = 0; k < REFINE_SUMS; k++) {
                    refine_sums[k * REFINE_LANES + lane] += refine_sums[k * REFINE_LANES + lane + stride];
                }
            }
            GroupMemoryBarrierWithGroupSync();
        }
        [ForceUnroll]
        for (uint k = 0; k < REFINE_SUMS; k++) { sums[k] = refine_sums[k * REFINE_LANES]; }
        GroupMemoryBarrierWithGroupSync();
        if (running) {
            let weight = sums[1];
            let sg = float2(sums[6], sums[7]);
            let h00 = sums[12];
            let h01 = sums[13];
            let h11 = sums[14];
            let det = h00 * h11 - h01 * h01;
            // A search's answer is only as good as its step, so a tile that can't be placed takes
            // its neighbours'.
            failed = weight < MIN_REFINED * sums[0] || det <= 1e-6 * (h00 + h11) * (h00 + h11) || h00 + h11 <= 1e-12;
            if (!failed) {
                let mean_r = sums[2] / weight;
                let mean_f = sums[3] / weight;
                let spread_r = max(sums[4] / weight - mean_r * mean_r, 0.0);
                let spread_f = max(sums[5] / weight - mean_f * mean_f, 0.0);
                let contrast = spread_f > 0.0 ? sqrt(spread_r / spread_f) : 1.0;
                let b = contrast * (float2(sums[10], sums[11]) - mean_f * sg) - (float2(sums[8], sums[9]) - mean_r * sg);
                let step = -float2(h11 * b.x - h01 * b.y, h00 * b.y - h01 * b.x) / det;
                d += step;
                failed = length(d - start) > REFINE_REACH;
                running = !failed && length(step) >= 0.001;
            } else {
                running = false;
            }
        }
    }
    if (lane != 0 || group.x >= params.grid_width || group.y >= params.grid_height) { return; }
    for (uint k = 0; k < 4; k++) { found[out + k] = previous[out + k]; }
    if (failed) {
        found[out + 3] = 0.0;
    } else if (refining) {
        found[out] = d.x;
        found[out + 1] = d.y;
    }
}

[shader("compute")]
[numthreads(8, 8, 1)]
void regularize(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.grid_width || gid.y >= params.grid_height) { return; }
    let tile = gid.y * params.grid_width + gid.x;
    let out = tile * 4;
    float xs[25];
    float ys[25];
    int count = 0;
    for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
            let tx = int(gid.x) + x;
            let ty = int(gid.y) + y;
            if (tx < 0 || ty < 0 || tx >= int(params.grid_width) || ty >= int(params.grid_height)) { continue; }
            let at = (ty * int(params.grid_width) + tx) * 4;
            if (previous[at + 3] > 0.0) {
                xs[count] = previous[at];
                ys[count] = previous[at + 1];
                count++;
            }
        }
    }
    float dx = previous[out];
    float dy = previous[out + 1];
    float score = previous[out + 3] > 0.0 ? previous[out + 2] : 0.0;
    if (count > 0) {
        for (int a = 0; a < count; a++) {
            for (int b = a + 1; b < count; b++) {
                if (xs[b] < xs[a]) { let hold = xs[a]; xs[a] = xs[b]; xs[b] = hold; }
                if (ys[b] < ys[a]) { let hold = ys[a]; ys[a] = ys[b]; ys[b] = hold; }
            }
        }
        let middle_x = xs[count / 2];
        let middle_y = ys[count / 2];
        if (previous[out + 3] == 0.0 || abs(dx - middle_x) > OUTLIER.d || abs(dy - middle_y) > OUTLIER.d) {
            dx = middle_x;
            dy = middle_y;
            score = 0.0;
        }
    }
    found[out] = dx;
    found[out + 1] = dy;
    // zero where the tile took its neighbours' answer, which `Field::placed` leaves out
    found[out + 2] = score;
    found[out + 3] = count > 0 ? 1.0 : 0.0;
}

// One ring outward: a tile nothing placed takes the mean of the placed tiles beside it, so a
// field reaches over a region its reference held nothing to correlate, a blown sky most of all.
[shader("compute")]
[numthreads(8, 8, 1)]
void fill(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.grid_width || gid.y >= params.grid_height) { return; }
    let out = (gid.y * params.grid_width + gid.x) * 4;
    for (uint k = 0; k < 4; k++) { found[out + k] = previous[out + k]; }
    if (previous[out + 3] > 0.0) { return; }
    float2 sum = float2(0.0);
    float count = 0.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            let tx = int(gid.x) + x;
            let ty = int(gid.y) + y;
            if (tx < 0 || ty < 0 || tx >= int(params.grid_width) || ty >= int(params.grid_height)) { continue; }
            let at = (ty * int(params.grid_width) + tx) * 4;
            if (previous[at + 3] > 0.0) {
                sum += float2(previous[at], previous[at + 1]);
                count += 1.0;
            }
        }
    }
    if (count == 0.0) { return; }
    found[out] = sum.x / count;
    found[out + 1] = sum.y / count;
    found[out + 3] = 1.0;
}
