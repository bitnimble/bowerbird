// Sum each Bayer period into one alignment sample, then box-reduce its pyramid.
// Every block sees each filter once, so a one-photosite shift moves the same scene content
// without making the compared planes differ by filter colour.

import light;

struct Params {
    uint width;
    uint height;
    uint output_width;
    uint output_height;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> input;
[vk::binding(2, 0)] RWStructuredBuffer<float> output;

[shader("compute")]
[numthreads(8, 8, 1)]
void block_luma(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let x = gid.x * 2;
    let y = gid.y * 2;
    let x1 = min(x + 1, params.width - 1);
    let y1 = min(y + 1, params.height - 1);
    output[gid.y * params.output_width + gid.x] = measured<Level>(
        input[y * params.width + x] + input[y * params.width + x1]
        + input[y1 * params.width + x] + input[y1 * params.width + x1]).v;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void reduce_luma(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let x = gid.x * 2;
    let y = gid.y * 2;
    let x1 = min(x + 1, params.width - 1);
    let y1 = min(y + 1, params.height - 1);
    output[gid.y * params.output_width + gid.x] = measured<Level>(0.25 * (
        input[y * params.width + x] + input[y * params.width + x1]
        + input[y1 * params.width + x] + input[y1 * params.width + x1])).v;
}
