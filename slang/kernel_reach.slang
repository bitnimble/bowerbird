// How much of a lattice kernel reaches a place: the weight its operator is summed under.
module kernel_reach;

/// Smootherstep of `u`, already in 0 to 1.
float smoother(float u)
{
    return u * u * u * (u * (u * 6.0 - 15.0) + 10.0);
}

public float4 smoother(float4 u)
{
    return u * u * u * (u * (u * 6.0 - 15.0) + 10.0);
}

/// One at the centre, nothing at the reach, easing by smootherstep over the last `feather` of it.
/// A zero feather spans the whole reach, where neighbours a reach apart sum to one, which
/// `fit_lattice.slang` lands pairs under.
public float fall(float distance, float reach, float feather)
{
    if (reach <= 0.0) { return 1.0; }
    let u = feather > 0.0
        ? clamp((reach - abs(distance)) / min(feather, reach), 0.0, 1.0)
        : 1.0 - min(abs(distance) / reach, 1.0);
    return smoother(u);
}

/// `centre`, `reach`, `feather` and `at` in `lattice_at`'s coordinates.
public float kernel_weight(float4 centre, float4 reach, float4 feather, float4 at)
{
    let chroma = fall(at.y - centre.y, reach.y, feather.y);
    let level = fall(at.z - centre.z, reach.z, feather.z);
    let neighbourhood = fall(at.w - centre.w, reach.w, feather.w);
    let rest = chroma * level * neighbourhood;
    if (rest <= 0.0) { return 0.0; }
    var turns = abs(at.x - centre.x);
    turns = min(turns, 1.0 - turns);
    // A kernel reaching grey would otherwise take a different value there from each hue: fading
    // its hue distance to nothing as chroma does makes grey one place again.
    if (centre.y < reach.y) { turns *= clamp(at.y / max(centre.y, 1e-6), 0.0, 1.0); }
    return rest * fall(turns, reach.x, feather.x);
}
