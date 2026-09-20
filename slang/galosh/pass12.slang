// Phase 5: the denoise itself - two passes of 8x8 Walsh-Hadamard shrinkage, overlapped.
//
// Pass 1 thresholds each block's AC coefficients against a BayesShrink level and builds a
// pilot estimate; pass 2 uses that pilot for a Wiener gain on the same blocks. Both
// accumulate through a Kaiser window over all sixteen stride-2 phases, so what comes out is
// an average of sixteen overlapping estimates rather than a tiling.
//
// **The block is sixteen vector registers, not an array, and that is the whole performance
// story.** An 8x8 block in `float block[64]`, with its median found by partially sorting a
// second 63-element array, cannot live in registers - a GPU gives a dynamically-indexed local
// array a *scratch* allocation in device memory, and once one of a kernel's arrays is there
// the rest of the working set follows - so every one of the ~2600 element accesses a block
// costs becomes an uncoalesced round trip to memory. Measured on RADV that way: 10.3s for a
// 12MP frame, and a 24MP one lost the device to its watchdog. This is why every index below
// is a constant.

[vk::binding(0, 0)] StructuredBuffer<float> in_buf;
[vk::binding(1, 0)] RWStructuredBuffer<float> out_buf;

struct Push {
    int width;
    int height;
    float sigma_strength;
    /// The first tile row this dispatch owns, so a band covers tiles rather than rows.
    ///
    /// **This is what keeps a band shrinking against the frame's own neighbourhood.** The shrinkage
    /// is defined over a tile grid anchored at the frame's origin, so a band that began mid-tile
    /// would re-anchor that grid under every pixel in it - which is the defect `decode_rawler`'s
    /// tiled denoise carried until it was made to round each origin to `2 * PASS12_TILE`. Counting
    /// in tiles rather than rows makes that impossible to express. Zero for a whole frame.
    int tile_y0;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

/// How much of the cycle spin to run: 1 is every phase, 2 is one in four.
///
/// **A specialisation constant rather than a uniform, for the reason `frame.slang` gives about
/// its own.** Taken from the constant buffer the trip count and the phase's `%` stop being
/// compile-time, which costs the sixteen-phase path its unrolling and its mask: measured at 61MP,
/// 5030ms became 5480 for a frame that never took the short spin. The host builds one pipeline per
/// value and picks between them.
[vk::constant_id(0)]
const int PHASE_SPIN = 1;

/// The same for the row phases, so the two axes can be strided apart.
///
/// Sixteen phases is (1, 1) and four is (2, 2); striding one axis alone gives the eight in
/// between, which is the rung a frame too noisy to drop to four still wants.
[vk::constant_id(1)]
const int PHASE_SPIN_Y = 1;

/// Whether the phases run down the diagonal, which is the only way two of them cover both axes.
///
/// **The spin's own indexing cannot express a diagonal, and two phases that do not is what stripes
/// a shadow.** `px` and `py` come out of one counter as a quotient and a remainder, so striding the
/// rows to a trip count of one - which is what two phases costs - leaves every block's row boundary
/// on the same row of the frame, however many column offsets it visits. The residue is then
/// constant along a row, and the sharpen's amount multiplies it into something a reader sees.
/// Taking `py` from `px` instead puts the second phase at (2, 2), so neither boundary repeats.
[vk::constant_id(2)]
const int PHASE_DIAGONAL = 0;

static const int BS = 8;
static const int BP = 64;
static const int STRIDE = 2;
static const int PHASE_MOD = BS / STRIDE;
static const int N_PHASES = PHASE_MOD * PHASE_MOD;
/// Phases per axis at this spin, so `SPUN_X * SPUN_Y` is the trip count over both.
static const int SPUN_X = PHASE_MOD / PHASE_SPIN;
static const int SPUN_Y = PHASE_MOD / PHASE_SPIN_Y;
/// Enough context that every block a tile's interior needs is stride-aligned inside it.
static const int HALO = BS - STRIDE;
/// The least of a coefficient the gain may keep, which is what decides how even the residual is.
///
/// The gain is the pilot over the pilot plus the noise, so it goes to 1 wherever the
/// signal is strong and the grain there is passed through untouched, while the flat beside it is
/// cut to this. That spread is what a reader sees: measured on DSC00982 against the body's own JPEG
/// of the same frame, the grain within a few pixels of an edge was 2.74 times the grain in the open
/// where the body's was 1.29 times its own - the same *quantity* of noise, arranged so it reads as
/// compression around every boundary rather than as film grain.
///
/// **Raised rather than capped, because a ceiling scales the signal in the same coefficient.** A
/// cap at 0.5 does bring the ratio to 1.50, and it also pulls every block straddling an edge toward
/// its own mean - `a_hard_edge_comes_back_without_a_stripe` reads a level shift of 0.0013 along the
/// boundary, which is a stripe across a horizon and a worse defect than the one it fixes. Sparing the
/// zero-sequency cross stops the stripe and not the rest: a curved edge carries interior sequency
/// too, and on `synth_raw --square`'s disc the cap put a 6.6-code bright rim on the dark side and
/// *more* grain within two pixels of it (sd 4.8 against 3.7 uncapped). The floor
/// only ever touches coefficients the pilot says hold nothing, so it has no signal to attenuate.
///
/// **Flat across the sequencies, and sloping it is a trap worth naming.** A floor ramped from 0.05
/// slow to 0.5 fine, and a sequency-ramped squaring of the gain beside it, were both fitted to pull
/// the residual's spectrum towards the body's; neither moved it, the two-pixel band they aimed at
/// being made by the demosaic downstream rather than left by the gain. What they did do at the slow
/// end was flatten block-scale content, which comes back as quantised blocking across the picture.
static const float WIENER_FLOOR = 0.25;

static const int TILE_SIZE = 28;
static const int TILE_W = TILE_SIZE + 2 * HALO;
static const int TILE_PIXELS = TILE_W * TILE_W;
static const int WG_SIZE = 64;

/// Kaiser, beta 2.0, N 8, as the two halves of a row.
static const float4 KAISER_LO = float4(0.34012, 0.59885, 0.84123, 0.97659);
static const float4 KAISER_HI = float4(0.97659, 0.84123, 0.59885, 0.34012);

// One allocation rather than several: a Metal driver laid four separate workgroup arrays of
// this size over each other, and 762 of the tile's 1600 entries read back changed between phase 1
// writing them and phase 2 reading them - a frame whose structure survives while its levels do not.
// Splitting these into an array each brings that back.
//
// The tile is copied in with them rather than read from `in_buf` per access: reading it live costs
// nothing on RADV and produces a smeared, primary-coloured frame on Metal.
// **Paired, because the accumulate is what this kernel costs.** Every one of a block's 64 values
// reads and writes a numerator and a denominator, 256 round trips a block, and priced by
// collapsing it that is 2225ms of a 61MP frame's 6000ms - more than the transforms, the median and
// the occupancy put together. Held as one `float2` the pair moves in a single 8-byte access
// instead of two 4-byte ones, which halves the traffic without touching an operand or its order.
//
// The tile and the pilot share the other half for the same reason they shared an allocation
// before: they are read together by pass 2, which wants the noisy sample and its guide.
static const int PAIR_AT = 0;
static const int ACC_AT = TILE_PIXELS / 2;

/// Two pixels to a slot, so the accumulate moves sixteen bytes at a time.
///
/// **The round trip is the cost, not the traffic.** Skipping the third of pass 2's writes that
/// nothing reads bought exactly nothing, which says this is bound by the read-modify-write
/// dependency and not by bandwidth - so what pays is fewer trips per value, and only that.
/// Pairing numerator with denominator halved them and was worth 13%; pairing two pixels halves
/// them again.
///
/// `at` is `ref_r * TILE_W + ref_c` with both even, so a row's eight pixels are four whole slots
/// and no access straddles one.
groupshared float4 scratch[TILE_PIXELS];

/// One row of a block: `lo` is columns 0-3, `hi` columns 4-7.
struct Half {
    float4 lo;
    float4 hi;
};

/// An 8x8 block, one field per row.
struct Block {
    Half r0;
    Half r1;
    Half r2;
    Half r3;
    Half r4;
    Half r5;
    Half r6;
    Half r7;
};

// **Every struct here is filled field by field, never with an initializer list.** Slang compiles
// `into = { a, b }` into a synthesized `Struct_$init()` that *returns the struct by value*, which
// is precisely the call shape Metal drops - and `wgsl_call_shapes` refuses it, for the reason
// `wht2d` gives below.
void wht8(out Half into, Half x)
{
    let a = float4(x.lo.x + x.lo.y, x.lo.x - x.lo.y, x.lo.z + x.lo.w, x.lo.z - x.lo.w);
    let e = float4(x.hi.x + x.hi.y, x.hi.x - x.hi.y, x.hi.z + x.hi.w, x.hi.z - x.hi.w);
    let b = float4(a.x + a.z, a.y + a.w, a.x - a.z, a.y - a.w);
    let f = float4(e.x + e.z, e.y + e.w, e.x - e.z, e.y - e.w);
    into.lo = b + f;
    into.hi = b - f;
}

/// The transpose, which is what lets one row butterfly serve both axes.
void transposed(out Block into, Block b)
{
    into.r0.lo = float4(b.r0.lo.x, b.r1.lo.x, b.r2.lo.x, b.r3.lo.x);
    into.r0.hi = float4(b.r4.lo.x, b.r5.lo.x, b.r6.lo.x, b.r7.lo.x);
    into.r1.lo = float4(b.r0.lo.y, b.r1.lo.y, b.r2.lo.y, b.r3.lo.y);
    into.r1.hi = float4(b.r4.lo.y, b.r5.lo.y, b.r6.lo.y, b.r7.lo.y);
    into.r2.lo = float4(b.r0.lo.z, b.r1.lo.z, b.r2.lo.z, b.r3.lo.z);
    into.r2.hi = float4(b.r4.lo.z, b.r5.lo.z, b.r6.lo.z, b.r7.lo.z);
    into.r3.lo = float4(b.r0.lo.w, b.r1.lo.w, b.r2.lo.w, b.r3.lo.w);
    into.r3.hi = float4(b.r4.lo.w, b.r5.lo.w, b.r6.lo.w, b.r7.lo.w);
    into.r4.lo = float4(b.r0.hi.x, b.r1.hi.x, b.r2.hi.x, b.r3.hi.x);
    into.r4.hi = float4(b.r4.hi.x, b.r5.hi.x, b.r6.hi.x, b.r7.hi.x);
    into.r5.lo = float4(b.r0.hi.y, b.r1.hi.y, b.r2.hi.y, b.r3.hi.y);
    into.r5.hi = float4(b.r4.hi.y, b.r5.hi.y, b.r6.hi.y, b.r7.hi.y);
    into.r6.lo = float4(b.r0.hi.z, b.r1.hi.z, b.r2.hi.z, b.r3.hi.z);
    into.r6.hi = float4(b.r4.hi.z, b.r5.hi.z, b.r6.hi.z, b.r7.hi.z);
    into.r7.lo = float4(b.r0.hi.w, b.r1.hi.w, b.r2.hi.w, b.r3.hi.w);
    into.r7.hi = float4(b.r4.hi.w, b.r5.hi.w, b.r6.hi.w, b.r7.hi.w);
}

void wht_rows(out Block into, Block b)
{
    wht8(into.r0, b.r0);
    wht8(into.r1, b.r1);
    wht8(into.r2, b.r2);
    wht8(into.r3, b.r3);
    wht8(into.r4, b.r4);
    wht8(into.r5, b.r5);
    wht8(into.r6, b.r6);
    wht8(into.r7, b.r7);
}

void scaled(out Block into, Block b, float by)
{
    into.r0.lo = b.r0.lo * by; into.r0.hi = b.r0.hi * by;
    into.r1.lo = b.r1.lo * by; into.r1.hi = b.r1.hi * by;
    into.r2.lo = b.r2.lo * by; into.r2.hi = b.r2.hi * by;
    into.r3.lo = b.r3.lo * by; into.r3.hi = b.r3.hi * by;
    into.r4.lo = b.r4.lo * by; into.r4.hi = b.r4.hi * by;
    into.r5.lo = b.r5.lo * by; into.r5.hi = b.r5.hi * by;
    into.r6.lo = b.r6.lo * by; into.r6.hi = b.r6.hi * by;
    into.r7.lo = b.r7.lo * by; into.r7.hi = b.r7.hi * by;
}

/// **Written through the out parameter rather than returned, because Metal loses the tail of a
/// returned `Block`.** A `Block` is 256 bytes, and an out-of-line call that returns one by value
/// comes back with bytes 152..255 - lanes 38..63, a contiguous tail beginning at `r4.hi.z` -
/// holding what that call produced the previous time it ran. Each phase accumulates on the last, so
/// the error multiplies by 64 a phase and a constant frame at 41 arrives as 0.64.
///
/// Measured against Tint's own MSL outside the browser: returning by value is wrong whether the
/// function has three call sites or one, and whether or not it is marked `noinline`; forcing it
/// inline hides it, and so does giving each call site its own copy - but only because the copies
/// then get inlined, which is a heuristic and not a guarantee. Writing through the pointer is the
/// only shape that stays correct with the function forced out of line.
///
/// What a device with the fault shows: a constant frame comes back changed, though a constant block
/// has no AC coefficients for either pass to alter.
void wht2d(out Block into, Block b, bool normalize)
{
    Block rows1; wht_rows(rows1, b);
    Block cols1; transposed(cols1, rows1);
    Block rows2; wht_rows(rows2, cols1);
    Block transformed; transposed(transformed, rows2);
    if (normalize) {
        scaled(into, transformed, 1.0 / 64.0);
        return;
    }
    into = transformed;
}

void tile_row(out Half into, int base)
{
    let at = PAIR_AT + base / 2;
    let s0 = scratch[at];
    let s1 = scratch[at + 1];
    let s2 = scratch[at + 2];
    let s3 = scratch[at + 3];
    into.lo = float4(s0.x, s0.z, s1.x, s1.z);
    into.hi = float4(s2.x, s2.z, s3.x, s3.z);
}

void pilot_row(out Half into, int base)
{
    let at = PAIR_AT + base / 2;
    let s0 = scratch[at];
    let s1 = scratch[at + 1];
    let s2 = scratch[at + 2];
    let s3 = scratch[at + 3];
    into.lo = float4(s0.y, s0.w, s1.y, s1.w);
    into.hi = float4(s2.y, s2.w, s3.y, s3.w);
}

void tile_block(out Block into, int at)
{
    tile_row(into.r0, at);
    tile_row(into.r1, at + TILE_W);
    tile_row(into.r2, at + 2 * TILE_W);
    tile_row(into.r3, at + 3 * TILE_W);
    tile_row(into.r4, at + 4 * TILE_W);
    tile_row(into.r5, at + 5 * TILE_W);
    tile_row(into.r6, at + 6 * TILE_W);
    tile_row(into.r7, at + 7 * TILE_W);
}

void pilot_block(out Block into, int at)
{
    pilot_row(into.r0, at);
    pilot_row(into.r1, at + TILE_W);
    pilot_row(into.r2, at + 2 * TILE_W);
    pilot_row(into.r3, at + 3 * TILE_W);
    pilot_row(into.r4, at + 4 * TILE_W);
    pilot_row(into.r5, at + 5 * TILE_W);
    pilot_row(into.r6, at + 6 * TILE_W);
    pilot_row(into.r7, at + 7 * TILE_W);
}

/// One row of a block as the magnitudes of its coefficients.
struct Mags {
    float4 lo;
    float4 hi;
};

struct Mags16 {
    Mags a;
    Mags b;
};

struct Mags32 {
    Mags a;
    Mags b;
    Mags c;
    Mags d;
};

void mags_of(out Mags into, Half h)
{
    into.lo = abs(h.lo);
    into.hi = abs(h.hi);
}

void reversed(out Mags into, Mags x)
{
    into.lo = x.hi.wzyx;
    into.hi = x.lo.wzyx;
}

/// Four ascending, from a bitonic four.
float4 clean4(float4 v)
{
    let a = min(v.xy, v.zw);
    let b = max(v.xy, v.zw);
    let l = min(float2(a.x, b.x), float2(a.y, b.y));
    let h = max(float2(a.x, b.x), float2(a.y, b.y));
    return float4(l.x, h.x, l.y, h.y);
}

float4 sort4(float4 v)
{
    return clean4(float4(min(v.x, v.y), max(v.x, v.y), max(v.z, v.w), min(v.z, v.w)));
}

/// Eight ascending, from a bitonic eight.
void clean8(out Mags into, Mags x)
{
    into.lo = clean4(min(x.lo, x.hi));
    into.hi = clean4(max(x.lo, x.hi));
}

void sort8(out Mags into, Mags x)
{
    Mags bitonic;
    bitonic.lo = sort4(x.lo);
    bitonic.hi = sort4(x.hi).wzyx;
    clean8(into, bitonic);
}

/// Sixteen ascending, from a bitonic sixteen.
void clean16(out Mags16 into, Mags p, Mags q)
{
    Mags l;
    l.lo = min(p.lo, q.lo);
    l.hi = min(p.hi, q.hi);
    Mags h;
    h.lo = max(p.lo, q.lo);
    h.hi = max(p.hi, q.hi);
    clean8(into.a, l);
    clean8(into.b, h);
}

/// Sixteen ascending, from two ascending eights: reversing the second makes them one bitonic.
void merge16(out Mags16 into, Mags a, Mags b)
{
    Mags rb; reversed(rb, b);
    clean16(into, a, rb);
}

/// Thirty-two ascending, from two ascending sixteens.
void merge32(out Mags32 into, Mags16 a, Mags16 b)
{
    Mags x0; reversed(x0, b.b);
    Mags x1; reversed(x1, b.a);
    Mags l_a;
    l_a.lo = min(a.a.lo, x0.lo);
    l_a.hi = min(a.a.hi, x0.hi);
    Mags l_b;
    l_b.lo = min(a.b.lo, x1.lo);
    l_b.hi = min(a.b.hi, x1.hi);
    Mags16 l; clean16(l, l_a, l_b);
    Mags h_a;
    h_a.lo = max(a.a.lo, x0.lo);
    h_a.hi = max(a.a.hi, x0.hi);
    Mags h_b;
    h_b.lo = max(a.b.lo, x1.lo);
    h_b.hi = max(a.b.hi, x1.hi);
    Mags16 h; clean16(h, h_a, h_b);
    into.a = l.a;
    into.b = l.b;
    into.c = h.a;
    into.d = h.b;
}

/// The MAD of the 63 AC coefficients, as a per-coefficient variance.
///
/// A network rather than a loop because every index has to be a constant, for the reason the
/// header gives - and a network rather than the bisection it replaced, which was equally exact but
/// spent 31 rounds counting all 64 against a midpoint: 1625ms of this kernel's 4354ms at 61MP.
///
/// **Sorted as floats, and it must stay that way.** The magnitudes are non-negative, so the IEEE
/// encoding is monotonic in the value and sorting the bit patterns as `u32` gives the same order
/// for a few fewer instructions. It also breaks this kernel on Metal: with the `bitcast` sort in
/// place, 1.9M of the tile's samples read back from workgroup storage as something other than what
/// was written to them, and the frame comes out with a dark line every 28 rows. Nothing else in
/// the kernel changes - stage for stage, the sort is the only thing that has to be swapped for the
/// corruption to appear and go.
float mad_sigma_y_sq(Block b)
{
    Mags head; mags_of(head, b.r0);
    // The DC term is not one of the 63, so it is put above every magnitude a coefficient can have
    // and sorts out of the rank below.
    head.lo.x = 1e38;

    Mags s0; sort8(s0, head);
    Mags m1; mags_of(m1, b.r1);
    Mags s1; sort8(s1, m1);
    Mags m2; mags_of(m2, b.r2);
    Mags s2; sort8(s2, m2);
    Mags m3; mags_of(m3, b.r3);
    Mags s3; sort8(s3, m3);
    Mags m4; mags_of(m4, b.r4);
    Mags s4; sort8(s4, m4);
    Mags m5; mags_of(m5, b.r5);
    Mags s5; sort8(s5, m5);
    Mags m6; mags_of(m6, b.r6);
    Mags s6; sort8(s6, m6);
    Mags m7; mags_of(m7, b.r7);
    Mags s7; sort8(s7, m7);

    Mags16 ab0; merge16(ab0, s0, s1);
    Mags16 ab1; merge16(ab1, s2, s3);
    Mags32 ab; merge32(ab, ab0, ab1);
    Mags16 cd0; merge16(cd0, s4, s5);
    Mags16 cd1; merge16(cd1, s6, s7);
    Mags32 cd; merge32(cd, cd0, cd1);

    // The last merge stops at its first step, which already separates the 32 smallest of the 64
    // from the 32 largest: the largest of those is the 32nd, so what would have put them in order
    // is a max instead.
    Mags x0; reversed(x0, cd.d);
    Mags x1; reversed(x1, cd.c);
    Mags x2; reversed(x2, cd.b);
    Mags x3; reversed(x3, cd.a);
    let l0_lo = min(ab.a.lo, x0.lo);
    let l0_hi = min(ab.a.hi, x0.hi);
    let l1_lo = min(ab.b.lo, x1.lo);
    let l1_hi = min(ab.b.hi, x1.hi);
    let l2_lo = min(ab.c.lo, x2.lo);
    let l2_hi = min(ab.c.hi, x2.hi);
    let l3_lo = min(ab.d.lo, x3.lo);
    let l3_hi = min(ab.d.hi, x3.hi);
    let top = max(
        max(max(l0_lo, l0_hi), max(l1_lo, l1_hi)),
        max(max(l2_lo, l2_hi), max(l3_lo, l3_hi)));
    let pair = max(top.xy, top.zw);

    let sy = max(pair.x, pair.y) / 0.6745;
    return (sy * sy) / float(BP);
}

/// A row hard-thresholded, and how many of its coefficients survived.
struct Kept {
    Half row;
    float count;
};

void threshold(out Kept into, Half h, float lambda)
{
    let lo = abs(h.lo) >= float4(lambda);
    let hi = abs(h.hi) >= float4(lambda);
    into.count = dot(select(lo, float4(1.0), float4(0.0)), float4(1.0))
        + dot(select(hi, float4(1.0), float4(0.0)), float4(1.0));
    into.row.lo = select(lo, h.lo, float4(0.0));
    into.row.hi = select(hi, h.hi, float4(0.0));
}

/// The Wiener gain a row's pilot asks for, and the energy it carries.
struct Gained {
    Half row;
    float energy;
};

void wiener(out Gained into, Half noisy, Half pilot_row_, float sigma_sq_unorm)
{
    let s2_lo = pilot_row_.lo * pilot_row_.lo;
    let s2_hi = pilot_row_.hi * pilot_row_.hi;
    // **The divisor is floored because both of its terms can be zero at once, and `max` does not
    // agree about NaN across backends.** `sigma_sq_unorm` is exactly zero whenever the luma slider
    // is - an ordinary position, since colour alone satisfies `does_anything` - and a block that is
    // exactly flat, a clipped highlight or shadows the conditioning clamped to zero, has every AC
    // coefficient of its pilot at zero too. That is 0/0. WGSL's `max` propagates the NaN and
    // Metal's `fmax` returns the other operand, so the two hosts would take different branches
    // through the fallback below on the same photograph, which is the one thing the shared shaders
    // exist to prevent.
    let eps_floor = float4(1e-20);
    let w_lo = max(s2_lo / max(s2_lo + float4(sigma_sq_unorm), eps_floor), float4(WIENER_FLOOR));
    let w_hi = max(s2_hi / max(s2_hi + float4(sigma_sq_unorm), eps_floor), float4(WIENER_FLOOR));
    into.row.lo = noisy.lo * w_lo;
    into.row.hi = noisy.hi * w_hi;
    into.energy = dot(w_lo, w_lo) + dot(w_hi, w_hi);
}

void accumulate(Half h, int at, float weight, float row_window)
{
    let wlo = weight * row_window * KAISER_LO;
    let whi = weight * row_window * KAISER_HI;
    let slot = ACC_AT + at / 2;
    scratch[slot] += float4(wlo.x * h.lo.x, wlo.x, wlo.y * h.lo.y, wlo.y);
    scratch[slot + 1] += float4(wlo.z * h.lo.z, wlo.z, wlo.w * h.lo.w, wlo.w);
    scratch[slot + 2] += float4(whi.x * h.hi.x, whi.x, whi.y * h.hi.y, whi.y);
    scratch[slot + 3] += float4(whi.z * h.hi.z, whi.z, whi.w * h.hi.w, whi.w);
}

void accumulate_block(Block b, int at, float weight)
{
    accumulate(b.r0, at, weight, KAISER_LO.x);
    accumulate(b.r1, at + TILE_W, weight, KAISER_LO.y);
    accumulate(b.r2, at + 2 * TILE_W, weight, KAISER_LO.z);
    accumulate(b.r3, at + 3 * TILE_W, weight, KAISER_LO.w);
    accumulate(b.r4, at + 4 * TILE_W, weight, KAISER_HI.x);
    accumulate(b.r5, at + 5 * TILE_W, weight, KAISER_HI.y);
    accumulate(b.r6, at + 6 * TILE_W, weight, KAISER_HI.z);
    accumulate(b.r7, at + 7 * TILE_W, weight, KAISER_HI.w);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void pass12(uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    let tile_x = int(group.x) * TILE_SIZE;
    let tile_y = (int(group.y) + pc.tile_y0) * TILE_SIZE;
    let lid = int(local.y) * 8 + int(local.x);

    // Blocks are anchored over `[0, dim - BS]` only; one anchored outside that must not be
    // accumulated.
    let img_rmax = pc.height - BS;
    let img_cmax = pc.width - BS;

    // A slot at a time, which is two pixels. `TILE_W` is even and a slot starts on an even pixel,
    // so the pair is always the same row and one `gy` serves both.
    for (int s = lid; s < TILE_PIXELS / 2; s += WG_SIZE) {
        let i = 2 * s;
        let gx = tile_x - HALO + (i % TILE_W);
        let gy = tile_y - HALO + (i / TILE_W);
        let inside = gy >= 0 && gy < pc.height;
        var v0 = 0.0;
        if (inside && gx >= 0 && gx < pc.width) {
            v0 = in_buf[gy * pc.width + gx];
        }
        var v1 = 0.0;
        if (inside && gx + 1 >= 0 && gx + 1 < pc.width) {
            v1 = in_buf[gy * pc.width + gx + 1];
        }
        scratch[PAIR_AT + s] = float4(v0, 0.0, v1, 0.0);
        scratch[ACC_AT + s] = float4(0.0, 0.0, 0.0, 0.0);
    }
    GroupMemoryBarrierWithGroupSync();

    let n_blocks_dim = (TILE_W - BS) / STRIDE + 1;
    let sigma_sq = pc.sigma_strength * pc.sigma_strength;
    let lambda_max_unorm = pc.sigma_strength * sqrt(2.0 * log(float(BP))) * sqrt(float(BP));
    let sigma_sq_unorm = sigma_sq * float(BP);

    for (int phase = 0; phase < SPUN_X * SPUN_Y; phase++) {
        let px = (phase % SPUN_X) * PHASE_SPIN;
        let py = PHASE_DIAGONAL != 0 ? px : (phase / SPUN_X) * PHASE_SPIN_Y;
        let bpd = (n_blocks_dim - px + PHASE_MOD - 1) / PHASE_MOD;
        let bpd_y = (n_blocks_dim - py + PHASE_MOD - 1) / PHASE_MOD;
        let n_blocks = bpd * bpd_y;

        for (int bi = lid; bi < n_blocks; bi += WG_SIZE) {
            // **Repeated subtraction, not `bi / bpd` and `bi % bpd`.** `bpd` is a runtime value, and
            // dividing by one here returns a quotient Metal's guards below then reject: measured over a
            // frame, every block row reached the guards in equal number and only `by` divisible by
            // `PHASE_MOD` came out of them, so twelve of every sixteen phases contributed nothing and the
            // frame came back all but undenoised. The loop is bounded by `bpd_y`, which is five.
            var byi = 0;
            var rem = bi;
            while (true) {
                if (rem < bpd) { break; }
                rem -= bpd;
                byi += 1;
            }
            let bx = rem * PHASE_MOD + px;
            let by = byi * PHASE_MOD + py;
            if (bx >= n_blocks_dim || by >= n_blocks_dim) { continue; }

            let ref_c = bx * STRIDE;
            let ref_r = by * STRIDE;
            if (tile_y - HALO + ref_r < 0 || tile_y - HALO + ref_r > img_rmax) { continue; }
            if (tile_x - HALO + ref_c < 0 || tile_x - HALO + ref_c > img_cmax) { continue; }

            let at = ref_r * TILE_W + ref_c;
            Block src;
            tile_block(src, at);
            Block b;
            wht2d(b, src, false);

            let sigma_x_sq = max(mad_sigma_y_sq(b) - sigma_sq, 0.0);
            var lambda = 1e30;
            if (sigma_x_sq >= 1e-10) {
                lambda = min((sigma_sq / sqrt(sigma_x_sq)) * sqrt(float(BP)), lambda_max_unorm);
            }

            // Hard threshold, not soft. A soft one here is a different algorithm.
            let dc = b.r0.lo.x;
            Kept k0; threshold(k0, b.r0, lambda);
            Kept k1; threshold(k1, b.r1, lambda);
            Kept k2; threshold(k2, b.r2, lambda);
            Kept k3; threshold(k3, b.r3, lambda);
            Kept k4; threshold(k4, b.r4, lambda);
            Kept k5; threshold(k5, b.r5, lambda);
            Kept k6; threshold(k6, b.r6, lambda);
            Kept k7; threshold(k7, b.r7, lambda);
            var kept = k0.count + k1.count + k2.count + k3.count + k4.count + k5.count + k6.count
                + k7.count;
            if (abs(dc) >= lambda) {
                kept -= 1.0;
            }
            b.r0 = k0.row;
            b.r1 = k1.row;
            b.r2 = k2.row;
            b.r3 = k3.row;
            b.r4 = k4.row;
            b.r5 = k5.row;
            b.r6 = k6.row;
            b.r7 = k7.row;
            b.r0.lo.x = dc;

            Block shrunk;
            wht2d(shrunk, b, true);
            accumulate_block(shrunk, at, 1.0 / (kept + 1.0));
        }
        GroupMemoryBarrierWithGroupSync();
    }

    for (int s = lid; s < TILE_PIXELS / 2; s += WG_SIZE) {
        let acc = scratch[ACC_AT + s];
        let pair = scratch[PAIR_AT + s];
        // Written whole rather than by component: this file's Metal history is a driver mislaying
        // groupshared, and a partial vector store is the shape least worth finding that out on.
        scratch[PAIR_AT + s] = float4(
            pair.x,
            select(acc.y > 1e-10, acc.x / acc.y, pair.x),
            pair.z,
            select(acc.w > 1e-10, acc.z / acc.w, pair.z));
        scratch[ACC_AT + s] = float4(0.0, 0.0, 0.0, 0.0);
    }
    GroupMemoryBarrierWithGroupSync();

    for (int phase = 0; phase < SPUN_X * SPUN_Y; phase++) {
        let px = (phase % SPUN_X) * PHASE_SPIN;
        let py = PHASE_DIAGONAL != 0 ? px : (phase / SPUN_X) * PHASE_SPIN_Y;
        let bpd = (n_blocks_dim - px + PHASE_MOD - 1) / PHASE_MOD;
        let bpd_y = (n_blocks_dim - py + PHASE_MOD - 1) / PHASE_MOD;
        let n_blocks = bpd * bpd_y;

        for (int bi = lid; bi < n_blocks; bi += WG_SIZE) {
            // **Repeated subtraction, not `bi / bpd` and `bi % bpd`.** `bpd` is a runtime value, and
            // dividing by one here returns a quotient Metal's guards below then reject: measured over a
            // frame, every block row reached the guards in equal number and only `by` divisible by
            // `PHASE_MOD` came out of them, so twelve of every sixteen phases contributed nothing and the
            // frame came back all but undenoised. The loop is bounded by `bpd_y`, which is five.
            var byi = 0;
            var rem = bi;
            while (true) {
                if (rem < bpd) { break; }
                rem -= bpd;
                byi += 1;
            }
            let bx = rem * PHASE_MOD + px;
            let by = byi * PHASE_MOD + py;
            if (bx >= n_blocks_dim || by >= n_blocks_dim) { continue; }

            let ref_c = bx * STRIDE;
            let ref_r = by * STRIDE;
            if (tile_y - HALO + ref_r < 0 || tile_y - HALO + ref_r > img_rmax) { continue; }
            if (tile_x - HALO + ref_c < 0 || tile_x - HALO + ref_c > img_cmax) { continue; }

            let at = ref_r * TILE_W + ref_c;
            Block noisy_src;
            tile_block(noisy_src, at);
            Block noisy;
            wht2d(noisy, noisy_src, false);
            Block guide_src;
            pilot_block(guide_src, at);
            Block guide;
            wht2d(guide, guide_src, false);

            Gained g0; wiener(g0, noisy.r0, guide.r0, sigma_sq_unorm);
            Gained g1; wiener(g1, noisy.r1, guide.r1, sigma_sq_unorm);
            Gained g2; wiener(g2, noisy.r2, guide.r2, sigma_sq_unorm);
            Gained g3; wiener(g3, noisy.r3, guide.r3, sigma_sq_unorm);
            Gained g4; wiener(g4, noisy.r4, guide.r4, sigma_sq_unorm);
            Gained g5; wiener(g5, noisy.r5, guide.r5, sigma_sq_unorm);
            Gained g6; wiener(g6, noisy.r6, guide.r6, sigma_sq_unorm);
            Gained g7; wiener(g7, noisy.r7, guide.r7, sigma_sq_unorm);
            // The DC coefficient's gain is 1 rather than the pilot's, so its energy is 1 too and
            // the floor the rest were held to is not part of it.
            // Floored for the same reason as `wiener` above: a flat block at zero luma is 0/0 here too.
            let dc_s2 = guide.r0.lo.x * guide.r0.lo.x;
            let dc_w = max(dc_s2 / max(dc_s2 + sigma_sq_unorm, 1e-20), WIENER_FLOOR);
            var energy = g0.energy + g1.energy + g2.energy + g3.energy + g4.energy + g5.energy
                + g6.energy + g7.energy - dc_w * dc_w + 1.0;
            Block b;
            b.r0 = g0.row;
            b.r1 = g1.row;
            b.r2 = g2.row;
            b.r3 = g3.row;
            b.r4 = g4.row;
            b.r5 = g5.row;
            b.r6 = g6.row;
            b.r7 = g7.row;
            b.r0.lo.x = noisy.r0.lo.x;

            Block gained;
            wht2d(gained, b, true);
            accumulate_block(gained, at, 1.0 / max(energy, 1e-6));
        }
        GroupMemoryBarrierWithGroupSync();
    }

    for (int i = lid; i < TILE_SIZE * TILE_SIZE; i += WG_SIZE) {
        let lx = i % TILE_SIZE;
        let ly = i / TILE_SIZE;
        let idx = (ly + HALO) * TILE_W + (lx + HALO);
        let gx = tile_x + lx;
        let gy = tile_y + ly;
        if (gx < pc.width && gy < pc.height) {
            // `idx` is the pixel; a slot holds two of them, the even one in `xy` and the odd in
            // `zw`. The interior's origin is even, so which half a pixel lands in follows `lx`.
            let acc = scratch[ACC_AT + idx / 2];
            let pair = scratch[PAIR_AT + idx / 2];
            let even = (idx & 1) == 0;
            let numer = select(even, acc.x, acc.z);
            let denom = select(even, acc.y, acc.w);
            out_buf[gy * pc.width + gx] =
                select(denom > 1e-10, numer / denom, select(even, pair.x, pair.z));
        }
    }
}
