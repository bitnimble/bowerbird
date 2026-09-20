// The fit's resamplers, where the geometry search's grids are built: the Lanczos3 reduce that
// brings the render and the camera's preview onto a common grid, and the blur the falloff's pair is
// prefiltered with. Both separable - one dispatch an axis, the second reading what the first wrote
// - and both reading either an 8-bit plane held as its own bytes, four samples to a word, or the
// f32 RGB every pass emits.
//
// The Lanczos conventions are `fast_image_resize`'s, which is what `image::resize` reduces a host
// plane by and what the fit's recorded numbers were measured against: on a downscale the support
// scales with the ratio, a source pixel's weight is read at its own centre, the window is truncated
// at the frame's edge rather than extended, and what survives it is normalised to sum to one.
//
// The blur is a stack blur's kernel written out: triangular weights `radius + 1 - |k|` over
// `(radius + 1)^2`, with the edge pixel repeated past the frame, which is what a running triangular
// window arrives at a pixel at a time.
//
// The box beside it is the colour fit's own prefilter, three passes an axis rather than one, and its
// window is truncated at the frame's edge rather than repeated.

struct Params {
    int source_width;
    int source_height;
    int width;
    int height;
    /// 0 resamples along x and passes y through, 1 the other way.
    int axis;
    /// Read `source_bytes` through 1/255 rather than `source`.
    int packed;
    /// Taps either side, which `fit_stack_blur` alone reads.
    int radius;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Interleaved f32 RGB, `source_width` by `source_height`.
[vk::binding(0, 0)] StructuredBuffer<float> source;
/// The same plane 8-bit, four samples to a word.
[vk::binding(4, 0)] StructuredBuffer<uint> source_bytes;
/// `width` by `height`, interleaved f32 RGB.
[vk::binding(2, 0)] RWStructuredBuffer<float> plane;

static const float PI = 3.14159265358979323846;

float component(int index)
{
    if (pc.packed != 0) {
        return float((source_bytes[index >> 2] >> uint(8 * (index & 3))) & 0xff) / 255.0;
    }
    return source[index];
}

float3 at(int x, int y)
{
    let i = (y * pc.source_width + x) * 3;
    return float3(component(i), component(i + 1), component(i + 2));
}

/// One source pixel, `step` along the axis this dispatch resamples and `other` across it.
float3 along(int other, int step)
{
    return pc.axis == 0 ? at(step, other) : at(other, step);
}

void put(int x, int y, float3 rgb)
{
    let i = (y * pc.width + x) * 3;
    // A Lanczos window has negative lobes, so a hard edge overshoots either end of the range and
    // the pass after this one would resample the overshoot.
    plane[i] = clamp(rgb.x, 0.0, 1.0);
    plane[i + 1] = clamp(rgb.y, 0.0, 1.0);
    plane[i + 2] = clamp(rgb.z, 0.0, 1.0);
}

float sinc(float x)
{
    if (x == 0.0) { return 1.0; }
    let t = PI * x;
    return sin(t) / t;
}

float lanczos3(float x)
{
    if (x <= -3.0 || x >= 3.0) { return 0.0; }
    return sinc(x) * sinc(x / 3.0);
}

[shader("compute")]
[numthreads(16, 16, 1)]
void fit_lanczos(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let across = pc.axis == 0 ? y : x;
    let source_size = pc.axis == 0 ? pc.source_width : pc.source_height;
    let scale = float(source_size) / float(pc.axis == 0 ? pc.width : pc.height);
    let filter_scale = max(scale, 1.0);
    let reach = 3.0 * filter_scale;
    let centre = (float(pc.axis == 0 ? x : y) + 0.5) * scale;
    let first = max(int(floor(centre - reach)), 0);
    let last = min(int(ceil(centre + reach)), source_size);

    var acc = float3(0.0);
    var weight = 0.0;
    for (int s = first; s < last; s++) {
        // Source pixel `s` covers `[s, s + 1)`, so its centre stands `s + 0.5 - centre` away.
        let w = lanczos3((float(s) + 0.5 - centre) / filter_scale);
        weight += w;
        acc += w * along(across, s);
    }
    put(x, y, weight != 0.0 ? acc / weight : float3(0.0));
}

[shader("compute")]
[numthreads(16, 16, 1)]
void fit_stack_blur(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let across = pc.axis == 0 ? y : x;
    let here = pc.axis == 0 ? x : y;
    let edge = (pc.axis == 0 ? pc.source_width : pc.source_height) - 1;

    var acc = float3(0.0);
    for (int k = -pc.radius; k <= pc.radius; k++) {
        let w = float(pc.radius + 1 - abs(k));
        acc += w * along(across, clamp(here + k, 0, edge));
    }
    put(x, y, acc / float((pc.radius + 1) * (pc.radius + 1)));
}

/// The colour fit's prefilter, one axis a dispatch: a flat window truncated where it meets the
/// frame's edge and divided by however much of it survived.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_box_blur(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let across = pc.axis == 0 ? y : x;
    let here = pc.axis == 0 ? x : y;
    let count = pc.axis == 0 ? pc.source_width : pc.source_height;
    let lo = max(here - pc.radius, 0);
    let hi = min(here + pc.radius, count - 1);

    var acc = float3(0.0);
    for (int k = lo; k <= hi; k++) {
        acc += along(across, k);
    }
    let out = max(acc / float(hi - lo + 1), float3(0.0));
    // Not `put`: the planes this filters carry scene light above diffuse white, and the clamp a
    // Lanczos pass needs would flatten every highlight in them to one.
    let i = (y * pc.width + x) * 3;
    plane[i] = out.x;
    plane[i + 1] = out.y;
    plane[i + 2] = out.z;
}
