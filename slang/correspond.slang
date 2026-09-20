// Where a point's content sits in the camera's own rendering.
//
// The camera match runs this at three places - the geometry settle's `registration`, the
// sharp-plane `registered`, and the wide pass inside `fitted_chroma`, all three over a 7x7 patch and
// a 9x9 offset window. It is a zero-mean normalised cross correlation, which is template matching
// and the shape a device is built for.
//
// **One thread per point, not per offset.** The tie-break is a scan in a fixed offset order -
// strictly better wins, and an equal score only wins if it moved less - so the offsets have to be
// visited in order by something carrying the running best. Splitting them across lanes would need a
// reduction that reproduces that order, which costs more than the scan does.
//
// The planes are f32, which is not a compromise: they are built from 8-bit samples, so f32's 24-bit
// mantissa holds them exactly and a 49-term patch sum nowhere near reaches its limits. Measured, one
// frame's held-out deltaE moves 1e-6 and every fitted matrix and curve is unchanged.

struct Push {
    int width;
    int height;
    int points;
    float flat_patch;
    float match_min;
    /// Threads along x, so the second dispatch dimension can carry the rest.
    ///
    /// A dense search is one thread per pixel of the camera's plane, and a 61MP frame's plane
    /// passes the 65535 workgroups a single dimension may hold - which is a validation error,
    /// which `gpu::build` turns into a panic, so the whole fit fails and the photo ships with
    /// its own colour. `Asking::dispatch` spreads the overflow across y and states the stride
    /// it used here.
    int span;
    /// How far either way of the centre to look, or negative for the whole `SEARCH` window.
    ///
    /// A dense pass already knows roughly where it is going: `wide_samples` searches a probe
    /// per tile and every pixel of that tile is within a pixel or two of the same answer. Given
    /// that, a pixel needs the offsets beside it rather than all 81, which is the difference
    /// between the largest stage of the fit and a small one - and it still scores what it
    /// lands on, so a pixel whose content does not match its tile's is still rejected.
    int refine;
    /// Whether `given` holds an offset to centre the search on, rather than the point itself.
    int has_given;
    /// How far either way of a point the compared window reaches, and how far the search moves it.
    ///
    /// **A length, so it belongs to the plane rather than to this file.** Seven pixels over a nine
    /// pixel sweep is what registers two renderings of one photograph, and the camera match's planes
    /// are one size - but a panorama's are whatever the smallest preview in the set was, 1616 for a
    /// RAW and 800 for a grid tile, and the same absolute window covers twice the scene on the
    /// smaller. The caller states what it wants in the pixels it has.
    int patch;
    int search;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[vk::binding(0, 0)] StructuredBuffer<float> ours;
[vk::binding(1, 0)] StructuredBuffer<float> theirs;
/// Two ints a point: the coordinates the search is centred on.
[vk::binding(2, 0)] StructuredBuffer<int> at;
/// Four floats a point: dx, dy, peak, and which of the three outcomes it was.
[vk::binding(3, 0)] RWStructuredBuffer<float> found;
/// `patch_stats` over `theirs`, and bound to a stub where `TABULATED` is off.
[vk::binding(4, 0)] StructuredBuffer<float> their_stats;
/// Two ints a point: the offset the search is centred on, in `theirs`. Bound to a stub where the
/// caller believes nothing and the search is centred on the point itself.
[vk::binding(5, 0)] StructuredBuffer<int> given;

/// Whether the camera plane's patch statistics were worked out up front.
///
/// A dense search wants them - at stride 1 the 81 windows around a point overlap the 81 around its
/// neighbour almost entirely - and a sparse one does not, since tabulating a 3.3M-pixel plane for
/// 6000 points is most of a frame's work for nothing. The host builds one pipeline per value.
[vk::constant_id(0)]
const int TABULATED = 0;

/// The mean and total squared deviation of the compared window centred on a point.
void patch_of(StructuredBuffer<float> plane, int x, int y, out float mean, out float spread)
{
    var sum = 0.0;
    var count = 0.0;
    for (int dy = -pc.patch; dy <= pc.patch; dy++) {
        for (int dx = -pc.patch; dx <= pc.patch; dx++) {
            sum += plane[(y + dy) * pc.width + (x + dx)];
            count += 1.0;
        }
    }
    mean = sum / count;
    var deviation = 0.0;
    for (int dy = -pc.patch; dy <= pc.patch; dy++) {
        for (int dx = -pc.patch; dx <= pc.patch; dx++) {
            let d = plane[(y + dy) * pc.width + (x + dx)] - mean;
            deviation += d * d;
        }
    }
    spread = deviation;
}

/// The zero-mean normalised cross correlation of our patch at (x, y) against theirs at (tx, ty),
/// or -1 where their side has nothing to correlate with.
///
/// `mean` and `spread` are ours, worked out once by the caller; theirs come from the tabulation
/// where there is one.
float score_at(int x, int y, float mean, float spread, int tx, int ty)
{
    float their_mean;
    float their_spread;
    if (TABULATED != 0) {
        let slot = 2 * (ty * pc.width + tx);
        their_mean = their_stats[slot];
        their_spread = their_stats[slot + 1];
    } else {
        patch_of(theirs, tx, ty, their_mean, their_spread);
    }
    if (their_spread < pc.flat_patch) { return 0.0; }

    // **Our side re-read rather than held.** Hoisted out of the offset loop these 49 centred
    // samples would be an array indexed by a loop variable, which a shader puts in scratch - and
    // every tap would cost a spill rather than a subtract.
    var joint = 0.0;
    for (int dy = -pc.patch; dy <= pc.patch; dy++) {
        for (int dx = -pc.patch; dx <= pc.patch; dx++) {
            joint += (ours[(y + dy) * pc.width + (x + dx)] - mean)
                * (theirs[(ty + dy) * pc.width + (tx + dx)] - their_mean);
        }
    }
    return joint / sqrt(spread * their_spread);
}

/// Where the peak of a parabola through three scores sits, relative to the middle one.
///
/// The integer scan lands on the nearest whole offset, and the sub-pixel remainder is what a
/// panorama's rotations are solved from: at a preview's 1616px a tenth of a pixel there is most of
/// a pixel at 61MP, which is the difference between a seam that is invisible and one that is not.
///
/// Zero where the three do not describe a peak at all - a plateau, or a minimum, which happens on
/// a repeating texture - so an offset with no curvature to read is left where the scan put it.
float sub_pixel(float lower, float middle, float upper)
{
    let curvature = lower - 2.0 * middle + upper;
    if (curvature >= 0.0) { return 0.0; }
    return clamp(0.5 * (lower - upper) / curvature, -0.5, 0.5);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void correspond(uint3 id: SV_DispatchThreadID)
{
    let point = int(id.y * uint(pc.span) + id.x);
    if (point >= pc.points) { return; }
    let x = at[2 * point];
    let y = at[2 * point + 1];
    let out = 4 * point;

    // A position the caller marked as too near an edge to hold a window. Asked about anyway, so
    // that a dense search's answers line up with the grid by index and nothing downstream has to
    // invert a compaction to find its own point.
    if (x < 0 || y < 0) {
        found[out] = 0.0;
        found[out + 1] = 0.0;
        found[out + 2] = 0.0;
        found[out + 3] = -1.0;
        return;
    }

    float mean;
    float spread;
    patch_of(ours, x, y, mean, spread);

    // A featureless patch cannot be matched and does not need to be: with nothing varying across it
    // every offset reads the same colour, so a shift costs nothing. Rejecting these would throw
    // away exactly the even surfaces the colour fit most wants.
    if (spread < pc.flat_patch) {
        found[out] = 0.0;
        found[out + 1] = 0.0;
        found[out + 2] = 1.0;
        found[out + 3] = 1.0;
        return;
    }

    // **The centre in `theirs`, not a bound on the window.** A caller that already believes an
    // offset may believe one of any size - a panorama's frames overlap by a third of a frame -
    // and clamping it into the window would search around the point instead, which is not where
    // the content is. The host admitted this point on the window holding `PATCH + SEARCH` about
    // `at + given`, so that is how far the reads below are known to be inside both planes.
    var centre_x = x;
    var centre_y = y;
    if (pc.has_given != 0) {
        centre_x += given[2 * point];
        centre_y += given[2 * point + 1];
    }
    // Whatever `refine` allows, and never wider than the window the host reserved.
    let reach = pc.refine >= 0 ? min(pc.refine, pc.search) : pc.search;

    var best_x = 0;
    var best_y = 0;
    var peak = -1e30;
    for (int oy = -reach; oy <= reach; oy++) {
        for (int ox = -reach; ox <= reach; ox++) {
            let score = score_at(x, y, mean, spread, centre_x + ox, centre_y + oy);
            // Ties go to the smaller shift: the geometry fit is meant to have brought these
            // together already, so where two offsets explain the patch equally the one that moves
            // less is the one to believe.
            let nearer = abs(ox) + abs(oy) < abs(best_x) + abs(best_y);
            if (score > peak || (score == peak && nearer)) {
                peak = score;
                best_x = ox;
                best_y = oy;
            }
        }
    }

    // The four neighbours of the peak, re-scored rather than kept from the scan: keeping them
    // would be an array the offsets index, which a shader puts in scratch.
    //
    // Only where the search was allowed to reach the neighbour, since a peak on the edge of the
    // window has no evidence about the offset beyond it - and beyond the window is where the
    // host stopped reserving readable plane.
    var sub_x = 0.0;
    var sub_y = 0.0;
    if (abs(best_x) < reach) {
        sub_x = sub_pixel(
            score_at(x, y, mean, spread, centre_x + best_x - 1, centre_y + best_y),
            peak,
            score_at(x, y, mean, spread, centre_x + best_x + 1, centre_y + best_y));
    }
    if (abs(best_y) < reach) {
        sub_y = sub_pixel(
            score_at(x, y, mean, spread, centre_x + best_x, centre_y + best_y - 1),
            peak,
            score_at(x, y, mean, spread, centre_x + best_x, centre_y + best_y + 1));
    }

    // Relative to the point, so a caller reads one number whether or not it handed in a belief.
    found[out] = float(centre_x - x + best_x) + sub_x;
    found[out + 1] = float(centre_y - y + best_y) + sub_y;
    found[out + 2] = peak;
    // Below the floor the host has no correspondence to act on, which the last slot says: -1 for
    // unmatched, 0 for found, 1 for a patch too flat to have searched.
    found[out + 3] = peak >= pc.match_min ? 0.0 : -1.0;
}
