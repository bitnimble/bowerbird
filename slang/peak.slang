// The scene's own top end, as a histogram and a scan. **The only implementation of it.**
//
// The CPU took a quantile of a million sampled pixels by partial sort, through its own copy
// of the colour transform; that copy is gone and both hosts run this. A shader cannot sort a
// million values cheaply, so this bins them and reads the quantile off the cumulative count,
// which is the same statistic at the bin's resolution. No readback on the editor's path: the
// scan writes the peak into a buffer the draw reads next.
//
// Per tick rather than at open because it is not a property of the sensor: it measures
// *after* the colour transform and after the exposure, which `matched_nits` reads off the slider. Move
// it to the open and raising exposure pushes highlights past a knee placed for a frame
// that was never exposed, which is a clip. Everything upstream of the slider - `white`,
// `source_level`, the curves, the chroma map - is at the open already.
//
// Whole frame, always, and this is load-bearing rather than incidental. It is the one
// measurement that must not follow the display: sample the visible crop instead and the
// highlight roll-off shifts as the reader pans from a dark region to a bright one, which
// is the most visible failure this pipeline could have. Same reason the stride is fixed
// and unjittered - the sample set has to be the same pixels every tick, or the knee
// shimmers between frames. Its cost does not scale with the frame either, since the count
// is fixed.
import prelude;
import edit;
import colour;
import light;

[vk::binding(5, 0)] public RWStructuredBuffer<Atomic<uint> > histogram;
[vk::binding(6, 0)] public RWStructuredBuffer<float> peak_out;
// [0] counts what cleared the threshold - which may be more than were kept - and the
// levels follow from 4, four to a candidate.
[vk::binding(8, 0)] RWStructuredBuffer<Atomic<uint> > candidates;

// The host needs the same two numbers to size the buffers, and
// `the_shader_sizes_match_the_buffers_allocated_for_them` holds `gpu.rs` to these.
//
// Folded rather than specialised, and load-bearing: WebKit refuses a pipeline handed a constant
// its entry point does not statically reference, and of the four here `measure` never reads
// CANDIDATES while `collect` never reads BINS. Passing both to all four was every RAW refusing
// to open on Safari with "Compute library failed creation" and nothing else said. Only a value
// that genuinely differs between pipelines built from one entry point may be a specialisation
// constant - `FROM_FRAME` in `frame` is the one - since that is the only kind an entry point
// cannot stop using.
static const uint BINS = 8192;
static const uint CANDIDATES = 16384;

// The histogram is logarithmic, in stops either side of reference white.
//
// Linear bins cannot hold this, and both ways of sizing them are wrong. Fixed at a few
// times diffuse white, they saturate: `measured` is taken *after* the exposure, so the
// slider carries it up with the gain, and a couple of stops up every real highlight lands
// in the last bin - the quantile reads the peak as the top of the range whatever the frame
// holds, and the highlights hard-clip.
//
// Growing the top with the gain instead is worse, because `measured` does not grow with the
// gain: the tone curve compresses highlights, so it rises more slowly, and a range that
// rose linearly left the candidates collapsing towards the first bin. There the quantile
// reads a peak of nearly nothing, the roll-off clamps the whole frame to it, and the
// picture goes dark and flat - at particular slider positions, on the photographs whose
// curves compress hardest.
//
// In stops both problems disappear, because relative resolution is what a peak needs: 8192
// bins over 28 stops is 0.0034 of a stop each, and the range covers anything a sensor and a
// slider can produce between them.
static const float LOG_LOW = -14.0;
static const float LOG_HIGH = 14.0;
static const float LOG_SPAN = LOG_HIGH - LOG_LOW;

/// Which bin a value in units of reference white falls in.
///
/// Takes a bare `float` rather than the `Light<Rendered>` every caller holds: `probe_bins` calls
/// it under a loop, where `no_struct_returns_under_a_loop` forbids constructing one. So the `.v`
/// is taken at the call.
///
/// Nothing reaches the `u32` conversion that it is not defined on, and that is the whole
/// point of the shape below. WGSL leaves `u32(x)` undefined for a NaN and for anything past
/// the range, so a pixel the colour transform returned as a NaN - or as an infinity - binned
/// wherever the driver happened to put it, which is *not the same place on two hosts*. This
/// is the one measurement a rendition and the editor have to agree on to the bin, and it
/// feeds a value every pixel in the frame is then clamped to.
public uint bin_of(float v)
{
    // Below the range is the bottom bin rather than an error: a black pixel is a real sample
    // and `log2(0)` is not a number to clamp. Written as "not above zero" so it catches a NaN
    // too, which no comparison against one does.
    if (!(v > 0.0)) { return 0; }
    let t = clamp((log2(v) - LOG_LOW) / LOG_SPAN, 0.0, 1.0);
    return min(uint(t * float(BINS)), BINS - 1);
}

/// The value at a bin's own centre, in units of reference white.
float bin_centre(uint bin)
{
    return exp2(LOG_LOW + ((float(bin) + 0.5) / float(BINS)) * LOG_SPAN);
}

/// And at its lower edge, which is the form a threshold wants.
float bin_floor(uint bin)
{
    return exp2(LOG_LOW + (float(bin) / float(BINS)) * LOG_SPAN);
}

/// `tone::PEAK_QUANTILE`.
static const float QUANTILE = 0.9999;

/// What the quantile is taken of: the post-colour peak channel, in units of reference.
///
/// `Rendered`, because dividing the display's nits by the reference is what takes them back into
/// the camera's own rendering - the domain the histogram's stops are measured in and the one
/// `peak_out[1]` is a threshold in. `bin_value` multiplies it back.
Light<Rendered> peak_channel(Colour<SceneNits> nits, float2 at)
{
    let coloured = matched_nits(nits, at).v / edit.reference;
    return measured<Rendered>(max(coloured.r, max(coloured.g, coloured.b)));
}

/// A pixel's own place in the frame, in its pixels, which the presence sliders read the blur at.
float2 at_of(uint x, uint y)
{
    return float2(float(x), float(y)) + float2(0.5);
}

void count_in(Light<Rendered> v)
{
    histogram[bin_of(v.v)].add(1);
}

/// The sampled row of the frame this invocation covers, or nothing.
uint2 sampled(uint3 id)
{
    let y = id.y * edit.row_stride;
    if (id.x >= edit.width || y >= edit.height) { return uint2(0, 0xffffffff); }
    return uint2(id.x, y);
}

/// About a million pixels, as whole rows. Runs at the open, not per edit.
///
/// Three shapes, and the reasoning matters more than the code. Reading every pixel was
/// first, on the grounds that a shader has no reason to subsample - but this pass runs the
/// same colour transform the grade does, so at full frame it costs what the grade costs.
/// Measured at 12.5ms against the grade's 12.8, and the atomics are not what dominates it.
/// The levels never read every pixel either: `tone::QUANTILE_SAMPLES` caps them at a million.
///
/// Copying the levels' stride exactly was second, and it barely helped: `k * pixels /
/// counted` scatters consecutive lanes about ten pixels apart, so every one of them takes
/// its own cache line and the pass is back to fetching the whole frame to read a tenth of
/// it. Whole rows, every nth, samples just as evenly - the count is what the quantile cares
/// about, and `tone::QUANTILE_SAMPLES` says so - while consecutive lanes stay adjacent.
[shader("compute")]
[numthreads(64, 1, 1)]
void measure(uint3 id : SV_DispatchThreadID)
{
    let at = sampled(id);
    if (at.y == 0xffffffff) { return; }
    count_in(peak_channel(measured<SceneNits>(nits_at(at.x, at.y)), at_of(at.x, at.y)));
}

/// The brightest of those million, kept so the tick does not have to find them again.
///
/// Runs once, after a full `measure` and the `quantile` that turns it into a threshold.
/// The camera inverse, exposure gain, and reader curve preserve luma rank. Tone sliders and
/// differing colour ratios can still reorder channel maxima, so retained pixels are regraded
/// at each tick and the candidate-parity test holds them against the whole sample.
///
/// The presence sliders are the one gain that is *not* smooth in the pixel's own value - a
/// clarity lift is worth more at an edge than a stop away from one - so a frame graded with
/// them measures its peak off pixels chosen without them. What that costs is a knee placed
/// against a slightly different set of highlights, which moves the roll-off rather than
/// clipping anything: `display_nits` clamps whatever the curve leaves above the display.
[shader("compute")]
[numthreads(64, 1, 1)]
void collect(uint3 id : SV_DispatchThreadID)
{
    let at = sampled(id);
    if (at.y == 0xffffffff) { return; }
    // The codes rather than the nits, because that is what a candidate is kept as: `remeasure`
    // decodes them again at the tick's own exposure.
    let level = level_at(at.x, at.y);
    let here = peak_channel(measured<SceneNits>(nits_of(level)), at_of(at.x, at.y));
    if (here.v < peak_out[1]) { return; }

    // Counted past the cap rather than clamped, so the caller can tell that more qualified
    // than were kept and stop reading them. A blown sky puts far more than `CANDIDATES` in one
    // bin; what is kept then is the top of the frame, since these arrive in dispatch order.
    let slot = candidates[0].add(1);
    if (slot >= CANDIDATES) { return; }
    let base = 4 + slot * 4;
    candidates[base].store(uint(level.r));
    candidates[base + 1].store(uint(level.g));
    candidates[base + 2].store(uint(level.b));
    // The fourth word was padding, keeping the stride a power of two. It carries the raster
    // index now, because `remeasure` grades these pixels again and the presence sliders need
    // to know where each one was - a candidate with no position would be graded against the
    // blur at the frame's top-left corner, so a strong clarity would move the roll-off knee
    // by however hazy that corner happened to be.
    candidates[base + 3].store(at.y * edit.width + at.x);
}

/// The tick's whole measurement: the kept candidates, at this exposure.
[shader("compute")]
[numthreads(64, 1, 1)]
void remeasure(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= min(candidates[0].load(), CANDIDATES)) { return; }
    let base = 4 + id.x * 4;
    let pixel = candidates[base + 3].load();
    count_in(peak_channel(
        measured<SceneNits>(nits_of(float3(
            float(candidates[base].load()),
            float(candidates[base + 1].load()),
            float(candidates[base + 2].load())))),
        at_of(pixel % edit.width, pixel / edit.width)));
}

/// The quantile off the cumulative count, searched from the bright end.
///
/// From the top rather than the bottom because that is the end the answer is at, and
/// because it is the only form that reads the same whether the histogram holds the whole
/// sample or only its brightest: rank 100-from-the-top is rank 100-from-the-top either
/// way, where rank 999,900-from-the-bottom is not.
///
/// **One lane, and no workgroup memory.** This summed the bins in parallel first - a lane per
/// 32-bin chunk, then a search across the 256 partials and within the chosen chunk - which is
/// 288 steps rather than the 8192 below. It also did not work: on one reader's GPU the
/// partials read back as values no lane had written this dispatch, summing to 2.6x the counts
/// actually in the histogram, so the chunk picked held nothing near the rank and the search
/// inside it fell through to bin zero. That is a peak of one nit, which `rolled_off` clamps
/// the whole frame to - a black picture, on about half the positions of the exposure slider.
/// The barrier is legal and the driver is wrong, but a grade that depends on a barrier
/// holding is not worth a fraction of a millisecond. Searching from the top breaks at the
/// answer rather than walking every bin, so what it costs is the empty bins above the
/// highlights.
Light<DisplayNits> bin_value(uint bin)
{
    return measured<DisplayNits>(bin_centre(bin) * edit.reference);
}

[shader("compute")]
[numthreads(1, 1, 1)]
void quantile()
{
    // How far down from the brightest the answer sits, over the sample the CPU would have
    // taken. The same rank whether the histogram holds the whole sample or only the candidates,
    // because the candidates are read only when they are every pixel that cleared the
    // threshold - the caller checks the count and reads the frame instead when they are not.
    //
    // There was a rescale here, by the share of qualifying pixels kept. It read that share as a
    // fair sample and it is not one: `collect` keeps whichever arrive first, in dispatch order,
    // so an overflow keeps the top rows of the frame rather than a spread of it - and the peak
    // it measures is that region's rather than the picture's.
    let want = uint(max(1.0, (1.0 - QUANTILE) * float(edit.peak_samples)));

    // The brightest bin holding anything, kept as the search passes it, for a histogram with
    // fewer samples in it than the rank - which the candidates can be, since they are counted
    // against `peak_samples` and hold only the brightest of them. No quantile is defined over a
    // sample that short and the brightest of it is, so that is what an exhausted search answers.
    // **This is the difference between a photograph and a black rectangle**: falling through to
    // bin zero instead is a peak of one nit, and every pixel in the frame clamped to it.
    var seen = 0u;
    var found = 0u;
    var highest = 0u;
    var occupied = false;
    for (uint b = BINS; b > 0; b = b - 1) {
        let count = histogram[b - 1].load();
        if (count > 0 && !occupied) {
            highest = b - 1;
            occupied = true;
        }
        seen = seen + count;
        if (seen >= want) {
            found = b - 1;
            break;
        }
    }
    if (seen < want) { found = highest; }

    // The bin's centre, and never zero: a scene peak of zero would put the roll-off in a
    // division by it, which is the same guard `scene_peak_nits` applies by returning None.
    peak_out[0] = max(bin_value(found).v, 1.0);

    // And the threshold `collect` keeps a pixel above, which is the same search at a much
    // shallower rank. Only on the open's run: it walks every bin rather than stopping near
    // the top, which measured at 0.7ms - most of what the tick's peak now costs at all.
    //
    // Asked as "has anything been collected yet", which is what the open's run actually is:
    // `collect` runs after this and in the same submit, so the count is zero here and only
    // here. Asking instead whether the tick is reading the candidates means the same thing
    // only until a tick stops reading them - a frame whose candidates overflowed falls back to
    // reading the whole frame, and every one of those ticks then re-walks all 8192 bins for a
    // threshold nothing would read again.
    if (candidates[0].load() != 0) { return; }
    seen = 0u;
    var edge = 0u;
    for (uint b = BINS; b > 0; b = b - 1) {
        seen = seen + histogram[b - 1].load();
        if (seen >= CANDIDATES / 2) { edge = b - 1; break; }
    }
    // The bin's lower edge, and in `Rendered` rather than in nits: `collect` compares against
    // this before the reference has been multiplied back in.
    peak_out[1] = bin_floor(edge);
}
