// Every patch statistic a dense search will ask for, worked out once per pixel.
//
// The tabulated form `DevicePlane::tabulate` builds, which is what makes a dense search cheap: a
// correlation needs the camera plane's patch mean and spread at all 81 offsets around every point,
// and at stride 1 each of those windows shares 72 of its 49 samples with the window next door.
// Recomputing them inside the offset loop costs a point 81 x 98 taps where reading them costs 81
// loads.
//
// **Not for a sparse search.** `registration` asks about 6000 points on a stride of 13, so its
// windows never touch and tabulating the plane is 3.3M pixels of work for 486k lookups. Which is
// why `correspond` takes it as a specialisation constant rather than always.

struct Push {
    int width;
    int height;
    /// The window `correspond` will compare, which this tabulates the statistics of - so it is the
    /// caller's own number, and a plane tabulated for one width cannot be searched at another.
    int patch;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[vk::binding(0, 0)] StructuredBuffer<float> plane;
/// Two floats a pixel: the mean, then the total squared deviation from it.
[vk::binding(1, 0)] RWStructuredBuffer<float> stats;


static const int TILE = 16;
/// The widest patch whose windows a workgroup holds for itself; a wider one reads `plane` per tap.
static const int MOST_PATCH = 8;
groupshared float held[(TILE + 2 * MOST_PATCH) * (TILE + 2 * MOST_PATCH)];

/// The plane at `(x, y)`, from the workgroup's `span`-wide copy starting at `origin` where it
/// holds one.
float tap(bool tiled, int span, int2 origin, int x, int y)
{
    if (tiled) { return held[(y - origin.y) * span + (x - origin.x)]; }
    return plane[y * pc.width + x];
}

[shader("compute")]
[numthreads(TILE, TILE, 1)]
void patch_stats(uint3 id: SV_DispatchThreadID, uint3 group: SV_GroupID, uint index: SV_GroupIndex)
{
    let patch = pc.patch;
    let tiled = patch <= MOST_PATCH;
    let span = TILE + 2 * patch;
    let origin = int2(group.xy) * TILE - patch;
    if (tiled) {
        for (int k = int(index); k < span * span; k += TILE * TILE) {
            let at = origin + int2(k % span, k / span);
            let inside = all(at >= 0) && at.x < pc.width && at.y < pc.height;
            held[k] = inside ? plane[at.y * pc.width + at.x] : 0.0;
        }
    }
    GroupMemoryBarrierWithGroupSync();

    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }
    let out = 2 * (y * pc.width + x);

    // Zero where the window would leave the plane, exactly as the host leaves it. Every caller
    // guards `holds(x, y, PATCH + SEARCH)` before it searches, so nothing reads these.
    if (x < patch || y < patch || x + patch >= pc.width || y + patch >= pc.height) {
        stats[out] = 0.0;
        stats[out + 1] = 0.0;
        return;
    }

    // Two sweeps in the host's own order rather than one pass of sums and squares: a spread taken
    // as `sum2/n - mean^2` cancels two large numbers against each other, and the values here sit
    // near 0.5 where that cancellation eats most of the significance a flatness test reads.
    var sum = 0.0;
    var count = 0.0;
    for (int dy = -patch; dy <= patch; dy++) {
        for (int dx = -patch; dx <= patch; dx++) {
            sum += tap(tiled, span, origin, x + dx, y + dy);
            count += 1.0;
        }
    }
    let mean = sum / count;
    var deviation = 0.0;
    for (int dy = -patch; dy <= patch; dy++) {
        for (int dx = -patch; dx <= patch; dx++) {
            let d = tap(tiled, span, origin, x + dx, y + dy) - mean;
            deviation += d * d;
        }
    }
    stats[out] = mean;
    stats[out + 1] = deviation;
}
