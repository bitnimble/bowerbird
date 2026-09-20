// What every GALOSH kernel shares: the names of the scalar block it reads.
//
// WGSL has no push constants, so each kernel declares its own `Push` at binding 20 - the field
// names are the kernel's own - and the host writes one 256-byte-aligned slot per dispatch and
// binds it with a dynamic offset.
module prelude;

// `params_buf` slots. Every consumer reads them off the device: only α, σ² and the IRLS scale
// ever cross back to the host.
public static const int P_SIGMA_CH0 = 0;
public static const int P_UNIFIED_SIGMA = 4;
public static const int P_INV_SG = 5;
public static const int P_DARK_REF0 = 6;
public static const int P_S_SCALE = 10;
public static const int P_ALPHA = 13;
public static const int P_SIGMA_SQ = 14;
public static const int P_DARK_THRESH = 15;
// The IRLS bounds. See `irls_seed`.
public static const int P_S_MIN = 16;
public static const int P_S_MAX = 17;

public static const float FLT_MAX = 3.402823466e+38;

/// The colour filter array, as the kernels that have to know a photosite's colour carry it in
/// their own `Push`: the period's extent, and its colours two bits apiece, twelve to a word
/// (`cfa::Cfa::packed_colours`).
///
/// `mosaic.slang` says the same thing for the demosaic, and the two cannot be one module: that
/// one owns bindings 0 and 1 for the frame it reads, which is where GALOSH's own planes sit.
public struct Pattern {
    public int period_w;
    public int period_h;
    public uint packed0;
    public uint packed1;
    public uint packed2;
};

/// 0 red, 1 green, 2 blue. The coordinate is the caller's own and is not clamped.
public uint cfa_colour(Pattern p, int r, int c)
{
    let slot = uint(r % p.period_h) * uint(p.period_w) + uint(c % p.period_w);
    let word = slot / 12u;
    let packed = word == 0u ? p.packed0 : (word == 1u ? p.packed1 : p.packed2);
    return (packed >> ((slot - word * 12u) * 2u)) & 3u;
}

/// How far a photosite of this colour sits from the luma its neighbourhood carries, in terms of
/// the two chroma planes `chroma_extract_halfres` writes: `C1 = mR - mB`, `C2 = mR - 2mG + mB`.
///
/// Luma being `(mR + 2mG + mB) / 4`, subtracting it from each colour's own mean leaves
/// `(2C1 + C2) / 4` at a red, `-C2 / 4` at a green and `(-2C1 + C2) / 4` at a blue - which is
/// what makes the plane the shrinkage reads free of the pattern, whatever the pattern is.
/// What a period's two chroma axes carry of a photosite's own noise, so that both arrive at the
/// shrinkage carrying one sigma as the 2x2 pair does.
///
/// **The threshold every chroma stage applies is calibrated against a unit-gain axis.** Bayer's
/// pair is `0.5 * (r -+ gb +- gr - b)`, four independent samples at a magnitude of a half, so each
/// axis carries exactly the sample's own sigma and the calibration is invisible. A period's pair is
/// built from *means* instead - 8 red, 20 green and 8 blue over a 6x6 - so `mR - mB` carries
/// `sqrt(1/8 + 1/8)` of it and `mR - 2mG + mB` carries `sqrt(1/8 + 4/20 + 1/8)`: half a sigma and
/// two thirds, unequal to each other as well as to the pair the threshold was measured on. Left
/// unnormalised the shrinkage reads both axes as noisier than they are and shrinks accordingly,
/// which takes colour detail out and leaves the noise that motivated it.
///
/// Applied at the extraction and undone in the inverse, so the transform is still its own inverse.
/// `Cfa::chroma_gain` counts it off the pattern and pushes it; nothing here can, the period being
/// up to thirty-six sites and this being read once per photosite.
public float2 chroma_weights(uint colour)
{
    if (colour == 0u) { return float2(0.5, 0.25); }
    if (colour == 2u) { return float2(-0.5, 0.25); }
    return float2(0.0, -0.25);
}

// The block mean range whose variance the envelope fit will actually read.
//
// **Here rather than in `ne_finalize` alone, because two kernels now depend on the same bound.**
// Every read of `blk_var` there is gated on the block's mean falling inside this, so a block
// outside it has no variance worth computing and `ne_block_stats` skips its median outright.
// Written twice the two could drift apart, and the direction that matters is a block the fit reads
// whose variance was never computed - so they read one declaration instead.
public static const float BLOCK_MEAN_FLOOR = 0.003;
public static const float BLOCK_MEAN_CEILING = 0.97;

// The smallest shot-noise slope the GAT will divide by. Every kernel here scales by `2/alpha`,
// so a zero or a NaN in the slot is an infinity in the transform and a NaN in every pixel; this
// is that guard and nothing more. It is deliberately far below any slope an estimator reports -
// a frame with no measurable shot noise is a frame the transform still has to code - because
// `build_inv_lut` is accurate at any alpha now that it stops summing where f32 cannot.
public static const float ALPHA_MIN = 1e-8;

/// Workgroups the two dark-reference reducers are dispatched over, which they stride their
/// grid by.
///
/// **`galosh::DR_WORKGROUPS` is the same number**, and the dispatch is what makes it true:
/// a stride wider than the dispatch leaves the tail of the frame unreduced and the reference
/// fitted to part of it, which is a dark frame subtracted at the wrong level rather than a
/// failure. `the_reducers_stride_the_grid_the_host_dispatches` holds the two together.
public static const int DR_WORKGROUPS = 512;

/// `galosh::ACHROMATIC_RANGE`, the neutrality gate both dark-reference reducers apply.
public static const float ACHROMATIC_RANGE = 4.0;

/// Each histogram and table below is written by one kernel and read by another, and sized by the
/// host (`galosh.rs`, `the_table_sizes_are_the_ones_the_shader_declares`).
public static const int DARK_HIST_BINS = 4096;
public static const float DARK_LAP_MAX = 0.1;
public static const int SIGMA_BINS = 4096;
public static const float SIGMA_LAP_MAX = 16.0;
public static const int LUT_SIZE = 4096;

/// The GAT undone in closed form, for any `d` at all.
///
/// **What the table is for is the correction, not the transform.** `gat_forward_full` is
/// `t = (2/a) sqrt(a y + 3/8 a^2 + sigma^2)` above the break and a straight line below it, and both
/// invert exactly - so this is a level wherever it is asked. The table carries only Mäkitalo-Foi's
/// unbiased correction on top of that, which is a photon-starved effect and has converged to
/// nothing well before the top of the range.
///
/// Which makes it the answer outside the table's ends, and the answer when there is no usable
/// table: a constant there is what turns a fit that came out wrong into a *flat frame* - white
/// from the upper arm, black from the lower - and a flat frame is a broken picture reported as a
/// rendered one. Biased shadows are a picture.
public float gat_inv_exact(float d, float y_break, float t_break, float sigma_raw, float a, float sq)
{
    if (d <= t_break) {
        return y_break + sigma_raw * (d - t_break);
    }
    let root = d * a * 0.5;
    return (root * root - 0.375 * a * a - sq) / max(a, ALPHA_MIN);
}

/// The unbiased inverse, off the table `build_inv_lut` filled, falling back to the closed form
/// wherever the table does not bracket `d`.
///
/// Beside [`gat_inv_exact`], which is the arm it falls back to, so the two halves of one transform
/// are read together rather than a kernel away from each other. The tables are the caller's own
/// bindings, at numbers other kernels use for other things, so they arrive as arguments - Slang
/// specialises a buffer parameter at the call site, and what is emitted reads the caller's global
/// directly.
///
/// The bracket test is spelled against the table rather than for it, so a `lut_params` that came
/// back NaN takes the closed form too - every comparison against NaN is false, and what a search
/// over a NaN table returns is anyone's guess.
public float gat_inv_lut(
    StructuredBuffer<float> lut_d,
    StructuredBuffer<float> lut_x,
    StructuredBuffer<float> lut_params,
    float d,
    uint entries)
{
    let bracketed = lut_params[1] > lut_params[0] && d > lut_params[0] && d < lut_params[1];
    if (!bracketed) {
        return min(
            gat_inv_exact(d, lut_params[2], lut_params[3], lut_params[4], lut_params[5], lut_params[6]),
            1.0);
    }

    var lo = 0u;
    var hi = entries - 1;
    while (lo + 1 < hi) {
        let mid = (lo + hi) >> 1;
        if (lut_d[mid] <= d) { lo = mid; } else { hi = mid; }
    }
    let d0 = lut_d[lo];
    let d1 = lut_d[lo + 1];
    let t = (d - d0) / max(d1 - d0, 1e-10);
    return lut_x[lo] + t * (lut_x[lo + 1] - lut_x[lo]);
}

/// How many inputs a [`Tally`] holds before its top level goes back to a running sum: 2^24 of
/// them, against the low millions a whole-frame reduction divides between its invocations.
public static const uint TALLY_LEVELS = 24;

/// A sum whose accuracy does not depend on how the compiler orders its arithmetic.
///
/// **Nothing here may rely on a rounding error surviving.** A shader has no `f64`, and the
/// obvious f32 substitute - compensated
/// summation, recovering each rounding error the way Knuth's TwoSum does, from
/// `(v - (t - s)) + (s - (t - (t - s)))` - cannot be used: that expression is *identically zero
/// over the reals* and non-zero only because `t` was rounded. A compiler permitted to treat
/// floats as reals folds it to zero, leaving a naive running sum and no sign that anything
/// changed; Metal's shader compiler is permitted exactly that by default, and Metal is where most
/// of these pixels are graded.
///
/// So the accuracy is structural instead. Level `k` holds the sum of exactly 2^k inputs, and two
/// values are only ever added when they are the same size - a term is never added to a total that
/// has already outgrown it, which is the failure that loses it entirely. The error grows with the
/// log of the count rather than the count, and no reordering of the additions can take that away,
/// because every one of them is an ordinary add with nothing to cancel.
public struct Tally {
    public float level[24];
    public uint filled;
};

public Tally tally()
{
    Tally t;
    for (uint at = 0; at < TALLY_LEVELS; at += 1) {
        t.level[at] = 0.0;
    }
    t.filled = 0;
    return t;
}

public void tally_push(inout Tally t, float v)
{
    var carry = v;
    var at = 0u;
    while (true) {
        if (at >= TALLY_LEVELS) { break; }
        if ((t.filled & (1u << at)) == 0) { break; }
        carry = t.level[at] + carry;
        t.filled &= ~(1u << at);
        at += 1;
    }
    // Past 2^24 inputs the top level takes them one at a time, which is an ordinary running sum
    // over the overflow rather than a wrong answer or a lost term.
    let top = min(at, TALLY_LEVELS - 1);
    let occupied = (t.filled & (1u << top)) != 0;
    t.level[top] = select(occupied, t.level[top] + carry, carry);
    t.filled |= (1u << top);
}

/// Smallest block first, so the fold itself keeps the property the levels were built for.
public float tally_sum(Tally t)
{
    var total = 0.0;
    for (uint at = 0; at < TALLY_LEVELS; at += 1) {
        if ((t.filled & (1u << at)) != 0) {
            total = total + t.level[at];
        }
    }
    return total;
}
