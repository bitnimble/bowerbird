// How far one frame of a panorama sits from another, at a size where the whole search is affordable.
//
// The correspondence search (`correspond.slang`) is a refiner: it looks nine pixels either way,
// which is nothing beside the third of a frame two neighbouring shots of a panorama are apart. So
// something has to say roughly where the overlap is before that search can be pointed at it, and
// this is it - every whole-frame translation, scored by how well the overlapping part of one plane
// explains the other.
//
// **One thread per candidate translation, not per pixel.** A candidate's score is a reduction over
// its own overlap and every candidate wants a different overlap, so the parallelism is across
// candidates and each one walks its own region. At 202px there are about 100k of them and each
// walks at most 7k samples, which is a fraction of a second; at the full 1616px it would be 4000
// times that, which is why the search happens here and the answer is carried up the pyramid.
//
// Rotation is not searched. A panorama shot by hand rolls by a degree or two, which a translation
// still finds - the correlation peak widens rather than moving - and the roll itself is solved
// later, from the dense correspondences a translation is accurate enough to seed.

struct Push {
    int a_width;
    int a_height;
    int b_width;
    int b_height;
    int min_dx;
    int max_dx;
    int min_dy;
    int max_dy;
    /// The overlap, as a fraction of a whole plane, at which a candidate is believed in full.
    float overlap_full;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[vk::binding(0, 0)] StructuredBuffer<float> a;
[vk::binding(1, 0)] StructuredBuffer<float> b;
/// Three floats a candidate: its weighted score, and the translation it scored.
[vk::binding(2, 0)] RWStructuredBuffer<float> scored;

/// The long edge both planes are reduced to before they are searched.
///
/// Small enough that every translation can be tried, and large enough that a 7x7 patch of a
/// building is still a 7x7 patch of a building. The pyramid above it doubles from here.
static const int COARSE_LONG = 202;

/// Every second sample along each axis, so a candidate costs a quarter of its overlap.
///
/// The planes are box reductions of the search plane, so neighbouring samples are already an
/// average of several source pixels and there is nothing at this scale that lives between two of
/// them. Measured on a synthetic pair, the peak lands on the same translation either way.
///
/// **How many source pixels that average is depends on the caller** - eight from a pan's 1616,
/// four from a burst's 808 (`composite_align::Kind`) - but the stride itself does not: this plane
/// is reduced to `COARSE_LONG` whatever arrived, so a count of *its* pixels is scale-exact.
static const int STRIDE = 2;

[shader("compute")]
[numthreads(64, 1, 1)]
void composite_coarse(uint3 id: SV_DispatchThreadID)
{
    let candidate = int(id.x);
    let across = pc.max_dx - pc.min_dx + 1;
    let down = pc.max_dy - pc.min_dy + 1;
    if (candidate >= across * down) { return; }
    let dx = pc.min_dx + candidate % across;
    let dy = pc.min_dy + candidate / across;

    // b's pixel (x, y) shows what a shows at (x + dx, y + dy), so a sample has to fall inside both
    // planes - which are not the same shape where a set mixes portrait frames with landscape ones.
    let x0 = max(0, -dx);
    let x1 = min(pc.b_width, pc.a_width - dx);
    let y0 = max(0, -dy);
    let y1 = min(pc.b_height, pc.a_height - dy);

    var n = 0.0;
    var sa = 0.0;
    var sb = 0.0;
    var saa = 0.0;
    var sbb = 0.0;
    var sab = 0.0;
    for (int y = y0; y < y1; y += STRIDE) {
        for (int x = x0; x < x1; x += STRIDE) {
            let va = a[(y + dy) * pc.a_width + (x + dx)];
            let vb = b[y * pc.b_width + x];
            n += 1.0;
            sa += va;
            sb += vb;
            saa += va * va;
            sbb += vb * vb;
            sab += va * vb;
        }
    }

    let count = max(n, 1.0);
    let covariance = sab - sa * sb / count;
    let spread_a = saa - sa * sa / count;
    let spread_b = sbb - sb * sb / count;
    let zncc = (spread_a > 1e-6 && spread_b > 1e-6) ? covariance / sqrt(spread_a * spread_b) : -1.0;

    // **Weighted by how much of the frame the candidate actually explains.** A translation that
    // leaves two frames touching at a corner correlates a few hundred samples, and a few hundred
    // samples of sky correlate perfectly - so an unweighted score picks the corner over the true
    // overlap every time. Above `overlap_full` the weight is 1 and the score is the correlation.
    let smaller = min(pc.a_width * pc.a_height, pc.b_width * pc.b_height);
    let overlap = n * float(STRIDE * STRIDE) / float(smaller);
    let weight = min(1.0, overlap / pc.overlap_full);
    scored[3 * candidate] = zncc * weight;
    scored[3 * candidate + 1] = float(dx);
    scored[3 * candidate + 2] = float(dy);
}
