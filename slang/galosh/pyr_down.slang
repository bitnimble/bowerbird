// One level of the noisy pyramid from the one above it, a 2x2 box apiece: the noise in it is still
// white, at half the deviation.
import pyramid;

[vk::binding(0, 0)] StructuredBuffer<float> fine;
[vk::binding(1, 0)] RWStructuredBuffer<float> coarse;

struct Push {
    int fine_w;
    int fine_h;
    int coarse_w;
    int coarse_h;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_down(uint3 id : SV_DispatchThreadID)
{
    let cx = int(id.x);
    let cy = int(id.y);
    if (cx >= pc.coarse_w || cy >= pc.coarse_h) { return; }

    let x0 = 2 * cx;
    let y0 = 2 * cy;
    let x1 = min(x0 + 1, pc.fine_w - 1);
    let y1 = min(y0 + 1, pc.fine_h - 1);
    for (int p = 0; p < PLANES; p++) {
        let sum = fine[at_plane(p, x0, y0, pc.fine_w, pc.fine_h)]
            + fine[at_plane(p, x1, y0, pc.fine_w, pc.fine_h)]
            + fine[at_plane(p, x0, y1, pc.fine_w, pc.fine_h)]
            + fine[at_plane(p, x1, y1, pc.fine_w, pc.fine_h)];
        coarse[at_plane(p, cx, cy, pc.coarse_w, pc.coarse_h)] = 0.25 * sum;
    }
}
