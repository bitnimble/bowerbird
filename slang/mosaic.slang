// The frame and its colour filter array: what every demosaic reads before its own parameters.
//
// **Two algorithms, one pattern layer.** RCD and the demultiplexing share no stage between the
// mosaic and the picture - one fills gaps in per-channel planes, the other separates overlapping
// bands - but they read the same frame, the same photosite colours, and they fill the same border
// the same way. That much lives here, so a pattern is described once and a border is interpolated
// once, and a third demosaic gets both for nothing.
//
// They cannot share a pipeline layout, which is why they are still two modules: a layout covers
// every binding its module declares, RCD already sits exactly on the eight storage buffers a device
// is required to offer, and the demultiplexing's own planes would put the pair four over.
module mosaic;

/// Positions this can describe, which is X-Trans's 6x6.
public static const uint MAX_SLOTS = 36;

public struct Shape {
    public uint width;
    public uint height;
    /// Sites nearer an edge than this are filled by `nearby_mean` rather than reconstructed.
    public uint margin;
    /// The colour at each position of the period, two bits apiece, twelve to a word: 0 red, 1
    /// green, 2 blue (`cfa::Cfa::packed_colours`).
    ///
    /// **Three scalars and not an array, and the bench is what decided it.** An array in the uniform
    /// address space is a memory load per lookup with an index the compiler cannot fold, and
    /// `assemble.slang` asks for nine colours per output pixel before it knows whether the pixel is
    /// anywhere near clipping. Spelled as an array that cost the demosaic 238ms against a 105ms
    /// budget on a 61MP frame. Three scalars stay in registers, so a lookup is two selects and a
    /// shift - which is what the packed word it replaced already was.
    public uint packed0;
    public uint packed1;
    public uint packed2;
};

[vk::binding(0, 0)] public ConstantBuffer<Shape> shape;
[vk::binding(1, 0)] public StructuredBuffer<float> samples;

/// A frame coordinate to an index, clamped to the plane rather than wrapped.
public uint index(int r, int c)
{
    let rr = clamp(r, 0, int(shape.height) - 1);
    let cc = clamp(c, 0, int(shape.width) - 1);
    return uint(rr) * shape.width + uint(cc);
}

public float sample(int r, int c)
{
    return samples[index(r, c)];
}

/// The CFA's period, fixed when the pipeline is compiled rather than read when a colour is.
///
/// **A specialisation constant, and the bench is what insisted.** The lookup below is a modulo, and
/// a modulo by a value the compiler cannot see is an integer division - spelled that way,
/// `assemble.slang`'s thirteen colours per output pixel cost the demosaic 227ms against a 105.7ms
/// budget on a 61MP frame. Stubbing the lookup to a constant brought it back to 108ms, so the
/// lookup was the whole of it; packing the pattern, masking instead of dividing, and hoisting the
/// reads each moved it by a few percent and none of them closed it. Fixed here, `% 2` is a mask and
/// `% 6` is a multiply, and the Bayer path is the arithmetic it always was.
///
/// This is the lesson `frame.slang` already records for its own draw: as a runtime branch the dead
/// half still has to be allocated for.
[vk::constant_id(0)]
const uint PERIOD_W = 2;
[vk::constant_id(1)]
const uint PERIOD_H = 2;

/// Where a frame coordinate lands in the period.
///
/// **Takes the coordinate as given, and every caller owes it one inside the plane.** Clamping here
/// would be wrong as well as slow: the colour of a clamped coordinate is a different photosite's,
/// where `sample` clamps precisely so an edge read *keeps* its own.
public uint slot_at(int r, int c)
{
    return (uint(r) % PERIOD_H) * PERIOD_W + uint(c) % PERIOD_W;
}

/// The period's colours in registers, for a caller that wants many of them.
///
/// **`assemble.slang` asks for thirteen per output pixel, and a uniform read has latency.** With the
/// period already a compile-time constant, thirteen reads of `shape` still left the reduced route at
/// 194ms against a 105.7ms budget on a 61MP frame - so what remained was the load itself. The code
/// this replaced hoisted its pattern into one word before its loop for exactly that reason.
public struct Pattern {
    public uint packed0;
    public uint packed1;
    public uint packed2;
};

/// Written through rather than returned, field by field: `no_struct_returns_under_a_loop` says why,
/// and `colour_at` below puts this on the path of every gather in both demosaics.
public void pattern(out Pattern it)
{
    it.packed0 = shape.packed0;
    it.packed1 = shape.packed1;
    it.packed2 = shape.packed2;
}

/// The CFA colour at a pixel, off a pattern the caller already holds: 0 red, 1 green, 2 blue.
///
/// A period of twelve positions or fewer lives in one word, which is every Bayer sensor - and then
/// this is one shift and one mask, which is what it replaced. The rest decodes away with the
/// constant.
public uint colour_of(Pattern it, int r, int c)
{
    let slot = slot_at(r, c);
    if (PERIOD_W * PERIOD_H <= 12u) {
        return (it.packed0 >> (slot * 2u)) & 3u;
    }
    let word = slot / 12u;
    let packed = word == 0u ? it.packed0 : (word == 1u ? it.packed1 : it.packed2);
    return (packed >> ((slot - word * 12u) * 2u)) & 3u;
}

/// The same for a caller with a single colour to look up, which is every stage of RCD.
public uint colour_at(int r, int c)
{
    Pattern it;
    pattern(it);
    return colour_of(it, r, c);
}

/// True where the pixel is at least `m` from every edge.
public bool interior(int r, int c, int m)
{
    return r >= m && c >= m && r < int(shape.height) - m && c < int(shape.width) - m;
}

/// The mean of a colour's samples over a 5x5 neighbourhood, ignoring taps of other colours.
///
/// Only used in the outer margin, where a demosaic has nothing to read and any reasonable
/// interpolation will do. 5x5 rather than 3x3 because a 3x3 window of X-Trans is not guaranteed to
/// hold a red or a blue; the fallback to the site's own value is what covers a window that holds
/// none regardless.
public float nearby_mean(int r, int c, uint want)
{
    float total = 0.0;
    float count = 0.0;
    for (int dr = -2; dr <= 2; dr++) {
        for (int dc = -2; dc <= 2; dc++) {
            let rr = r + dr;
            let cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= int(shape.height) || cc >= int(shape.width)) { continue; }
            if (colour_at(rr, cc) != want) { continue; }
            total += sample(rr, cc);
            count += 1.0;
        }
    }
    if (count == 0.0) { return sample(r, c); }
    return total / count;
}

/// Every channel the sensor did not sample here, interpolated from the ones it did.
public float3 filled_margin(int r, int c)
{
    let here = colour_at(r, c);
    let value = sample(r, c);
    return float3(
        select(here == 0, value, nearby_mean(r, c, 0)),
        select(here == 1, value, nearby_mean(r, c, 1)),
        select(here == 2, value, nearby_mean(r, c, 2)));
}
