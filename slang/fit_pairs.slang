// The colour fit's ceiling, its mask, the hue census beside it, and the pair list they select -
// over the two fit-grid planes, where `fit_register.slang` left them.
//
// Every threshold arrives through the uniform. They are the same numbers `hdr_fit.rs` gates on and
// documents at length, and a shader restating one would be a second place to change it. What is
// stated here rather than passed is the word's own layout, which
// `the_shader_packs_the_word_the_host_takes_apart` holds against the host's reading of it.
//
// The ceiling is *selected*, not binned. It is the rank-`at` element of the render's own maxima and
// the value it lands on crosses to the sidecar, so a binned quantile would answer to within a bin
// where the host answered exactly. Two passes over the f32 bit patterns give the exact one - the
// high half narrows it to one of 65536 buckets, the low half picks the code inside that bucket -
// which is legal because a non-negative float orders the same way its bit pattern does, and these
// planes are box averages and gated blurs of non-negative light.
import prelude;

struct Params {
    int width;
    int height;
    /// Pixels one thread of the pair passes walks, and how many such blocks the plane holds.
    int block;
    int blocks;
    int hue_bins;
    /// Below this many usable pixels the frame does not get to move its own ceiling.
    int min_counted;
    /// `hdr_fit::MARGIN_DARK`.
    float margin_dark;
    float camera_clipping;
    float camera_crushed;
    /// `TRUST_CEILING`: where the selection starts, and half where it may reach.
    float trust_ceiling;
    /// `OUR_CLIPPING / TRUST_CEILING`, which the colour gate scales the fitted ceiling by.
    float colour_scale;
    /// How much square-root luma may change across a pixel before the pair is dropped.
    float gradient_limit;
    /// `GREY_CHROMA`, and the level under which a chroma ratio is noise rather than a hue.
    float grey_chroma;
    float grey_floor;
    /// Below this much chroma a pixel has no hue to census.
    float hue_chroma;
    /// One pixel in this many along each axis carries `FRAME`.
    int frame_stride;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Our own render, interleaved f32 RGB, in multiples of diffuse white.
[vk::binding(0, 0)] StructuredBuffer<float> render;
/// The camera's rendering of the same pixel, linearised into the same primaries.
[vk::binding(1, 0)] StructuredBuffer<float> jpeg;
/// The mask a pixel earned, with the hue it was censused into above it.
[vk::binding(2, 0)] RWStructuredBuffer<uint> bits;
/// The selection's two halves, one after the other.
[vk::binding(3, 0)] RWStructuredBuffer<Atomic<uint> > histogram;
[vk::binding(4, 0)] RWStructuredBuffer<Atomic<uint> > marks;
/// Pairs per block, then where each block's run starts once `fit_pairs_offsets` has run.
[vk::binding(5, 0)] RWStructuredBuffer<uint> counts;
/// Five words a pair: its pixel, the camera's colour there, and whether it is one of the greys.
[vk::binding(6, 0)] RWStructuredBuffer<uint> pairs;

static const uint HALF_BINS = 65536;

/// Bit `c` is set where channel `c` is usable on its own; `ALL` where all three are.
///
/// The distinction is load-bearing. A per-channel curve only needs its own channel in range, and
/// requiring all three threw away most of the samples at the top of red's and green's domains: in a
/// sky it is blue that is near clipping, so every sky pixel was dropped from red's curve as well.
/// Both curves then ran out of data well below the ceiling and were extrapolated from there, which
/// tinted the upper mid-tones magenta - measured at deltaA* +5.2 in the 75-89 L* band, on pixels
/// that sit *inside* the fit domain. The matrix still wants all three, being cross-channel.
static const uint ALL = 8;

/// All three channels carry colour, which is a weaker test than `ALL` and a different one.
///
/// `ALL` requires our side below the ceiling, because the stage it gates is a per-channel curve and
/// that ceiling is the top of the curve's domain. The chroma stages want no such thing: they need a
/// target that says what colour was there, and the camera's own clipping level already answers that.
///
/// Gating both on the curve's ceiling threw away every bright surface. On IMG_8789 the bird bath
/// reads 239/242/250 against a camera at 215/219/222 - the camera is 15 counts below its own clip
/// and perfectly informative, while we are over a ceiling that exists for an unrelated reason. So
/// the one surface most obviously wrong in the output was contributing nothing to the correction
/// meant to fix it, and the map covered it by extrapolating from foliage.
static const uint COLOUR = 16;

/// The picture, as opposed to the pairs: one pixel in `frame_stride` along each axis, wherever we
/// rendered something.
///
/// **A pair is not a sample of the photograph, and on some frames it is not close.** Every gate
/// above exists to find pixels the camera can *teach* from, which is a far narrower thing than the
/// pixels a fitted transform will be *applied* to: an orange-lit stairwell has the camera's blue
/// crushed on 89% of the grid, so the matrix is solved on a near-neutral ninth and then run over
/// the rest, where it adds blue the camera never rendered. Held out pairs cannot see that, being
/// drawn from the same ninth. So the candidates are scored on this set as well, and it keeps
/// precisely what the pairs throw away - a crushed channel is a poor thing to solve against, being
/// a quantised bound rather than a level, and a perfectly good thing to be wrong against.
static const uint FRAME = 32;

/// How small a share of its own pixel's brightest channel a channel may be and still carry a level.
///
/// A neutral pixel holds its three channels within a factor of two of each other whatever its
/// brightness, so nothing black is excluded by this; what is excluded is the deeply monochromatic,
/// where one channel has been driven to the floor by the colour transform rather than by the light.
///
/// **A tenth, swept over the 32-frame library and the fixtures.** At a fiftieth the shadow pedestal
/// that motivated this only halves, 0.373 to 0.166, where the library's own worst is 0.065; at a
/// tenth it lands at 0.058, inside the library's range, and the black leading in that frame renders
/// 36/22/8 against the camera's 30/19/7 where it had been 43/36/29. The fit's residual prefers a
/// twentieth by a tenth of a deltaE and IMG_1144 by nine tenths, which is the trade taken: the
/// residual is one number over a whole frame and cannot see a toe, and a pedestal is a defect a
/// reader sees in every shadow.
static const float CRUSHED_SHARE = 0.10;

/// Where the censused hue sits in the same word, clear of every bit above.
static const uint HUE_SHIFT = 8;

/// What `marks` holds before the hue counts start.
static const uint COUNTED = 0;
static const uint UNCLIPPED = 1;
static const uint BUCKET = 2;
static const uint BELOW = 3;
static const uint CEILING = 4;
static const uint TOTAL = 5;
static const uint HUES = 6;

/// Words a pair's record occupies.
static const uint PAIR_WORDS = 5;

float3 render_at(int p) { return float3(render[p * 3], render[p * 3 + 1], render[p * 3 + 2]); }
float3 jpeg_at(int p) { return float3(jpeg[p * 3], jpeg[p * 3 + 1], jpeg[p * 3 + 2]); }

float high_of(float3 v) { return max(v.x, max(v.y, v.z)); }
float low_of(float3 v) { return min(v.x, min(v.y, v.z)); }

/// A black warp margin is not scene content, and the exact-zero test is what says so.
bool lit(float3 v) { return v.x != 0.0 || v.y != 0.0 || v.z != 0.0; }

/// The rank the selection is looking for: as many pixels as the camera rendered unclipped, or the
/// last one there is.
uint wanted_rank()
{
    let counted = marks[COUNTED].load();
    return min(marks[UNCLIPPED].load(), counted - 1);
}

/// The bucket the render's maxima fall in, counted over the pixels that carry scene content.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_extent_high(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }
    let p = y * pc.width + x;
    let v = render_at(p);
    if (!lit(v)) { return; }

    marks[COUNTED].add(1);
    if (high_of(jpeg_at(p)) < pc.camera_clipping) { marks[UNCLIPPED].add(1); }
    histogram[asuint(high_of(v)) >> 16].add(1);
}

/// Which of those buckets holds the rank, and how many pixels sit below it.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_extent_pick()
{
    if (marks[COUNTED].load() == 0) { return; }
    let at = wanted_rank();
    var seen = 0u;
    for (uint bucket = 0u; bucket < HALF_BINS; bucket++) {
        let count = histogram[bucket].load();
        if (seen + count > at) {
            marks[BUCKET].store(bucket);
            marks[BELOW].store(seen);
            return;
        }
        seen += count;
    }
}

/// The low half of the pattern, for the pixels that landed in that bucket.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_extent_low(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }
    let p = y * pc.width + x;
    let v = render_at(p);
    if (!lit(v)) { return; }

    let word = asuint(high_of(v));
    if ((word >> 16) != marks[BUCKET].load()) { return; }
    histogram[HALF_BINS + (word & 0xffffu)].add(1);
}

/// The exact code, clamped into the domain a curve can be fitted over.
///
/// Never below `trust_ceiling`, so a frame whose content already fits is untouched, and capped at
/// twice it: past that the camera is clipping so much that the stretch would only spend curve
/// resolution on levels with no data.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_extent_finish()
{
    var chosen = pc.trust_ceiling;
    if (marks[COUNTED].load() >= uint(pc.min_counted)) {
        let at = wanted_rank();
        var seen = marks[BELOW].load();
        for (uint low = 0u; low < HALF_BINS; low++) {
            let count = histogram[HALF_BINS + low].load();
            if (seen + count > at) {
                chosen = asfloat((marks[BUCKET].load() << 16) | low);
                break;
            }
            seen += count;
        }
        chosen = clamp(chosen, pc.trust_ceiling, 2.0 * pc.trust_ceiling);
    }
    marks[CEILING].store(asuint(chosen));
}

/// Which sixth of the hue circle the camera put this pixel in, and one bucket for everything too
/// close to grey to have a hue at all.
///
/// A chroma ratio taken between crushed codes is noise: a pixel the camera rendered 2/1/3 reads as
/// 67% chroma and lands in a hue bin on nothing.
uint hue_bucket(int p)
{
    let t = jpeg_at(p);
    let high = high_of(t);
    let low = low_of(t);
    if (!(high > pc.camera_crushed) || (high - low) / high < pc.hue_chroma) {
        return uint(pc.hue_bins);
    }
    let span = high - low;
    var sixth = 4.0 + (t.x - t.y) / span;
    if (t.x >= t.y && t.x >= t.z) {
        sixth = (t.y - t.z) / span;
    } else if (t.y >= t.z) {
        sixth = 2.0 + (t.z - t.x) / span;
    }
    let turns = fmod(sixth + 6.0, 6.0) / 6.0;
    return min(uint(turns * float(pc.hue_bins)), uint(pc.hue_bins - 1));
}

/// The camera's luma at a pixel, on the square root a gradient is measured over.
float coded_at(int x, int y)
{
    return sqrt(max(dot(LUMA, jpeg_at(y * pc.width + x)), 0.0));
}

/// Whether a small misregistration could still change the colour here, plus the two gates the
/// curves and the chroma stages want, all of which the mask's bits carry apart.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_mask(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }
    let p = y * pc.width + x;
    // Every pixel is censused, border included, because the weighting the census feeds is read by
    // pixel and the mask is what decides whether a weight is ever asked for.
    let hue = hue_bucket(p);
    bits[p] = hue << HUE_SHIFT;
    if (pc.width < 3 || pc.height < 3) { return; }
    if (x == 0 || x == pc.width - 1 || y == 0 || y == pc.height - 1) { return; }

    let v = render_at(p);
    if (!lit(v)) { return; }
    let t = jpeg_at(p);
    // Before every gate below, because those gates are what this set exists to see past - the
    // camera's own clipping included. A clipped target has no level to be measured against, and
    // the host marks it so (`hdr_fit`, a negative balance) - but it says the colour is at least
    // that saturated, so a candidate that renders it past the gamut is wrong there, and the
    // objective's gamut term is what reads it.
    var frame = 0u;
    if (x % pc.frame_stride == 0 && y % pc.frame_stride == 0) {
        frame = FRAME;
    }
    bits[p] = frame | (hue << HUE_SHIFT);
    // The margin tapers through near-black, the exact-zero test misses the taper, and a pair with
    // camera content over our taper teaches the curve that light maps to dark. Only our side has a
    // margin, so only that direction is a crumb: the camera black over our signal is the toe's
    // teacher.
    if (dot(LUMA, v) < pc.margin_dark && dot(LUMA, t) >= pc.margin_dark) { return; }

    let ceiling = asfloat(marks[CEILING].load());
    let colour_limit = ceiling * pc.colour_scale;
    let brightest = high_of(v);
    var mask = 0u;
    var colour = 0u;
    for (int c = 0; c < 3; c++) {
        if (t[c] >= pc.camera_clipping) { continue; }
        // **A channel the colour transform crushed is a bound, not a level** - the argument `FRAME`
        // already makes against solving on one, applied to the stage that reads a level directly.
        // Where a pixel is saturated enough that one channel is a tenth of its own brightest, that
        // channel says only "very little", while the camera's rendering of it says a number; fitted
        // together they teach a curve that near-zero renders as grey, and the curve is read by every
        // genuinely black pixel in the frame. Measured on the ISO 4000 church: the darkest green
        // bins are the stained glass, where our blue panes crush green and the camera's do not, and
        // their pairs invert the toe from 0.0046 up to 0.24.
        //
        // **`mask` only.** `COLOUR` exists to keep exactly these pixels for the stages that want a
        // target rather than a level, which the paragraph above it argues at length - a saturated
        // hue routinely puts its other two channels under a tenth of its brightest, so gating the
        // `colour` bits here would starve the matrix and the chroma map of the vivid pixels that
        // gate was added to stop discarding.
        let crushed = v[c] < CRUSHED_SHARE * brightest;
        if (v[c] < ceiling && !crushed) { mask |= 1u << uint(c); }
        if (v[c] < colour_limit) { colour |= 1u << uint(c); }
    }
    if (colour == 0) { return; }
    if (mask == 7) { mask |= ALL; }
    if (colour == 7 && low_of(t) > pc.camera_crushed) { mask |= COLOUR; }

    // Gradient on the square root of luma rather than on linear light. A fixed linear threshold is
    // not the same test at both ends - in the shadows almost nothing exceeds it and in the sky
    // almost everything does - so the surviving pixels would come from the dark half of the frame
    // and the curve would be fitted where it has least to say.
    let across = abs(coded_at(x + 1, y) - coded_at(x - 1, y))
        + abs(coded_at(x, y + 1) - coded_at(x, y - 1));
    if (across > pc.gradient_limit) { return; }

    bits[p] = mask | frame | (hue << HUE_SHIFT);
    if ((mask & ALL) != 0) { marks[HUES + hue].add(1); }
}

/// Whether either side rendered this pixel near enough to neutral to count as one of the frame's
/// greys.
///
/// Either side, not the camera's alone. Selecting on the camera's rendering makes a body that tints
/// its neutrals exclude itself from its own correction: a scene grey rendered 4% warm reads as 5.7%
/// chroma, and on the Sony fixture that put 81% of the frame's scene-greys outside the set - 1226 of
/// 6487, against the floor of 200 below which `grey_balance` does not run at all. The target stays
/// the camera's rendering of those pixels either way; only which pixels count is widened.
bool neutral(float3 v)
{
    let high = high_of(v);
    return high > pc.grey_floor && (high - low_of(v)) / high < pc.grey_chroma;
}

/// The half-open run of pixels one thread of the two passes below walks.
int2 span_of(uint b)
{
    let first = int(b) * pc.block;
    return int2(first, min(first + pc.block, pc.width * pc.height));
}

/// How many of a bit's pixels each block holds, counted before any of them is placed.
///
/// The bit is a parameter rather than a uniform so the two selections are two entry points over
/// one walk: a uniform would have to be rewritten between the dispatches, and two buffers holding
/// one differing word is more to keep in step than two names.
void count_of(uint3 id, uint bit)
{
    if (int(id.x) >= pc.blocks) { return; }
    let span = span_of(id.x);
    var found = 0u;
    for (int p = span.x; p < span.y; p++) {
        if ((bits[p] & bit) != 0) { found++; }
    }
    counts[id.x] = found;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_pairs_count(uint3 id: SV_DispatchThreadID) { count_of(id, COLOUR); }

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_frame_count(uint3 id: SV_DispatchThreadID) { count_of(id, FRAME); }

/// Where each block's run starts, which is what keeps the pair list in ascending pixel order.
///
/// An atomic append would be shorter and would put the pairs in whatever order the lanes landed;
/// everything downstream sums over them in index order, where float addition is not associative, so
/// two fits of one photograph would disagree.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_pairs_offsets()
{
    var seen = 0u;
    for (int b = 0; b < pc.blocks; b++) {
        let found = counts[b];
        counts[b] = seen;
        seen += found;
    }
    marks[TOTAL].store(seen);
}

/// Each selected pixel, the camera's colour there, and whether it is one of the greys.
void write_of(uint3 id, uint bit)
{
    if (int(id.x) >= pc.blocks) { return; }
    let span = span_of(id.x);
    var slot = counts[id.x];
    for (int p = span.x; p < span.y; p++) {
        if ((bits[p] & bit) == 0) { continue; }
        let t = jpeg_at(p);
        let out = slot * PAIR_WORDS;
        pairs[out] = uint(p);
        pairs[out + 1] = asuint(t.x);
        pairs[out + 2] = asuint(t.y);
        pairs[out + 3] = asuint(t.z);
        pairs[out + 4] = neutral(t) || neutral(render_at(p)) ? 1u : 0u;
        slot++;
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_pairs_write(uint3 id: SV_DispatchThreadID) { write_of(id, COLOUR); }

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_frame_write(uint3 id: SV_DispatchThreadID) { write_of(id, FRAME); }
