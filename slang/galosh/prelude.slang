// What every GALOSH kernel shares: the names of the scalar block it reads.
//
// WGSL has no push constants, so each kernel declares its own `Push` at binding 20 - the field
// names are the kernel's own - and the host writes one 256-byte-aligned slot per dispatch and
// binds it with a dynamic offset.
module prelude;
import "../light.slang";

// `params_buf` slots. Every consumer reads them off the device: only α, σ² and the IRLS scale
// ever cross back to the host.
public static const int P_SIGMA_CH0 = 0;
public static const int P_UNIFIED_SIGMA = 4;
public static const int P_DARK_REF0 = 6;
public static const int P_S_SCALE = 10;
public static const int P_ALPHA = 13;
public static const int P_SIGMA_SQ = 14;
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

/// Green's conditioning gain over the photosite's own colour's: multiplied by it, a photosite has
/// green's noise, which is the only noise the fit states and the GAT stabilises.
public float to_green(Pattern p, float red, float blue, int r, int c)
{
    let colour = cfa_colour(p, r, c);
    return colour == 0u ? red : (colour == 2u ? blue : 1.0);
}

// The block mean above which the envelope fit reads no variance.
//
// **Here rather than in `ne_finalize` alone, because two kernels depend on the same bound.** Every
// read of `blk_var` there is gated on it, so a block above it has no variance worth computing and
// `ne_block_stats` writes it off. Written twice the two could drift apart, and the direction that
// matters is a block the fit reads whose variance was never computed.
public static const float BLOCK_MEAN_CEILING = 0.97;

/// The side of a block `ne_block_stats` measures, in its channel's own photosites.
public static const int NOISE_BLOCK = 8;

// The smallest shot-noise slope the GAT will divide by. Every kernel here scales by `2/alpha`,
// so a zero or a NaN in the slot is an infinity in the transform and a NaN in every pixel; this
// is that guard and nothing more. It is deliberately far below any slope an estimator reports -
// a frame with no measurable shot noise is a frame the transform still has to code - because
// `build_inv_lut` is accurate at any alpha now that it stops summing where f32 cannot.
public static const float ALPHA_MIN = 1e-8;

/// The sigma the GAT reads at black: the read noise's, and Anscombe's 3/8 of an electron with it.
public float gat_sigma_at_black(float a, float sigma_sq)
{
    return sqrt(0.375 * a * a + max(sigma_sq, 0.0));
}

public float gat_forward(Gain sample, float alpha, float sigma_sq)
{
    let a = max(alpha, ALPHA_MIN);
    let at_black = gat_sigma_at_black(a, sigma_sq);
    let x = sample.g;
    var x_safe = x;
    if (!(x == x)) { x_safe = 0.0; }
    if (x_safe >= 0.0) {
        return (2.0 / a) * sqrt(a * x_safe + at_black * at_black);
    }
    // Light ends at black and so does the curve: a sample under it goes down the tangent there.
    // Followed to its own zero the curve steepens to `1 / sigma`, and a fit that read no read
    // noise then throws a photosite under black seven orders out.
    return 2.0 * at_black / a + x_safe / at_black;
}

/// A green-referred photosite (conditioned value times `to_green`) stabilised and dark-subtracted,
/// as the pyramid reads it.
public float gat_stabilised(float green, float alpha, float sigma_sq, float unified_sigma, float dark)
{
    Gain sample;
    sample.g = green;
    return gat_forward(sample, alpha, sigma_sq) / unified_sigma - dark;
}

/// Workgroups the two dark-reference reducers are dispatched over, which they stride their
/// grid by.
///
/// **`galosh::DR_WORKGROUPS` is the same number**, and the dispatch is what makes it true:
/// a stride wider than the dispatch leaves the tail of the frame unreduced and the reference
/// fitted to part of it, which is a dark frame subtracted at the wrong level rather than a
/// failure. `the_reducers_stride_the_grid_the_host_dispatches` holds the two together.
public static const int DR_WORKGROUPS = 512;

/// The black levels a mosaic is conditioned against, as far as they are told apart under black:
/// green's on either row, which a Bayer body levels separately, then red's and blue's.
public static const int BLACK_LEVELS = 4;

public int black_level_of(uint colour, int row)
{
    if (colour == 1u) { return row & 1; }
    return colour == 0u ? 2 : 3;
}

/// One black level's photosites under it, as `under_black_reduce` gathers them and `ne_finalize`
/// reads them back.
///
/// **The deepest value a level holds is kept apart, and is not the noise's.** It is where the
/// file's zero lands, which every photosite that was never read sits at: Sony pads a 61MP frame
/// with 3.5 million of them, thirty to each one the read noise put under black, and a dead
/// photosite is the same value. Where a frame has neither it is one sample of the tail.
public struct UnderBlack {
    /// Summed over every photosite above the deepest, with how many.
    public float depth;
    public float count;
    /// How many of those have the next photosite of their colour under black too: every second one
    /// of a field at black, and none of a defect or of a lit field's tail.
    public float paired;
    /// Zero where nothing is under black.
    public float deepest;
    public float at_deepest;
    public float paired_at_deepest;
};

/// What a workgroup of `under_black_reduce` writes: an [`UnderBlack`] to each black level.
public static const int UNDER_BLACK_SUMS = 24;

// Every one of these writes through a parameter, a field at a time: they are called under loops,
// where Metal drops a call that returns a struct (`tests/wgsl_call_shapes.rs`).

int under_black_word(int workgroup, int level)
{
    return workgroup * UNDER_BLACK_SUMS + level * (UNDER_BLACK_SUMS / BLACK_LEVELS);
}

public void under_black_put(
    RWStructuredBuffer<float> partials,
    int workgroup,
    int level,
    UnderBlack held)
{
    let at = under_black_word(workgroup, level);
    partials[at] = held.depth;
    partials[at + 1] = held.count;
    partials[at + 2] = held.paired;
    partials[at + 3] = held.deepest;
    partials[at + 4] = held.at_deepest;
    partials[at + 5] = held.paired_at_deepest;
}

public void under_black_at(
    StructuredBuffer<float> partials,
    int workgroup,
    int level,
    out UnderBlack held)
{
    let at = under_black_word(workgroup, level);
    held.depth = partials[at];
    held.count = partials[at + 1];
    held.paired = partials[at + 2];
    held.deepest = partials[at + 3];
    held.at_deepest = partials[at + 4];
    held.paired_at_deepest = partials[at + 5];
}

public void under_black_none(out UnderBlack none)
{
    none.depth = 0.0;
    none.count = 0.0;
    none.paired = 0.0;
    none.deepest = 0.0;
    none.at_deepest = 0.0;
    none.paired_at_deepest = 0.0;
}

public void under_black_merge(inout UnderBlack into, UnderBlack other)
{
    if (other.deepest > into.deepest) {
        into.depth += into.at_deepest * into.deepest;
        into.count += into.at_deepest;
        into.paired += into.paired_at_deepest;
        into.deepest = other.deepest;
        into.at_deepest = other.at_deepest;
        into.paired_at_deepest = other.paired_at_deepest;
    } else if (other.deepest == into.deepest) {
        into.at_deepest += other.at_deepest;
        into.paired_at_deepest += other.paired_at_deepest;
    } else {
        into.depth += other.at_deepest * other.deepest;
        into.count += other.at_deepest;
        into.paired += other.paired_at_deepest;
    }
    into.depth += other.depth;
    into.count += other.count;
    into.paired += other.paired;
}

public void under_black_take(inout UnderBlack into, float depth, bool paired)
{
    UnderBlack one;
    under_black_none(one);
    one.deepest = depth;
    one.at_deepest = 1.0;
    one.paired_at_deepest = paired ? 1.0 : 0.0;
    under_black_merge(into, one);
}

/// `galosh::ACHROMATIC_RANGE`, the neutrality gate both dark-reference reducers apply.
public static const float ACHROMATIC_RANGE = 4.0;

/// Each histogram and table below is written by one kernel and read by another, and sized by the
/// host (`galosh.rs`, `the_table_sizes_are_the_ones_the_shader_declares`).
public static const int SIGMA_BINS = 4096;
public static const float SIGMA_LAP_MAX = 16.0;
public static const int LUT_SIZE = 4096;

/// The GAT undone in closed form, for any `d` at all.
///
/// **What the table is for is the correction, not the transform.** `gat_forward_full` is
/// `t = (2/a) sqrt(a y + 3/8 a^2 + sigma^2)` above black and a straight line below it, and both
/// invert exactly - so this is a level wherever it is asked. The table carries only Mäkitalo-Foi's
/// unbiased correction on top of that, which is a photon-starved effect and has converged to
/// nothing well before the top of the range.
///
/// Which makes it the answer outside the table's ends, and the answer when there is no usable
/// table: a constant there is what turns a fit that came out wrong into a *flat frame* - white
/// from the upper arm, black from the lower - and a flat frame is a broken picture reported as a
/// rendered one. Biased shadows are a picture.
public float gat_inv_exact(float d, float a, float at_black)
{
    let d_black = 2.0 * at_black / a;
    if (d <= d_black) {
        return at_black * (d - d_black);
    }
    let root = d * a * 0.5;
    return (root * root - at_black * at_black) / a;
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
        return min(gat_inv_exact(d, lut_params[2], lut_params[3]), 1.0);
    }

    // The closed form lands within an entry or two of the bracket, so the search gallops out from
    // there rather than bisecting the whole table: a dozen dependent loads per photosite otherwise.
    let guess = gat_inv_exact(d, lut_params[2], lut_params[3]) * float(entries - 1);
    // Spelled against the comparison, so a guess that is not a number starts the walk at entry 0.
    var lo = guess >= 0.0 ? uint(min(guess, float(entries - 2))) : 0u;
    var hi = lo + 1;
    var step = 1u;
    while (lo > 0 && lut_d[lo] > d) {
        hi = lo;
        lo = lo > step ? lo - step : 0u;
        step *= 2u;
    }
    step = 1u;
    while (hi < entries - 1 && lut_d[hi] <= d) {
        lo = hi;
        hi = min(hi + step, entries - 1);
        step *= 2u;
    }
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

public static const int PAIRWISE = 8;

/// The sum of `PAIRWISE` terms as the tree a [`Tally`] would build of them.
public float pairwise(float v[PAIRWISE])
{
    return ((v[0] + v[1]) + (v[2] + v[3])) + ((v[4] + v[5]) + (v[6] + v[7]));
}

public float4 pairwise(float4 v[PAIRWISE])
{
    return ((v[0] + v[1]) + (v[2] + v[3])) + ((v[4] + v[5]) + (v[6] + v[7]));
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
