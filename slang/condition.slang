// `decode_rawler::conditioned` as a kernel: the sensor's samples become the mosaic every later
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
// sample is a function of sixteen bits and a slot, so `decode_rawler::curve` evaluates its own
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
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> words;
[vk::binding(2, 0)] StructuredBuffer<float> curve;
[vk::binding(3, 0)] RWStructuredBuffer<float> mosaic;

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

    mosaic[at] = curve[(params.slot_of[position] << 16) | raw];
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
