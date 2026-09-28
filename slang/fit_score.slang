// The colour fit's objective.
//
// The fit measures itself about thirty times over a frame's ~150k train pairs - six ridge
// candidates at each of three rounds, then the saturation's sweep and its refinement - and every
// one of those probes is the same 4.7 million evaluations of a 3x3, a Lab conversion and a
// CIEDE2000.
//
// **What crosses is the pairs, once per stage.** Everything a probe reads that does not move -
// the camera's rendering, the hue balance, and the per-pair colour below the probe's own
// parameter - is uploaded once, so a stage uploads about five megabytes and then asks as many
// probes as it likes for nothing. `fit_target` runs once over that upload: it turns the camera's
// rendering into the Lab every probe compares against, and sums per block the two terms of a
// partial that no probe moves.
//
// **One thread per (probe, block), and the block is part of the answer.** Float addition is not
// associative, so each probe is summed over fixed blocks of `block` pairs in index order and the
// host folds the blocks in order afterwards: the same terms, in the same order, in the same
// groups, whatever adapter runs it.

import prelude;
import fit_class;

struct Params {
    int pairs;
    int blocks;
    int block;
    int probes;
    /// Which parameter shape the probes carry, as `Probe` names them.
    int shape;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per pair, four floats: the colour below the probe's parameter, then the luma a saturation
/// blend rotates about.
[vk::binding(0, 0)] StructuredBuffer<float4> below;
/// Per pair, four floats: the camera's rendering in the render's own linear Rec.2020, and the
/// hue balance beside it. Rewritten in place as Lab by `fit_target`, before any probe reads it.
///
/// **A negative balance is a target the camera clipped.** Its magnitude is still the pair's
/// weight, but its level is a bound rather than a colour, so it is measured for the gamut term
/// only and never for a deltaE. The sign carries that so the frame set needs no second plane.
[vk::binding(1, 0)] RWStructuredBuffer<float4> target;
/// Per probe, twelve floats: a 3x3 in the first nine and a scalar in the tenth, read according
/// to `shape`. The `to_srgb` matrix is folded into the 3x3 by the host where there is one.
[vk::binding(3, 0)] StructuredBuffer<float> probe;
/// The sRGB matrix the camera's rendering is taken through, and a probe that carries no matrix
/// of its own with it.
[vk::binding(4, 0)] StructuredBuffer<float> to_srgb;
/// Per (probe, block), `PARTIAL` floats in `Partial`'s own order.
[vk::binding(5, 0)] RWStructuredBuffer<float> partial;
/// Per block, `INVARIANT` floats: the hue balance summed, then the pairs tallied per bucket and
/// per class.
[vk::binding(6, 0)] RWStructuredBuffer<float> invariant;

/// `hdr_fit::BIAS_BUCKETS`, three bands of the camera's chroma against three of its lightness.
static const int BIAS_BUCKETS = 9;
/// `hdr_fit::COLOUR_CLASSES`: the neutrals, then each sector of the camera's hue as a muted
/// class, a vivid one and a deep one.
static const int HUE_SECTORS = 12;
static const int COLOUR_CLASSES = 1 + 3 * HUE_SECTORS;
/// Chroma per unit of lightness past which a vivid colour is deep. A tungsten-lit room's dark
/// wood floor is vivid at 1.6 and a red pair of shorts deep at 3.3, and in one class the floor's
/// thousand pairs improving hid the shorts turning pink.
static const float DEEP = 2.0;
/// What a unit of CIEDE2000's lightness and chroma terms counts for against one of hue in the
/// visible error: a colour turned towards its neighbour is a different colour, one a little darker
/// is the same colour in other light, and one a little duller the least of the three.
static const float LIGHTNESS_SHARE = 0.5;
static const float CHROMA_SHARE = 0.33;
/// The L* at which the fade towards black counts a difference at half its full weight.
static const float DARK_FADE = 10.0;
/// The trusted balance summed, every balance's magnitude summed, the trusted pairs counted, the
/// pairs counted, then the tally per bucket and per class.
static const int INVARIANT = 4 + BIAS_BUCKETS + COLOUR_CLASSES;
/// Four sums, a signed chroma pair per bucket, the error per class, the plain CIEDE2000 sum, then
/// the block's invariant.
///
/// **The invariant is copied in rather than accumulated.** The hue balance's sum and the tally
/// per bucket do not depend on the probe, and accumulating them in `fit_score` is ten more floats
/// live in every thread - which on a small adapter is the difference between the accumulators
/// living in registers and living in memory. `fit_target` sums them once per block instead.
static const int PARTIAL = 4 + 2 * BIAS_BUCKETS + COLOUR_CLASSES + 1 + INVARIANT;

/// A probe scales the chroma about the pair's luma, which is `fitted_saturation`'s blend.
static const int SHAPE_SATURATION = 0;
/// A probe carries its own 3x3, which is `fitted_matrix_for`'s ridge candidates.
static const int SHAPE_MATRIX = 1;

/// `25^7`, which written out reads as a typo.
static const float POW25_7 = 6103515625.0;

float len2(float a, float b)
{
    return sqrt(a * a + b * b);
}

/// By squaring rather than through `pow` - which is an exponential of a logarithm and loses
/// several digits on a value that then divides by itself plus `25^7`.
float pow7(float v)
{
    let v2 = v * v;
    let v4 = v2 * v2;
    return v4 * v2 * v;
}

float degrees_of(float r)
{
    let d = r * 57.29577951308232;
    return d < 0.0 ? d + 360.0 : d;
}

/// Which of `BIAS_BUCKETS` the camera's own rendering puts a pair in.
int bucket_of(float3 lab)
{
    let chroma = chroma_of(lab);
    let band = chroma < NEUTRAL_CHROMA ? 0 : (chroma < 20.0 ? 1 : 2);
    let light = lab.x < 30.0 ? 0 : (lab.x < 70.0 ? 1 : 2);
    return band * 3 + light;
}

/// Which of `COLOUR_CLASSES` the camera's own rendering puts a pair in.
int class_of(float3 lab)
{
    if (chroma_of(lab) < NEUTRAL_CHROMA) { return 0; }
    let sector = min(int(degrees_of(atan2(lab.z, lab.y)) * (float(HUE_SECTORS) / 360.0)), HUE_SECTORS - 1);
    let band = chroma_of(lab) >= DEEP * lab.x ? 2 : select(vivid(lab), 1, 0);
    return 1 + 3 * sector + band;
}

/// `t`'s four cosines by angle addition from one direction.
float hue_t(float cos_h, float sin_h)
{
    let cos2 = 2.0 * cos_h * cos_h - 1.0;
    let sin2 = 2.0 * sin_h * cos_h;
    let cos3 = cos_h * cos2 - sin_h * sin2;
    let sin3 = sin_h * cos2 + cos_h * sin2;
    let cos4 = cos2 * cos2 - sin2 * sin2;
    let sin4 = 2.0 * sin2 * cos2;
    const float COS30 = 0.8660254037844386;
    const float COS6 = 0.9945218953682733;
    const float SIN6 = 0.1045284632676535;
    const float COS63 = 0.4539904997395468;
    const float SIN63 = 0.8910065241883679;
    return 1.0 - 0.17 * (cos_h * COS30 + sin_h * 0.5) + 0.24 * cos2
        + 0.32 * (cos3 * COS6 - sin3 * SIN6)
        - 0.20 * (cos4 * COS63 + sin4 * SIN63);
}

/// The L* a grey as light as `v`'s brightest channel has: how far from black a colour is to the
/// eye, where its own L* puts a vivid dark red beside a black.
float seen_lightness(float3 v)
{
    let y = clamp(max(v.x, max(v.y, v.z)), 0.0, 1.0);
    return y > 0.008856 ? 116.0 * pow(y, 1.0 / 3.0) - 16.0 : 903.3 * y;
}

float lab_unf(float f) { return f > 0.206893 ? f * f * f : (f - 16.0 / 116.0) / 7.787; }

/// Linear sRGB of a Lab triple, `lab_of` undone.
float3 linear_of(float3 lab)
{
    let fy = (lab.x + 16.0) / 116.0;
    let fx = fy + lab.y / 500.0;
    let fz = fy - lab.z / 200.0;
    let x = 0.95047 * lab_unf(fx);
    let y = lab_unf(fy);
    let z = 1.08883 * lab_unf(fz);
    return float3(
        3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
        -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
}

/// Plain CIEDE2000, visible distance, and its signed chromatic residual in shared a/b axes.
///
/// What the weighting functions buy over dE76, and the reason the fit scores in this: `SC` and
/// `SH` grow with chroma, so at `C* ~ 60` the divisor reaches ~3.7 where a neutral's is 1. The
/// same Lab error therefore counts several times more on a grey wall than on a saturated glaze -
/// which is the right way round, and every failure this crate has been burned by is near-neutral.
/// Still a magnitude, so it cannot see a systematic cast; that is the signed bucket sum below.
///
/// **The hue terms off the two chroma directions, not off their angles.** Written literally the
/// formula spends two `atan2` finding the hues, a `sin` on their difference and four `cos` on
/// their mean. For unit vectors `u` and `v` at the two hues, `u x v` is `sin` of the difference
/// and so carries its sign, `|v - u|` is `2 sin` of half of it, and `u + v` points along the
/// short-arc mean - which is exactly what the wrapped average is defined to be. Only `rt`'s
/// exponential keeps an `atan2`: it is centred on hue 275 and its argument reaches -275, so a
/// wrapped formulation would smooth away the discontinuity the standard puts at hue 0.
float4 delta_e2000(float3 p, float3 q, float seen)
{
    let l1 = p.x; let a1 = p.y; let b1 = p.z;
    let l2 = q.x; let a2 = q.y; let b2 = q.z;

    let c1 = len2(a1, b1);
    let c2 = len2(a2, b2);
    let cbar = (c1 + c2) * 0.5;
    let cbar7 = pow7(cbar);
    let g = 0.5 * (1.0 - sqrt(cbar7 / (cbar7 + POW25_7)));

    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;
    let c1p = len2(a1p, b1);
    let c2p = len2(a2p, b2);

    let dlp = l2 - l1;
    let dcp = c2p - c1p;
    let lbarp = (l1 + l2) * 0.5;
    let cbarp = (c1p + c2p) * 0.5;

    let neutral = c1p * c2p == 0.0;
    let ux = a1p / c1p; let uy = b1 / c1p;
    let vx = a2p / c2p; let vy = b2 / c2p;
    let bisector = len2(ux + vx, uy + vy);
    // Opposite hues leave the mean undefined and the difference's sign decided by which colour
    // was named first, neither of which a direction can carry. Measure zero, and the literal
    // formula is the only thing that answers it.
    let literal = neutral || !(bisector > 1e-9);

    float dbig_hp;
    float t;
    float hbarp;
    float2 direction;
    if (literal) {
        let h1p = c1p == 0.0 ? 0.0 : degrees_of(atan2(b1, a1p));
        let h2p = c2p == 0.0 ? 0.0 : degrees_of(atan2(b2, a2p));
        var dhp = 0.0;
        if (!neutral) {
            let d = h2p - h1p;
            dhp = d > 180.0 ? d - 360.0 : (d < -180.0 ? d + 360.0 : d);
        }
        let sum = h1p + h2p;
        if (neutral) {
            hbarp = sum;
        } else if (abs(h1p - h2p) <= 180.0) {
            hbarp = sum * 0.5;
        } else if (sum < 360.0) {
            hbarp = (sum + 360.0) * 0.5;
        } else {
            hbarp = (sum - 360.0) * 0.5;
        }
        let radians = hbarp * 0.017453292519943295;
        dbig_hp = 2.0 * sqrt(c1p * c2p) * sin(dhp * 0.017453292519943295 * 0.5);
        direction = float2(cos(radians), sin(radians));
        t = hue_t(direction.x, direction.y);
    } else {
        let cross = ux * vy - uy * vx;
        let chord = len2(vx - ux, vy - uy);
        let sign = cross < 0.0 ? -1.0 : 1.0;
        let cos_h = (ux + vx) / bisector;
        let sin_h = (uy + vy) / bisector;
        direction = float2(cos_h, sin_h);
        dbig_hp = sign * chord * sqrt(c1p * c2p);
        t = hue_t(cos_h, sin_h);
        hbarp = degrees_of(atan2(sin_h, cos_h));
    }

    let cbarp7 = pow7(cbarp);
    let centred = (hbarp - 275.0) / 25.0;
    let rt = -sin((2.0 * (30.0 * exp(-(centred * centred)))) * 0.017453292519943295)
        * 2.0 * sqrt(cbarp7 / (cbarp7 + POW25_7));

    let dl = lbarp - 50.0;
    let sl = 1.0 + (0.015 * dl * dl) / sqrt(20.0 + dl * dl);
    let sc = 1.0 + 0.045 * cbarp;
    let sh = 1.0 + 0.015 * cbarp * t;

    let tl = dlp / sl;
    let tc = dcp / sc;
    let th = dbig_hp / sh;
    let ql = tl * LIGHTNESS_SHARE;
    let qc = tc * CHROMA_SHARE;
    let fade = seen / (seen + DARK_FADE) * ((50.0 + DARK_FADE) / 50.0);
    // Preserve the chromatic metric's cross term in a signed vector; lightness cannot tint it.
    let radial = qc + 0.5 * rt * th;
    let tangent = th * sqrt(max(1.0 - 0.25 * rt * rt, 0.0));
    let bias = -fade * (radial * direction + tangent * float2(-direction.y, direction.x));
    return float4(
        sqrt(tl * tl + tc * tc + th * th + rt * tc * th),
        fade * sqrt(max(ql * ql + qc * qc + th * th + rt * qc * th, 0.0)),
        bias);
}

float3 mul3(int at, float3 v)
{
    return float3(
        probe[at + 0] * v.x + probe[at + 1] * v.y + probe[at + 2] * v.z,
        probe[at + 3] * v.x + probe[at + 4] * v.y + probe[at + 5] * v.z,
        probe[at + 6] * v.x + probe[at + 7] * v.y + probe[at + 8] * v.z);
}

float3 through_srgb(float3 v)
{
    return float3(
        to_srgb[0] * v.x + to_srgb[1] * v.y + to_srgb[2] * v.z,
        to_srgb[3] * v.x + to_srgb[4] * v.y + to_srgb[5] * v.z,
        to_srgb[6] * v.x + to_srgb[7] * v.y + to_srgb[8] * v.z);
}

/// One channel of the camera's rendering on the 255 steps its JPEG genuinely lives on: the sRGB
/// transfer, IEC 61966-2-1, rounded to a level and undone.
///
/// This is the only quantisation in the comparison - ours reaches the objective unrounded - and
/// out of gamut clamps rather than being mapped, which is what the encode that wrote the JPEG
/// did with it too.
float on_grid(float v)
{
    let level = round(255.0 * srgb_oetf(clamp(v, 0.0, 1.0))) / 255.0;
    return srgb_eotf(level);
}

/// How far past the sRGB gamut a linear-light sRGB triple sits: the fraction of its chroma a
/// luma-preserving pull to the hull would take off, 0 on or inside it and 1 for a colour with no
/// grey of its luma to pull towards.
///
/// The camera's rendering is an sRGB JPEG, so nothing in the target is past that hull; a
/// clipped target says the colour reached it, and a candidate that renders past it is wrong by
/// this much there where a deltaE - which `lab_of` clamps to the hull first - reads zero. It is
/// the one quantity a clipped target can be measured against.
float excursion(float3 v)
{
    let lowest = min(v.x, min(v.y, v.z));
    if (lowest >= 0.0) { return 0.0; }
    let luma = dot(LUMA709, v);
    if (luma <= 0.0) { return 1.0; }
    return -lowest / (luma - lowest);
}

/// What the probe makes of one pair, in the domain `lab_of` reads.
float3 probed(int p, int k)
{
    let held = below[k];
    if (pc.shape == SHAPE_SATURATION) {
        let saturation = probe[p * 12 + 9];
        let m = held.xyz;
        // The same short circuit `colour.slang`'s `finish_chroma` takes: `l + (m - l) * 1.0` is
        // not bit-identical to `m`, and the neutral probe is exactly 1.0.
        let blended = saturation == 1.0 ? m : held.w + (m - held.w) * saturation;
        return through_srgb(blended);
    }
    // The 3x3 the host handed over already has `to_srgb` folded into it, so a ridge candidate is
    // one multiply here rather than two.
    return mul3(p * 12, held.xyz);
}

/// The camera's side of every pair, once per upload: its Lab in place of its linear Rec.2020,
/// and per block the two sums no probe moves.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_target(uint3 id : SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let start = b * pc.block;
    let end = min(start + pc.block, pc.pairs);

    var weight = 0.0;
    var weight_all = 0.0;
    var trusted = 0.0;
    float seen[BIAS_BUCKETS];
    [ForceUnroll]
    for (int i = 0; i < BIAS_BUCKETS; i++) {
        seen[i] = 0.0;
    }
    float classed[COLOUR_CLASSES];
    [ForceUnroll]
    for (int i = 0; i < COLOUR_CLASSES; i++) {
        classed[i] = 0.0;
    }
    for (int k = start; k < end; k++) {
        let t = target[k];
        let srgb = through_srgb(t.xyz);
        let lab = lab_of(float3(on_grid(srgb.x), on_grid(srgb.y), on_grid(srgb.z)));
        target[k] = float4(lab, t.w);
        let trust = t.w >= 0.0;
        weight += select(trust, t.w, 0.0);
        weight_all += abs(t.w);
        trusted += select(trust, 1.0, 0.0);
        // A clipped target is in no bucket: its Lab is the hull's, not the colour's.
        let at = select(trust, bucket_of(lab), -1);
        [ForceUnroll]
        for (int i = 0; i < BIAS_BUCKETS; i++) {
            seen[i] = select(at == i, seen[i] + 1.0, seen[i]);
        }
        let in_class = select(trust, class_of(lab), -1);
        [ForceUnroll]
        for (int i = 0; i < COLOUR_CLASSES; i++) {
            classed[i] = select(in_class == i, classed[i] + 1.0, classed[i]);
        }
    }

    let out = b * INVARIANT;
    invariant[out] = weight;
    invariant[out + 1] = weight_all;
    invariant[out + 2] = trusted;
    invariant[out + 3] = float(end - start);
    [ForceUnroll]
    for (int i = 0; i < BIAS_BUCKETS; i++) {
        invariant[out + 4 + i] = seen[i];
    }
    [ForceUnroll]
    for (int i = 0; i < COLOUR_CLASSES; i++) {
        invariant[out + 4 + BIAS_BUCKETS + i] = classed[i];
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_score(uint3 id : SV_DispatchThreadID)
{
    let unit = int(id.x);
    if (unit >= pc.probes * pc.blocks) { return; }
    let p = unit / pc.blocks;
    let b = unit % pc.blocks;
    let start = b * pc.block;
    let end = min(start + pc.block, pc.pairs);

    var balanced = 0.0;
    var flat = 0.0;
    var plain = 0.0;
    var gamut_balanced = 0.0;
    var gamut_flat = 0.0;
    float bias_a[BIAS_BUCKETS];
    float bias_b[BIAS_BUCKETS];
    [ForceUnroll]
    for (int i = 0; i < BIAS_BUCKETS; i++) {
        bias_a[i] = 0.0;
        bias_b[i] = 0.0;
    }
    float class_error[COLOUR_CLASSES];
    [ForceUnroll]
    for (int i = 0; i < COLOUR_CLASSES; i++) {
        class_error[i] = 0.0;
    }

    for (int k = start; k < end; k++) {
        let t = target[k];
        let lit = probed(p, k);
        let past = excursion(lit);
        gamut_balanced += abs(t.w) * past;
        gamut_flat += past;
        if (t.w < 0.0) { continue; }
        let ours = lab_of(lit);
        let seen = max(seen_lightness(lit), seen_lightness(linear_of(t.xyz)));
        let both = delta_e2000(ours, t.xyz, seen);
        let e = both.y;
        balanced += t.w * e;
        flat += e;
        plain += both.x;

        // **Accumulated by a select over all nine rather than by a subscript**, so the two arrays
        // keep constant indices and stay in registers: a dynamically-indexed local array gets a
        // scratch allocation in device memory, which `pass12` records at ten seconds for a frame.
        // Measured here at 150k pairs, a single probe is 0.89ms with the index constant, 1.94 with
        // the select, and 1.89 with the subscript - so the select is worth having and the gap to
        // the first is what the pooling itself costs.
        let at = bucket_of(t.xyz);
        [ForceUnroll]
        for (int i = 0; i < BIAS_BUCKETS; i++) {
            let mine = at == i;
            bias_a[i] = select(mine, bias_a[i] + both.z, bias_a[i]);
            bias_b[i] = select(mine, bias_b[i] + both.w, bias_b[i]);
        }
        let in_class = class_of(t.xyz);
        [ForceUnroll]
        for (int i = 0; i < COLOUR_CLASSES; i++) {
            class_error[i] = select(in_class == i, class_error[i] + e, class_error[i]);
        }
    }

    let out = unit * PARTIAL;
    partial[out] = balanced;
    partial[out + 1] = flat;
    partial[out + 2] = gamut_balanced;
    partial[out + 3] = gamut_flat;
    [ForceUnroll]
    for (int i = 0; i < BIAS_BUCKETS; i++) {
        partial[out + 4 + 2 * i] = bias_a[i];
        partial[out + 4 + 2 * i + 1] = bias_b[i];
    }
    [ForceUnroll]
    for (int i = 0; i < COLOUR_CLASSES; i++) {
        partial[out + 4 + 2 * BIAS_BUCKETS + i] = class_error[i];
    }
    partial[out + 4 + 2 * BIAS_BUCKETS + COLOUR_CLASSES] = plain;
    [ForceUnroll]
    for (int j = 0; j < INVARIANT; j++) {
        partial[out + 4 + 2 * BIAS_BUCKETS + COLOUR_CLASSES + 1 + j] = invariant[b * INVARIANT + j];
    }
}
