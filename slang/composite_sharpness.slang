// A focus bracket's layer, weighed by how sharp it is at each pixel.
//
// **Local contrast in light, over the layer's own level.** The energy of a Laplacian around the
// pixel, divided by the square of the light it sits on, so a frame is not preferred for being
// brighter there. Raised to a power, which `composite_blend`'s normalising turns into a soft choice
// of the sharpest frame; a floor under it keeps flat ground, where every frame reads the same,
// averaged rather than handed to whichever frame's noise happened to be largest.
import lanes;
import packed;
import prelude;

struct Params {
    uint width;
    uint height;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> layer;
/// Where the source reaches, as the gather wrote it, and where this writes the sharpness over it.
[vk::binding(2, 0)] RWStructuredBuffer<float> weight;
/// The layer's coding undone, as `composite_blend.slang` reads it.
[vk::binding(3, 0)] StructuredBuffer<float> light_of_code;

/// Pixels either side the energy is averaged over. `composite_job::SHARPNESS_HALO` is this and the
/// Laplacian's own one, rounded up to even.
static const int REACH = 2;
/// Contrast, squared, below which every frame is as sharp as the next: a percent.
static const float FLOOR = 1e-4;
/// How hard the sharpest frame wins.
static const float POWER = 2.0;
/// A light below which contrast is not told apart from noise, in the blend's own units: a nit.
static const float DARK = 1e-4;

float luma_at(int x, int y)
{
    let cx = uint(clamp(x, 0, int(params.width) - 1));
    let cy = uint(clamp(y, 0, int(params.height) - 1));
    let base = (cy * params.width + cx) * 3;
    let light = float3(
        light_of_code[half_of(layer[base / 2], base)],
        light_of_code[half_of(layer[(base + 1) / 2], base + 1)],
        light_of_code[half_of(layer[(base + 2) / 2], base + 2)]);
    return dot(LUMA, max(light, float3(0.0)));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void composite_sharpness(uint3 id : SV_DispatchThreadID)
{
    let pixel = linear(id);
    if (pixel >= params.width * params.height) { return; }
    let reach = weight[pixel];
    if (reach <= 0.0) { return; }
    let x = int(pixel % params.width);
    let y = int(pixel / params.width);

    float energy = 0.0;
    float level = 0.0;
    for (int dy = -REACH; dy <= REACH; dy++) {
        for (int dx = -REACH; dx <= REACH; dx++) {
            let here = luma_at(x + dx, y + dy);
            let laplacian = 4.0 * here
                - luma_at(x + dx - 1, y + dy) - luma_at(x + dx + 1, y + dy)
                - luma_at(x + dx, y + dy - 1) - luma_at(x + dx, y + dy + 1);
            energy += laplacian * laplacian;
            level += here;
        }
    }
    let taps = float((2 * REACH + 1) * (2 * REACH + 1));
    let mean = level / taps + DARK;
    weight[pixel] = reach * pow(energy / taps / (mean * mean) + FLOOR, POWER);
}
