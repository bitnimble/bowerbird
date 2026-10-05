// Where the chroma lattice is indexed: ZCAM's lightness, chroma and hue, read in polar.
//
// ZCAM is absolute, so `Rendered` is pinned at `INDEX_WHITE_NITS` on the way in, and its viewing
// conditions are pinned with it (`lattice::Zcam`): an index only has to be the same function in
// the fit and in the grade, and constants make it one.
module index_space;

import light;
import prelude;

/// Diffuse white of `Rendered`, in the nits ZCAM is defined over: BT.2408's reference white.
public static const float INDEX_WHITE_NITS = 203.0;

/// Rec.2020 to Jzazbz's cone space, which ZCAM shares, through XYZ and the `b`/`g` blue
/// correction, and back.
public static const float3x3 R2020_TO_LMS = float3x3(
    0.530003576, 0.355703633, 0.086089990,
    0.289388269, 0.525394823, 0.157481505,
    0.091098083, 0.147587582, 0.734233807);
public static const float3x3 LMS_TO_R2020 = float3x3(
    2.990669997, -2.049742417, 0.088976794,
    -1.634525136, 3.145628209, -0.483036886,
    -0.042505112, -0.377983217, 1.448019175);
/// The coded cones to `Iz`, before `ZCAM_EPSILON`, and the two opponent axes.
public static const float3x3 LMS_TO_IAB = float3x3(
    0.0, 1.0, 0.0,
    3.524000000, -4.066708000, 0.542708000,
    0.199076000, 1.096799000, -1.295875000);
/// ST 2084's curve with Jzazbz's own outer exponent, `1.7 * 2523 / 32`.
public static const float ZCAM_P = 134.034375;
/// What the coded M cone holds at black.
public static const float ZCAM_EPSILON = 3.7035226210190005e-11;

/// `lattice::Zcam`, whose test holds these to the host's.
public static const float ZCAM_WHITE_IZ = 0.393513023;
public static const float ZCAM_LIGHTNESS_EXPONENT = 1.039705149;
public static const float ZCAM_CHROMA_SCALE = 104.594248795;
/// ZCAM's eccentricity is `1.015 + cos(89.038 degrees + hue)`.
public static const float ZCAM_HUE_COS = 0.016789279;
public static const float ZCAM_HUE_SIN = 0.999859050;

static const float TAU = 6.283185307179586;

/// ST 2084's shape with ZCAM's outer exponent, over nits.
float3 coded(float3 nits)
{
    // Clamped at zero: a matrix can hand the lattice a colour past the spectral locus, whose cone
    // response goes negative, and the curve has no answer there.
    let y = pow(max(nits, float3(0.0)) / PQ_MAX_NITS, float3(PQ_M1));
    return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), float3(ZCAM_P));
}

float3 uncoded(float3 code)
{
    let e = pow(max(code, float3(0.0)), float3(1.0 / ZCAM_P));
    return PQ_MAX_NITS * pow(max(e - PQ_C1, float3(0.0)) / (PQ_C2 - PQ_C3 * e), float3(1.0 / PQ_M1));
}

/// `hue` a unit direction in the opponent plane.
float eccentricity(float2 hue)
{
    return 1.015 + ZCAM_HUE_COS * hue.x - ZCAM_HUE_SIN * hue.y;
}

/// A rendered colour's lightness, then its chroma laid along its hue.
public Colour<Opponent> opponent_of(Colour<Rendered> colour)
{
    let iab = mul(LMS_TO_IAB, coded(mul(R2020_TO_LMS, colour.v * INDEX_WHITE_NITS)));
    let iz = max(iab.x - ZCAM_EPSILON, 0.0);
    let lightness = 100.0 * pow(iz / ZCAM_WHITE_IZ, ZCAM_LIGHTNESS_EXPONENT);
    let ab = length(iab.yz);
    let hue = iab.yz / max(ab, 1e-30);
    let chroma = ZCAM_CHROMA_SCALE * pow(ab, 0.74) * pow(eccentricity(hue), 0.068);
    return exactly<Opponent>(float3(lightness, chroma * hue));
}

/// The way back, for the bake: the rendered colour a lattice texel stands for.
public Colour<Rendered> rendered_of(Colour<Opponent> colour)
{
    let iz = ZCAM_WHITE_IZ * pow(max(colour.v.x, 0.0) / 100.0, 1.0 / ZCAM_LIGHTNESS_EXPONENT);
    let chroma = length(colour.v.yz);
    let hue = colour.v.yz / max(chroma, 1e-30);
    let ab = pow(chroma / (ZCAM_CHROMA_SCALE * pow(eccentricity(hue), 0.068)), 50.0 / 37.0) * hue;
    // `LMS_TO_IAB` solved for the cones: its first row is the M cone alone.
    let m = iz + ZCAM_EPSILON;
    let rest = ab - m * float2(LMS_TO_IAB[1][1], LMS_TO_IAB[2][1]);
    let a = float2(LMS_TO_IAB[1][0], LMS_TO_IAB[2][0]);
    let s = float2(LMS_TO_IAB[1][2], LMS_TO_IAB[2][2]);
    let det = a.x * s.y - s.x * a.y;
    let long_cone = (rest.x * s.y - s.x * rest.y) / det;
    let short_cone = (a.x * rest.y - a.y * rest.x) / det;
    let nits = mul(LMS_TO_R2020, uncoded(float3(long_cone, m, short_cone)));
    return measured<Rendered>(nits / INDEX_WHITE_NITS);
}

/// Where an opponent colour and a neighbourhood sit in the lattice's own coordinates: hue in turns,
/// then the square roots of chroma, lightness as it is, and the square root of the neighbourhood.
///
/// The roots put nodes where a frame's colours mass, near neutral and in the shadows; lightness
/// needs none, ZCAM having coded it already.
public float4 lattice_at(Colour<Opponent> colour, float neighbourhood)
{
    let chroma = length(colour.v.yz);
    var turn = atan2(colour.v.z, colour.v.y) / TAU;
    turn = turn - floor(turn);
    return float4(turn, sqrt(chroma), colour.v.x, sqrt(max(neighbourhood, 0.0)));
}

/// The opponent colour at a place in lattice coordinates, which is `lattice_at` undone.
public Colour<Opponent> opponent_at(float4 at)
{
    let chroma = at.y * at.y;
    let angle = at.x * TAU;
    return exactly<Opponent>(float3(at.z, chroma * cos(angle), chroma * sin(angle)));
}
