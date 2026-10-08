// A block's two populations, where its pixels hold two: the mean a pixel is read at.
//
// `mean_frame.slang` splits each block in two and keeps both means, and `colour.slang` reads a
// pixel at the one it belongs to; `fit_register.slang` splits each registered pair's window the
// same way, so the fit is taught at the colours the render reads at. A box mean over an edge is a
// colour neither side has: read there, the lattice hands a thin red stripe and the wall behind it
// one correction fitted for their mix. Where the split finds no edge, only texture or noise, every
// reader falls back to the box mean.
module block_split;

/// The split is measured in log light, so a ratio is a distance whatever the level, offset by
/// this share of diffuse white so shadow noise does not read as contrast. An offset, not a clamp:
/// a clamp piles the darker half of the noise onto one value, and two-means finds that pile.
public static const float SPLIT_FLOOR = 1.0 / 64.0;

/// Separation over the pooled spread inside the two halves. Two-means cuts a single noisy
/// population near 1; an edge between two flat colours sits far past these.
public static const float SEPARATE_FROM = 2.0;
public static const float SEPARATE_BY = 4.0;

/// Separation in stops under which the halves are one colour, however clean.
public static const float DISTINCT_FROM = 0.1;
public static const float DISTINCT_BY = 0.3;

/// Pixels the smaller half needs, in block widths: a stripe one pixel across a block holds a
/// block's width of them, a lone hot pixel one.
public static const float HELD_FROM = 0.25;
public static const float HELD_BY = 1.0;

public float3 split_space(float3 nits, float reference)
{
    return log2(max(nits, float3(0.0)) + float3(SPLIT_FLOOR * reference));
}

/// Two-means rounds after the seeds.
public static const int SETTLE = 1;

/// Lightness, red against green and blue against yellow, orthonormal in `split_space`.
static const float3 SEED_AXES[3] = {
    float3(0.57735027, 0.57735027, 0.57735027),
    float3(0.70710678, -0.70710678, 0.0),
    float3(0.40824829, 0.40824829, -0.81649658),
};

/// Where two-means starts, gathered in one walk over a block: the pixels at either end of each of
/// `SEED_AXES`, their projection in `.a`. The farthest-apart pair seeds the halves.
public struct Seeds {
    float4 low[3];
    float4 high[3];
}

public void seeds_begin(out Seeds s)
{
    for (int k = 0; k < 3; k++) {
        s.low[k] = float4(0.0, 0.0, 0.0, 1e30);
        s.high[k] = float4(0.0, 0.0, 0.0, -1e30);
    }
}

/// `v` in `split_space`.
public void seeds_add(inout Seeds s, float3 v)
{
    for (int k = 0; k < 3; k++) {
        let t = dot(v, SEED_AXES[k]);
        if (t < s.low[k].a) { s.low[k] = float4(v, t); }
        if (t > s.high[k].a) { s.high[k] = float4(v, t); }
    }
}

public void seeds_pick(Seeds s, out float3 first, out float3 second)
{
    first = s.low[0].rgb;
    second = s.high[0].rgb;
    var apart = length(second - first);
    for (int k = 1; k < 3; k++) {
        let d = length(s.high[k].rgb - s.low[k].rgb);
        if (d > apart) {
            apart = d;
            first = s.low[k].rgb;
            second = s.high[k].rgb;
        }
    }
}

/// How far the split is trusted, 0 for the box mean and 1 for each half on its own.
public float split_weight(float separation, float spread, float smaller, float block)
{
    return smoothstep(SEPARATE_FROM, SEPARATE_BY, separation / max(spread, 1e-6))
        * smoothstep(DISTINCT_FROM, DISTINCT_BY, separation)
        * smoothstep(HELD_FROM * block, HELD_BY * block, smaller);
}

/// How far `pixel` lies towards `second` from `first`, eased: 0 in the first half, 1 in the
/// second. All three in `split_space`.
public float second_half(float3 pixel, float3 first, float3 second)
{
    let axis = second - first;
    let along = dot(pixel - first, axis) / max(dot(axis, axis), 1e-6);
    return smoothstep(0.25, 0.75, along);
}

/// The mean a pixel is read at, from one cell's two texels: the first half's mean and share of
/// the block, the second's mean and `split_weight`. `pixel` is in `split_space`.
public float3 mean_for(float4 first, float4 second, float3 pixel, float reference)
{
    let box = first.a * first.rgb + (1.0 - first.a) * second.rgb;
    if (second.a <= 0.0) { return box; }
    let own = lerp(
        first.rgb,
        second.rgb,
        second_half(pixel, split_space(first.rgb, reference), split_space(second.rgb, reference)));
    return lerp(box, own, second.a);
}
