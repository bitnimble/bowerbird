// Phase 7: chroma regressed on luma over a 15x15 window, at one pyramid level.
//
// A degree-1 weighted least squares of each chroma term against the luma guide, the weights
// bilateral on the guide and a local colour pilot. The clamp holds the
// regression inside the window's own chroma range, which is what a degree-1 fit will
// otherwise extrapolate past.
//
// The tile is 16: 24x24 would be 576 invocations, over the 256 a portable workgroup is
// allowed. The answer does not depend on it - every read is a gather
// with a reflected boundary - only the halo's share of the work does.

import "../px.slang";
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> y_guide;
[vk::binding(1, 0)] StructuredBuffer<float> c1_in;
[vk::binding(2, 0)] StructuredBuffer<float> c2_in;
[vk::binding(3, 0)] StructuredBuffer<float> c3_in;
[vk::binding(4, 0)] RWStructuredBuffer<float> c1_out;
[vk::binding(5, 0)] RWStructuredBuffer<float> c2_out;
[vk::binding(6, 0)] RWStructuredBuffer<float> c3_out;

struct Push {
    int width;
    int height;
    float strength_c;
    /// `galosh::RATIO_FLOOR`.
    float ratio_floor;
    /// A sample's noise at this level, as a share of the half-resolution plane's.
    float level_noise;
    float green_sign;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int R = 7;
static const float BW = 3.0;
static const float CHROMA_BW = 1.75;
static const int TILE_DIM = 16;
static const int TILE_W = TILE_DIM + 2 * R;
static const int TILE_PIX = TILE_W * TILE_W;

groupshared float t_y[900];
groupshared float t_c1[900];
groupshared float t_c2[900];
groupshared float t_c3[900];
groupshared float t_p1[900];
groupshared float t_p2[900];

/// What a colour difference is divided by to become a share of the luma; one where the floor is
/// zero, which is the pyramid on the differences themselves.
float share_of(float luma)
{
    return pc.ratio_floor > 0.0 ? max(luma, pc.ratio_floor) : 1.0;
}

int reflect_index(int at, int size)
{
    if (at < 0) { at = -at; }
    if (at >= size) { at = 2 * size - at - 2; }
    return clamp(at, 0, size - 1);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void loess_chroma_3p_tiled(uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    if (pc.width <= 0 || pc.height <= 0) { return; }
    let tile_x = int(group.x) * TILE_DIM;
    let tile_y = int(group.y) * TILE_DIM;
    let lx = int(local.x);
    let ly = int(local.y);
    let lid = ly * TILE_DIM + lx;
    let wg_size = TILE_DIM * TILE_DIM;
    let independent = pc.green_sign != 0.0;
    let pilot_radius = independent ? int(COLOUR_GUIDE_RADIUS.n) : 0;
    let pilot_side = 2 * pilot_radius + 1;
    let pilot_width = min(pilot_side, pc.width);
    let pilot_height = min(pilot_side, pc.height);
    let pilot_area = float(pilot_width * pilot_height);
    let exclude_centre = pilot_area > 1.0 ? 1.0 : 0.0;
    let pilot_samples = pilot_area - exclude_centre;

    for (int i = lid; i < TILE_PIX; i += wg_size) {
        let tx = i % TILE_W;
        let ty = i / TILE_W;
        let gx = reflect_index(tile_x - R + tx, pc.width);
        let gy = reflect_index(tile_y - R + ty, pc.height);
        let gp = gy * pc.width + gx;
        let y = y_guide[gp];
        let c = float3(c1_in[gp], c2_in[gp], c3_in[gp]) / share_of(y);
        t_y[i] = y;
        t_c1[i] = c.x;
        t_c2[i] = c.y;
        t_c3[i] = c.z;
        let pilot_x = clamp(gx - pilot_radius, 0, pc.width - pilot_width);
        let pilot_y = clamp(gy - pilot_radius, 0, pc.height - pilot_height);
        var pilot = float2(0.0);
        for (int py = 0; py < pilot_height; py++) {
            for (int px = 0; px < pilot_width; px++) {
                let at = (pilot_y + py) * pc.width + pilot_x + px;
                pilot += colour_axes(float3(c1_in[at], c2_in[at], c3_in[at]), pc.green_sign)
                    / share_of(y_guide[at]);
            }
        }
        let own = (pilot - exclude_centre * colour_axes(c, pc.green_sign)) / pilot_samples;
        t_p1[i] = own.x;
        t_p2[i] = own.y;
    }
    GroupMemoryBarrierWithGroupSync();

    let ox = tile_x + lx;
    let oy = tile_y + ly;
    if (ox >= pc.width || oy >= pc.height) { return; }

    let cx_lds = R + lx;
    let cy_lds = R + ly;
    // **The chroma is regressed as a share of the luma, and put back against this pixel's own.** A
    // site's three terms are colour differences, so on a coloured surface a change of brightness
    // alone moves them in proportion - a dark line on green is a dip in all four of the site's
    // numbers. Regressed as they stand, the fit flattens that dip as though it were a hue and the
    // inverse rebuilds the line at a fraction of its depth; as a share, the line is a constant and
    // there is nothing for the smoothing to take. The floor holds the share finite in the shadows,
    // where it degrades to the plain difference.
    let centre = cy_lds * TILE_W + cx_lds;
    let y_c = t_y[centre];
    let scale_c = share_of(y_c);
    let c_c = float3(t_c1[centre], t_c2[centre], t_c3[centre]);
    let pilot_c = float2(t_p1[centre], t_p2[centre]);
    // No window or pilot here meets the frame's edge, so neither reflects nor clamps.
    let reach = R + pilot_radius;
    let interior = tile_x >= reach && tile_x + TILE_DIM - 1 + reach < pc.width
        && tile_y >= reach && tile_y + TILE_DIM - 1 + reach < pc.height;
    let query_x = clamp(ox - pilot_radius, 0, pc.width - pilot_width);
    let query_y = clamp(oy - pilot_radius, 0, pc.height - pilot_height);
    let bw = BW * pc.level_noise;
    let inv_2sigma_sq = 1.0 / (2.0 * bw * bw);
    let chroma_bw = CHROMA_BW * pc.level_noise / sqrt(pilot_samples);
    let inv_2chroma_sq = 1.0 / (2.0 * chroma_bw * chroma_bw);
    let pilot_noise = 2.0 * pc.level_noise * pc.level_noise / pilot_samples;

    var sum_w = 0.0;
    var sum_y = 0.0;
    var sum_yy = 0.0;
    var sum_c = float3(0.0);
    var sum_yc = float3(0.0);
    var cmin = float3(1e30);
    var cmax = float3(-1e30);

    for (int dy = -R; dy <= R; dy++) {
        let ty_lds = cy_lds + dy;
        let first = independent ? -R : -R + ((dy + R) & 1);
        let stride = independent ? 1 : 2;
        for (int dx = first; dx <= R; dx += stride) {
            let p = ty_lds * TILE_W + (cx_lds + dx);
            let yi = t_y[p];
            let scale_i = share_of(yi);
            let ci = float3(t_c1[p], t_c2[p], t_c3[p]);
            cmin = min(cmin, ci);
            cmax = max(cmax, ci);
            let dy_g = yi - y_c;
            let pilot_i = float2(t_p1[p], t_p2[p]);
            let dc = (pilot_i - pilot_c) * scale_c;
            var overlap_width = max(pilot_side - abs(dx), 0);
            var overlap_height = max(pilot_side - abs(dy), 0);
            var query_in_candidate = abs(dx) <= pilot_radius && abs(dy) <= pilot_radius;
            var candidate_in_query = query_in_candidate;
            var same_centre = dx == 0 && dy == 0;
            if (!interior) {
                let candidate_x = reflect_index(ox + dx, pc.width);
                let candidate_y = reflect_index(oy + dy, pc.height);
                let pilot_x = clamp(candidate_x - pilot_radius, 0, pc.width - pilot_width);
                let pilot_y = clamp(candidate_y - pilot_radius, 0, pc.height - pilot_height);
                overlap_width = max(min(query_x + pilot_width, pilot_x + pilot_width) - max(query_x, pilot_x), 0);
                overlap_height = max(min(query_y + pilot_height, pilot_y + pilot_height) - max(query_y, pilot_y), 0);
                query_in_candidate = ox >= pilot_x && ox < pilot_x + pilot_width
                    && oy >= pilot_y && oy < pilot_y + pilot_height;
                candidate_in_query = candidate_x >= query_x && candidate_x < query_x + pilot_width
                    && candidate_y >= query_y && candidate_y < query_y + pilot_height;
                same_centre = candidate_x == ox && candidate_y == oy;
            }
            let overlap = float(overlap_width * overlap_height) - exclude_centre
                * (float(query_in_candidate) + float(candidate_in_query) - float(same_centre));
            let noise_scale = scale_c / scale_i;
            let expected_noise = pilot_noise * (1.0 + noise_scale * noise_scale
                - 2.0 * noise_scale * overlap / pilot_samples);
            let sample_difference = (ci - c_c) * scale_c;
            let distance = independent
                ? max(dot(dc, dc) - expected_noise, 0.0) / 2.0 * inv_2chroma_sq
                : dot(sample_difference, sample_difference) * inv_2chroma_sq / 3.0;
            let w = exp(-dy_g * dy_g * inv_2sigma_sq - distance);
            sum_w += w;
            sum_y += w * yi;
            sum_yy += w * yi * yi;
            sum_c += w * ci;
            sum_yc += w * yi * ci;
        }
    }

    let inv_w = 1.0 / max(sum_w, 1e-10);
    let mean_y = sum_y * inv_w;
    let mean_yy = sum_yy * inv_w;
    let mean_c = sum_c * inv_w;
    let mean_yc = sum_yc * inv_w;

    let var_y = max(mean_yy - mean_y * mean_y, 0.0);
    let eps = pc.strength_c * pc.strength_c;
    let inv_denom = 1.0 / max(var_y + eps, 1e-6);

    let a = (mean_yc - mean_y * mean_c) * inv_denom;
    let b = mean_c - a * mean_y;

    var fitted = a * y_c + b;
    if (cmax.x >= cmin.x) { fitted.x = clamp(fitted.x, cmin.x, cmax.x); }
    if (cmax.y >= cmin.y) { fitted.y = clamp(fitted.y, cmin.y, cmax.y); }
    if (cmax.z >= cmin.z) { fitted.z = clamp(fitted.z, cmin.z, cmax.z); }

    fitted *= scale_c;

    let op = oy * pc.width + ox;
    c1_out[op] = fitted.x;
    c2_out[op] = fitted.y;
    c3_out[op] = fitted.z;
}
