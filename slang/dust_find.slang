// Finding the particles, on the device the mosaic is already sitting on.
//
// **Nothing crosses to the host but the mask and the spots.** Everything up to the flood fill is
// elementwise or separable - the halving, the blurs, a morphological opening, a couple of folds and
// a threshold - and everything after it is a few hundred small independent fits, so the two things
// that go back are the thresholded prominence the fill needs and the ~20kB of spots the fits make.
// The frame stays where it was decoded.
//
// **Every working plane is half floats, two to a word.** `packHalf2x16` emits core WGSL, so this
// asks nothing of the adapter that `shader-f16` would - and the planes are the whole memory cost of
// a search, 150MB on a 61MP body at four bytes a sample. Two to a word is also half the traffic
// through passes that are almost all bandwidth.
//
// The precision that buys is 2^-11 relative, and the one plane where that is not obviously enough is
// the logged frame itself: a log radiance of -2.3 quantises at about 1e-3, against a visibility floor
// of 0.02. Hence `LOG_ANCHOR`. Nothing downstream reads a logged value except as a difference from
// another one, so the whole plane can be shifted to sit around zero where the mantissa is spent on
// the part that matters.
import lanes;
import px;

static const float PI = 3.14159265358979;
static const uint LANES = 64;

/// `dust::BINS` and `dust::SPAN`, held against them by
/// `the_shaders_declare_the_numbers_the_host_does`.
static const uint BINS = 14;
static const Extent<BlobRadius> SPAN = { 2.5 };
static const uint SPOT_WORDS = 8 + BINS;
/// A spot plus the flag saying whether the gates kept it.
static const uint OUT_WORDS = SPOT_WORDS + 1;

/// Where the logged planes are centred before they are stored, as a log radiance.
///
/// **Only so a half float's mantissa lands on the part of the number anything reads.** Every use of
/// these planes is a difference between two of them, so the shift cancels out of every answer - but
/// it moves the useful range, roughly a mid grey down to the darkest surround a spot may be claimed
/// against, from around -1.7 to around zero. Quantisation there is 5e-4 rather than 1e-3, against a
/// visibility floor of 0.02.
///
/// `log(0.18)`: the mid grey, which is what an exposure is metered to and so where a frame's samples
/// actually sit.
static const float LOG_ANCHOR = 1.7148;

/// The dimmest surround a particle may be claimed against, as a gamma-encoded level.
///
/// Dust nobody can see is dust nobody needs removed, and a dark surround is where the achromatic
/// argument is weakest anyway - black-level crush and noise masking both break it.
static const float MIN_SURROUND = 0.25;

/// The faintest dip worth removing, as a log-radiance drop.
///
/// **A visibility floor, not a confidence one.** Log radiance is roughly the perceptual unit, so
/// display contrast is about this over gamma and 0.02 lands near the 1% a smooth gradient makes just
/// noticeable. Without it the band-pass reports confident statistical detections nobody can see: the
/// fine blur averages some 45 photosites, cutting photon noise sevenfold, so a dip well under the
/// per-pixel noise is still a firm detection. On the frame this was built against, 21 of 35 "spots"
/// were below a third of a code value.
static const float MIN_DEPTH = 0.02;

/// The deepest log dip a spot may claim before it stops being a particle. `dust::MOST_DIP`.
///
/// **A discriminator, not a safety rail, and the only one that acts on magnitude.** A shadow is the
/// pupil convolved with something far smaller, so it is an attenuation of a few percent to about a
/// third. On the reference frame every candidate in the sky came back between 0.018 and 0.26, and the
/// ones at 0.46 to 1.09 were all rock - dark scene features that happen to be round and dust-sized.
/// Without this they are merely unlikely, and a reader who turns the sensitivity up to catch a faint
/// spot gets a patch of hillside brightened threefold.
static const float MOST_DIP = 0.35;

/// `dust::MOST_ELONGATION`, which is also what the host refuses a stored spot over.
static const float MOST_ELONGATION = 10.0;

struct Find {
    /// The working grid, in samples. Both are even, so a row is a whole number of packed words and no
    /// pass carries a parity case.
    uint hw;
    uint hh;
    /// The mosaic's own row stride, in photosites.
    uint stride;
    /// Where the picture starts inside the readable plane, in photosites.
    uint ox;
    uint oy;
    /// `2 * shrink`: photosites per working sample, per axis.
    uint step;
    uint shrink;
    /// The window for whichever separable pass is running.
    uint radius;
    /// `cfa[i]` is the colour of the i'th photosite of a 2x2, row-major.
    uint4 cfa;
    /// Squared, so the mask compares squares and no root is taken over the frame.
    float snr_squared;
    /// Which channel a fold is on: the first seeds the accumulators, the rest fold into them.
    uint channel;
    /// 0 erodes, 1 dilates.
    uint dilate;
    /// Blobs the fits were handed.
    uint count;
};

[vk::binding(0, 0)] ConstantBuffer<Find> find;

/// Packed words to a row, which is the stride every plane here is addressed by.
uint wide()
{
    return find.hw / 2;
}

uint words()
{
    return wide() * find.hh;
}

// ---------------------------------------------------------------- the halving

[vk::binding(1, 0)] StructuredBuffer<float> mosaic;
[vk::binding(2, 0)] RWStructuredBuffer<uint> red;
[vk::binding(3, 0)] RWStructuredBuffer<uint> green;
[vk::binding(4, 0)] RWStructuredBuffer<uint> blue;
[vk::binding(5, 0)] RWStructuredBuffer<uint> mean;
[vk::binding(6, 0)] RWStructuredBuffer<uint> surround;

/// The logged RGB of one working sample: the 2x2 CFA sites it covers, averaged in linear light.
///
/// Averaged in *linear* light and logged once, because a shadow multiplies radiance and the log of a
/// mean is not the mean of the logs.
///
/// No interpolation - four times less work, and a spot twenty photosites across loses nothing to it.
/// No white balance either: a constant per-channel gain cancels out of a log residual.
float3 logged_at(uint qx, uint qy)
{
    var sums = float3(0.0);
    var counts = float3(0.0);
    for (uint sy = 0; sy < find.shrink; sy += 1) {
        for (uint sx = 0; sx < find.shrink; sx += 1) {
            for (uint slot = 0; slot < 4; slot += 1) {
                let y = find.oy + qy * find.step + sy * 2 + (slot >> 1);
                let x = find.ox + qx * find.step + sx * 2 + (slot & 1);
                let level = max(mosaic[y * find.stride + x], 1e-4);
                let colour = find.cfa[slot];
                let which = float3(
                    float(colour == 0),
                    float(colour == 1 || colour == 3),
                    float(colour == 2));
                sums += which * level;
                counts += which;
            }
        }
    }
    let level = max(sums / max(counts, float3(1.0)), float3(1e-4));
    return float3(log(level.r), log(level.g), log(level.b));
}

/// One RGB sample per 2x2 CFA site, logged, with the achromatic mean and the surround level taken
/// while the three are still in registers rather than by two later sweeps of the frame.
///
/// A thread to a word, so it does this twice: the planes are packed in pairs and a thread that owned
/// one sample would own half a word.
[shader("compute")]
[numthreads(64, 1, 1)]
void quads(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let qy = at / wide();
    let qx = (at - qy * wide()) * 2;

    let left = logged_at(qx, qy);
    let right = logged_at(qx + 1, qy);
    red[at] = packHalf2x16(float2(left.r, right.r) + LOG_ANCHOR);
    green[at] = packHalf2x16(float2(left.g, right.g) + LOG_ANCHOR);
    blue[at] = packHalf2x16(float2(left.b, right.b) + LOG_ANCHOR);
    let achromatic = float2(left.r + left.g + left.b, right.r + right.g + right.b) / 3.0;
    mean[at] = packHalf2x16(achromatic + LOG_ANCHOR);
    // Gamma-encoded green, which is `exp(g / 2.2)` rather than `exp(g)` raised to a power. Unshifted:
    // it is a level between zero and one, where a half float's mantissa is already where it wants to be.
    surround[at] = packHalf2x16(exp(float2(left.g, right.g) / 2.2));
}

// ------------------------------------------------------- the separable passes

[vk::binding(10, 0)] StructuredBuffer<uint> src;
[vk::binding(11, 0)] RWStructuredBuffer<uint> dst;

/// Samples one thread of a box pass carries its running sum down.
static const uint SEGMENT = 256;

/// The box mean down a column's window, as a running sum: two reads a sample whatever the radius.
///
/// **Only down a column, and the frame is turned rather than blurred sideways.** A running sum is
/// sequential, so the lanes of a wave are on separate runs - and down the columns that means they sit
/// on consecutive samples of one row, and every step of every one of them is a contiguous read. Along
/// the rows the same arrangement puts each lane on a different row, which is a cache line fetched for
/// four bytes of it at every step: measured, 95ms a blur against 5, and eight blurs to a search. So
/// there is no row pass. [`turn_plane`] turns the frame between two runs of this one.
///
/// The sum itself is full precision; only what it writes is halved.
[shader("compute")]
[numthreads(64, 1, 1)]
void box_cols(uint3 id : SV_DispatchThreadID)
{
    let job = linear(id);
    let bands = (find.hh + SEGMENT - 1) / SEGMENT;
    if (job >= wide() * bands) { return; }
    let band = job / wide();
    let wx = job - band * wide();
    let first = band * SEGMENT;
    let last = min(first + SEGMENT, find.hh);

    let r = int(find.radius);
    let bottom = int(find.hh) - 1;
    var sum = float2(0.0);
    for (int i = int(first) - r; i <= int(first) + r; i += 1) {
        sum += unpackHalf2x16ToFloat(src[uint(clamp(i, 0, bottom)) * wide() + wx]);
    }
    let window = float(2 * find.radius + 1);
    for (uint y = first; y < last; y += 1) {
        dst[y * wide() + wx] = packHalf2x16(sum / window);
        sum += unpackHalf2x16ToFloat(src[uint(clamp(int(y) + r + 1, 0, bottom)) * wide() + wx])
             - unpackHalf2x16ToFloat(src[uint(clamp(int(y) - r, 0, bottom)) * wide() + wx]);
    }
}

/// The tile one workgroup turns, in samples. Its rows are held a sample apart in workgroup storage so
/// the transposed read walks banks rather than hammering one.
static const uint PATCH = 32;
groupshared float turning[PATCH * (PATCH + 1)];

/// The frame, turned, so the pass above can be the only box pass there is.
///
/// Coalesced at both ends, which is the whole reason it is a tile and not a copy: read row by row and
/// written row by row, with the turn happening in workgroup storage where a strided access costs
/// nothing. Reads a plane `hw` by `hh` and writes one `hh` by `hw`.
///
/// **The pairs are unpacked on the way in and repacked on the way out**, because a turned pair is two
/// samples of one column rather than of one row. Held as full floats in between, which is what the
/// odd stride is for.
[shader("compute")]
[numthreads(64, 1, 1)]
void transpose(uint3 group: SV_GroupID, uint lane: SV_GroupIndex)
{
    let across = (find.hw + PATCH - 1) / PATCH;
    let tile = group.x + group.y * ROW_GROUPS;
    let ty = tile / across;
    let tx = tile - ty * across;
    if (ty * PATCH >= find.hh) { return; }
    let x0 = tx * PATCH;
    let y0 = ty * PATCH;

    // Sixteen words to a tile row, so four rows of the tile at a time.
    let half = PATCH / 2;
    let col = lane & (half - 1);
    for (uint row = lane / half; row < PATCH; row += LANES / half) {
        var held = float2(0.0);
        let y = y0 + row;
        if (x0 + col * 2 < find.hw && y < find.hh) {
            held = unpackHalf2x16ToFloat(src[y * wide() + x0 / 2 + col]);
        }
        turning[row * (PATCH + 1) + col * 2] = held.x;
        turning[row * (PATCH + 1) + col * 2 + 1] = held.y;
    }
    GroupMemoryBarrierWithGroupSync();
    // The written plane is `hh` samples wide, so a word of it pairs two of this tile's rows.
    let out_wide = find.hh / 2;
    for (uint row = lane / half; row < PATCH; row += LANES / half) {
        let y = x0 + row;
        let x = y0 + col * 2;
        if (x < find.hh && y < find.hw) {
            dst[y * out_wide + x / 2] = packHalf2x16(float2(
                turning[col * 2 * (PATCH + 1) + row],
                turning[(col * 2 + 1) * (PATCH + 1) + row]));
        }
    }
}

float extreme(float a, float b)
{
    return select(find.dilate == 1, max(a, b), min(a, b));
}

float2 extremes(float2 a, float2 b)
{
    return select(find.dilate == 1, max(a, b), min(a, b));
}

/// One sample of a packed row, by its column.
float along_row(uint row, int x)
{
    let at = uint(clamp(x, 0, int(find.hw) - 1));
    return unpackHalf2x16ToFloat(src[row + at / 2])[at & 1];
}

/// The extreme over the window along a row, for the pair of samples one word holds.
///
/// Both windows out of one walk: they are the same span shifted by a sample, so the word read at each
/// step serves them both.
[shader("compute")]
[numthreads(64, 1, 1)]
void rank_rows(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let wy = at / wide();
    let row = wy * wide();
    let even = int((at - row) * 2);
    let r = int(find.radius);

    var best = float2(along_row(row, even), along_row(row, even + 1));
    for (int x = even - r; x <= even + 1 + r; x += 1) {
        let held = along_row(row, x);
        if (x <= even + r) {
            best.x = extreme(best.x, held);
        }
        if (x >= even + 1 - r) {
            best.y = extreme(best.y, held);
        }
    }
    dst[at] = packHalf2x16(best);
}

/// The same down a column, where a word's two samples share their window's rows.
[shader("compute")]
[numthreads(64, 1, 1)]
void rank_cols(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let y = int(at / wide());
    let wx = at - uint(y) * wide();
    let r = int(find.radius);
    let bottom = int(find.hh) - 1;

    var best = unpackHalf2x16ToFloat(src[uint(clamp(y - r, 0, bottom)) * wide() + wx]);
    for (int i = y - r + 1; i <= y + r; i += 1) {
        best = extremes(best, unpackHalf2x16ToFloat(src[uint(clamp(i, 0, bottom)) * wide() + wx]));
    }
    dst[at] = packHalf2x16(best);
}

// ------------------------------------------------------------------ the folds

[vk::binding(20, 0)] StructuredBuffer<uint> sharp;
[vk::binding(21, 0)] StructuredBuffer<uint> background;
[vk::binding(22, 0)] RWStructuredBuffer<uint> band_sum;
[vk::binding(23, 0)] RWStructuredBuffer<uint> band_low;
[vk::binding(24, 0)] RWStructuredBuffer<uint> band_high;

/// One channel's band-pass, folded into the running achromatic sum and the chroma extremes.
///
/// Band-pass rather than high-pass: a plain `log - blur` keeps every scene edge at full strength and
/// buries a blob several samples across in them, and the fine blur is what stops pixel-scale texture
/// and read noise doing the same.
[shader("compute")]
[numthreads(64, 1, 1)]
void fold(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let value = unpackHalf2x16ToFloat(sharp[at]) - unpackHalf2x16ToFloat(background[at]);
    if (find.channel == 0) {
        band_sum[at] = packHalf2x16(value);
        band_low[at] = packHalf2x16(value);
        band_high[at] = packHalf2x16(value);
    } else {
        band_sum[at] = packHalf2x16(unpackHalf2x16ToFloat(band_sum[at]) + value);
        band_low[at] = packHalf2x16(min(unpackHalf2x16ToFloat(band_low[at]), value));
        band_high[at] = packHalf2x16(max(unpackHalf2x16ToFloat(band_high[at]), value));
    }
}

[vk::binding(30, 0)] RWStructuredBuffer<uint> score;
[vk::binding(31, 0)] RWStructuredBuffer<uint> texture_rms;

/// The achromatic dip, penalised by whatever chroma it carries, and the squared mean beside it.
///
/// Squared because that is the only form anything downstream wants: it is blurred into the RMS the
/// local threshold reads, and a quantile of the squares is the square of the quantile.
[shader("compute")]
[numthreads(64, 1, 1)]
void judge(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let mid = unpackHalf2x16ToFloat(band_sum[at]) / 3.0;
    // A dip carrying chroma is a scene edge: occlusion takes every channel equally.
    let chroma = max(unpackHalf2x16ToFloat(band_high[at]) - mid, mid - unpackHalf2x16ToFloat(band_low[at]));
    score[at] = packHalf2x16(max(-mid - 2.0 * chroma, float2(0.0)));
    texture_rms[at] = packHalf2x16(mid * mid);
}

[vk::binding(40, 0)] StructuredBuffer<uint> opened;
[vk::binding(41, 0)] StructuredBuffer<uint> flat;
[vk::binding(42, 0)] RWStructuredBuffer<uint> prominence;

/// The white top-hat: what stands above its own opening. An opening with a disc larger than any dust
/// erases everything dust-sized, so the difference keeps only what is small *and* stands above its
/// surround - a lit rock face survives the opening intact and cancels to nothing.
[shader("compute")]
[numthreads(64, 1, 1)]
void tophat(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let stands = unpackHalf2x16ToFloat(flat[at]) - unpackHalf2x16ToFloat(opened[at]);
    prominence[at] = packHalf2x16(max(stands, float2(0.0)));
}

// ---------------------------------------------------- the floor, and the mask

[vk::binding(50, 0)] StructuredBuffer<uint> counted;
[vk::binding(51, 0)] RWStructuredBuffer<Atomic<uint>> histogram;

/// Bins by log, which is what a texture spanning decades wants, and turns a quantile over a frame
/// into one over 512 counts.
static const uint HIST_BINS = 512;
static const float HIST_FLOOR_LOG2 = -40.0;

/// The quantile the mask's floor sits at: the flattest tenth of the frame.
static const float FLOOR_QUANTILE = 0.1;

uint hist_bin(float value)
{
    let safe = clamp(value, 1e-12, 1.0);
    let along = (log2(safe) - HIST_FLOOR_LOG2) / -HIST_FLOOR_LOG2;
    return uint(clamp(along * float(HIST_BINS), 0.0, float(HIST_BINS - 1)));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void spread(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let held = unpackHalf2x16ToFloat(counted[at]);
    histogram[hist_bin(held.x)].add(1);
    histogram[hist_bin(held.y)].add(1);
}

[vk::binding(52, 0)] RWStructuredBuffer<uint> counts;

/// Where the counts run past a tenth of the frame, as a level, written back over the last bin.
///
/// **One lane, so that the host never has to see the histogram.** Reading 512 counts back to divide
/// them is a submit, a drain and a map for two kilobytes - and everything after it in the sweep waits
/// on that round trip, which is most of a millisecond on a frame that takes 150. `threshold` reads
/// the answer out of the buffer instead, and the whole sweep is one submit.
///
/// Over the last bin, which is safe for a reason that has nothing to do with which bin wins: one
/// lane runs both loops to completion before it writes, so there is no read of that count left to
/// clobber. A frame saturated everywhere would select it legitimately, and still be answered right.
[shader("compute")]
[numthreads(1, 1, 1)]
void quantile()
{
    var total = 0u;
    for (uint bin = 0; bin < HIST_BINS; bin += 1) {
        total += counts[bin];
    }
    let wanted = uint(float(total) * FLOOR_QUANTILE);

    var seen = 0u;
    var at = HIST_BINS - 1;
    for (uint bin = 0; bin < HIST_BINS; bin += 1) {
        seen += counts[bin];
        if (seen >= wanted) {
            at = bin;
            break;
        }
    }
    let along = (float(at) + 0.5) / float(HIST_BINS);
    // Floored, or a perfectly flat patch divides by its own absence of noise and detects grain.
    let level = max(exp2(HIST_FLOOR_LOG2 - along * HIST_FLOOR_LOG2), 1e-10);
    counts[HIST_BINS - 1] = asuint(level);
}

[vk::binding(60, 0)] StructuredBuffer<uint> against;
[vk::binding(61, 0)] StructuredBuffer<uint> local_noise;
[vk::binding(62, 0)] RWStructuredBuffer<uint> masked;
[vk::binding(63, 0)] StructuredBuffer<uint> floor_of;

/// The prominence where a dip stands far enough above its own neighbourhood's noise, and zero
/// everywhere else.
///
/// **The mask and the heights in one plane, because the fill wants both and neither alone.** The
/// threshold's first term is `prominence > 0`, so a masked sample is exactly a positive one here -
/// which makes this a mask the host can read without a second buffer crossing the bus for it. Half
/// floats order the same way their bit patterns do while they are not negative, so the host does not
/// even have to decode it to walk it.
///
/// Per sample against the local noise, never one figure for the frame: a frame-wide threshold is set
/// by its busiest region and lands above every real particle in the smooth part, so the sky reports
/// nothing while the rock reports hundreds.
[shader("compute")]
[numthreads(64, 1, 1)]
void threshold(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= words()) { return; }
    let value = unpackHalf2x16ToFloat(against[at]);
    let level = asfloat(floor_of[HIST_BINS - 1]);
    let noise = max(unpackHalf2x16ToFloat(local_noise[at]), float2(level));
    let keep = (value > float2(0.0)) & (value * value > find.snr_squared * noise);
    masked[at] = packHalf2x16(select(keep, value, float2(0.0)));
}

// ------------------------------------------------------------------ the fits

[vk::binding(70, 0)] StructuredBuffer<float> blobs;
[vk::binding(71, 0)] StructuredBuffer<uint> log_mean;
[vk::binding(72, 0)] StructuredBuffer<uint> busy;
[vk::binding(73, 0)] StructuredBuffer<uint> lit;
[vk::binding(74, 0)] RWStructuredBuffer<float> spots;

groupshared float partial[LANES];
groupshared float bin_dip[BINS * LANES];
groupshared float bin_count[BINS * LANES];
groupshared float shared_level;
groupshared float shared_snr;
groupshared float shared_gates;
groupshared float2 shared_axes;
groupshared float2 shared_turn;

static const uint OF_LOG_MEAN = 0;
static const uint OF_BUSY = 1;
static const uint OF_LIT = 2;

float field_at(uint which, uint x, uint y)
{
    let at = y * wide() + x / 2;
    let half = x & 1;
    if (which == OF_LOG_MEAN) { return unpackHalf2x16ToFloat(log_mean[at])[half]; }
    if (which == OF_BUSY) { return unpackHalf2x16ToFloat(busy[at])[half]; }
    return unpackHalf2x16ToFloat(lit[at])[half];
}

/// Median over a ring clear of the blob, so a particle does not measure its own surround and one ray
/// landing on an edge cannot carry the answer.
///
/// **Outside the footprint, not outside the bounding box.** The correction reaches `SPAN` blob radii
/// and the profile is still a tenth of its peak at two, so a ring taken from the thresholded extent
/// falls inside the skirt as soon as the blob is large - and the level then comes back darkened,
/// every bin under-reports, and the deepest particles are the ones most likely to be dropped for
/// being too faint.
float ring(uint which, float cx, float cy, float scale)
{
    float taken[12];
    let radius = SPAN.d * scale + 3.0;
    for (uint step = 0; step < 12; step += 1) {
        let angle = 2.0 * PI * float(step) / 12.0;
        let x = uint(clamp(cx + radius * cos(angle), 0.0, float(find.hw) - 1.0));
        let y = uint(clamp(cy + radius * sin(angle), 0.0, float(find.hh) - 1.0));
        taken[step] = field_at(which, x, y);
    }
    for (uint i = 1; i < 12; i += 1) {
        let value = taken[i];
        var j = int(i) - 1;
        while (j >= 0 && taken[uint(j)] > value) {
            taken[uint(j) + 1] = taken[uint(j)];
            j -= 1;
        }
        taken[uint(j + 1)] = value;
    }
    return taken[6];
}

float fold_lanes(uint lane, float value)
{
    partial[lane] = value;
    GroupMemoryBarrierWithGroupSync();
    if (lane == 0) {
        var total = 0.0;
        for (uint i = 0; i < LANES; i += 1) {
            total += partial[i];
        }
        partial[0] = total;
    }
    GroupMemoryBarrierWithGroupSync();
    let total = partial[0];
    GroupMemoryBarrierWithGroupSync();
    return total;
}

float dip_at(float level, int cx, int cy, int dx, int dy)
{
    let x = cx + dx;
    let y = cy + dy;
    if (x < 0 || y < 0 || x >= int(find.hw) || y >= int(find.hh)) {
        return 0.0;
    }
    return max(level - field_at(OF_LOG_MEAN, uint(x), uint(y)), 0.0);
}

/// The ellipse one blob's attenuation makes, its profile in that frame, and whether the gates keep
/// it. One workgroup a blob.
///
/// **Moments of the dip, not of the thresholded mask.** The mask is a contour of the thing being
/// measured, so its shape moves with the threshold; weighting by the attenuation itself does not.
/// Taken over the core only, because out in the skirt the dip is the size of the noise and clamping
/// that at zero feeds in a bias that is isotropic by construction and would argue every spot round.
///
/// A blob the gates have already lost is fitted anyway rather than returned from, because every
/// reduction below is a workgroup barrier and a barrier has to be reached by all 64 lanes. The host
/// caps what it uploads, so the waste is bounded and small; a divergent exit is a hung dispatch.
[shader("compute")]
[numthreads(64, 1, 1)]
void fits(uint3 group: SV_GroupID, uint lane: SV_GroupIndex)
{
    let blob = group.x;
    if (blob >= find.count) { return; }
    let base = blob * 4;
    let cx = int(blobs[base + 0]);
    let cy = int(blobs[base + 1]);
    let area = blobs[base + 2];
    let peak = blobs[base + 3];
    let out_at = blob * OUT_WORDS;
    let scale = sqrt(area / PI);

    if (lane == 0) {
        // Rooted here, where twelve samples want it, rather than over the whole frame.
        let noise = sqrt(max(ring(OF_BUSY, float(cx), float(cy), scale), 0.0));
        shared_snr = peak / max(noise, 1e-6);
        shared_level = ring(OF_LOG_MEAN, float(cx), float(cy), scale);
        let bright = ring(OF_LIT, float(cx), float(cy), scale);
        // Against the same bar the mask was grown at, squared as the mask compares it.
        let sure = shared_snr * shared_snr >= find.snr_squared;
        shared_gates = float(sure && bright >= MIN_SURROUND);
    }
    GroupMemoryBarrierWithGroupSync();
    let level = shared_level;

    let near = int(1.5 * scale);
    var weight = 0.0;
    var sx = 0.0;
    var sy = 0.0;
    for (int dy = -near + int(lane); dy <= near; dy += int(LANES)) {
        for (int dx = -near; dx <= near; dx += 1) {
            let dip = dip_at(level, cx, cy, dx, dy);
            weight += dip;
            sx += dip * float(dx);
            sy += dip * float(dy);
        }
    }
    let norm = max(fold_lanes(lane, weight), 1e-9);
    let mx = fold_lanes(lane, sx) / norm;
    let my = fold_lanes(lane, sy) / norm;

    var mxx = 0.0;
    var myy = 0.0;
    var mxy = 0.0;
    for (int dy = -near + int(lane); dy <= near; dy += int(LANES)) {
        for (int dx = -near; dx <= near; dx += 1) {
            let dip = dip_at(level, cx, cy, dx, dy);
            let u = float(dx) - mx;
            let v = float(dy) - my;
            mxx += dip * u * u;
            myy += dip * v * v;
            mxy += dip * u * v;
        }
    }
    let cxx = fold_lanes(lane, mxx) / norm;
    let cyy = fold_lanes(lane, myy) / norm;
    let cxy = fold_lanes(lane, mxy) / norm;

    if (lane == 0) {
        let mid = (cxx + cyy) / 2.0;
        let half = (cxx - cyy) / 2.0;
        let spread_of = sqrt(half * half + cxy * cxy);
        let theta = 0.5 * atan2(2.0 * cxy, cxx - cyy);
        let major = sqrt(max(mid + spread_of, 1e-9));
        let minor = sqrt(max(mid - spread_of, 1e-9));
        // **Bounded, because a near-singular moment matrix is not a very thin particle.** A blob whose
        // dip is positive on one row only comes back at 150:1, which is a `reach` two orders past the
        // blob - an 800k-iteration profile loop for one candidate, and a prune that then deletes every
        // real spot for a hundred samples around it.
        let stretch = min(major / sqrt(major * minor), MOST_ELONGATION);
        shared_axes = float2(stretch, 1.0 / stretch);
        shared_turn = float2(cos(theta), sin(theta));
    }
    GroupMemoryBarrierWithGroupSync();
    let axes = shared_axes;
    let turn = shared_turn;

    for (uint bin = 0; bin < BINS; bin += 1) {
        bin_dip[bin * LANES + lane] = 0.0;
        bin_count[bin * LANES + lane] = 0.0;
    }
    let reach = int(SPAN.d * scale * axes.x * 1.2);
    for (int dy = -reach + int(lane); dy <= reach; dy += int(LANES)) {
        for (int dx = -reach; dx <= reach; dx += 1) {
            let x = cx + dx;
            let y = cy + dy;
            if (x < 0 || y < 0 || x >= int(find.hw) || y >= int(find.hh)) { continue; }
            let px = float(dx) - mx;
            let py = float(dy) - my;
            let u = px * turn.x + py * turn.y;
            let v = -px * turn.y + py * turn.x;
            let along_major = u / axes.x;
            let along_minor = v / axes.y;
            let elliptical =
                sqrt(along_major * along_major + along_minor * along_minor) / scale;
            let along = elliptical / SPAN.d * float(BINS);
            if (along < 0.0 || along >= float(BINS)) { continue; }
            let bin = uint(along);
            bin_dip[bin * LANES + lane] += level - field_at(OF_LOG_MEAN, uint(x), uint(y));
            bin_count[bin * LANES + lane] += 1.0;
        }
    }
    GroupMemoryBarrierWithGroupSync();

    // **Judged on the profile that will actually be divided out.** A mean over the thresholded blob
    // would be a proxy for it, and a worse one - it reads whatever the mask happened to enclose, so a
    // fit whose centre drifted off the dip still passes and is stored as a spot that corrects nothing.
    if (lane < BINS) {
        var dip = 0.0;
        var count = 0.0;
        for (uint i = 0; i < LANES; i += 1) {
            dip += bin_dip[lane * LANES + i];
            count += bin_count[lane * LANES + i];
        }
        let value = max(dip / max(count, 1.0), 0.0);
        spots[out_at + 8 + lane] = value;
        // Every bin against the ceiling, not just the plateau, because that is where the host checks a
        // spot on the way back in - and a writer looser than its own reader emits spots it will refuse.
        partial[lane] = float(value <= MOST_DIP);
    }
    GroupMemoryBarrierWithGroupSync();

    if (lane == 0) {
        var sound = shared_gates > 0.5 && spots[out_at + 8] >= MIN_DEPTH;
        for (uint bin = 0; bin < BINS; bin += 1) {
            sound = sound && partial[bin] > 0.5;
        }
        // **Back into the whole sensor's quad coordinates**, which is the space a stored spot is in and
        // the one `dust.slang` reads. The half-sample is not a rounding nicety: a working sample is
        // the mean of the `step` photosites it covers, so it stands at their centroid, while the kernel
        // reads a quad `q` as photosite `2q`. Without the shift every correction lands up-and-left of
        // the particle it was measured from.
        let along = float(2 * find.shrink - 1) / 4.0;
        spots[out_at + 0] = (float(cx) + mx) * float(find.shrink) + along + float(find.ox) / 2.0;
        spots[out_at + 1] = (float(cy) + my) * float(find.shrink) + along + float(find.oy) / 2.0;
        spots[out_at + 2] = scale * float(find.shrink);
        spots[out_at + 3] = axes.x;
        spots[out_at + 4] = axes.y;
        spots[out_at + 5] = turn.x;
        spots[out_at + 6] = turn.y;
        spots[out_at + 7] = shared_snr;
        spots[out_at + SPOT_WORDS] = float(sound);
    }
}
