import prelude;

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
    int subtract;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

static const int COLOUR_REACH = 1;

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
            l += luma_sample(l_cs_den, pc.width, pc.height, 2 * sx, 2 * sy);
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
    if (pc.subtract != 0) {
        c1_h[hp] -= p1_h[hp];
        c2_h[hp] -= p2_h[hp];
        c3_h[hp] -= p3_h[hp];
        return;
    }

    let x = 2 * hx;
    let y = 2 * hy;
    let derivatives = brightness_derivatives(l_cs_den, pc.width, pc.height, x, y);

    let shares = shares_at(hx, hy);
    var p = float3(0.0);
    for (int j = 0; j < 4; j++) {
        let i = float(j & 1) - 0.5;
        let k = float(j >> 1) - 0.5;
        let offset = 2.0 * shares[j] * (i * derivatives.x + k * derivatives.y + 2.0 * i * k * derivatives.z);
        let s1 = k < 0.0 ? 1.0 : -1.0;
        let s2 = i < 0.0 ? 1.0 : -1.0;
        p += offset * float3(s1, s2, s1 * s2);
    }

    p1_h[hp] = p.x;
    p2_h[hp] = p.y;
    p3_h[hp] = p.z;
}
