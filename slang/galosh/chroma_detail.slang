// Phase 7's bracket: the part of a site's three differences that the luma already explains, taken
// out before the chroma is smoothed and put back after.
//
// **A site's "chroma" is not only colour.** `chroma_extract_halfres` writes its row difference, its
// column difference and its diagonal, and on any surface those carry the luma's gradient across the
// site as well as the surface's hue - a hair strand darkens one column of the site it crosses. The
// pyramid smooths all three as though they were hue, so that detail went with the noise and the
// inverse rebuilt the site as a two-pixel weave. Predicted here from the stride-1 luma the shrinkage
// denoised, so what the smoothing sees is the colour alone.
//
// Each photosite is taken to be its colour's local level times one shared modulation, so a line
// crossing a green surface moves the greens and barely the rest. `D` is the site's own one-pixel
// difference of that modulation read off the two-pixel box, `i tan(pi f)` in frequency; `TAPS` match
// it to seventh order, where a plain central difference reaches `cos^2(pi f)` of it. Nothing past the
// box's null is recoverable.
[vk::binding(0, 0)] StructuredBuffer<float> l_cs_den;
[vk::binding(1, 0)] RWStructuredBuffer<float> c1_h;
[vk::binding(2, 0)] RWStructuredBuffer<float> c2_h;
[vk::binding(3, 0)] RWStructuredBuffer<float> c3_h;
[vk::binding(4, 0)] RWStructuredBuffer<float> p1_h;
[vk::binding(5, 0)] RWStructuredBuffer<float> p2_h;
[vk::binding(6, 0)] RWStructuredBuffer<float> p3_h;

struct Push {
    int width;
    int height;
    int halfwidth;
    int halfheight;
    /// 0 to predict into `p`, -1 to take the prediction out, +1 to put it back.
    float sign;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const float TAPS[3] = { 29.0 / 64.0, -1.0 / 8.0, 1.0 / 64.0 };/// Sites either side of this one the colour is averaged over.
static const int COLOUR_REACH = 1;

float luma_at(int x, int y)
{
    return l_cs_den[clamp(y, 0, pc.height - 1) * pc.width + clamp(x, 0, pc.width - 1)];
}

float across_at(int x, int y)
{
    var d = 0.0;
    for (int k = 1; k <= 3; k++) {
        d += TAPS[k - 1] * (luma_at(x + k, y) - luma_at(x - k, y));
    }
    return d;
}
/// Each photosite's share of the site's luma, in `chroma_extract_halfres`'s order: the top-left, the
/// top-right, the bottom-left, the bottom-right.
float4 shares_at(int hx, int hy)
{
    var l = 0.0;
    var c = float3(0.0);
    for (int dy = -COLOUR_REACH; dy <= COLOUR_REACH; dy++) {
        for (int dx = -COLOUR_REACH; dx <= COLOUR_REACH; dx++) {
            let sx = clamp(hx + dx, 0, pc.halfwidth - 1);
            let sy = clamp(hy + dy, 0, pc.halfheight - 1);
            let hp = sy * pc.halfwidth + sx;
            l += luma_at(2 * sx, 2 * sy);
            c += float3(c1_h[hp], c2_h[hp], c3_h[hp]);
        }
    }
    if (l <= 1e-3) { return float4(0.25); }
    let r = c / l;
    // Floored and renormalised, so each stays a share: in read noise about black the chroma dwarfs
    // a luma near zero, and an unbounded share turns the luma's gradient into a coloured ring.
    let shares = max(float4(
        1.0 + r.x + r.y + r.z,
        1.0 + r.x - r.y - r.z,
        1.0 - r.x + r.y - r.z,
        1.0 - r.x - r.y + r.z), float4(0.0));
    return shares / (shares.x + shares.y + shares.z + shares.w);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void chroma_detail(uint3 id : SV_DispatchThreadID)
{
    let hx = int(id.x);
    let hy = int(id.y);
    if (hx >= pc.halfwidth || hy >= pc.halfheight) { return; }
    let hp = hy * pc.halfwidth + hx;
    if (pc.sign != 0.0) {
        c1_h[hp] += pc.sign * p1_h[hp];
        c2_h[hp] += pc.sign * p2_h[hp];
        c3_h[hp] += pc.sign * p3_h[hp];
        return;
    }

    let x = 2 * hx;
    let y = 2 * hy;
    let across = across_at(x, y);
    var down = 0.0;
    var mixed = 0.0;
    for (int k = 1; k <= 3; k++) {
        down += TAPS[k - 1] * (luma_at(x, y + k) - luma_at(x, y - k));
        mixed += TAPS[k - 1] * (across_at(x, y + k) - across_at(x, y - k));
    }

    let shares = shares_at(hx, hy);
    var p = float3(0.0);
    for (int j = 0; j < 4; j++) {
        let i = float(j & 1) - 0.5;
        let k = float(j >> 1) - 0.5;
        let offset = 2.0 * shares[j] * (i * across + k * down + 2.0 * i * k * mixed);
        let s1 = k < 0.0 ? 1.0 : -1.0;
        let s2 = i < 0.0 ? 1.0 : -1.0;
        p += offset * float3(s1, s2, s1 * s2);
    }

    p1_h[hp] = p.x;
    p2_h[hp] = p.y;
    p3_h[hp] = p.z;
}
