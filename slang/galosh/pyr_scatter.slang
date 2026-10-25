// The pyramid's colour planes fused with the level below and handed back as GALOSH's three
// half-resolution colour terms.
import pyramid;

[vk::binding(0, 0)] StructuredBuffer<float> sites;
[vk::binding(1, 0)] StructuredBuffer<float> boxed;
[vk::binding(2, 0)] StructuredBuffer<float> below;
[vk::binding(3, 0)] RWStructuredBuffer<float> c1;
[vk::binding(4, 0)] RWStructuredBuffer<float> c2;
[vk::binding(5, 0)] RWStructuredBuffer<float> c3;

struct Push {
    int w0;
    int h0;
    int w1;
    int h1;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

float fused(int p, int x, int y)
{
    return sites[at_plane(p, x, y, pc.w0, pc.h0)]
        + upsampled_difference(below, boxed, p, x, y, pc.w1, pc.h1);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_scatter(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.w0 || y >= pc.h0) { return; }
    let at = y * pc.w0 + x;
    c1[at] = fused(1, x, y);
    c2[at] = fused(2, x, y);
    c3[at] = fused(3, x, y);
}
