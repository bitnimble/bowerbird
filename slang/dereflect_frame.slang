// The reflection remover's way into a frame and back out: the shrunk frame's white, the network's
// input planes with the brush drawn into them, and the predicted reflection taken out of a window
// of the frame at full size, in linear light.

import packed;
import px;
import times;

struct Params {
    /// Threads a dispatch row, for the index past 65535 workgroups.
    uint span;
    uint count;
    /// The frame bound: the shrunk one, or the window the reflection comes out of.
    uint width;
    uint height;
    /// The network's plane, the shrunk frame padded out to whole multiples of 16.
    uint plane_width;
    uint plane_height;
    uint looked_width;
    uint looked_height;
    /// Where the window sits in the whole frame, and the whole frame's size, in the window's pixels.
    uint origin_x;
    uint origin_y;
    uint full_width;
    uint full_height;
    uint segments;
    /// The running count the white's quantile is crossed at.
    uint white_mark;
    /// The share of the reflection taken out.
    float strength;
    float coding_floor;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Scene-linear samples, interleaved RGB, two to a word.
[vk::binding(0, 0)] RWStructuredBuffer<uint> frame;
/// The network's planes, `[C][plane_height][plane_width]`: its input, or its coded answer.
[vk::binding(1, 0)] RWStructuredBuffer<float> planes;
[vk::binding(2, 0)] RWStructuredBuffer<Atomic<uint> > histogram;
/// The brush as segments, each `x0, y0, x1, y1, radius, kind` on the `Looked` plane.
[vk::binding(3, 0)] StructuredBuffer<float> segments;
/// The shrunk frame's white, in levels.
[vk::binding(4, 0)] RWStructuredBuffer<float> white;

static const uint THREADS = 64;
static const uint LEVEL_BINS = 65536;
static const uint SEGMENT = 6;
static const uint HINTS = 2;
/// How far a stroke's edge fades, as a share of its radius: the middle of what training drew.
static const float BRUSH_SOFTNESS = 0.2;

uint index(uint3 id)
{
    return id.y * pc.span + id.x;
}

float level_at(uint sample)
{
    return level_of(half_of(frame[sample >> 1], sample));
}

float3 pixel_at(uint x, uint y)
{
    let first = wide_at<Looked>(x, y, measured<Looked>(pc.width)) * 3;
    return float3(level_at(first), level_at(first + 1), level_at(first + 2));
}

float stabilise(float x)
{
    return sqrt(x + pc.coding_floor) - sqrt(pc.coding_floor);
}

float unstabilise(float coded)
{
    let root = coded + sqrt(pc.coding_floor);
    return root * root - pc.coding_floor;
}

/// One count per pixel of the shrunk frame, of its channels' mean, binned by its half's bits.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void white_count(uint3 id: SV_DispatchThreadID)
{
    let p = index(id);
    if (p >= pc.count) { return; }
    let rgb = pixel_at(p % pc.width, p / pc.width);
    histogram[bits_of(max((rgb.r + rgb.g + rgb.b) / 3.0, 0.0))].add(1);
}

/// The walk up the bins to the white's quantile.
[shader("compute")]
[numthreads(1, 1, 1)]
void white_find()
{
    var seen = 0u;
    var found = LEVEL_BINS - 1;
    for (uint bin = 0u; bin < LEVEL_BINS; bin++) {
        seen += histogram[bin].load();
        if (seen >= pc.white_mark) {
            found = bin;
            break;
        }
    }
    // Never bin 0: a frame black at its quantile would divide the network's input by nothing.
    white[0] = level_of(max(found, 1u));
}

/// How much of a stroke covers the point `p`, as training drew one: a capsule whose edge fades
/// over `BRUSH_SOFTNESS` of its radius.
float covered(float2 p, uint segment)
{
    let at = segment * SEGMENT;
    let a = float2(segments[at], segments[at + 1]);
    let b = float2(segments[at + 2], segments[at + 3]);
    let radius = segments[at + 4];
    let along = b - a;
    let reach = dot(along, along);
    let t = reach > 0.0 ? clamp(dot(p - a, along) / reach, 0.0, 1.0) : 0.0;
    let distance = length(p - a - t * along);
    return 1.0 / (1.0 + exp(-(radius - distance) / (BRUSH_SOFTNESS * radius)));
}

/// The network's input: the shrunk frame over its white, coded, its edge repeated out to the
/// plane's, then the brush's planes.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void ingest(uint3 id: SV_DispatchThreadID)
{
    let p = index(id);
    if (p >= pc.count) { return; }
    let x = p % pc.plane_width;
    let y = p / pc.plane_width;
    let light = pixel_at(min(x, pc.looked_width - 1), min(y, pc.looked_height - 1)) / white[0];
    let plane = pc.plane_width * pc.plane_height;
    planes[p] = stabilise(light.r);
    planes[plane + p] = stabilise(light.g);
    planes[2 * plane + p] = stabilise(light.b);
    float brushed[HINTS] = { 0.0, 0.0 };
    let centre = float2(float(x) + 0.5, float(y) + 0.5);
    for (uint s = 0; s < pc.segments; s++) {
        let kind = uint(segments[s * SEGMENT + 5]);
        brushed[kind] = max(brushed[kind], covered(centre, s));
    }
    planes[times(plane, 3) + p] = brushed[0];
    planes[4 * plane + p] = brushed[1];
}

/// The network's coded reflection at a point of the `Looked` plane, as linear light over white,
/// bilinear as `F.interpolate(align_corners=False)` enlarges it.
float reflection(float2 at, uint channel)
{
    let w = pc.looked_width;
    let h = pc.looked_height;
    let fx = max(at.x, 0.0);
    let fy = max(at.y, 0.0);
    let x0 = min(uint(fx), w - 1);
    let y0 = min(uint(fy), h - 1);
    let x1 = min(x0 + 1, w - 1);
    let y1 = min(y0 + 1, h - 1);
    let wx = fx - float(x0);
    let wy = fy - float(y0);
    let first = channel * pc.plane_width * pc.plane_height;
    let top = tap(first, x0, y0) * (1.0 - wx) + tap(first, x1, y0) * wx;
    let bottom = tap(first, x0, y1) * (1.0 - wx) + tap(first, x1, y1) * wx;
    return top * (1.0 - wy) + bottom * wy;
}

float tap(uint first, uint x, uint y)
{
    return max(unstabilise(planes[first + y * pc.plane_width + x]), 0.0);
}

/// The reflection taken out of each sample of a window of the frame, in place, never below black.
/// One thread a word of the window.
[shader("compute")]
[numthreads(THREADS, 1, 1)]
void take_out(uint3 id: SV_DispatchThreadID)
{
    let word = index(id);
    if (word >= pc.count) { return; }
    let samples = wide<Drawn>(pc.width * pc.height) * 3;
    let full_width = measured<Drawn>(pc.full_width);
    let full_height = measured<Drawn>(pc.full_height);
    let looked_width = exact<Looked>(pc.looked_width);
    let looked_height = exact<Looked>(pc.looked_height);
    var packed = frame[word];
    for (uint part = 0; part < 2; part++) {
        let sample = 2 * word + part;
        if (sample >= samples) { continue; }
        let pixel = sample / 3;
        let channel = sample - times(pixel, 3);
        let place = float2(float(pc.origin_x + pixel % pc.width), float(pc.origin_y + pixel / pc.width));
        let looked = float2(
            onto(place.x + 0.5, full_width, looked_width),
            onto(place.y + 0.5, full_height, looked_height)) - 0.5;
        let taken = reflection(looked, channel) * white[0] * pc.strength;
        let level = level_of(half_of(packed, sample));
        let bits = bits_of(level - clamp(taken, 0.0, max(level, 0.0)));
        packed = part == 0 ? (packed & 0xffff0000) | bits : (packed & 0xffff) | (bits << 16);
    }
    frame[word] = packed;
}
