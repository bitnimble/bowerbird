// GALOSH's half-resolution colour terms as the pyramid's first two levels, beside the denoised
// luma that guides them: plane 0 the guide, planes 1 to 3 the colour.
import pyramid;

[vk::binding(0, 0)] StructuredBuffer<float> guide;
[vk::binding(1, 0)] StructuredBuffer<float> c1;
[vk::binding(2, 0)] StructuredBuffer<float> c2;
[vk::binding(3, 0)] StructuredBuffer<float> c3;
[vk::binding(4, 0)] RWStructuredBuffer<float> sites;
[vk::binding(5, 0)] RWStructuredBuffer<float> below;

struct Push {
    int w0;
    int h0;
    int w1;
    int h1;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

float4 site_at(int x, int y)
{
    let at = y * pc.w0 + x;
    return float4(guide[at], c1[at], c2[at], c3[at]);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_gather(uint3 id : SV_DispatchThreadID)
{
    let cx = int(id.x);
    let cy = int(id.y);
    if (cx >= pc.w1 || cy >= pc.h1) { return; }

    var mean = float4(0.0);
    for (int j = 0; j < 2; j++) {
        for (int i = 0; i < 2; i++) {
            let x = 2 * cx + i;
            let y = 2 * cy + j;
            let site = site_at(min(x, pc.w0 - 1), min(y, pc.h0 - 1));
            mean += site;
            if (x < pc.w0 && y < pc.h0) {
                for (int p = 0; p < PLANES; p++) {
                    sites[at_plane(p, x, y, pc.w0, pc.h0)] = site[p];
                }
            }
        }
    }
    for (int p = 0; p < PLANES; p++) {
        below[at_plane(p, cx, cy, pc.w1, pc.h1)] = 0.25 * mean[p];
    }
}
