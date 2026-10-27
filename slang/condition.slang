// `decode::raw::conditioned` as a kernel: the sensor's samples become the mosaic every later
// stage reads.
//
// **The samples arrive packed two to a `u32`, which is the whole point.** WGSL has no `u16`, so
// the alternative is conditioning on the host and uploading the mosaic as `f32` - twice the
// transfer for a subtract, a divide and a multiply. Packed flat rather than row by row: a frame of
// odd width then has rows straddling word boundaries, and only the frame's own last word is half
// full, where a per-row stride would leave one in every row and shear the picture.
//
// **The conditioning is a table and not the expression, which is not an optimisation.** Vulkan
// requires only 2.5 ULP of `OpFDiv` and RADV takes it, lowering the divide to a reciprocal and a
// multiply - so a shader spelling `(raw - floor) / range * gain` disagrees with the CPU in the last
// bit, and this frame is what every rendition and every later stage is built from. A conditioned
// sample is a function of sixteen bits and a slot, so `decode::raw::curve` evaluates its own
// expression over the whole of that domain and nothing is computed twice.
//
// **A slot is not a position, and on a 6x6 pattern the difference is 33 runs of the table.** What
// the conditioning actually varies by is the pair (black level, white balance gain), and a sensor
// has far fewer of those than it has positions in its period: X-Trans reports one black level
// repeated 36 times, so its 36 positions share three slots - one per colour - where writing a run
// per position would be 9.4MB uploaded for every tile.
import lanes;
import packed;

/// Positions in the largest period carried, which is X-Trans's 6x6 (`crate::cfa::MAX_PERIOD`).
static const uint MAX_SLOTS = 36;

struct Params {
    /// Samples to the row, which is what turns a flat index back into a CFA position.
    uint width;
    /// Samples in the frame, `words * 2` less the odd tail.
    uint count;
    /// The CFA's period: 2 by 2 for Bayer, 6 by 6 for X-Trans.
    uint period_w;
    uint period_h;
    /// Which run of the curve each position of the period reads, deduplicated by the host.
    ///
    /// One per sixteen bytes, because a uniform array strides its elements to sixteen whatever they
    /// are. 576 bytes against a 64KB binding, and no dynamic index into a vector's components.
    uint slot_of[MAX_SLOTS];
    /// The first sample's column and row in the gain maps' image, then that image's width and height.
    int4 frame;
    /// How many gain maps there are, in `x`.
    uint4 shading;
};

/// `condition::GainMap`, as `condition::shading_storage` lays it out.
struct GainMap {
    /// Top, left, bottom, right.
    int4 area;
    /// Row pitch, column pitch, points down, points across.
    uint4 grid;
    /// Spacing down and across, then origin down and across, as fractions of the image.
    float4 placement;
    /// The map's first gain, in `x`.
    uint4 storage;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> words;
[vk::binding(2, 0)] StructuredBuffer<float> curve;
[vk::binding(3, 0)] RWStructuredBuffer<float> mosaic;
[vk::binding(7, 0)] StructuredBuffer<GainMap> gain_maps;
[vk::binding(8, 0)] StructuredBuffer<float> gains;

/// One grid coordinate of dng_sdk's `dng_gain_map_interpolator`: the photosite's centre, held at
/// the grid's first and last points beyond them.
float grid_at(int place, int extent, float origin, float spacing, uint points)
{
    let at = ((float(place) + 0.5) / float(extent) - origin) / spacing;
    return clamp(at, 0.0, float(points - 1));
}

float shading_at(int row, int col)
{
    var gain = 1.0;
    for (uint m = 0; m < params.shading.x; m++) {
        let map = gain_maps[m];
        if (row < map.area.x || row >= map.area.z || col < map.area.y || col >= map.area.w) {
            continue;
        }
        if (uint(row - map.area.x) % map.grid.x != 0 || uint(col - map.area.y) % map.grid.y != 0) {
            continue;
        }
        let v = grid_at(row, params.frame.w, map.placement.z, map.placement.x, map.grid.z);
        let h = grid_at(col, params.frame.z, map.placement.w, map.placement.y, map.grid.w);
        let v0 = uint(v);
        let h0 = uint(h);
        let v1 = min(v0 + 1, map.grid.z - 1);
        let h1 = min(h0 + 1, map.grid.w - 1);
        let first = map.storage.x;
        let across = map.grid.w;
        let top = lerp(gains[first + v0 * across + h0], gains[first + v0 * across + h1], h - float(h0));
        let bottom = lerp(gains[first + v1 * across + h0], gains[first + v1 * across + h1], h - float(h0));
        gain *= lerp(top, bottom, v - float(v0));
    }
    return gain;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void condition(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.count) { return; }

    let raw = half_of(words[at >> 1], at);

    let row = at / params.width;
    let col = at - row * params.width;
    let position = (row % params.period_h) * params.period_w + col % params.period_w;
    let slot = params.slot_of[position] << 16;

    // Held at the ceiling, as dng_sdk holds a gained sample at white: `assemble.slang` reads fill
    // as a fraction of it.
    let shading = shading_at(int(row) + params.frame.y, int(col) + params.frame.x);
    mosaic[at] = min(curve[slot | raw] * shading, curve[slot | 0xFFFF]);
}

// A rectangle of one mosaic into another, which is how a tile is cut and put back without the frame
// ever leaving the device.
struct Rect {
    uint src_stride;
    uint src_left;
    uint src_top;
    uint dst_stride;
    uint dst_left;
    uint dst_top;
    uint width;
    uint height;
};

// Past `condition`'s own, because one module may not declare two resources at one binding.
[vk::binding(4, 0)] ConstantBuffer<Rect> rect;
[vk::binding(5, 0)] StructuredBuffer<float> source;
[vk::binding(6, 0)] RWStructuredBuffer<float> written;

[shader("compute")]
[numthreads(64, 1, 1)]
void copy_rect(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= rect.width * rect.height) { return; }

    let row = at / rect.width;
    let col = at - row * rect.width;
    written[(rect.dst_top + row) * rect.dst_stride + rect.dst_left + col] =
        source[(rect.src_top + row) * rect.src_stride + rect.src_left + col];
}
