// Phase 2(a): the weighted residual against the dark reference just fitted.
//
// The IRLS iteration: this measures how far the blocks sit from the fit, and
// `dark_resid_finalize_mwg` turns that into the next Tukey scale.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> in_gat_full;
[vk::binding(1, 0)] StructuredBuffer<float> raw;
[vk::binding(2, 0)] StructuredBuffer<float> params;
[vk::binding(3, 0)] RWStructuredBuffer<float> partial_resid_buf;

struct Push {
    int width;
    int height;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int WGSIZE = 256;

groupshared float lds[512];

[shader("compute")]
[numthreads(256, 1, 1)]
void dark_resid_reduce_mwg(
    uint3 id : SV_DispatchThreadID,
    uint3 local : SV_GroupThreadID,
    uint3 group : SV_GroupID)
{
    let gid = int(id.x);
    let lid = int(local.x);
    let wgid = int(group.x);
    let total_wis = DR_WORKGROUPS * WGSIZE;

    let inv_s = 1.0 / max(params[P_S_SCALE], 1e-20);
    let dr0 = params[P_DARK_REF0 + 0];
    let dr1 = params[P_DARK_REF0 + 1];
    let dr2 = params[P_DARK_REF0 + 2];
    let dr3 = params[P_DARK_REF0 + 3];

    let n_block_rows = pc.height / 2;
    let n_block_cols = pc.width / 2;
    let total_blocks = n_block_rows * n_block_cols;

    var swr = tally();
    var sww = tally();

    for (int bi = gid; bi < total_blocks; bi += total_wis) {
        let br_idx = bi / n_block_cols;
        let bc_idx = bi - br_idx * n_block_cols;
        let br = 2 * br_idx;
        let bc = 2 * bc_idx;

        let g0 = in_gat_full[br * pc.width + bc];
        let g1 = in_gat_full[(br + 1) * pc.width + bc];
        let g2 = in_gat_full[br * pc.width + (bc + 1)];
        let g3 = in_gat_full[(br + 1) * pc.width + (bc + 1)];
        let ch_max = max(max(g0, g1), max(g2, g3));
        let ch_min = min(min(g0, g1), min(g2, g3));
        if (ch_max - ch_min > ACHROMATIC_RANGE) { continue; }

        let iv0 = raw[br * pc.width + bc];
        let iv1 = raw[(br + 1) * pc.width + bc];
        let iv2 = raw[br * pc.width + (bc + 1)];
        let iv3 = raw[(br + 1) * pc.width + (bc + 1)];
        let l_raw = (iv0 + iv1 + iv2 + iv3) * 0.25;
        let r = l_raw * inv_s;
        let r2 = r * r;
        let w = 1.0 / (1.0 + r2 * r2);
        let d0 = g0 - dr0;
        let d1 = g1 - dr1;
        let d2 = g2 - dr2;
        let d3 = g3 - dr3;
        let resid2 = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
        tally_push(sww, w);
        tally_push(swr, w * resid2 * 0.25);
    }

    lds[lid * 2 + 0] = tally_sum(swr);
    lds[lid * 2 + 1] = tally_sum(sww);
    GroupMemoryBarrierWithGroupSync();

    for (int s = WGSIZE / 2; s > 0; s >>= 1) {
        if (lid < s) {
            for (int q = 0; q < 2; q++) {
                lds[lid * 2 + q] = lds[lid * 2 + q] + lds[(lid + s) * 2 + q];
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (lid == 0) {
        partial_resid_buf[wgid * 2 + 0] = lds[0];
        partial_resid_buf[wgid * 2 + 1] = lds[1];
    }
}
