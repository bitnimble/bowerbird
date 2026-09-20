// The reader's temperature and tint, as one matrix on the frame.
//
// **Here rather than on either host, because both would need it.** A tick recomputes this
// whenever the slider moves and a rendition needs the same answer, so writing it twice is the
// divergence DESIGN 21.1 is about - and this one would be invisible, since two Robertson
// searches disagreeing by a few Kelvin renders as a picture rather than as an error. The
// pattern is `decode`'s: one invocation fills a small buffer, and everything that grades
// reads it.
//
// The inverse - what the *camera* balanced for, from its multipliers and its own matrix - is
// `as_shot`, at the bottom. No client ever asks for it and the decode wants it once per open
// rather than once per edit, but it walks the same isotherms as the forward map, and a second
// copy of that table is the divergence again.
//
// **What the frame already is.** The decode balanced it against the camera's own multipliers,
// so a neutral surface under the as-shot illuminant comes out grey. Asking for a different
// illuminant therefore is not "apply a white balance" but "undo that one and apply this
// instead", which in cone space is a ratio: the two illuminants' cone responses, divided. The
// output white cancels out of that ratio entirely, which is why nothing here mentions D65.
//
// Sliding *up* in Kelvin says the light was bluer than the camera assumed, so more blue is
// divided out and the picture gets warmer. That is Camera Raw's direction, and it is the
// physical one.
import prelude;
import edit;
import primaries;

[vk::binding(14, 0)] public RWStructuredBuffer<float> balance_out;

/// What the camera recorded, for `as_shot`: its four multipliers, then its own `cam_xyz` as four
/// rows of three. The fourth of each is the shape the decoder holds them in, and is not read.
[vk::binding(18, 0)] StructuredBuffer<float> as_shot_in;

/// Robertson's 31 isotherms: reciprocal megakelvin, CIE 1960 `u` and `v`, and the isotherm's
/// slope.
///
/// Wyszecki & Stiles by way of the DNG SDK. Transcribed rather than computed because that is what
/// Adobe ships and what a sidecar's numbers were produced against; deriving the locus from
/// Planck's law instead would be a few hundred Kelvin off theirs at the ends.
static const float4 LOCUS[31] = {
    float4(  0.0, 0.18006, 0.26352,   -0.24341),
    float4( 10.0, 0.18066, 0.26589,   -0.25479),
    float4( 20.0, 0.18133, 0.26846,   -0.26876),
    float4( 30.0, 0.18208, 0.27119,   -0.28539),
    float4( 40.0, 0.18293, 0.27407,   -0.30470),
    float4( 50.0, 0.18388, 0.27709,   -0.32675),
    float4( 60.0, 0.18494, 0.28021,   -0.35156),
    float4( 70.0, 0.18611, 0.28342,   -0.37915),
    float4( 80.0, 0.18740, 0.28668,   -0.40955),
    float4( 90.0, 0.18880, 0.28997,   -0.44278),
    float4(100.0, 0.19032, 0.29326,   -0.47888),
    float4(125.0, 0.19462, 0.30141,   -0.58204),
    float4(150.0, 0.19962, 0.30921,   -0.70471),
    float4(175.0, 0.20525, 0.31647,   -0.84901),
    float4(200.0, 0.21142, 0.32312,   -1.0182),
    float4(225.0, 0.21807, 0.32909,   -1.2168),
    float4(250.0, 0.22511, 0.33439,   -1.4512),
    float4(275.0, 0.23247, 0.33904,   -1.7298),
    float4(300.0, 0.24010, 0.34308,   -2.0637),
    float4(325.0, 0.24702, 0.34655,   -2.4681),
    float4(350.0, 0.25591, 0.34951,   -2.9641),
    float4(375.0, 0.26400, 0.35200,   -3.5814),
    float4(400.0, 0.27218, 0.35407,   -4.3633),
    float4(425.0, 0.28039, 0.35577,   -5.3762),
    float4(450.0, 0.28863, 0.35714,   -6.7262),
    float4(475.0, 0.29685, 0.35823,   -8.5955),
    float4(500.0, 0.30505, 0.35907,  -11.324),
    float4(525.0, 0.31320, 0.35968,  -15.628),
    float4(550.0, 0.32129, 0.36011,  -23.325),
    float4(575.0, 0.32931, 0.36038,  -40.770),
    float4(600.0, 0.33724, 0.36051, -116.45)
};

/// Adobe's tint units per unit of `uv` off the locus. Negative, which is what puts a positive
/// tint towards magenta.
static const float TINT_SCALE = -3000.0;

/// The chromaticity of an illuminant, from Camera Raw's two numbers.
///
/// Robertson's method run forwards: find the two isotherms the reciprocal temperature falls
/// between, interpolate the locus point and the isotherm direction across them, then step
/// along that direction by the tint. Reciprocal temperature rather than temperature because
/// that is the axis the table is uniform in, and the one a slider feels linear on.
public float2 xy_of(float temperature, float tint)
{
    let mireds = 1.0e6 / max(temperature, 1.0);
    // The last pair rather than none, for anything past the blue end of the table, which is
    // where Adobe's own search also stops.
    var index = 29;
    for (int i = 0; i < 29; i = i + 1) {
        if (mireds < LOCUS[i + 1][0]) {
            index = i;
            break;
        }
    }

    let lo = LOCUS[index];
    let hi = LOCUS[index + 1];
    let f = (hi[0] - mireds) / (hi[0] - lo[0]);
    var u = lo[1] * f + hi[1] * (1.0 - f);
    var v = lo[2] * f + hi[2] * (1.0 - f);

    // Each isotherm's direction normalised *before* the blend, not after: they are directions
    // rather than displacements, and mixing them by length would swing the tint axis towards
    // whichever of the two happens to be steeper.
    let lo_length = sqrt(1.0 + lo[3] * lo[3]);
    let hi_length = sqrt(1.0 + hi[3] * hi[3]);
    var du = f / lo_length + (1.0 - f) / hi_length;
    var dv = lo[3] * f / lo_length + hi[3] * (1.0 - f) / hi_length;
    let length = sqrt(du * du + dv * dv);
    du = du / length;
    dv = dv / length;

    let offset = tint / TINT_SCALE;
    u = u + du * offset;
    v = v + dv * offset;

    let denominator = u - 4.0 * v + 2.0;
    return float2(1.5 * u / denominator, v / denominator);
}

/// A chromaticity as a temperature and a tint: the same method run backwards.
///
/// Walks the locus from the blue end looking for the isotherm the point has crossed to the far
/// side of, interpolates the temperature between that pair, and reads the tint off the remaining
/// distance along the isotherm itself.
float2 temperature_tint_of(float2 xy)
{
    let denominator = 1.5 - xy.x + 6.0 * xy.y;
    // A degenerate chromaticity has no isotherm to sit on. D65 rather than a refusal, because
    // this is reached from a camera matrix that has already been checked and the caller has
    // nowhere useful to put a second failure.
    if (abs(denominator) < 1.0e-12) {
        return float2(6500.0, 0.0);
    }
    let u = 2.0 * xy.x / denominator;
    let v = 3.0 * xy.y / denominator;

    float last_distance = 0.0;
    float last_du = 0.0;
    float last_dv = 0.0;
    for (int index = 1; index < 31; index = index + 1) {
        let row = LOCUS[index];
        // The isotherm's direction, normalised. Its fourth word is the slope in `uv`.
        let reach = sqrt(1.0 + row[3] * row[3]);
        var du = 1.0 / reach;
        var dv = row[3] / reach;
        var uu = u - row[1];
        var vv = v - row[2];
        // Which side of this isotherm the point is on. It starts positive at the blue end and
        // goes negative once the walk has passed the point.
        var distance = -uu * dv + vv * du;

        if (distance <= 0.0 || index == 30) {
            distance = max(-distance, 0.0);
            // Between this isotherm and the one before it, in reciprocal temperature - which is
            // the axis the table is uniform in and the one a temperature slider feels linear on.
            float f = 0.0;
            if (index != 1) {
                f = distance / (last_distance + distance);
            }
            let before = LOCUS[index - 1];
            let mireds = before[0] * f + row[0] * (1.0 - f);
            uu = u - (before[1] * f + row[1] * (1.0 - f));
            vv = v - (before[2] * f + row[2] * (1.0 - f));
            du = du * (1.0 - f) + last_du * f;
            dv = dv * (1.0 - f) + last_dv * f;
            let length = sqrt(du * du + dv * dv);
            return float2(
                1.0e6 / max(mireds, 1.0e-9),
                (uu * du / length + vv * dv / length) * TINT_SCALE);
        }
        last_distance = distance;
        last_du = du;
        last_dv = dv;
    }
    return float2(6500.0, 0.0);
}

/// A chromaticity as tristimulus values at unit luminance.
float3 xyz_of(float2 xy)
{
    let y = max(xy.y, 1.0e-6);
    return float3(xy.x / y, 1.0, (1.0 - xy.x - xy.y) / y);
}

/// The least a cone response may count for, against the largest of the three.
///
/// **The bound goes on the gain, not on the chromaticity.** A tint steps the illuminant off the
/// locus, and far enough off - 2000K against a tint of +45, which `DSC00853` is shot at - it
/// leaves the chromaticity diagram entirely: `x + y` passes one, the `Z` that `xyz_of` computes
/// as `1 - x - y` goes negative, and so does the Bradford `S` response of it. A negative `S`
/// inverts the blue gain, which is the cold end of the slider coming out *yellow*. Short of that
/// the response is merely tiny and the gain is a division by almost nothing, which the luma
/// renormalisation then pays for by crushing the other two channels: measured at a floor of a
/// thousandth, the whole frame graded to a mean of 13, 7, 5.
///
/// Repairing the chromaticity instead was tried and is worse: it moves illuminants that are
/// perfectly real - 2000K at a tint of 25 keeps a `z` of 0.008 - so `temperature_tint_of` no
/// longer reads back what the forward map was asked for, which
/// `the_shader_solves_the_illuminant_this_crate_reads_back` catches. This leaves every named
/// illuminant exactly where it is and bounds only what is divided by it.
static const float MIN_RESPONSE = 1.0e-2;

/// A cone triple with no component small enough, or negative enough, to divide by.
float3 answerable(float3 cone)
{
    let floor = max(max(cone.x, max(cone.y, cone.z)), 1.0e-6) * MIN_RESPONSE;
    return max(cone, float3(floor));
}

/// The whole balance as one matrix on a Rec.2020 linear colour, written for the grade to read.
///
/// One invocation: this reads four uniforms and nothing else, so it is the same answer for
/// every pixel in the dispatch and no pixel has any business computing it. Which is the point
/// of the pass - two locus searches of up to thirty steps each, then two matrix products - and
/// per pixel that costs about what the rest of the grade does.
[shader("compute")]
[numthreads(1, 1, 1)]
void balance()
{
    var m = float3x3(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);

    // **Where the document's nulls are resolved, and the only place they are.** A half the reader
    // has not moved is the frame's own, so it stands in here rather than in either host - see
    // `balance_set` in `edit.slang` for what having each host decide it cost.
    let asked_temperature =
        select((edit.balance_set & 1) != 0, edit.temperature, edit.as_shot_temperature);
    let asked_tint = select((edit.balance_set & 2) != 0, edit.tint, edit.as_shot_tint);

    // A frame whose camera recorded no usable multipliers has no illuminant to move away from,
    // and says so with an as-shot temperature of zero. Identity rather than a guess.
    //
    // So is a pair that resolves to the frame's own, and that arm is not redundant. The two cone
    // matrices are rounded literals rather than exact inverses, so `CONE_TO_R2020 *
    // R2020_TO_CONE` is the identity to about a millionth - enough to move the odd count, which
    // would make "As Shot" a *slightly* different picture from having never touched the slider.
    // It is the same illuminant; it has to be the same bytes.
    let moved =
        asked_temperature != edit.as_shot_temperature || asked_tint != edit.as_shot_tint;
    if (edit.as_shot_temperature > 0.0 && moved) {
        let was = mul(XYZ_TO_CONE, xyz_of(xy_of(edit.as_shot_temperature, edit.as_shot_tint)));
        let wanted = mul(XYZ_TO_CONE, xyz_of(xy_of(asked_temperature, asked_tint)));
        let gain = answerable(was) / answerable(wanted);
        let diagonal =
            float3x3(gain.x, 0.0, 0.0, 0.0, gain.y, 0.0, 0.0, 0.0, gain.z);
        m = mul(mul(CONE_TO_R2020, diagonal), R2020_TO_CONE);

        // Renormalised so a neutral keeps its luminance. Without it the whole grade breathes as
        // the reader drags temperature: `white`, the measured scene peak and the roll-off knee are
        // all levels, and a balance that moved them would be an exposure slider with a colour on
        // it.
        let white = mul(m, float3(1.0));
        m = m * (1.0 / max(dot(LUMA, white), 1.0e-6));
    }

    // Rows of four, because that is what the grade indexes and a row of three would put every
    // one after the first at an offset nobody can read at a glance.
    for (int row = 0; row < 3; row = row + 1) {
        balance_out[row * 4] = m[row][0];
        balance_out[row * 4 + 1] = m[row][1];
        balance_out[row * 4 + 2] = m[row][2];
    }
}

/// The illuminant the camera balanced for, from what the decoder read out of the file.
///
/// The multipliers are what a neutral surface has to be multiplied by to come out grey, so the
/// surface itself sat at their reciprocal - and that reciprocal, through the camera's own
/// `cam_xyz`, is the illuminant. Written as the temperature, the tint, and a third word saying
/// whether there is one at all: zero where the file recorded no usable multipliers, where the
/// matrix will not invert, or where the chromaticity is degenerate, and then the reader's sliders
/// have no baseline and stay closed.
///
/// One shot rather than the DNG SDK's iteration, because there is nothing here to iterate: that
/// loop exists for a dual-illuminant profile, whose matrix depends on the very temperature being
/// solved for, and the decode picks one matrix.
[shader("compute")]
[numthreads(1, 1, 1)]
void as_shot()
{
    balance_out[0] = 0.0;
    balance_out[1] = 0.0;
    balance_out[2] = 0.0;

    let r = as_shot_in[0];
    let g = as_shot_in[1];
    let b = as_shot_in[2];
    if (!(r > 0.0) || !(g > 0.0) || !(b > 0.0)) {
        return;
    }

    let m = float3x3(
        as_shot_in[4], as_shot_in[5], as_shot_in[6],
        as_shot_in[7], as_shot_in[8], as_shot_in[9],
        as_shot_in[10], as_shot_in[11], as_shot_in[12]);
    // The rows of the adjugate, which is the inverse times the determinant.
    let adjugate0 = float3(
        m[1][1] * m[2][2] - m[1][2] * m[2][1],
        m[0][2] * m[2][1] - m[0][1] * m[2][2],
        m[0][1] * m[1][2] - m[0][2] * m[1][1]);
    let adjugate1 = float3(
        m[1][2] * m[2][0] - m[1][0] * m[2][2],
        m[0][0] * m[2][2] - m[0][2] * m[2][0],
        m[0][2] * m[1][0] - m[0][0] * m[1][2]);
    let adjugate2 = float3(
        m[1][0] * m[2][1] - m[1][1] * m[2][0],
        m[0][1] * m[2][0] - m[0][0] * m[2][1],
        m[0][0] * m[1][1] - m[0][1] * m[1][0]);
    let determinant = m[0][0] * adjugate0.x + m[0][1] * adjugate1.x + m[0][2] * adjugate2.x;
    // **The floor is f32's noise, not a small number.** A camera matrix's entries are O(1), so a
    // determinant assembled from six of their products carries rounding of about 1e-7 - anything
    // under a millionth is that noise rather than a determinant, and dividing by it hands back an
    // arbitrary chromaticity presented as the camera's. Real ones are nowhere near it: Canon's
    // 5D and 5D Mk III come out at 0.60 and 0.43.
    //
    // It is a floor on the *scale* as well, which the answer is not - the chromaticity below is
    // normalised by `sum`, so a decoder handing over uniformly tiny entries would be refused with
    // a perfectly determined answer available. No format rawler reads does that.
    if (!(abs(determinant) > 1.0e-6)) {
        return;
    }

    let neutral = float3(1.0 / r, 1.0 / g, 1.0 / b);
    let xyz = float3(dot(adjugate0, neutral), dot(adjugate1, neutral), dot(adjugate2, neutral))
        / determinant;
    let sum = xyz.x + xyz.y + xyz.z;
    if (!(sum > 0.0)) {
        return;
    }

    let found = temperature_tint_of(float2(xyz.x / sum, xyz.y / sum));
    balance_out[0] = found.x;
    balance_out[1] = found.y;
    balance_out[2] = 1.0;
}
