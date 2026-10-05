// Where the chroma lattice is indexed: a perceptual opponent space, read in polar.
//
// Jzazbz by default and ICtCp beside it, chosen per fitted map (`hdr_fit::IndexSpace`). Both are
// absolute, so `Rendered` is pinned at `INDEX_WHITE_NITS` on the way in: an index only has to be
// the same function in the fit and in the grade, and a constant makes it one.
module index_space;

import light;
import prelude;

public static const uint SPACE_JZAZBZ = 0;
public static const uint SPACE_ICTCP = 1;

/// Diffuse white of `Rendered`, in the nits both spaces are defined over: BT.2408's reference white.
public static const float INDEX_WHITE_NITS = 203.0;

/// Rec.2020 to Jzazbz's cone space, through XYZ and the `b`/`g` blue correction, and back.
public static const float3x3 R2020_TO_JZ_LMS = float3x3(
    0.530003576, 0.355703633, 0.086089990,
    0.289388269, 0.525394823, 0.157481505,
    0.091098083, 0.147587582, 0.734233807);
public static const float3x3 JZ_LMS_TO_R2020 = float3x3(
    2.990669997, -2.049742417, 0.088976794,
    -1.634525136, 3.145628209, -0.483036886,
    -0.042505112, -0.377983217, 1.448019175);
public static const float3x3 JZ_LMS_TO_IAB = float3x3(
    0.5, 0.5, 0.0,
    3.524000000, -4.066708000, 0.542708000,
    0.199076000, 1.096799000, -1.295875000);
public static const float3x3 JZ_IAB_TO_LMS = float3x3(
    1.0, 0.138605043, 0.058047316,
    1.0, -0.138605043, -0.058047316,
    1.0, -0.096019242, -0.811891896);
/// Jzazbz's own exponent on ST 2084's curve: `1.7 * 2523 / 32`.
public static const float JZ_P = 134.034375;
public static const float JZ_D = -0.56;
public static const float JZ_D0 = 1.6295499532821566e-11;

/// BT.2100's ICtCp, from Rec.2020 and back.
public static const float3x3 R2020_TO_ICTCP_LMS = float3x3(
    0.412109375, 0.523925781, 0.063964844,
    0.166748047, 0.720458984, 0.112792969,
    0.024169922, 0.075439453, 0.900390625);
public static const float3x3 ICTCP_LMS_TO_R2020 = float3x3(
    3.436606694, -2.506452119, 0.069845424,
    -0.791329556, 1.983600452, -0.192270896,
    -0.025949900, -0.098913715, 1.124863614);
public static const float3x3 ICTCP_LMS_TO_ITP = float3x3(
    0.5, 0.5, 0.0,
    1.613769531, -3.323486328, 1.709716797,
    4.378173828, -4.245605469, -0.132568359);
public static const float3x3 ICTCP_ITP_TO_LMS = float3x3(
    1.0, 0.008609037, 0.111029625,
    1.0, -0.008609037, -0.111029625,
    1.0, 0.560031336, -0.320627175);

static const float TAU = 6.283185307179586;

/// ST 2084's shape with its outer exponent `p`, over nits.
float3 coded(float3 nits, float p)
{
    // Clamped at zero: a matrix can hand the lattice a colour past the spectral locus, whose cone
    // response goes negative, and the curve has no answer there.
    let y = pow(max(nits, float3(0.0)) / PQ_MAX_NITS, float3(PQ_M1));
    return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), float3(p));
}

float3 uncoded(float3 code, float p)
{
    let e = pow(max(code, float3(0.0)), float3(1.0 / p));
    return PQ_MAX_NITS * pow(max(e - PQ_C1, float3(0.0)) / (PQ_C2 - PQ_C3 * e), float3(1.0 / PQ_M1));
}

/// A rendered colour's lightness and two opponent axes.
public Colour<Opponent> opponent_of(Colour<Rendered> colour, uint space)
{
    let nits = colour.v * INDEX_WHITE_NITS;
    if (space == SPACE_ICTCP) {
        return exactly<Opponent>(mul(ICTCP_LMS_TO_ITP, coded(mul(R2020_TO_ICTCP_LMS, nits), PQ_M2)));
    }
    let iab = mul(JZ_LMS_TO_IAB, coded(mul(R2020_TO_JZ_LMS, nits), JZ_P));
    let jz = (1.0 + JZ_D) * iab.x / (1.0 + JZ_D * iab.x) - JZ_D0;
    return exactly<Opponent>(float3(jz, iab.yz));
}

/// The way back, for the bake: the rendered colour a lattice texel stands for.
public Colour<Rendered> rendered_of(Colour<Opponent> colour, uint space)
{
    if (space == SPACE_ICTCP) {
        let nits = mul(ICTCP_LMS_TO_R2020, uncoded(mul(ICTCP_ITP_TO_LMS, colour.v), PQ_M2));
        return measured<Rendered>(nits / INDEX_WHITE_NITS);
    }
    let j = colour.v.x + JZ_D0;
    let iz = j / (1.0 + JZ_D - JZ_D * j);
    let nits = mul(JZ_LMS_TO_R2020, uncoded(mul(JZ_IAB_TO_LMS, float3(iz, colour.v.yz)), JZ_P));
    return measured<Rendered>(nits / INDEX_WHITE_NITS);
}

/// Where an opponent colour and a neighbourhood sit in the lattice's own coordinates: hue in turns,
/// then the square roots of chroma, lightness as it is, and the square root of the neighbourhood.
///
/// The roots put nodes where a frame's colours mass, near neutral and in the shadows; lightness
/// needs none, both spaces having coded it already.
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
