// Search a sensor-anchored field coarse to fine over 2x2-block luma.
// Each block contains every Bayer filter, so odd-photosite motion can be compared; the recipe's
// prior resolves repeated texture while the finest search measures fractional handheld offsets.

import px;

static const float PRIOR_PENALTY = 0.0003;
static const float MIN_MATCH = 0.35;
static const Extent<Sensor> OUTLIER = { 2.0 };

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
    uint pad0;
    uint pad1;
    uint pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> reference;
[vk::binding(2, 0)] StructuredBuffer<float> frame;
[vk::binding(3, 0)] StructuredBuffer<float> previous;
[vk::binding(4, 0)] RWStructuredBuffer<float> found;
[vk::binding(5, 0)] StructuredBuffer<float> priors;

float score_at(int rx, int ry, int fx, int fy, float mean, float variance)
{
    if (fx - params.patch < 0 || fy - params.patch < 0
        || fx + params.patch >= int(params.frame_width)
        || fy + params.patch >= int(params.frame_height)) { return -2.0; }
    float sum = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            sum += frame[(fy + y) * int(params.frame_width) + fx + x];
        }
    }
    let side = float(2 * params.patch + 1);
    let frame_mean = sum / (side * side);
    float frame_variance = 0.0;
    float joint = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            let a = reference[(ry + y) * int(params.reference_width) + rx + x] - mean;
            let b = frame[(fy + y) * int(params.frame_width) + fx + x] - frame_mean;
            joint += a * b;
            frame_variance += b * b;
        }
    }
    return frame_variance > 1e-8 ? joint * rsqrt(variance * frame_variance) : -2.0;
}

float sample_frame(float x, float y)
{
    let ix = int(floor(x));
    let iy = int(floor(y));
    let fx = frac(x);
    let fy = frac(y);
    let a = lerp(frame[iy * int(params.frame_width) + ix], frame[iy * int(params.frame_width) + ix + 1], fx);
    let b = lerp(frame[(iy + 1) * int(params.frame_width) + ix], frame[(iy + 1) * int(params.frame_width) + ix + 1], fx);
    return lerp(a, b, fy);
}

float fractional_score(int rx, int ry, float fx, float fy, float mean, float variance)
{
    if (fx - float(params.patch) < 0.0 || fy - float(params.patch) < 0.0
        || fx + float(params.patch) + 1.0 >= float(params.frame_width)
        || fy + float(params.patch) + 1.0 >= float(params.frame_height)) { return -2.0; }
    float sum = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            sum += sample_frame(fx + float(x), fy + float(y));
        }
    }
    let side = float(2 * params.patch + 1);
    let frame_mean = sum / (side * side);
    float frame_variance = 0.0;
    float joint = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            let a = reference[(ry + y) * int(params.reference_width) + rx + x] - mean;
            let b = sample_frame(fx + float(x), fy + float(y)) - frame_mean;
            joint += a * b;
            frame_variance += b * b;
        }
    }
    return frame_variance > 1e-8 ? joint * rsqrt(variance * frame_variance) : -2.0;
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

    float sum = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            sum += reference[(ry + y) * int(params.reference_width) + rx + x];
        }
    }
    let side = float(2 * params.patch + 1);
    let mean = sum / (side * side);
    float variance = 0.0;
    for (int y = -params.patch; y <= params.patch; y++) {
        for (int x = -params.patch; x <= params.patch; x++) {
            let value = reference[(ry + y) * int(params.reference_width) + rx + x] - mean;
            variance += value * value;
        }
    }
    if (variance < 1e-6 * side * side) { return; }

    let base_x = int(round(float(sensor_x - params.frame_left + int(round(predicted_x))) / float(params.step)));
    let base_y = int(round(float(sensor_y - params.frame_top + int(round(predicted_y))) / float(params.step)));
    float peak = -2.0;
    float best_utility = -3.0;
    int best_x = 0;
    int best_y = 0;
    for (int y = -params.reach; y <= params.reach; y++) {
        for (int x = -params.reach; x <= params.reach; x++) {
            let score = score_at(rx, ry, base_x + x, base_y + y, mean, variance);
            let candidate_x = float(params.frame_left - params.reference_left + (base_x + x - rx) * int(params.step));
            let candidate_y = float(params.frame_top - params.reference_top + (base_y + y - ry) * int(params.step));
            let from_prior_x = candidate_x - prior_x;
            let from_prior_y = candidate_y - prior_y;
            let utility = score - PRIOR_PENALTY * (from_prior_x * from_prior_x + from_prior_y * from_prior_y);
            if (utility > best_utility || (utility == best_utility && abs(x) + abs(y) < abs(best_x) + abs(best_y))) {
                best_utility = utility;
                peak = score;
                best_x = x;
                best_y = y;
            }
        }
    }
    if (peak < MIN_MATCH) { return; }
    float sub_x = 0.0;
    float sub_y = 0.0;
    if (params.step == 2 && abs(best_x) < params.reach && abs(best_y) < params.reach) {
        float step = 0.5;
        for (int iteration = 0; iteration < 6; iteration++) {
            float best_score = fractional_score(rx, ry, float(base_x + best_x) + sub_x, float(base_y + best_y) + sub_y, mean, variance);
            float move_x = 0.0;
            float move_y = 0.0;
            for (int y = -1; y <= 1; y++) {
                for (int x = -1; x <= 1; x++) {
                    let score = fractional_score(rx, ry,
                        float(base_x + best_x) + sub_x + float(x) * step,
                        float(base_y + best_y) + sub_y + float(y) * step,
                        mean, variance);
                    if (score > best_score) {
                        best_score = score;
                        move_x = float(x) * step;
                        move_y = float(y) * step;
                    }
                }
            }
            sub_x += move_x;
            sub_y += move_y;
            step *= 0.5;
        }
    }
    found[out] = float(params.frame_left - params.reference_left)
        + (float(base_x + best_x - rx) + sub_x) * float(params.step);
    found[out + 1] = float(params.frame_top - params.reference_top)
        + (float(base_y + best_y - ry) + sub_y) * float(params.step);
    found[out + 2] = peak;
    found[out + 3] = 1.0;
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
        }
    }
    found[out] = dx;
    found[out + 1] = dy;
    found[out + 2] = previous[out + 2];
    found[out + 3] = count > 0 ? 1.0 : 0.0;
}
