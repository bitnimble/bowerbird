// A level's low band handed to the level below, which saw it with a quarter of the noise: what
// the level kept of its own box is swapped for what the level below made of it.
import pyramid;

[vk::binding(0, 0)] RWStructuredBuffer<float> level;
[vk::binding(1, 0)] StructuredBuffer<float> boxed;
[vk::binding(2, 0)] StructuredBuffer<float> below;

struct Push {
    int w;
    int h;
    int below_w;
    int below_h;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void pyr_fuse(uint3 id : SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.w || y >= pc.h) { return; }
    for (int p = 0; p < PLANES; p++) {
        level[at_plane(p, x, y, pc.w, pc.h)] +=
            upsampled_difference(below, boxed, p, x, y, pc.below_w, pc.below_h);
    }
}
