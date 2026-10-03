// The frame's nits, averaged to the camera match's own supervision footprint, and split in two
// where a block straddles an edge (`block_split.slang`).
//
// The colour fit teaches the chroma lattice on block means - one pair per pixel of a
// 1280-wide grid over the photograph - and at those means it is measured correct. Read per
// render pixel instead, the lattice meets colours the fit never saw: texture spreads a
// block's pixels across cells whose operators differ, and the mean of the corrected
// pixels is not the correction of the mean. On a lit skin transition that gap is a mauve
// patch the camera's own rendering does not have. `matched_nits` therefore reads the
// lattice *at* this average and applies the operator to the pixel itself, which makes the
// block means of the two renderings agree by construction.
//
// Two texels a block, side by side: the first half's mean and its share of the block, then the
// second half's mean and how far the split is trusted. One workgroup a block, each lane walking
// the same block-relative pixels whatever window the block is seen through, so a tile and the
// whole render split every block they share alike.
//
// Through `nits_of_code`, not a host-side decode: the grade has one implementation (21.1),
// and this average has to sit exactly where the grade's own reads sit.
import block_split;
import packed;
import px;

struct Push {
    uint width;
    uint height;
    /// The supervision footprint in this frame's pixels: the photograph's long edge over
    /// the fit grid's, scaled to however much of the photograph this frame holds.
    uint block;
    /// Where the frame starts inside its photograph-anchored block, per axis: the blocks
    /// partition the *photograph*, so a window whose origin is not a block multiple opens
    /// with a partial cell. Anchored there so a tile and the whole render average the same
    /// pixels into every cell they share.
    uint phase_x;
    uint phase_y;
    /// Nits of diffuse white, which `split_space` floors against.
    float reference;
};

[vk::binding(20, 0)] ConstantBuffer<Push> pc;
[vk::binding(1, 0)] StructuredBuffer<uint> frame;
[vk::binding(12, 0)] StructuredBuffer<float> nits_of_code;
[vk::image_format("rgba16f")]
[vk::binding(19, 0)] WTexture2D<float4> mean_frame;

static const uint SIDE = 16;
static const uint LANES = SIDE * SIDE;
static const uint SETTLE = 3;

groupshared float4 lane_a[LANES];
groupshared float4 lane_b[LANES];
groupshared float2 lane_c[LANES];

float3 nits_at(int2 p)
{
    let base = wide_at<Drawn>(uint(p.x), uint(p.y), measured<Drawn>(pc.width)) * 3;
    return float3(
        nits_of_code[half_of(frame[base / 2], base)],
        nits_of_code[half_of(frame[(base + 1) / 2], base + 1)],
        nits_of_code[half_of(frame[(base + 2) / 2], base + 2)]);
}

/// The frame pixel at block-relative `(x, y)` of block `cell`, or `(-1, -1)` past the frame.
int2 pixel_of(uint2 cell, uint x, uint y)
{
    let p = int2(cell * pc.block + uint2(x, y)) - int2(int(pc.phase_x), int(pc.phase_y));
    if (p.x < 0 || p.y < 0 || p.x >= int(pc.width) || p.y >= int(pc.height)) { return int2(-1); }
    return p;
}

void summed(uint lane)
{
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = LANES / 2; stride > 0; stride = stride / 2) {
        if (lane < stride) {
            lane_a[lane] += lane_a[lane + stride];
            lane_b[lane] += lane_b[lane + stride];
            lane_c[lane] += lane_c[lane + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
}

/// The pixel furthest from `from` in `lane_a[0].rgb`, its distance in `.a`.
void furthest(uint2 cell, uint2 local, uint lane, float3 from)
{
    var best = float4(from, -1.0);
    for (uint y = local.y; y < pc.block; y += SIDE) {
        for (uint x = local.x; x < pc.block; x += SIDE) {
            let p = pixel_of(cell, x, y);
            if (p.x < 0) { continue; }
            let v = split_space(nits_at(p), pc.reference);
            let d = length(v - from);
            if (d > best.a) { best = float4(v, d); }
        }
    }
    lane_a[lane] = best;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = LANES / 2; stride > 0; stride = stride / 2) {
        if (lane < stride && lane_a[lane + stride].a > lane_a[lane].a) {
            lane_a[lane] = lane_a[lane + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
}

[shader("compute")]
[numthreads(16, 16, 1)]
void mean(uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID, uint lane : SV_GroupIndex)
{
    let cell = group.xy;

    var log_sum = float3(0.0);
    var count = 0.0;
    for (uint y = local.y; y < pc.block; y += SIDE) {
        for (uint x = local.x; x < pc.block; x += SIDE) {
            let p = pixel_of(cell, x, y);
            if (p.x < 0) { continue; }
            log_sum += split_space(nits_at(p), pc.reference);
            count += 1.0;
        }
    }
    lane_a[lane] = float4(log_sum, count);
    lane_b[lane] = float4(0.0);
    lane_c[lane] = float2(0.0);
    summed(lane);
    let centre = lane_a[0].rgb / max(lane_a[0].a, 1.0);
    GroupMemoryBarrierWithGroupSync();

    // Seeded two-means: the pixel furthest from the mean, then the one furthest from that.
    furthest(cell, local.xy, lane, centre);
    var first = lane_a[0].rgb;
    GroupMemoryBarrierWithGroupSync();
    furthest(cell, local.xy, lane, first);
    var second = lane_a[0].rgb;
    GroupMemoryBarrierWithGroupSync();

    var nits_first = float3(0.0);
    var nits_second = float3(0.0);
    var counts = float2(0.0);
    var spread = 0.0;
    for (uint round = 0; round <= SETTLE; round++) {
        var into_first = float4(0.0);
        var into_second = float4(0.0);
        var lit_first = float3(0.0);
        var lit_second = float3(0.0);
        var scatter = 0.0;
        for (uint y = local.y; y < pc.block; y += SIDE) {
            for (uint x = local.x; x < pc.block; x += SIDE) {
                let p = pixel_of(cell, x, y);
                if (p.x < 0) { continue; }
                let nits = nits_at(p);
                let v = split_space(nits, pc.reference);
                let to_first = length(v - first);
                let to_second = length(v - second);
                if (to_first <= to_second) {
                    into_first += float4(v, 1.0);
                    lit_first += nits;
                    scatter += to_first * to_first;
                } else {
                    into_second += float4(v, 1.0);
                    lit_second += nits;
                    scatter += to_second * to_second;
                }
            }
        }
        lane_a[lane] = into_first;
        lane_b[lane] = into_second;
        lane_c[lane] = float2(scatter, 0.0);
        summed(lane);
        let a = lane_a[0];
        let b = lane_b[0];
        spread = lane_c[0].x;
        GroupMemoryBarrierWithGroupSync();
        if (round == SETTLE) {
            // The last round only measures: these sums are against the centres it assigned by.
            counts = float2(a.a, b.a);
            lane_a[lane] = float4(lit_first, 0.0);
            lane_b[lane] = float4(lit_second, 0.0);
            lane_c[lane] = float2(0.0);
            summed(lane);
            nits_first = lane_a[0].rgb;
            nits_second = lane_b[0].rgb;
            break;
        }
        if (a.a > 0.0) { first = a.rgb / a.a; }
        if (b.a > 0.0) { second = b.rgb / b.a; }
    }

    if (lane != 0) { return; }
    let total = counts.x + counts.y;
    let at = int2(cell.x * 2, cell.y);
    if (counts.x <= 0.0 || counts.y <= 0.0) {
        let box = (nits_first + nits_second) / max(total, 1.0);
        mean_frame.Store(at, float4(box, 1.0));
        mean_frame.Store(at + int2(1, 0), float4(box, 0.0));
        return;
    }
    let trusted = split_weight(
        length(first - second), sqrt(spread / total), min(counts.x, counts.y), float(pc.block));
    mean_frame.Store(at, float4(nits_first / counts.x, counts.x / total));
    mean_frame.Store(at + int2(1, 0), float4(nits_second / counts.y, trusted));
}
