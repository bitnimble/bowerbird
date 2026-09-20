// Phase 7: a plane copied into one of another size, reads clamped to the source's last row and
// column - so a smaller destination is a top-left crop and a larger one is edge-padded.
//
// `k16_jbu_3p` writes exactly twice its input's dimensions, so an odd level's guide is cropped to
// even on the way in and its output padded back out on the way up.

[vk::binding(0, 0)] StructuredBuffer<float> src;
[vk::binding(1, 0)] RWStructuredBuffer<float> dst;

struct Push {
    int sw;
    int sh;
    int dw;
    int dh;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void copy_2d_clamped(uint3 id : SV_DispatchThreadID)
{
    let dx = int(id.x);
    let dy = int(id.y);
    if (dx >= pc.dw || dy >= pc.dh) { return; }
    let sx = min(dx, pc.sw - 1);
    let sy = min(dy, pc.sh - 1);
    dst[dy * pc.dw + dx] = src[sy * pc.sw + sx];
}
