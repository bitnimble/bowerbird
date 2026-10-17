// A gain map applied to a finished picture's light, shared by a decode (`linearise.slang`) and the
// viewer's stage (`stage.slang`) so a HEIC's highlights are one picture in both.
module gain_map;

/// `linearise::Picture::gain_mode`'s numbering.
public static const uint GAIN_ISO = 0;
public static const uint GAIN_APPLE = 1;

/// The four map texels a picture pixel blends, top left, top right, bottom left, bottom right.
public struct GainTaps {
    public uint4 at;
    public float2 fraction;
};

/// Where a picture pixel reads its map, bilinear, as indices into a `map.x`-wide raster.
///
/// Bilinear rather than nearest because the map is stored at a fraction of the picture's
/// resolution - half is usual, a quarter is legal - and a nearest read of one puts a staircase
/// along every highlight edge it brightens.
public GainTaps gain_taps(uint2 at, uint2 picture, uint2 map)
{
    // The pixel's centre in the map's grid, which is the sampling both sides of a gain map agree
    // on: the two rasters cover the same picture, so the centres line up rather than the corners.
    //
    // **Clamped before the floor, not after.** Outside the first and last texel centres there is
    // no pair to interpolate between, and clamping only the *index* while taking the weight from
    // the unclamped position leaves the edge reading three quarters of its neighbour: at `x = 0`
    // of a half-resolution map `u` is -0.25, so `x0` snaps to 0 while `fx` stays 0.75. Where the
    // map steps at a highlight that reaches the picture's edge, that is a bright line down it.
    let u = clamp((float(at.x) + 0.5) * float(map.x) / float(picture.x) - 0.5, 0.0, float(map.x - 1));
    let v = clamp((float(at.y) + 0.5) * float(map.y) / float(picture.y) - 0.5, 0.0, float(map.y - 1));
    let x0 = uint(floor(u));
    let y0 = uint(floor(v));
    let x1 = min(x0 + 1, map.x - 1);
    let y1 = min(y0 + 1, map.y - 1);
    GainTaps taps;
    taps.at = uint4(y0 * map.x + x0, y0 * map.x + x1, y1 * map.x + x0, y1 * map.x + x1);
    taps.fraction = float2(u - floor(u), v - floor(v));
    return taps;
}

public float3 blended(GainTaps taps, float3 corner[4])
{
    let top = lerp(corner[0], corner[1], taps.fraction.x);
    let bottom = lerp(corner[2], corner[3], taps.fraction.x);
    return lerp(top, bottom, taps.fraction.y);
}

/// ISO 21496-1's terms, or Apple's, which are different curves and not different constants.
public struct GainTerms {
    public uint mode;
    /// `GAIN_APPLE`'s only term.
    public float headroom;
    public float3 lowest;
    public float3 highest;
    public float3 gamma;
    public float3 offset_base;
    public float3 offset_alternate;
};

/// The alternate rendition `recovery` (normalised map values) lifts `base` to, at full strength.
///
/// **The whole gain, always.** The standard's weight exists to meet a *display's* headroom, and the
/// roll-off that meets a panel comes after this, in each caller. Applying a display weight here
/// would bake one tone map in and then run another over it.
public float3 gain_mapped(float3 base, float3 recovery, GainTerms terms)
{
    // **A straight line to the headroom, not a power of it.** Apple's reconstruction is linear in
    // the recovery where ISO's is exponential, so the two disagree everywhere but the ends: at half
    // recovery under a headroom of 8, ISO gives 2.83x and this gives 4.5x. Monochrome by
    // construction, so one channel of the replicated map decides all three.
    if (terms.mode == GAIN_APPLE) {
        return base * (1.0 + (terms.headroom - 1.0) * recovery.r);
    }
    let power = float3(
        pow(recovery.r, 1.0 / max(terms.gamma.r, 1e-6)),
        pow(recovery.g, 1.0 / max(terms.gamma.g, 1e-6)),
        pow(recovery.b, 1.0 / max(terms.gamma.b, 1e-6)));
    let log_gain = lerp(terms.lowest, terms.highest, power);
    return (base + terms.offset_base) * exp2(log_gain) - terms.offset_alternate;
}
