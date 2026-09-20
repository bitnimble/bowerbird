// A spot or a thing the reader removed, filled from elsewhere in the same frame (`repair.rs`).
//
// **Every position here is already in this buffer's pixels.** A repair is stored on the
// `px::Stored` grid and the host maps it onto whichever frame this is - the editor's, a rendition
// at its own size, a loupe's window - so the arithmetic below is the same at every size and names
// no constant in any space.
//
// **The fill is read from a copy taken before any repair ran** (`band`), so two repairs never read
// each other's work and the order they are drawn in decides only which one is on top where they
// overlap.
//
// Mixed in light, through `light_of_code` and back through its own search, for `reduce.slang`'s
// reason: a weighted sum of PQ codes is a number no photograph has.
import lanes;
import packed;
import prelude;
import seam_weight;

struct Params {
    /// The buffer's own width and height.
    uint2 size;
    /// The first pixel this dispatch covers, which is even, and how many follow it.
    uint first;
    uint pixels;
    /// Where the fill is read, from where it lands.
    int2 donor;
    uint vertices;
    /// The sample `band` starts at, which is even, and how many it holds.
    uint band_first;
    uint band_samples;
    /// What the fill's light is multiplied by.
    float gain;
    /// How far either side of the seam the fill fades across: all of it this far inside, none
    /// this far outside.
    float feather;
    /// `repair_cells`: the side of a cell, how many cells across and down, and where the first one
    /// starts.
    uint cell;
    uint2 cells;
    uint2 origin;
    /// The whole picture, `(left, top, right, bottom)`, in this buffer's pixels.
    float4 picture;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
[vk::binding(2, 0)] StructuredBuffer<uint> band;
/// `reduce.slang`'s table: the frame's light per code, normalised so the largest code is one.
[vk::binding(3, 0)] StructuredBuffer<float> light_of_code;
/// The seam, one vertex a pair of floats.
[vk::binding(4, 0)] StructuredBuffer<float> seam;
/// `repair_cells`: a cell's log2 light and its two log2 colour ratios.
[vk::binding(5, 0)] RWStructuredBuffer<float> cells;

/// `assembly_seam::NOT_REACHED`, for a cell no pixel of the frame falls in.
static const float NOT_REACHED = -1e30;

/// The least light a cell is read as, normalised as `light_of_code` is: fourteen stops under the
/// largest code, well below any diffuse white. A cell of black would otherwise be a log of zero,
/// and two cells of noise in the shadows would disagree by as many stops as a face and a wall.
static const float DARKEST = 0.00006103515625;

/// `reduce.slang`'s `code_of_light`, over the same table: the nearest code to a light, exactly, so
/// a fill of gain one lands on the code it was read from.
uint code_of_light(float light)
{
    uint lo = 0;
    uint hi = 65535;
    while (lo < hi) {
        let mid = (lo + hi) / 2;
        if (light_of_code[mid] < light) { lo = mid + 1; } else { hi = mid; }
    }
    if (lo > 0 && light - light_of_code[lo - 1] < light_of_code[lo] - light) {
        return lo - 1;
    }
    return lo;
}

float2 vertex(uint at)
{
    return float2(seam[at * 2], seam[at * 2 + 1]);
}

/// Whether `a` to `b` runs along one of the picture's edges.
bool on_the_border(float2 a, float2 b)
{
    let near = 0.01;
    let low = params.picture.xy;
    let high = params.picture.zw;
    return (abs(a.x - low.x) < near && abs(b.x - low.x) < near)
        || (abs(a.x - high.x) < near && abs(b.x - high.x) < near)
        || (abs(a.y - low.y) < near && abs(b.y - low.y) < near)
        || (abs(a.y - high.y) < near && abs(b.y - high.y) < near);
}

/// How far inside the seam `p` is, and negative outside it: the even-odd rule for which side, and
/// the nearest edge for how far.
///
/// An edge along the picture's border is not a seam, since nothing is past it to blend with: a
/// removal reaching the border is filled right up to it rather than faded to half there.
float depth(float2 p)
{
    var nearest = 1e30;
    var inside = false;
    var before = params.vertices - 1;
    for (uint at = 0; at < params.vertices; at++) {
        let a = vertex(before);
        let b = vertex(at);
        before = at;
        if ((b.y > p.y) != (a.y > p.y)) {
            let crossing = a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x);
            if (p.x < crossing) { inside = !inside; }
        }
        if (on_the_border(a, b)) { continue; }
        let along = b - a;
        let t = clamp(dot(p - a, along) / max(dot(along, along), 1e-12), 0.0, 1.0);
        nearest = min(nearest, length(p - (a + t * along)));
    }
    return select(inside, nearest, -nearest);
}

/// One pixel's three codes, with the fill mixed in where the seam reaches it.
uint3 repaired(uint pixel, uint3 codes)
{
    let x = pixel % params.size.x;
    let y = pixel / params.size.x;
    let weight = smooth_between(params.feather, depth(float2(float(x) + 0.5, float(y) + 0.5)));
    if (weight <= 0.0) { return codes; }
    let from = int2(int(x), int(y)) + params.donor;
    if (any(from < int2(0)) || any(from >= int2(params.size))) { return codes; }
    let sample = (uint(from.y) * params.size.x + uint(from.x)) * 3;
    if (sample < params.band_first || sample + 3 > params.band_first + params.band_samples) {
        return codes;
    }
    let at = sample - params.band_first;
    var out = codes;
    for (uint channel = 0; channel < 3; channel++) {
        let here = light_of_code[codes[channel]];
        let there = light_of_code[half_of(band[(at + channel) / 2], at + channel)] * params.gain;
        out[channel] = code_of_light(lerp(here, there, weight));
    }
    return out;
}

/// One repair, over the run of pixels its seam's bounds cover.
///
/// Two pixels an invocation, for `reduce.slang`'s `resize` reason: three samples do not fill a
/// whole number of words and two pixels do, so a pixel an invocation would share a word with its
/// neighbour and one of the two writes would be lost.
[shader("compute")]
[numthreads(64, 1, 1)]
void repair(uint3 id : SV_DispatchThreadID)
{
    let pair = linear(id);
    if (pair * 2 >= params.pixels) { return; }
    let first = params.first + pair * 2;
    let total = params.size.x * params.size.y;
    if (first >= total) { return; }

    let word = first * 3 / 2;
    let w0 = frame[word];
    let w1 = frame[word + 1];
    let a = repaired(first, uint3(w0 & 0xffff, w0 >> 16, w1 & 0xffff));
    if (first + 1 < total) {
        let w2 = frame[word + 2];
        let b = repaired(first + 1, uint3(w1 >> 16, w2 & 0xffff, w2 >> 16));
        frame[word] = a.x | (a.y << 16);
        frame[word + 1] = a.z | (b.x << 16);
        frame[word + 2] = b.y | (b.z << 16);
    } else {
        frame[word] = a.x | (a.y << 16);
        frame[word + 1] = a.z | (w1 & 0xffff0000);
    }
}

/// The field the solve searches: the frame averaged over square cells, as log2 light and the two
/// log2 colour ratios `assembly_seam::SeamField` holds, which is what `patch_search` compares.
[shader("compute")]
[numthreads(8, 8, 1)]
void repair_cells(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= params.cells.x || id.y >= params.cells.y) { return; }
    let start = params.origin + id.xy * params.cell;
    let end = min(start + uint2(params.cell), params.size);
    var sum = float3(0.0);
    var count = 0.0;
    for (uint y = start.y; y < end.y; y++) {
        for (uint x = start.x; x < end.x; x++) {
            let base = (y * params.size.x + x) * 3;
            sum += float3(
                light_of_code[half_of(frame[base / 2], base)],
                light_of_code[half_of(frame[(base + 1) / 2], base + 1)],
                light_of_code[half_of(frame[(base + 2) / 2], base + 2)]);
            count += 1.0;
        }
    }
    let at = (id.y * params.cells.x + id.x) * 3;
    if (count == 0.0) {
        cells[at] = NOT_REACHED;
        cells[at + 1] = 0.0;
        cells[at + 2] = 0.0;
        return;
    }
    let mean = max(sum / count, float3(DARKEST));
    cells[at] = log2(dot(LUMA, mean));
    cells[at + 1] = log2(mean.r / mean.g);
    cells[at + 2] = log2(mean.b / mean.g);
}
