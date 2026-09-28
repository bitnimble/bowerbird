import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> l_cs_den;
[vk::binding(1, 0)] RWStructuredBuffer<float> l_pixel;
[vk::binding(2, 0)] RWStructuredBuffer<float> l_h_den;

struct Push {
    int width;
    int height;
    int halfwidth;
    /// Whether Phase 3 blocked the frame at all. Off a 2x2 transform there are four estimates of
    /// every pixel to pool; off the subtraction the other patterns take there is one, and the
    /// average below would be a box blur with nothing to undo it.
    int blocked;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// Whether the phases pool at all. Off takes the site's own block alone, which is the exact
/// inverse of Phase 3 at every pixel.
[vk::constant_id(0)]
const int PHASE_POOL = 1;

[shader("compute")]
[numthreads(16, 16, 1)]
void lpixel_lh_den_fused(uint3 id : SV_DispatchThreadID)
{
    let fx = int(id.x);
    let fy = int(id.y);
    if (fx >= pc.width || fy >= pc.height) { return; }

    let own = l_cs_den[fy * pc.width + fx];
    if (pc.blocked == 0) {
        l_pixel[fy * pc.width + fx] = own;
        if ((fy & 1) == 0 && (fx & 1) == 0) {
            l_h_den[(fy >> 1) * pc.halfwidth + (fx >> 1)] = own;
        }
        return;
    }
    // The site's own phase: the block whose chroma the inverse will add back at this pixel.
    let sx = fx - (fx & 1);
    let sy = fy - (fy & 1);
    l_pixel[fy * pc.width + fx] = pooled_luma(l_cs_den, pc.width, pc.height, sx, sy, PHASE_POOL != 0);

    if ((fy & 1) == 0 && (fx & 1) == 0) {
        l_h_den[(fy >> 1) * pc.halfwidth + (fx >> 1)] = own;
    }
}
