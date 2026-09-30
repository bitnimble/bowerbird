// Phase 0(c): how far the photosites under black sit below it, one workgroup's share.
//
// Light only adds, so a photosite reads under black by read noise alone: the depths gathered here
// are the read noise's own lower half, with no scene and no shot noise in them. A black level at a
// time, since the fit states green's.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> raw;
[vk::binding(1, 0)] RWStructuredBuffer<float> partial_buf;

struct Push {
    int width;
    int height;
    int period_w;
    int period_h;
    uint packed0;
    uint packed1;
    uint packed2;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int WGSIZE = 256;

groupshared UnderBlack lds[WGSIZE * BLACK_LEVELS];

[shader("compute")]
[numthreads(256, 1, 1)]
void under_black_reduce(
    uint3 id : SV_DispatchThreadID,
    uint3 local : SV_GroupThreadID,
    uint3 group : SV_GroupID)
{
    let gid = int(id.x);
    let lid = int(local.x);
    let wgid = int(group.x);
    let total_wis = DR_WORKGROUPS * WGSIZE;
    let total = pc.width * pc.height;
    Pattern pat = { pc.period_w, pc.period_h, pc.packed0, pc.packed1, pc.packed2 };

    UnderBlack mine[BLACK_LEVELS];
    for (int l = 0; l < BLACK_LEVELS; l++) { under_black_none(mine[l]); }
    for (int at = gid; at < total; at += total_wis) {
        let value = raw[at];
        // Spelled against the comparison, so a sample that is not a number counts as nothing.
        if (!(value < 0.0)) { continue; }
        let y = at / pc.width;
        let x = at - y * pc.width;
        let level = black_level_of(cfa_colour(pat, y, x), y);
        let next = x + pc.period_w < pc.width ? at + pc.period_w : at - pc.period_w;
        under_black_take(mine[level], -value, raw[next] < 0.0);
    }

    for (int l = 0; l < BLACK_LEVELS; l++) { lds[lid * BLACK_LEVELS + l] = mine[l]; }
    GroupMemoryBarrierWithGroupSync();

    for (int s = WGSIZE / 2; s > 0; s >>= 1) {
        if (lid < s) {
            for (int l = 0; l < BLACK_LEVELS; l++) {
                under_black_merge(mine[l], lds[(lid + s) * BLACK_LEVELS + l]);
                lds[lid * BLACK_LEVELS + l] = mine[l];
            }
        }
        GroupMemoryBarrierWithGroupSync();
    }

    if (lid == 0) {
        for (int l = 0; l < BLACK_LEVELS; l++) {
            let at = wgid * UNDER_BLACK_SUMS + l * (UNDER_BLACK_SUMS / BLACK_LEVELS);
            partial_buf[at + 0] = lds[l].depth;
            partial_buf[at + 1] = lds[l].count;
            partial_buf[at + 2] = lds[l].paired;
            partial_buf[at + 3] = lds[l].deepest;
            partial_buf[at + 4] = lds[l].at_deepest;
            partial_buf[at + 5] = lds[l].paired_at_deepest;
        }
    }
}
