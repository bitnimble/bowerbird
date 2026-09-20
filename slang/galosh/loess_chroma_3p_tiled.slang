// Phase 7: chroma regressed on luma over a 15x15 window, at one pyramid level.
//
// A degree-1 weighted least squares of each chroma term against the luma guide, the weights
// bilateral on the guide - so the colour is smoothed along whatever the luma says is one
// surface, and stops at the edge rather than bleeding across it. The clamp holds the
// regression inside the window's own chroma range, which is what a degree-1 fit will
// otherwise extrapolate past.
//
// The tile is 16: 24x24 would be 576 invocations, over the 256 a portable workgroup is
// allowed. The answer does not depend on it - every read is a gather
// with a reflected boundary - only the halo's share of the work does.

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

/// What a colour difference is divided by to become a share of the luma; one where the floor is
/// zero, which is the pyramid on the differences themselves.
float share_of(float luma)
{
    return pc.ratio_floor > 0.0 ? max(luma, pc.ratio_floor) : 1.0;
}

[shader("compute")]
[numthreads(16, 16, 1)]
void loess_chroma_3p_tiled(uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    let tile_x = int(group.x) * TILE_DIM;
    let tile_y = int(group.y) * TILE_DIM;
    let lx = int(local.x);
    let ly = int(local.y);
    let lid = ly * TILE_DIM + lx;
    let wg_size = TILE_DIM * TILE_DIM;

    for (int i = lid; i < TILE_PIX; i += wg_size) {
        let tx = i % TILE_W;
        let ty = i / TILE_W;
        var gx = tile_x - R + tx;
        var gy = tile_y - R + ty;
        if (gx < 0) { gx = -gx; }
        if (gx >= pc.width) { gx = 2 * pc.width - gx - 2; }
        gx = clamp(gx, 0, pc.width - 1);
        if (gy < 0) { gy = -gy; }
        if (gy >= pc.height) { gy = 2 * pc.height - gy - 2; }
        gy = clamp(gy, 0, pc.height - 1);
        let gp = gy * pc.width + gx;
        t_y[i] = y_guide[gp];
        t_c1[i] = c1_in[gp];
        t_c2[i] = c2_in[gp];
        t_c3[i] = c3_in[gp];
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
    let y_c = t_y[cy_lds * TILE_W + cx_lds];
    let scale_c = share_of(y_c);
    let c_c = float3(
        t_c1[cy_lds * TILE_W + cx_lds],
        t_c2[cy_lds * TILE_W + cx_lds],
        t_c3[cy_lds * TILE_W + cx_lds]) / scale_c;
    let inv_2sigma_sq = 1.0 / (2.0 * BW * BW);
    let inv_2chroma_sq = 1.0 / (2.0 * CHROMA_BW * CHROMA_BW);

    var sum_w = 0.0;
    var sum_y = 0.0;
    var sum_yy = 0.0;
    var sum_c = float3(0.0);
    var sum_yc = float3(0.0);
    var cmin = float3(1e30);
    var cmax = float3(-1e30);

    for (int dy = -R; dy <= R; dy++) {
        let ty_lds = cy_lds + dy;
        // **Every other tap, offset a column each row, so the window is read as a checkerboard.**
        // 113 samples of the same 15x15 rather than 225: the support and the bandwidth are
        // unchanged, and a subsample of a weighted least squares is unbiased - only the estimator's
        // variance rises. The taps are the whole cost of this kernel, its arithmetic measuring at
        // 42ms of 334, so this is the only thing that moves it.
        //
        // Measured against the full window with `pixdiff`: a mean of 1.0-1.6 counts of 255 on a
        // base-ISO frame and 2.7-4.9 at ISO 25600.
        let first = -R + ((dy + R) & 1);
        for (int dx = first; dx <= R; dx += 2) {
            let p = ty_lds * TILE_W + (cx_lds + dx);
            let yi = t_y[p];
            let ci = float3(t_c1[p], t_c2[p], t_c3[p]) / share_of(yi);
            cmin = min(cmin, ci);
            cmax = max(cmax, ci);
            let dy_g = yi - y_c;
            // **On the colour, not only on its lightness.** A guide that is luma alone calls a
            // blue floral and the vermilion beam behind it one surface wherever the two are
            // equally light, and the regression then predicts the beam's chroma for the floral -
            // its own tap is one of 113 and the clamp cannot save it, the beam being inside the
            // window's range.
            //
            // Its own bandwidth, and it cannot borrow the guide's: `y_guide` is the shrinkage's
            // output where these three planes are `chroma_extract_halfres` off the frame that went
            // into it, so the guide's residual noise is a fraction of theirs however alike the two
            // were in the GAT. Divided by three as well, being three squared differences against
            // the guide's one - without that a chroma difference the size of the noise reads three
            // times as far as an equal one in luma.
            // Back in the difference's own units at this pixel, which is what the bandwidth is.
            let dc = (ci - c_c) * scale_c;
            let w = exp(-dy_g * dy_g * inv_2sigma_sq - dot(dc, dc) * inv_2chroma_sq / 3.0);
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
