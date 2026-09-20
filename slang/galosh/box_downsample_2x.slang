// Phase 7: one plane one level down its pyramid.

[vk::binding(0, 0)] StructuredBuffer<float> src;
[vk::binding(1, 0)] RWStructuredBuffer<float> dst;

struct Push {
    int sw;
    int sh;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void box_downsample_2x(uint3 id : SV_DispatchThreadID)
{
    let dw = pc.sw >> 1;
    let dh = pc.sh >> 1;
    let dx = int(id.x);
    let dy = int(id.y);
    if (dx >= dw || dy >= dh) { return; }

    let sx = 2 * dx;
    let sy = 2 * dy;
    let a = src[sy * pc.sw + sx];
    let b = src[sy * pc.sw + (sx + 1)];
    let c = src[(sy + 1) * pc.sw + sx];
    let d = src[(sy + 1) * pc.sw + (sx + 1)];
    dst[dy * dw + dx] = 0.25 * (a + b + c + d);
}
