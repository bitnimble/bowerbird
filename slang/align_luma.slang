// Sum each Bayer period into one alignment sample, then box-reduce its pyramid.
// Every block sees each filter once, so a one-photosite shift moves the same scene content
// without making the compared planes differ by filter colour.
// A frame's luma is carried into the reference's light by its exposure gain.

import light;
import clipped;

struct Params {
    uint width;
    uint height;
    uint output_width;
    uint output_height;
    float gain;
    float ceiling0;
    float ceiling1;
    float ceiling2;
    float ceiling3;
    uint tile;
    uint pad1;
    uint pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> input;
[vk::binding(2, 0)] RWStructuredBuffer<float> output;

// Below the level a channel saturates at, since a sensor bends before it stops.
bool saturated(uint x, uint y, float value)
{
    let at = (y & 1) * 2 + (x & 1);
    let ceiling = at == 0 ? params.ceiling0 : at == 1 ? params.ceiling1 : at == 2 ? params.ceiling2 : params.ceiling3;
    return at_ceiling(value, ceiling);
}

[shader("compute")]
[numthreads(8, 8, 1)]
void block_luma(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let x = gid.x * 2;
    let y = gid.y * 2;
    let x1 = min(x + 1, params.width - 1);
    let y1 = min(y + 1, params.height - 1);
    let a = input[y * params.width + x];
    let b = input[y * params.width + x1];
    let c = input[y1 * params.width + x];
    let d = input[y1 * params.width + x1];
    let blown = saturated(x, y, a) || saturated(x1, y, b) || saturated(x, y1, c) || saturated(x1, y1, d);
    output[gid.y * params.output_width + gid.x] = blown ? CLIPPED
        : measured<Level>(params.gain * (a + b + c + d)).v;
}

// A 1-4-6-4-1 binomial gives each parity of a row half its weight, so every site's luma weighs
// red, green and blue alike whatever filter the site itself carries.
static const float BINOMIAL[5] = { 1.0, 4.0, 6.0, 4.0, 1.0 };

[shader("compute")]
[numthreads(8, 8, 1)]
void site_luma(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    float sum = 0.0;
    bool blown = false;
    [ForceUnroll]
    for (int j = 0; j < 5; j++) {
        let y = uint(clamp(int(gid.y) + j - 2, 0, int(params.height) - 1));
        [ForceUnroll]
        for (int i = 0; i < 5; i++) {
            let x = uint(clamp(int(gid.x) + i - 2, 0, int(params.width) - 1));
            let value = input[y * params.width + x];
            blown = blown || saturated(x, y, value);
            sum += BINOMIAL[j] * BINOMIAL[i] * value;
        }
    }
    output[gid.y * params.output_width + gid.x] = blown ? CLIPPED
        : measured<Level>(params.gain * sum / 256.0).v;
}

// Per tile of a luma plane: the energy of its Laplacian, then its variance. Their ratio is how
// much of a frame's contrast is fine detail, which an exposure scales out of.
[shader("compute")]
[numthreads(8, 8, 1)]
void detail(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.output_width || gid.y >= params.output_height) { return; }
    let size = int(params.tile);
    let width = int(params.width);
    float n = 0.0;
    float sum = 0.0;
    float squares = 0.0;
    float fine = 0.0;
    for (int j = 0; j < size; j++) {
        let y = int(gid.y) * size + j;
        if (y < 1 || y >= int(params.height) - 1) { continue; }
        for (int i = 0; i < size; i++) {
            let x = int(gid.x) * size + i;
            if (x < 1 || x >= width - 1) { continue; }
            let at = y * width + x;
            let centre = input[at];
            let left = input[at - 1];
            let right = input[at + 1];
            let above = input[at - width];
            let below = input[at + width];
            if (!usable(centre) || !usable(left) || !usable(right) || !usable(above) || !usable(below)) { continue; }
            let laplacian = centre - 0.25 * (left + right + above + below);
            n += 1.0;
            sum += centre;
            squares += centre * centre;
            fine += laplacian * laplacian;
        }
    }
    let cell = (gid.y * params.output_width + gid.x) * 2;
    output[cell] = fine;
    output[cell + 1] = n > 0.0 ? squares - sum * sum / n : 0.0;
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
    let a = input[y * params.width + x];
    let b = input[y * params.width + x1];
    let c = input[y1 * params.width + x];
    let d = input[y1 * params.width + x1];
    let whole = usable(a) && usable(b) && usable(c) && usable(d);
    output[gid.y * params.output_width + gid.x] = whole
        ? measured<Level>(0.25 * (a + b + c + d)).v : CLIPPED;
}
