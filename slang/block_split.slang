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

/// How far the split is trusted, 0 for the box mean and 1 for each half on its own.
public float split_weight(float separation, float spread, float smaller, float block)
{
    return smoothstep(SEPARATE_FROM, SEPARATE_BY, separation / max(spread, 1e-6))
        * smoothstep(DISTINCT_FROM, DISTINCT_BY, separation)
        * smoothstep(HELD_FROM * block, HELD_BY * block, smaller);
}

/// The mean `pixel` is read at, from one cell's two texels: the first half's mean and share of
/// the block, the second's mean and `split_weight`.
public float3 mean_for(float4 first, float4 second, float3 pixel, float reference)
{
    let box = first.a * first.rgb + (1.0 - first.a) * second.rgb;
    if (second.a <= 0.0) { return box; }
    let a = split_space(first.rgb, reference);
    let axis = split_space(second.rgb, reference) - a;
    let along = dot(split_space(pixel, reference) - a, axis) / max(dot(axis, axis), 1e-6);
    let own = lerp(first.rgb, second.rgb, smoothstep(0.25, 0.75, along));
    return lerp(box, own, second.a);
}
