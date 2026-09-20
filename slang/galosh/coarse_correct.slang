// The coarse band's correction, bilinearly carried back over the frame it was taken from.
//
// **What the full-resolution shrinkage cannot reach.** An 8x8 block's DC is its own mean, and
// nothing inside the block tells noise in that mean apart from the picture being that much
// brighter there - so the shrinkage passes it through, and what survives is a mottle at the block's
// own scale. Phases help less than they look: two blocks two pixels apart share six of their eight
// columns, so their DC noise is most of the way to being the same number.
//
// Only the difference the smoothing made comes back up, so what the full pass already settled is
// untouched, and at a slider of nothing the difference is zero and this pass is an exact identity.

import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> coarse_den;
[vk::binding(1, 0)] StructuredBuffer<float> coarse_src;
[vk::binding(2, 0)] RWStructuredBuffer<float> full;

struct Push {
    int width;
    int height;
    int coarsewidth;
    int coarseheight;
    /// Full-resolution pixels to a coarse one.
    int scale;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

float delta_at(int cx, int cy)
{
    let i = cy * pc.coarsewidth + cx;
    return coarse_den[i] - coarse_src[i];
}

[shader("compute")]
[numthreads(16, 16, 1)]
void coarse_correct(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    // A box downsample puts a coarse sample's centre at the middle of the block it averaged, so a
    // full-resolution pixel lands between nodes rather than on one. Sampling at the node instead
    // replicates each coarse value over its whole block and lays that grid into the picture.
    let step = 1.0 / float(pc.scale);
    let u = (float(x) + 0.5) * step - 0.5;
    let v = (float(y) + 0.5) * step - 0.5;
    let x0 = clamp(int(floor(u)), 0, pc.coarsewidth - 1);
    let y0 = clamp(int(floor(v)), 0, pc.coarseheight - 1);
    let x1 = min(x0 + 1, pc.coarsewidth - 1);
    let y1 = min(y0 + 1, pc.coarseheight - 1);
    let tx = clamp(u - float(x0), 0.0, 1.0);
    let ty = clamp(v - float(y0), 0.0, 1.0);

    let top = lerp(delta_at(x0, y0), delta_at(x1, y0), tx);
    let bottom = lerp(delta_at(x0, y1), delta_at(x1, y1), tx);
    full[y * pc.width + x] += lerp(top, bottom, ty);
}
