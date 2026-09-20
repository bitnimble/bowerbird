// The coarse band, smoothed without a block grid anywhere in it.
//
// **A shrinkage cannot be used here, and that is the whole reason this file exists.** An 8x8 block
// at a quarter resolution spans 32 photosites, so the correction it produces is made of 32-pixel
// rectangles; bilinearly upsampled they are soft-edged rectangles, and against the lettering on
// DSC00982's stake the picture came back covered in them. The phase spin does not help - what is
// blocky is the correction, not the tiling - and against flat bokeh nothing shows at all, which is
// how it passed its first reading.
//
// A bilateral has no grid to leave behind. Every output is a weighted mean of its own
// neighbourhood, so a correction taken from it varies as smoothly as the picture does, and an edge
// steeper than the range bandwidth stops the averaging rather than being tiled across.

import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> src;
[vk::binding(1, 0)] RWStructuredBuffer<float> dst;

struct Push {
    int width;
    int height;
    /// How far two samples may differ and still pool, in the plane's own units.
    float range;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// Half-width of the neighbourhood. Two at a quarter resolution is eight photosites, which is the
/// band the level above is blind to and nothing smaller reaches.
static const int REACH = 2;

/// The spatial term, a binomial by distance so the mean has no square edge of its own.
static float weight_at(int dx, int dy)
{
    let r2 = float(dx * dx + dy * dy);
    return exp(-r2 / (2.0 * float(REACH) * float(REACH)));
}

[shader("compute")]
[numthreads(16, 16, 1)]
void coarse_smooth(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let centre = src[y * pc.width + x];
    // Zero range is the identity, which is what a slider at nothing has to mean.
    if (pc.range <= 0.0) {
        dst[y * pc.width + x] = centre;
        return;
    }
    let inv = 1.0 / (2.0 * pc.range * pc.range);

    var sum = 0.0;
    var wsum = 0.0;
    for (int dy = -REACH; dy <= REACH; dy++) {
        let sy = clamp(y + dy, 0, pc.height - 1);
        for (int dx = -REACH; dx <= REACH; dx++) {
            let sx = clamp(x + dx, 0, pc.width - 1);
            let v = src[sy * pc.width + sx];
            let d = v - centre;
            let w = weight_at(dx, dy) * exp(-d * d * inv);
            sum += w * v;
            wsum += w;
        }
    }
    // The centre is always one of the taps at full spatial weight and zero range distance, so
    // `wsum` is at least one and this cannot divide by nothing.
    dst[y * pc.width + x] = sum / wsum;
}
