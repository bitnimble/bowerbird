// The lateral aberration's walks over the render, where the render already is.
//
// `tca.rs` keeps everything that decides: the argmin of a sweep, the bins, the regression's solve,
// and every gate that says whether a curve is believed. What is here is only the arithmetic over
// pixels - the box average the estimate reads, the scan for point sources, the two splits measured
// around them, and the projected-gradient sums.
//
// **A sweep is a fixed set of candidates, which is what makes this batch.** `nulling_scale` asks 61
// shifts and `nulling_shift` 31, each over the same points at two halo offsets, and none of them
// depends on another's answer. One thread takes one (candidate, offset) and walks every point
// serially, so its sum is the host's sum in the host's order - exactly, not nearly. Golden sections
// are what cannot batch, and there are none here.
//
// The two splits are not one kernel with an argument. `tca_split` moves a channel by a shift the
// sweep is choosing; `tca_halo` reads each tap at *its own* radius through a candidate curve, which
// is what makes a curve's check free of a warp - a corrected frame's red at `q` is the raw frame's
// red at `q` scaled, so applying a candidate and measuring what it leaves is the same arithmetic as
// measuring what is there with the sampling positions moved.

struct Params {
    int width;
    int height;
    /// The reduce's shape, and how many source pixels a side it averages.
    int out_width;
    int out_height;
    int reduce;
    /// Stepped positions one thread of the scan walks, and how many such blocks the rows hold.
    int block;
    int blocks;
    int rows;
    /// Point sources the scan admitted, which every split is taken over.
    int points;
    /// Candidates in a sweep and halo offsets each is measured at.
    int candidates;
    int offsets;
    /// Which channel `tca_split` reads: 0 for red against green, 2 for blue.
    int channel;
    /// Whether a sweep candidate is a scale on the radius or a shift in pixels.
    int scaled;
    /// The sweep's ends, which a candidate's index divides between.
    float from;
    float to;
    /// Taps either side of a point, across the radius.
    int across;
    /// Where the scan starts looking, as a fraction of the half-diagonal.
    float radius_from;
    /// The band of radii a split reads, as fractions of the half-diagonal. One scan serves every
    /// caller and each names its own band: a bin's refinement asks about its own points, the
    /// frame-wide pass about all of them, and the verification about the outer frame alone.
    float bin_low;
    float bin_high;
    /// `MIN_EDGE`, and the stride the regression walks its rows on.
    float min_edge;
    int stride;
    /// Knots in each of `tca_halo`'s two curves, or zero to read the frame as it stands.
    int knots;
    /// `image::SPLINE_UNIT`, which a knot is carried in.
    float spline_unit;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// The render where `fit_render` left it: interleaved sRGB in 0..1, one float a component.
[vk::binding(0, 0)] StructuredBuffer<float> image;
/// The same plane box-averaged by `reduce`, which the regression reads.
[vk::binding(1, 0)] RWStructuredBuffer<uint> small;
/// Points per block, then where each block's run starts.
[vk::binding(2, 0)] RWStructuredBuffer<uint> counts;
/// Two ints a point source, in the order a serial scan would have found them.
[vk::binding(3, 0)] RWStructuredBuffer<int> at;
/// Two floats a slot: the split summed over the points it read, and how many there were.
[vk::binding(4, 0)] RWStructuredBuffer<float> splits;
/// The halo offsets a split is measured at.
[vk::binding(5, 0)] StructuredBuffer<float> halos;
/// Per row of the reduce: its cross and square sums per channel, and what it counted.
[vk::binding(6, 0)] RWStructuredBuffer<float> rows;
/// The per-channel gains the regression matches against green with, then `tca_halo`'s two curves
/// laid end to end, `pc.knots` each.
[vk::binding(7, 0)] StructuredBuffer<float> curves;
/// Three channel sums over the reduce, which the gains are the ratios of.
[vk::binding(8, 0)] RWStructuredBuffer<Atomic<uint> > tally;

/// How far out the scan looks for a neighbour, and how much darker one must be.
static const int REACH = 7;
static const float DROP = 35.0;
static const int LIT_AT_MOST = 12;
static const int MAX_EXTENT = 3;
static const int MARGIN = 24;
/// Words a row of the regression reports.
static const int ROW_WORDS = 5;
/// Where `curves` stops being the regression's gains and starts being the halo's knots.
static const int KNOTS_FROM = 3;

/// Quantised onto the 255 steps the camera's JPEG lives on, which is the width every threshold
/// here is stated in and the one the split's arithmetic was measured at.
float level(int index)
{
    return round(clamp(image[index] * 255.0, 0.0, 255.0));
}

float at_of(int x, int y, int c)
{
    return level((y * pc.width + x) * 3 + c);
}

/// The summed brightness of a pixel. Summed rather than averaged: the scan runs on every pixel and
/// the brightness test rejects almost all of them, so the cheap form of it is most of what it costs.
float total_at(int x, int y)
{
    return at_of(x, y, 0) + at_of(x, y, 1) + at_of(x, y, 2);
}

float luma_at(int x, int y) { return total_at(x, y) / 3.0; }

/// The frame's half-diagonal, which every radius here is a fraction of.
float half_of()
{
    let cx = float(pc.width) * 0.5;
    let cy = float(pc.height) * 0.5;
    return max(sqrt(cx * cx + cy * cy), 1.0);
}

/// A spline read at a radius, as the fraction it displaces by - `image::spline_at`, on the knots
/// laid into `curves` after the gains. Zero where the curve is empty, which reads the frame as it
/// stands.
float spline_at(int slot, float radius)
{
    if (pc.knots == 0) { return 0.0; }
    let base = KNOTS_FROM + slot * pc.knots;
    let last = float(pc.knots - 1);
    let position = clamp(radius * last, 0.0, last);
    let index = int(floor(position));
    let next = min(index + 1, pc.knots - 1);
    let value = curves[base + index]
        + (curves[base + next] - curves[base + index]) * (position - float(index));
    return value / pc.spline_unit;
}

/// Whether this pixel is a point source: bright but not clipped, a peak over its neighbours, dark
/// again well before the reach, and compact *and centred* about its own peak.
///
/// Extent is what separates a star from the end of a wire - a star's lit pixels all sit within a
/// pixel or two of its peak, where a wire's run away along it, and counting lit pixels alone left
/// five of a bridge's cables reading as stars.
bool is_source(int x, int y)
{
    let cx = float(pc.width) * 0.5;
    let cy = float(pc.height) * 0.5;
    let dx = float(x) - cx;
    let dy = float(y) - cy;
    let inner = pc.radius_from * half_of();
    if (dx * dx + dy * dy < inner * inner) { return false; }

    let total = total_at(x, y);
    if (total < 330.0 || total > 735.0) { return false; }
    let here = total / 3.0;

    for (int oy = -2; oy <= 2; oy++) {
        for (int ox = -2; ox <= 2; ox++) {
            if (ox == 0 && oy == 0) { continue; }
            if (luma_at(x + ox, y + oy) > here) { return false; }
        }
    }
    let steps = int2[8](
        int2(-1, 0), int2(1, 0), int2(0, -1), int2(0, 1),
        int2(-1, -1), int2(1, 1), int2(-1, 1), int2(1, -1));
    for (int k = 0; k < 8; k++) {
        if (!(luma_at(x + steps[k].x * REACH, y + steps[k].y * REACH) < here - DROP)) {
            return false;
        }
    }
    var count = 0;
    var extent = 0;
    for (int oy = -REACH; oy <= REACH; oy++) {
        for (int ox = -REACH; ox <= REACH; ox++) {
            if (luma_at(x + ox, y + oy) > here - DROP) {
                count++;
                extent = max(extent, max(abs(ox), abs(oy)));
            }
        }
    }
    return count <= LIT_AT_MOST && extent <= MAX_EXTENT;
}

/// The stepped positions one thread of the scan walks. Every second row, because a point source is
/// a single-pixel peak, so this finds about half of them - and the measurement wants tens per
/// radius bin, not thousands.
int columns() { return pc.width - 2 * MARGIN; }
int2 span_of(int b)
{
    let first = b * pc.block;
    return int2(first, min(first + pc.block, pc.rows * columns()));
}
int2 stepped(int s)
{
    let across = columns();
    return int2(MARGIN + s % across, MARGIN + 2 * (s / across));
}
bool scanned(int s, out int2 p)
{
    p = stepped(s);
    return p.y < pc.height - MARGIN && is_source(p.x, p.y);
}

/// Every source pixel contributes exactly once and the centre is preserved, so the radius each
/// sample sits at is the same fraction of the frame it was.
[shader("compute")]
[numthreads(16, 16, 1)]
void tca_reduce(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.out_width || y >= pc.out_height) { return; }
    var totals = float3(0.0);
    for (int sy = y * pc.reduce; sy < (y + 1) * pc.reduce; sy++) {
        for (int sx = x * pc.reduce; sx < (x + 1) * pc.reduce; sx++) {
            totals += float3(at_of(sx, sy, 0), at_of(sx, sy, 1), at_of(sx, sy, 2));
        }
    }
    // Truncated, because the host summed `u32` and divided them.
    let n = float(pc.reduce * pc.reduce);
    let out = (y * pc.out_width + x) * 3;
    for (int c = 0; c < 3; c++) {
        small[out + c] = uint(floor(totals[c] / n));
    }
}

[shader("compute")]
[numthreads(64, 1, 1)]
void tca_count(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let span = span_of(b);
    var kept = 0u;
    for (int s = span.x; s < span.y; s++) {
        int2 p;
        if (scanned(s, p)) { kept++; }
    }
    counts[b] = kept;
}

/// Where each block's run starts, which keeps the point list in the order a serial scan would
/// produce - and every sum taken over it is taken in that order.
[shader("compute")]
[numthreads(1, 1, 1)]
void tca_offsets()
{
    var seen = 0u;
    for (int b = 0; b < pc.blocks; b++) {
        let kept = counts[b];
        counts[b] = seen;
        seen += kept;
    }
    counts[pc.blocks] = seen;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void tca_write(uint3 id: SV_DispatchThreadID)
{
    let b = int(id.x);
    if (b >= pc.blocks) { return; }
    let span = span_of(b);
    var slot = counts[b];
    for (int s = span.x; s < span.y; s++) {
        int2 p;
        if (!scanned(s, p)) { continue; }
        at[int(slot) * 2] = p.x;
        at[int(slot) * 2 + 1] = p.y;
        slot++;
    }
}

/// A sample of one channel at a position, rounded and clamped as the host reads it.
float sample_at(float x, float y, int c)
{
    let px = int(round(clamp(x, 0.0, float(pc.width - 1))));
    let py = int(round(clamp(y, 0.0, float(pc.height - 1))));
    return at_of(px, py, c);
}

/// A point's own frame: its radius, the unit vector out along it, and the one across it - the
/// direction a radial scale moves nothing along.
bool frame_at(int k, out float2 centre, out float2 out_dir, out float2 across, out float radius)
{
    let cx = float(pc.width) * 0.5;
    let cy = float(pc.height) * 0.5;
    centre = float2(float(at[k * 2]), float(at[k * 2 + 1]));
    let d = centre - float2(cx, cy);
    radius = length(d);
    out_dir = float2(0.0);
    across = float2(0.0);
    if (radius < 1.0) { return false; }
    out_dir = d / radius;
    across = float2(-out_dir.y, out_dir.x);
    return true;
}

/// Outward minus inward colour against green, for one candidate shift at one halo offset.
[shader("compute")]
[numthreads(64, 1, 1)]
void tca_split(uint3 id: SV_DispatchThreadID)
{
    let slot = int(id.x);
    if (slot >= pc.candidates * pc.offsets) { return; }
    let candidate = slot / pc.offsets;
    let offset = halos[slot % pc.offsets];
    let step = pc.candidates > 1 ? float(candidate) / float(pc.candidates - 1) : 0.0;
    let value = pc.from + (pc.to - pc.from) * step;

    var total = 0.0;
    var counted = 0.0;
    // Every point in order, in one lane, which is what makes this the host's sum rather than one
    // that happens to be close to it.
    for (int k = 0; k < pc.points; k++) {
        float2 centre;
        float2 out_dir;
        float2 across;
        float radius;
        if (!frame_at(k, centre, out_dir, across, radius)) { continue; }
        let fraction = radius / half_of();
        if (fraction < pc.bin_low || fraction >= pc.bin_high) { continue; }
        let shift = pc.scaled != 0 ? value * radius : value;

        var sides = float2(0.0);
        for (int s = 0; s < 2; s++) {
            let sign = s == 0 ? 1.0 : -1.0;
            var sum = 0.0;
            for (int t = -pc.across; t <= pc.across; t++) {
                let q = centre + sign * out_dir * offset + across * float(t);
                sum += sample_at(q.x + out_dir.x * shift, q.y + out_dir.y * shift, pc.channel)
                    - sample_at(q.x, q.y, 1);
            }
            sides[s] = sum / float(pc.across * 2 + 1);
        }
        total += sides[0] - sides[1];
        counted += 1.0;
    }
    splits[slot * 2] = total;
    splits[slot * 2 + 1] = counted;
}

/// Outward minus inward colour against green with each channel read through a candidate *curve*,
/// both channels at once, for one halo offset.
///
/// **At each sample's own radius**, which is what the warp does. Taking one scale off the corner
/// and applying it everywhere over-corrects every point inside the corner, and a curve that grows
/// with radius then scores as harmful when it is the yardstick that is wrong - measured, it
/// rejected 34 of 43 corrections that were helping.
[shader("compute")]
[numthreads(64, 1, 1)]
void tca_halo(uint3 id: SV_DispatchThreadID)
{
    let slot = int(id.x);
    if (slot >= pc.offsets) { return; }
    let offset = halos[slot];
    let cx = float(pc.width) * 0.5;
    let cy = float(pc.height) * 0.5;
    let half = half_of();

    var totals = float2(0.0);
    var counted = 0.0;
    for (int k = 0; k < pc.points; k++) {
        float2 centre;
        float2 out_dir;
        float2 across;
        float radius;
        if (!frame_at(k, centre, out_dir, across, radius)) { continue; }
        let fraction = radius / half;
        if (fraction < pc.bin_low || fraction >= pc.bin_high) { continue; }

        var split = float2(0.0);
        for (int channel = 0; channel < 2; channel++) {
            let c = channel == 0 ? 0 : 2;
            var sides = float2(0.0);
            for (int s = 0; s < 2; s++) {
                let sign = s == 0 ? 1.0 : -1.0;
                var sum = 0.0;
                for (int t = -pc.across; t <= pc.across; t++) {
                    let q = centre + sign * out_dir * offset + across * float(t);
                    let qr = length(q - float2(cx, cy)) / half;
                    let scale = 1.0 + spline_at(channel, qr);
                    let moved = float2(cx, cy) + (q - float2(cx, cy)) * scale;
                    sum += sample_at(moved.x, moved.y, c) - sample_at(q.x, q.y, 1);
                }
                sides[s] = sum / float(pc.across * 2 + 1);
            }
            split[channel] = sides[0] - sides[1];
        }
        totals += split;
        counted += 1.0;
    }
    // Both channels in the one slot a halo offset owns, which is what the caller reads them as.
    splits[slot * 4] = totals[0];
    splits[slot * 4 + 1] = totals[1];
    splits[slot * 4 + 2] = counted;
    splits[slot * 4 + 3] = 0.0;
}

/// The channel sums the regression's gain match is the ratio of, over every ninety-seventh pixel
/// of the reduce.
///
/// Whole numbers, so an atomic tally is the host's own sum whatever order the lanes ran in - where
/// the regression's sums below are real and have to be folded in row order.
[shader("compute")]
[numthreads(64, 1, 1)]
void tca_gains(uint3 id: SV_DispatchThreadID)
{
    let pixel = int(id.x) * 97;
    if (pixel >= pc.out_width * pc.out_height) { return; }
    for (int c = 0; c < 3; c++) {
        tally[c].add(small[pixel * 3 + c]);
    }
}

/// One row of the regression the estimate falls back on: the gradient projected onto the offset
/// from the centre, which is the only direction a radial scale can move anything along.
///
/// A row a thread, folded by the caller in row order, because these are real sums where the scan's
/// were integers.
[shader("compute")]
[numthreads(64, 1, 1)]
void tca_slopes(uint3 id: SV_DispatchThreadID)
{
    let y = 1 + int(id.x);
    if (y >= pc.out_height - 1) { return; }
    // Not `out_width / 2`. A reduced pixel stands for the block it averaged, whose centre of mass
    // sits half a block in, so the frame's centre lands `(reduce - 1) / 2` input pixels off where
    // naming it the half-width would put it - a constant offset that lands squarely in a slope
    // fitted with no intercept.
    let inset = (float(pc.reduce) - 1.0) / 2.0;
    let cx = (float(pc.width) * 0.5 - inset) / float(pc.reduce);
    let cy = (float(pc.height) * 0.5 - inset) / float(pc.reduce);
    let row = pc.out_width * 3;

    var cross = float2(0.0);
    var square = float2(0.0);
    var counted = 0.0;
    for (int x = 1; x < pc.out_width - 1; x += pc.stride) {
        let i = (y * pc.out_width + x) * 3;
        let gx = (float(small[i + 3 + 1]) - float(small[i - 3 + 1])) / 2.0;
        let gy = (float(small[i + row + 1]) - float(small[i - row + 1])) / 2.0;
        if (abs(gx) + abs(gy) < pc.min_edge) { continue; }
        let dx = float(x) - cx;
        let dy = float(y) - cy;
        let regressor = -(dx * gx + dy * gy);
        for (int s = 0; s < 2; s++) {
            let c = s == 0 ? 0 : 2;
            // Gain-matched against green first, or the difference this reads carries the channels'
            // overall imbalance on top of the misregistration.
            let difference = curves[c] * float(small[i + c]) - float(small[i + 1]);
            cross[s] += difference * regressor;
            square[s] += regressor * regressor;
        }
        counted += 1.0;
    }
    let out = (y - 1) * ROW_WORDS;
    rows[out] = cross[0];
    rows[out + 1] = cross[1];
    rows[out + 2] = square[0];
    rows[out + 3] = square[1];
    rows[out + 4] = counted;
}
