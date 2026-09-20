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


[shader("compute")]
[numthreads(16, 16, 1)]
void patch_stats(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }
    let out = 2 * (y * pc.width + x);

    // Zero where the window would leave the plane, exactly as the host leaves it. Every caller
    // guards `holds(x, y, PATCH + SEARCH)` before it searches, so nothing reads these.
    let patch = pc.patch;
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
            sum += plane[(y + dy) * pc.width + (x + dx)];
            count += 1.0;
        }
    }
    let mean = sum / count;
    var deviation = 0.0;
    for (int dy = -patch; dy <= patch; dy++) {
        for (int dx = -patch; dx <= patch; dx++) {
            let d = plane[(y + dy) * pc.width + (x + dx)] - mean;
            deviation += d * d;
        }
    }
    stats[out] = mean;
    stats[out + 1] = deviation;
}
