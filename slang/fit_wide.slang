// The wide pass's two walks over the sharp planes: which pixels it will teach the lattice from, and
// what the pair at each of them actually is.
//
// `hdr_fit::wide_samples` has why the pass exists - a small saturated object is mostly edge at the
// pair grid's width and mostly interior at this one - and why the gates sit where they do. What is
// here is only the arithmetic over pixels; the tiling between the two walks, and the search it
// batches, stay on the host, which is index bookkeeping over a few thousand probes rather than work
// on a picture.
import prelude;

struct Params {
    /// The grid both planes are read on, which is the smaller of the two.
    int width;
    int height;
    /// Each plane's own shape, which the grid above is the smaller of: a sensor's aspect is not its
    /// preview's, so the two disagree by a row or two and each is indexed on its own stride.
    int target_width;
    int our_width;
    int our_height;
    /// One pixel in this many, each way.
    int stride;
    /// Pixels one thread of the gate walks, and how many such blocks the rows hold.
    int block;
    int blocks;
    /// How many rows the gate steps over, and how many admitted pixels the gather has.
    int rows;
    int count;
    /// Margin a correspondence window needs: `PATCH + SEARCH`.
    int edge;
    /// Taps either side of a sample's centre, and how far a neighbour may sit from it.
    int sample;
    float sample_range;
    /// Below this much chroma the camera's pixel is not what this pass exists for.
    float min_chroma;
    /// `readable`: neither end of the camera's range says anything.
    float camera_clipping;
    float camera_crushed;
    /// `MARGIN_DARK`, for the crumb rule the mask has.
    float margin_dark;
    /// `FLAT_ENOUGH`, and the ceiling our own side may not reach.
    float flat_enough;
    float ceiling;
    /// Zero where the lens has no falloff; otherwise `gains` holds one per radius bucket.
    int falloff;
    float half;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// The warped render at the wide grid, interleaved f32 RGB, without its falloff.
[vk::binding(0, 0)] StructuredBuffer<float> ours;
/// The camera's preview, linearised, at the same grid.
[vk::binding(1, 0)] StructuredBuffer<float> theirs;
/// `fit::Gain::at` per radius bucket, 256 of them.
[vk::binding(2, 0)] StructuredBuffer<float> gains;
/// Four floats a gathered position: dx, dy, peak, and which outcome the search reached.
[vk::binding(3, 0)] StructuredBuffer<float> found;
/// Admitted pixels per block, then where each block's run starts.
[vk::binding(4, 0)] RWStructuredBuffer<uint> counts;
/// Two ints an admitted pixel, in row-major order.
[vk::binding(5, 0)] RWStructuredBuffer<int> at;
/// Seven floats a gathered position: ours, the camera's, and whether it survived.
[vk::binding(6, 0)] RWStructuredBuffer<float> samples;

/// Words a gathered sample occupies.
static const int SAMPLE_WORDS = 7;

float3 rgb_at(StructuredBuffer<float> plane, int stride, int x, int y)
{
    let i = (y * stride + x) * 3;
    return float3(plane[i], plane[i + 1], plane[i + 2]);
}

/// A colour read at a matched location: a small average, gated per channel so it cannot mix across
/// a boundary.
float3 sample_at(StructuredBuffer<float> plane, int stride, int x, int y)
{
    let centre = rgb_at(plane, stride, x, y);
    var sum = float3(0.0);
    var count = 0.0;
    for (int dy = -pc.sample; dy <= pc.sample; dy++) {
        for (int dx = -pc.sample; dx <= pc.sample; dx++) {
            let v = rgb_at(plane, stride, x + dx, y + dy);
            if (any(abs(v - centre) > float3(pc.sample_range))) { continue; }
            sum += v;
            count += 1.0;
        }
    }
    return sum / count;
}

/// Whether a small misregistration could change the colour here.
bool flat_about(StructuredBuffer<float> plane, int stride, int x, int y)
{
    let centre = dot(LUMA, sample_at(plane, stride, x, y));
    let bound = pc.flat_enough * (abs(centre) + 0.01);
    for (int k = 0; k < 4; k++) {
        let dx = (k < 2 ? (k == 0 ? 2 : -2) : 0);
        let dy = (k < 2 ? 0 : (k == 2 ? 2 : -2));
        let luma = dot(LUMA, sample_at(plane, stride, x + dx, y + dy));
        if (!(abs(luma - centre) < bound)) { return false; }
    }
    return true;
}

/// Whether the camera's pixel measured anything: neither end of its range says anything.
bool readable(float3 t)
{
    return max(t.x, max(t.y, t.z)) < pc.camera_clipping
        && min(t.x, min(t.y, t.z)) > pc.camera_crushed;
}

/// Only the colours this pass exists for. A near-neutral costs the same neighbour test as a
/// saturated one and tells the map nothing: the frame's greys already fill those nodes from the
/// pairs, and there are four wide pixels for every pair.
bool coloured(float3 t)
{
    let luma = dot(LUMA, t);
    return max(abs(t.x - luma), abs(t.z - luma)) >= pc.min_chroma;
}

/// Whether a window of `edge` about this position fits inside both planes.
bool holds(int x, int y)
{
    return x >= pc.edge && y >= pc.edge
        && x + pc.edge < pc.width && y + pc.edge < pc.height;
}

/// The x of the `k`th stepped column, and how many there are in a row.
int columns() { return (pc.width - 2 + pc.stride - 1) / pc.stride; }
int column_at(int k) { return 1 + k * pc.stride; }
int row_at(int r) { return 1 + r * pc.stride; }

/// The half-open run of stepped positions one thread of the gate walks.
int2 span_of(uint b)
{
    let first = int(b) * pc.block;
    return int2(first, min(first + pc.block, pc.rows * columns()));
}

/// Whether the stepped position `s` is one this pass will teach from.
bool admits(int s)
{
    let y = row_at(s / columns());
    let x = column_at(s % columns());
    if (x >= pc.width - 1 || y >= pc.height - 1) { return false; }
    let t = rgb_at(theirs, pc.target_width, x, y);
    return readable(t) && coloured(t) && holds(x, y);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_wide_count(uint3 id: SV_DispatchThreadID)
{
    if (int(id.x) >= pc.blocks) { return; }
    let span = span_of(id.x);
    var kept = 0u;
    for (int s = span.x; s < span.y; s++) {
        if (admits(s)) { kept++; }
    }
    counts[id.x] = kept;
}

/// Where each block's run starts, which is what keeps the admitted list in row-major order.
///
/// An atomic append would put them in whatever order the lanes landed, and every moment the wide
/// samples are summed into is summed in this order.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_wide_offsets()
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
void fit_wide_write(uint3 id: SV_DispatchThreadID)
{
    if (int(id.x) >= pc.blocks) { return; }
    let span = span_of(id.x);
    var slot = counts[id.x];
    for (int s = span.x; s < span.y; s++) {
        if (!admits(s)) { continue; }
        at[slot * 2] = column_at(s % columns());
        at[slot * 2 + 1] = row_at(s / columns());
        slot++;
    }
}

/// What the pair at each admitted position is, about the offset its own search returned.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_wide_gather(uint3 id: SV_DispatchThreadID)
{
    let k = int(id.x);
    if (k >= pc.count) { return; }
    let out = k * SAMPLE_WORDS;
    samples[out + 6] = 0.0;

    let x = at[k * 2];
    let y = at[k * 2 + 1];
    var dx = 0;
    var dy = 0;
    if (found[k * 4 + 3] < 0.0) {
        // Where the search found nothing there is one more admissible case: a neighbourhood flat in
        // both planes, where a pixel or two of shift cannot change the colour - the test the search
        // replaced, kept for exactly the content the search cannot verify. A smooth lit gradient is
        // featureless by definition, and it is where banding lives; dropped here, its colours reach
        // the map from nowhere at all.
        if (!flat_about(ours, pc.our_width, x, y) || !flat_about(theirs, pc.target_width, x, y)) {
            return;
        }
    } else {
        // Rounded, the offsets being sub-pixel: this takes the sample the offset lands nearest,
        // rather than resampling between two of the camera's own pixels.
        dx = int(round(found[k * 4]));
        dy = int(round(found[k * 4 + 1]));
    }

    let raw = sample_at(ours, pc.our_width, x, y);
    let t = sample_at(theirs, pc.target_width, x + dx, y + dy);
    // Re-read after the shift, because the range and chroma tests in the gate were asked of the
    // pixel under our coordinate, not of the one that turned out to hold the same content.
    if (!readable(t) || !coloured(t)) { return; }
    // The same crumb rule `fit_mask` has: camera content over our warp margin's taper measures
    // nothing.
    if (dot(LUMA, raw) < pc.margin_dark && dot(LUMA, t) >= pc.margin_dark) { return; }

    var v = raw;
    if (pc.falloff != 0) {
        let rx = float(x) - float(pc.our_width) * 0.5;
        let ry = float(y) - float(pc.our_height) * 0.5;
        v *= gains[int(min(sqrt(rx * rx + ry * ry) / pc.half * 255.0, 255.0))];
    }
    if (max(v.x, max(v.y, v.z)) >= pc.ceiling) { return; }

    samples[out] = v.x;
    samples[out + 1] = v.y;
    samples[out + 2] = v.z;
    samples[out + 3] = t.x;
    samples[out + 4] = t.y;
    samples[out + 5] = t.z;
    samples[out + 6] = 1.0;
}
