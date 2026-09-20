// Corners of a frame, and what each one looks like, so two frames can be matched by content rather
// than by where a search was told to look.
//
// **The one thing a correlation search cannot do is say a match is unique.** Everything else the
// panorama measures asks how *well* two places agree, and a row of windows agrees with the row above
// it perfectly - so a scene that repeats answers a search confidently and wrongly, and no threshold
// on the answer separates the two. What separates them is asking how well the *second* best place
// agrees: Lowe's ratio test, which needs a description of a point good enough to compare against
// every point of the other frame rather than against the few a window holds.
//
// One thread per bucket for the detector, so the picture is walked here and what reaches the host is
// one candidate per bucket rather than a response per pixel. Spreading the corners over buckets is
// also what stops a detector handing back four hundred points of the same railing.

import px;

struct Push {
    int width;
    int height;
    /// How wide a square each thread keeps the best corner of.
    int bucket;
    /// Buckets across, so a thread can find its own.
    int across;
    /// How many points `describe` was given.
    int points;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[vk::binding(0, 0)] StructuredBuffer<float> plane;
/// Three floats a bucket: the corner response, then where it was.
[vk::binding(1, 0)] RWStructuredBuffer<float> corners;
/// Two ints a point, as `corners` reduced and chosen by the host.
[vk::binding(2, 0)] StructuredBuffer<int> at;
/// `SIDE * SIDE` floats a point.
[vk::binding(3, 0)] RWStructuredBuffer<float> described;

/// How far either way the structure tensor is summed.
static const int GRADIENT = 2;

/// Harris' own constant, and everybody's.
static const float HARRIS_K = 0.04;

/// The window a descriptor covers, and how many samples it reduces that to a side.
///
/// Thirty-three pixels holds several storeys of a facade where a seven-pixel correlation window
/// holds part of one, which is the whole point: what makes two rows of windows different is what
/// surrounds them. Eight by eight of it is sixty-four numbers, small enough that matching every
/// point of one frame against every point of another is a host loop over descriptors rather than a
/// second search over pixels.
///
/// **A share of the plane and not a count of its pixels**, because that reasoning is about
/// *picture* and this plane's size is the caller's: `composite_align::Kind` searches a burst on
/// half the long edge a pan gets, and a fixed sixteen would describe twice as much facade there -
/// and exclude twice as much of the frame's border from being matched at all. A sixteenth of a
/// hundredth resolves to exactly the sixteen this was tuned at on a 1616px plane.
static const Share REACH_OF_LONG = { 16.0 / 1616.0 };
static const int SIDE = 8;

/// That share in this plane's own pixels. Hoisted per entry rather than computed per sample, and a
/// plain `int` from there: `px.slang` says a struct constant under a loop is a call Metal drops.
int reach()
{
    return int(REACH_OF_LONG.over(measured<Search>(uint(max(pc.width, pc.height)))).n);
}

float at_pixel(int x, int y)
{
    let cx = clamp(x, 0, pc.width - 1);
    let cy = clamp(y, 0, pc.height - 1);
    return plane[cy * pc.width + cx];
}

/// Harris' corner response at a point: how much the structure tensor says the content varies in
/// *both* directions, which an edge fails and a corner passes.
float response_at(int x, int y)
{
    var xx = 0.0;
    var yy = 0.0;
    var xy = 0.0;
    for (int dy = -GRADIENT; dy <= GRADIENT; dy++) {
        for (int dx = -GRADIENT; dx <= GRADIENT; dx++) {
            let ix = 0.5 * (at_pixel(x + dx + 1, y + dy) - at_pixel(x + dx - 1, y + dy));
            let iy = 0.5 * (at_pixel(x + dx, y + dy + 1) - at_pixel(x + dx, y + dy - 1));
            xx += ix * ix;
            yy += iy * iy;
            xy += ix * iy;
        }
    }
    let trace = xx + yy;
    return (xx * yy - xy * xy) - HARRIS_K * trace * trace;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void composite_corners(uint3 id: SV_DispatchThreadID)
{
    let bucket = int(id.x);
    let rows = (pc.height + pc.bucket - 1) / pc.bucket;
    if (bucket >= pc.across * rows) { return; }
    let down = bucket / pc.across;
    let across = bucket % pc.across;
    let out = 3 * bucket;
    corners[out] = -1e30;
    corners[out + 1] = 0.0;
    corners[out + 2] = 0.0;

    // A descriptor has to fit, so a corner nearer the edge than its own window is no use.
    let edge = reach();
    let from_x = max(across * pc.bucket, edge);
    let from_y = max(down * pc.bucket, edge);
    let to_x = min((across + 1) * pc.bucket, pc.width - edge);
    let to_y = min((down + 1) * pc.bucket, pc.height - edge);
    if (from_x >= to_x || from_y >= to_y) { return; }

    var best = -1e30;
    var best_x = from_x;
    var best_y = from_y;
    for (int y = from_y; y < to_y; y++) {
        for (int x = from_x; x < to_x; x++) {
            let response = response_at(x, y);
            if (response > best) {
                best = response;
                best_x = x;
                best_y = y;
            }
        }
    }
    corners[out] = best;
    corners[out + 1] = float(best_x);
    corners[out + 2] = float(best_y);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void composite_describe(uint3 id: SV_DispatchThreadID)
{
    let point = int(id.x);
    if (point >= pc.points) { return; }
    let x = at[2 * point];
    let y = at[2 * point + 1];
    let out = SIDE * SIDE * point;

    // The window, reduced to one sample a cell. A mean over the cell rather than a tap, so the
    // description is of the content and not of where the grid happened to land on it.
    //
    // Both hoisted above the loop, `px.slang` having measured what a struct constant under one
    // costs; and `step` floored at one, so a plane small enough that the window is under eight
    // pixels still samples every cell rather than dividing to nothing.
    let edge = reach();
    let step = max((2 * edge) / SIDE, 1);
    var sum = 0.0;
    for (int cell = 0; cell < SIDE * SIDE; cell++) {
        let cy = cell / SIDE;
        let cx = cell % SIDE;
        var total = 0.0;
        for (int dy = 0; dy < step; dy++) {
            for (int dx = 0; dx < step; dx++) {
                total += at_pixel(x - edge + cx * step + dx, y - edge + cy * step + dy);
            }
        }
        let mean = total / float(step * step);
        described[out + cell] = mean;
        sum += mean;
    }

    // Zero-mean and unit length, so a dot product between two of these is their correlation and a
    // frame being darker than its neighbour costs nothing.
    let mean = sum / float(SIDE * SIDE);
    var spread = 0.0;
    for (int cell = 0; cell < SIDE * SIDE; cell++) {
        described[out + cell] -= mean;
        spread += described[out + cell] * described[out + cell];
    }
    let scale = spread > 1e-12 ? 1.0 / sqrt(spread) : 0.0;
    for (int cell = 0; cell < SIDE * SIDE; cell++) {
        described[out + cell] *= scale;
    }
}
