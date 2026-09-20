// The geometry search's objective, over the grids where the warp left them.
//
// A candidate is a warp and then this: gate every pixel of the grid into a pair, bin the camera's
// luma by the render's level, and score the held-out half against the curve the other half fitted.
// `fit::pairs` walked 273k pixels on the host for each of tens of candidates, and every one of
// those candidates came back off the device as an 8-bit plane first.
//
// **Every sum here is an integer**, which is what lets the folds be plain atomics: a level is a
// `u8`, a target is a `u8`, and a residual is the difference of two of them. Two runs agree to the
// bit whatever order the lanes landed in - the ordered-partial machinery `fit_score` needs for its
// f64 sums buys nothing here. `stacks.slang` records the same trade.
//
// The curve between the two folds stays on the host: 256 bins of gap-filling, extension and a
// monotone pass, which is arithmetic over a curve rather than over a picture.
import prelude;

struct Params {
    int width;
    int height;
    /// Pixels one thread of the gate walks, and how many such blocks a candidate holds.
    int block;
    int blocks;
    /// Candidates in this batch, each with a warped plane and a slot of its own throughout.
    int candidates;
    /// `fit::MAX_PAIR_GRADIENT`, summed over the camera's red across a pixel each way. Red rather
    /// than luma because it is what the host gated on, and a gate is not a measurement.
    int max_gradient;
    /// Whether `gain` carries a falloff's level table, or a pair's level is its own luma.
    int gained;
    /// Which half `fit_obj_curve` draws from, and which `fit_obj_score` then reads.
    int fitted;
    int held;
    /// `fit::MIN_BIN_SAMPLES`: below this a bin states a ratio rather than a measurement.
    int min_bin;
    /// Pairs the gate admitted, which is what `fit_obj_falloff` walks. The records past it belong
    /// to no candidate.
    int admitted;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Every candidate's warped grid, interleaved f32 RGB in 0..1, one plane after another.
[vk::binding(0, 0)] StructuredBuffer<float> warped;
/// The camera's grid, the same shape, shared by every candidate.
[vk::binding(1, 0)] StructuredBuffer<float> jpeg;
/// `fit::Gain`'s 256x256 level table, four levels to a word.
[vk::binding(2, 0)] StructuredBuffer<uint> gain;
/// Pairs per block, then where each block's run starts, per candidate.
[vk::binding(3, 0)] RWStructuredBuffer<uint> counts;
/// Each pair, in row-major order, per candidate: two words holding ours, the camera's, and the
/// radius the falloff is indexed by. `refit_gain` is the one reader that wants them on the host,
/// and it sums real f64 out of the sRGB transfer, which is not something a fold of integers does.
[vk::binding(4, 0)] RWStructuredBuffer<uint> records;
/// Per candidate and phase: the camera's luma summed per level, and how many landed there.
[vk::binding(5, 0)] RWStructuredBuffer<Atomic<uint> > bins;
/// Each candidate's fitted curve, 256 levels, one to a word so `fit_obj_curve` can write it.
[vk::binding(6, 0)] RWStructuredBuffer<uint> curves;
/// Per candidate: the residual summed over the held-out pairs, how many there were, and how many
/// pairs the gate admitted in total. Three words rather than two so that one twelve-byte readback
/// answers everything a candidate is asked - `MIN_PAIRS` included - and the objective is one submit.
[vk::binding(7, 0)] RWStructuredBuffer<Atomic<uint> > score;
/// `fit::invert_curve`'s answer for the round's own curve, 256 levels, then `fit::linear_table`'s
/// 256 - the sRGB transfer undone, which is the light a ratio of levels has to be taken in.
[vk::binding(8, 0)] StructuredBuffer<float> falloff_tables;
/// Per block, `FALLOFF_BINS` triples: the light the camera wants, the light we have, and the pairs
/// that carried them.
[vk::binding(9, 0)] RWStructuredBuffer<float> falloff_bins;

/// Words a candidate's answer occupies.
static const int SCORE_WORDS = 3;

/// `fit::refit_gain`'s radius bins, and the three sums each carries.
static const int FALLOFF_BINS = 12;
static const int FALLOFF_WORDS = 3;
/// Where `falloff_tables` stops being the inverted curve and starts being the linear table.
static const int LINEAR_FROM = 256;

// `prelude::LUMA709`, which is where the triple is written down; see the pair's note there.

/// Levels a curve is fitted over, and the two halves a pair list is split into.
static const int LEVELS = 256;
static const int PHASES = 2;

/// A candidate's own stretch of each buffer.
int pixels() { return pc.width * pc.height; }
int bins_per_candidate() { return PHASES * LEVELS * 2; }

/// The 8-bit level a float plane's sample carries, as `fit::read_rgb` rounds it.
int level_of(StructuredBuffer<float> plane, int base, int i)
{
    return int(clamp(round(plane[base + i] * 255.0), 0.0, 255.0));
}

int3 rgb_of(StructuredBuffer<float> plane, int base, int p)
{
    return int3(
        level_of(plane, base, p * 3),
        level_of(plane, base, p * 3 + 1),
        level_of(plane, base, p * 3 + 2));
}

/// The display-referred luma of a triple, in the same 8-bit levels the pair holds.
int luma8(int3 v)
{
    return int(round(dot(LUMA709, float3(v))));
}

int byte_of(StructuredBuffer<uint> packed, int index)
{
    return int((packed[index >> 2] >> uint(8 * (index & 3))) & 0xffu);
}

/// The level this pair is binned at: its own luma, or what the falloff makes of it at its radius.
int levelled(int radius, int luma)
{
    return pc.gained != 0 ? byte_of(gain, radius * LEVELS + luma) : luma;
}

/// Whether this pixel is a pair, and the two triples if it is.
bool paired(int candidate, int x, int y, out int3 ours, out int3 theirs)
{
    ours = int3(0);
    theirs = int3(0);
    if (x < 1 || y < 1 || x + 1 >= pc.width || y + 1 >= pc.height) { return false; }
    let p = y * pc.width + x;
    let base = candidate * pixels() * 3;
    theirs = rgb_of(jpeg, 0, p);
    // Clipped samples carry no mapping: everything above the knee landed on the same value, so
    // they would drag the top of the curve down.
    if (min(theirs.x, min(theirs.y, theirs.z)) <= 2) { return false; }
    if (max(theirs.x, max(theirs.y, theirs.z)) >= 253) { return false; }
    ours = rgb_of(warped, base, p);
    if (min(ours.x, min(ours.y, ours.z)) <= 1) { return false; }
    if (max(ours.x, max(ours.y, ours.z)) >= 254) { return false; }

    let gx = abs(level_of(jpeg, 0, p * 3 + 3) - level_of(jpeg, 0, p * 3 - 3));
    let gy = abs(
        level_of(jpeg, 0, (p + pc.width) * 3) - level_of(jpeg, 0, (p - pc.width) * 3));
    if (gx + gy > pc.max_gradient) { return false; }
    // A black warp margin is not scene content.
    return ours.x != 0 || ours.y != 0 || ours.z != 0;
}

/// The half-open run of pixels one thread walks.
int2 span_of(int b)
{
    let first = b * pc.block;
    return int2(first, min(first + pc.block, pixels()));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_count(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    let candidate = int(id.y);
    if (b >= pc.blocks || candidate >= pc.candidates) { return; }
    let span = span_of(b);
    var kept = 0u;
    for (int p = span.x; p < span.y; p++) {
        int3 ours;
        int3 theirs;
        if (paired(candidate, p % pc.width, p / pc.width, ours, theirs)) { kept++; }
    }
    counts[count_at(candidate, b)] = kept;
}

/// Blocks one group of the scan covers.
///
/// **The scan is two-level because one level is a single lane.** A 640x427 grid at eight pixels a
/// block is 34000 of them, and one invocation walking that many dependent global reads cost more
/// than every other pass of the objective put together - which is what a run at eight pixels a
/// block and a run at 256 both measured, from opposite ends. Two levels leave 533 for the serial
/// walk and put the rest back in parallel.
static const int GROUP = 64;

int groups() { return (pc.blocks + GROUP - 1) / GROUP; }

/// A candidate's stretch of `counts`: a count per block, then an offset per block, then the total,
/// then a base per group. The counts and the offsets are kept apart because the level that places
/// the blocks reads its group's counts while its neighbours write their own offsets.
int counts_per_candidate() { return 2 * pc.blocks + 1 + groups(); }
int count_at(int candidate, int b) { return candidate * counts_per_candidate() + b; }
int offset_at(int candidate, int b) { return candidate * counts_per_candidate() + pc.blocks + b; }
int total_at(int candidate) { return candidate * counts_per_candidate() + 2 * pc.blocks; }
int group_at(int candidate, int g) { return total_at(candidate) + 1 + g; }

/// Each group's own total, which is all the serial walk below has to read.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_group(uint3 id: SV_DispatchThreadID)
{
    let g = int(id.x);
    let candidate = int(id.y);
    if (g >= groups() || candidate >= pc.candidates) { return; }
    var seen = 0u;
    for (int b = g * GROUP; b < min((g + 1) * GROUP, pc.blocks); b++) {
        seen += counts[count_at(candidate, b)];
    }
    counts[group_at(candidate, g)] = seen;
}

/// Where each group's run starts, and the total behind them.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_scan(uint3 id: SV_DispatchThreadID)
{
    let candidate = int(id.x);
    if (candidate >= pc.candidates) { return; }
    var seen = 0u;
    for (int g = 0; g < groups(); g++) {
        let at = group_at(candidate, g);
        let kept = counts[at];
        counts[at] = seen;
        seen += kept;
    }
    counts[total_at(candidate)] = seen;
}

/// Where each block's run starts, which is what puts the pair list in row-major order.
///
/// The order is not tidiness: the two phases are every second pair from it, so which pair sits
/// where is part of the residual.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_offsets(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    let candidate = int(id.y);
    if (b >= pc.blocks || candidate >= pc.candidates) { return; }
    let g = b / GROUP;
    var seen = counts[group_at(candidate, g)];
    for (int before = g * GROUP; before < b; before++) {
        seen += counts[count_at(candidate, before)];
    }
    counts[offset_at(candidate, b)] = seen;
}

/// The radius bucket a pixel sits at, as `fit::Gain::radius` quantises it.
int radius_of(int p)
{
    let cx = float(pc.width) * 0.5;
    let cy = float(pc.height) * 0.5;
    let dx = float(p % pc.width) - cx;
    let dy = float(p / pc.width) - cy;
    let half = max(sqrt(cx * cx + cy * cy), 1.0);
    return int(min(sqrt(dx * dx + dy * dy) / half * 255.0, 255.0));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_write(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    let candidate = int(id.y);
    if (b >= pc.blocks || candidate >= pc.candidates) { return; }
    let span = span_of(b);
    var slot = counts[offset_at(candidate, b)];
    for (int p = span.x; p < span.y; p++) {
        int3 ours;
        int3 theirs;
        if (!paired(candidate, p % pc.width, p / pc.width, ours, theirs)) { continue; }
        let out = (candidate * pixels() + int(slot)) * 2;
        records[out] = uint(ours.x) | (uint(ours.y) << 8) | (uint(ours.z) << 16)
            | (uint(radius_of(p)) << 24);
        records[out + 1] = uint(theirs.x) | (uint(theirs.y) << 8) | (uint(theirs.z) << 16);
        slot++;
    }
}

/// A pair's level and the camera's answer at it, off its own record.
void pair_at(int candidate, int k, out int level, out int target)
{
    let out = (candidate * pixels() + k) * 2;
    let ours = records[out];
    let theirs = records[out + 1];
    let mine = int3(int(ours & 0xffu), int((ours >> 8) & 0xffu), int((ours >> 16) & 0xffu));
    let camera = int3(int(theirs & 0xffu), int((theirs >> 8) & 0xffu), int((theirs >> 16) & 0xffu));
    level = levelled(int(ours >> 24), luma8(mine));
    target = luma8(camera);
}

/// The camera's luma summed per level, for both halves at once.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_bins(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    let candidate = int(id.y);
    if (candidate >= pc.candidates) { return; }
    if (k >= int(counts[total_at(candidate)])) { return; }

    int level;
    int target;
    pair_at(candidate, k, level, target);
    let slot = candidate * bins_per_candidate() + (k & 1) * LEVELS * 2 + level * 2;
    bins[slot].add(uint(target));
    bins[slot + 1].add(1);
}

/// The curve one half's bins draw: gaps interpolated, ends extended, monotone.
///
/// **In the same submit as the bins that feed it and the score that reads it**, which is the whole
/// reason it is here rather than on the host with the rest of the fit's arithmetic. A candidate is
/// one dispatch chain and eight bytes back; split across submits for the host to draw the curve in
/// the middle, the refine's fifty sequential steps paid three round trips each and the search came
/// out half again slower than the host walk it replaced.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_obj_curve(uint3 id: SV_DispatchThreadID)
{
    let candidate = int(id.x);
    if (candidate >= pc.candidates) { return; }
    let bin = candidate * bins_per_candidate() + pc.fitted * LEVELS * 2;
    let out = candidate * LEVELS;
    // Carried out with the score, so the host learns how many pairs the gate admitted without a
    // readback of its own.
    score[candidate * SCORE_WORDS + 2].store(counts[total_at(candidate)]);

    var curve = float[LEVELS]();
    var known = int[LEVELS]();
    var seen = 0;
    for (int level = 0; level < LEVELS; level++) {
        let count = float(bins[bin + level * 2 + 1].load());
        curve[level] = count >= float(pc.min_bin) ? float(bins[bin + level * 2].load()) / count : -1.0;
        if (curve[level] >= 0.0) {
            known[seen] = level;
            seen++;
        }
    }
    if (seen < 2) {
        for (int level = 0; level < LEVELS; level++) { curves[out + level] = uint(level); }
        return;
    }

    let first = known[0];
    let last = known[seen - 1];
    let prev = known[seen - 2];
    let tail_slope = (curve[last] - curve[prev]) / float(last - prev);
    var cursor = 0;
    for (int level = 0; level < LEVELS; level++) {
        if (curve[level] >= 0.0) { continue; }
        if (level < first) {
            curve[level] = curve[first] * float(level) / float(max(first, 1));
            continue;
        }
        if (level > last) {
            curve[level] = curve[last] + tail_slope * float(level - last);
            continue;
        }
        while (cursor < seen - 1 && known[cursor + 1] < level) { cursor++; }
        let lo = known[cursor];
        let hi = known[cursor + 1];
        curve[level] = curve[lo] + (curve[hi] - curve[lo]) * float(level - lo) / float(hi - lo);
    }

    var ceiling = 0.0;
    for (int level = 0; level < LEVELS; level++) {
        ceiling = max(ceiling, curve[level]);
        curves[out + level] = uint(round(min(ceiling, 255.0)));
    }
}

/// The residual of the held-out half against the curve the other half fitted.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_score(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    let candidate = int(id.y);
    if (candidate >= pc.candidates) { return; }
    if (k >= int(counts[total_at(candidate)])) { return; }
    // The other phase from the one the curve was fitted on, which is what makes this held out.
    if ((k & 1) != pc.held) { return; }

    int level;
    int target;
    pair_at(candidate, k, level, target);
    let drawn = int(curves[candidate * LEVELS + level]);
    score[candidate * SCORE_WORDS].add(uint(abs(drawn - target)));
    score[candidate * SCORE_WORDS + 1].add(1);
}

/// The falloff's radius bins, summed over the pairs the gate admitted.
///
/// **What this replaces is a pair list crossing the bus.** `fit_gain` read every admitted record
/// back - about 180k of them - so the host could bin their light by radius into thirty-six numbers.
/// The two-parameter solve in front of those thirty-six stays on the host, where it is a `2x2` and
/// costs nothing.
///
/// One thread a block, walking its own pairs in order: float addition is not associative, so the
/// blocking is the answer's shape and the host sums the blocks in index order afterwards.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_obj_falloff(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let first = b * pc.block;
    let last = min(first + pc.block, pc.admitted);

    float wanted[FALLOFF_BINS];
    float had[FALLOFF_BINS];
    float counted[FALLOFF_BINS];
    for (int i = 0; i < FALLOFF_BINS; i++) { wanted[i] = 0.0; had[i] = 0.0; counted[i] = 0.0; }

    for (int k = first; k < last; k++) {
        // Every second pair, from the phase's own parity: the other half is what judges this one.
        if ((k & 1) != pc.fitted) { continue; }
        let out = k * 2;
        let ours = records[out];
        let theirs = records[out + 1];
        let mine = int3(int(ours & 0xffu), int((ours >> 8) & 0xffu), int((ours >> 16) & 0xffu));
        let camera = int3(int(theirs & 0xffu), int((theirs >> 8) & 0xffu), int((theirs >> 16) & 0xffu));
        let radius = int(ours >> 24);
        let bin = min(radius * FALLOFF_BINS / 256, FALLOFF_BINS - 1);

        // A level the curve never reached inverts to a clamp rather than a mapping, so those are
        // dropped rather than believed.
        let target = luma8(camera);
        let source = int(falloff_tables[target]);
        if (source <= 1 || source >= 254) { continue; }
        // Both sides linearised the same way, since what the bin wants is a ratio of light and
        // these levels are sRGB-encoded.
        let want = falloff_tables[LINEAR_FROM + source];
        let is = falloff_tables[LINEAR_FROM + luma8(mine)];
        if (is < 0.002 || want < 0.002) { continue; }
        // Summed, then divided once per bin: a ratio taken pair by pair would let a near-black
        // pixel carry as much as the sky.
        wanted[bin] += want;
        had[bin] += is;
        counted[bin] += 1.0;
    }

    let at = b * FALLOFF_BINS * FALLOFF_WORDS;
    for (int i = 0; i < FALLOFF_BINS; i++) {
        falloff_bins[at + i * FALLOFF_WORDS] = wanted[i];
        falloff_bins[at + i * FALLOFF_WORDS + 1] = had[i];
        falloff_bins[at + i * FALLOFF_WORDS + 2] = counted[i];
    }
}
