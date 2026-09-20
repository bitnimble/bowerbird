// What the camera match needs off the decoded frame, taken where the frame already is.
//
// Two reductions of a 60MP buffer: a box average down to the preview's own grid - 1616 on the
// long edge - and the two levels `fit_scan` walks a histogram for. What leaves the device is 21MB
// and two floats, against the 360MB the frame is - and the frame is on the device already,
// decoded, denoised, demosaiced and defringed there.
//
// The plane is what the whole fit runs at. Nothing downstream of here reads the frame at full size.

import prelude;
import packed;
import footprint;

struct Params {
    int width;
    int height;
    int out_width;
    int out_height;
    /// How many pixels the quantile reads, which is a fixed count rather than a fixed stride:
    /// `tone::QUANTILE_SAMPLES` records why the same photo decoded at two sizes must not anchor
    /// differently.
    int counted;
    int pixels;
    /// The running counts `fit_scan` marks the frame's bottom end, diffuse white and its top end
    /// at, as whole samples: `tone::marks` rounds the quantiles up in f64 so that the walk compares
    /// integers and no mark can round to the far side of the count that crosses it.
    int floor_mark;
    int white_mark;
    int peak_mark;
    /// `tone::WHITE_FLOOR_UNDER_PEAK`.
    float white_floor_under_peak;
    /// Rec.2020 to sRGB primaries, a row to a `float4` so that std140 leaves nothing between them.
    /// Passed rather than written out here: `hdr_fit::rec2020_to_srgb` derives it, and a literal
    /// would be a second copy to hold against that one.
    float4 to_srgb[3];
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// The frame's own u16 samples, interleaved RGB, two to a word.
[vk::binding(0, 0)] StructuredBuffer<uint> frame;
/// Interleaved RGB, in the raw magnitudes the host's `Plane` carries at this point.
[vk::binding(1, 0)] RWStructuredBuffer<float> plane;
/// One bin per `u16` level, counting the brightest channel of each sampled pixel.
[vk::binding(2, 0)] RWStructuredBuffer<Atomic<uint> > histogram;
/// Diffuse white, the frame's top end and its bottom end, in `u16` levels, in that order.
[vk::binding(3, 0)] RWStructuredBuffer<float> levels;
/// The plane as the geometry search reads it: interleaved f32 RGB, sRGB primaries and transfer,
/// 0..1. `fit_grids.slang` takes this as its unpacked source.
[vk::binding(4, 0)] RWStructuredBuffer<float> render;

/// One bin per level a `u16` sample can take, which is what the host sizes the histogram to.
static const uint LEVEL_BINS = 65536;

float sample_at(int index)
{
    return float(half_of(frame[index >> 1], uint(index)));
}

/// A box average, deliberately not a filtered resize: both sides of the pair get the same one
/// (`fit_warp.slang`'s `fit_box` for the preview), so neither is sharpened relative to the other.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_resize(uint3 id: SV_DispatchThreadID)
{
    let dx = int(id.x);
    let dy = int(id.y);
    if (dx >= pc.out_width || dy >= pc.out_height) { return; }

    let b = box_of(int2(dx, dy), int2(pc.width, pc.height), int2(pc.out_width, pc.out_height));
    var acc = float3(0.0);
    for (int y = b.z; y < b.w; y++) {
        for (int x = b.x; x < b.y; x++) {
            let i = (y * pc.width + x) * 3;
            acc += float3(sample_at(i), sample_at(i + 1), sample_at(i + 2));
        }
    }
    let n = float((b.w - b.z) * (b.y - b.x));
    let out = (dy * pc.out_width + dx) * 3;
    plane[out] = acc.x / n;
    plane[out + 1] = acc.y / n;
    plane[out + 2] = acc.z / n;
}

/// The pixel sample `k` of `counted` reads, spread over the frame by fraction rather than by
/// step: it lands at the same place whatever the frame's resolution, which is what makes two
/// decodes of one photo agree.
///
/// `k * pixels / counted` needs 46 bits at 61MP and WGSL has no 64-bit integer, so it comes apart
/// into pieces that fit. With `q` and `r` the quotient and remainder of `pixels / counted`,
/// `k*pixels = k*q*counted + k*r`, and the first term divides out exactly. What is left is
/// `floor(k*r/counted)`, where `r` is non-zero only when the count was capped - so `counted` is
/// then exactly `tone::QUANTILE_SAMPLES`, a power of two, and splitting `r` at its tenth bit puts
/// both partial products under 2^30. Exact.
uint spread_index(uint k, uint pixels, uint counted)
{
    let q = pixels / counted;
    let r = pixels - q * counted;
    if (r == 0) { return k * q; }
    let a = k * (r >> 10);
    let b = k * (r & 0x3ffu);
    return k * q + ((a + (b >> 10)) >> 10);
}

/// One count per sampled pixel, of its brightest component rather than its luminance: that is
/// what clips first, and anchoring on luminance lets a saturated channel run past the top of the
/// range while the pixel still reads as mid-toned.
///
/// The counts are integers, so the atomic merge is the serial answer to the bit however the lanes
/// interleave.
[shader("compute")]
[numthreads(64, 1, 1)]
void fit_levels(uint3 id: SV_DispatchThreadID)
{
    if (int(id.x) >= pc.counted) { return; }
    let i = int(3u * spread_index(id.x, uint(pc.pixels), uint(pc.counted)));
    let brightest = max(sample_at(i), max(sample_at(i + 1), sample_at(i + 2)));
    histogram[uint(brightest)].add(1);
}

/// The walk up the bins `fit_levels` counted, for the three levels the grade is placed against.
///
/// One invocation, like `peak.slang`'s `quantile`: a running count with three marks and a fallback
/// in it is a serial reduction, and 65536 bins of it is far cheaper than the 256KB the host would
/// read to do the same walk itself.
///
/// `peak` is the frame's own top end and not sensor saturation, which is what makes the grade
/// exposure-invariant: both levels scale with exposure, so their ratio - and therefore how much
/// roll-off the highlights get - is a property of the scene. Reading the peak off the sensor
/// instead would give a frame shot two stops down four times the compression for the same subject.
///
/// The floor is the same argument at the other end, and `adjust.slang` is what wants it: Blacks
/// and Shadows name the bottom of a picture, so a picture whose bottom is three stops under white
/// has to have them there rather than where a frame with real black in it would put them.
[shader("compute")]
[numthreads(1, 1, 1)]
void fit_scan()
{
    var highest = 0u;
    var bottom = -1;
    var white = -1;
    var peak = -1;
    var seen = 0u;
    for (uint level = 0u; level < LEVEL_BINS; level++) {
        let count = histogram[level].load();
        if (count == 0) { continue; }
        highest = level;
        seen = seen + count;
        if (bottom < 0 && seen >= uint(pc.floor_mark)) { bottom = int(level); }
        if (white < 0 && seen >= uint(pc.white_mark)) { white = int(level); }
        if (peak < 0 && seen >= uint(pc.peak_mark)) { peak = int(level); }
    }
    // A frame with too few distinct levels to reach a mark falls back to the end of the range it
    // was looking for, which is what the mark meant on such a frame anyway.
    let top = peak < 0 ? float(highest) : float(peak);
    let anchor = white < 0 ? top : float(white);
    // On a night frame the quantile lands on the dark ground, four stops and more under the
    // lights; anchoring there pushed a frame 24x and the camera match could not bring it back.
    levels[0] = max(anchor, top / pc.white_floor_under_peak);
    levels[1] = top;
    // Zero for a histogram with nothing in it, which is the only way the mark goes unreached: the
    // walk sees every sampled pixel, and the mark is a share of that same count.
    levels[2] = bottom < 0 ? 0.0 : float(bottom);
}

/// The plane as an 8-bit-grid sRGB render, which is what the geometry search compares against the
/// camera's own JPEG.
///
/// **Normalised by diffuse white, not by the frame's peak**, and the difference is not cosmetic:
/// the peak is the maximum of a strided subsample, so a single specular sample - a sun, a chrome
/// edge, a hot pixel - drags the whole render toward black by the peak/white ratio, which `tone.rs`
/// records as varying tenfold across bodies.
///
/// A pass of its own after `fit_scan`, because it divides by the white that walk just wrote. That
/// is also what keeps the host out of it: nothing here has to come back and be sent up again.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_render(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.out_width || y >= pc.out_height) { return; }

    let white = levels[0];
    let i = (y * pc.out_width + x) * 3;
    // A frame whose quantile landed on level 0 - a lens cap, a failed exposure - has no white to
    // divide by. `Levels::anchored` floors it on the host for the grade; here the render is simply
    // black, which is what such a frame is.
    let v = white > 0.0
        ? float3(plane[i], plane[i + 1], plane[i + 2]) / white
        : float3(0.0);
    let out = float3(
        dot(pc.to_srgb[0].xyz, v),
        dot(pc.to_srgb[1].xyz, v),
        dot(pc.to_srgb[2].xyz, v));

    for (int c = 0; c < 3; c++) {
        let coded = srgb_oetf(clamp(out[c], 0.0, 1.0));
        // On the 255 steps the camera's JPEG lives on, and back: the search compares the two
        // sides pixel by pixel, so ours has to be quantised the way theirs already is.
        render[i + c] = round(255.0 * coded) / 255.0;
    }
}
