// A PQ frame's `clli`: the brightest pixel and the frame's mean, each pixel counted at its largest
// channel (CTA-861.3), off the coded frame the encoder is about to be handed.
//
// Per workgroup rather than per frame, and the host folds the tiles: a sum over 61MP of nits does
// not fit an atomic `u32`, and a float cannot be added atomically.
import packed;
import prelude;
import light;

struct Params {
    uint width;
    uint height;
    uint tiles_across;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
/// Per tile, its brightest pixel then the sum of its pixels, in nits.
[vk::binding(2, 0)] RWStructuredBuffer<float> tiles;

static const uint SIDE = 16;

groupshared float brightest[SIDE * SIDE];
groupshared float summed[SIDE * SIDE];

float nits_of(uint code)
{
    return pq_inv<DisplayNits>(measured<Pq>(float(code) / 65535.0)).v;
}

[shader("compute")]
[numthreads(16, 16, 1)]
void content_light(uint3 id : SV_DispatchThreadID, uint3 group : SV_GroupID, uint index : SV_GroupIndex)
{
    var top = 0.0;
    if (id.x < params.width && id.y < params.height) {
        let p = (id.y * params.width + id.x) * 3;
        let r = nits_of(half_of(frame[p / 2], p));
        let g = nits_of(half_of(frame[(p + 1) / 2], p + 1));
        let b = nits_of(half_of(frame[(p + 2) / 2], p + 2));
        top = max(r, max(g, b));
    }
    brightest[index] = top;
    summed[index] = top;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = SIDE * SIDE / 2; stride > 0; stride = stride / 2) {
        if (index < stride) {
            brightest[index] = max(brightest[index], brightest[index + stride]);
            summed[index] = summed[index] + summed[index + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (index == 0) {
        let tile = group.y * params.tiles_across + group.x;
        tiles[tile * 2] = brightest[0];
        tiles[tile * 2 + 1] = summed[0];
    }
}
