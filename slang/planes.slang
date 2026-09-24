// A rendition the page decoded, as the sixteen-bit RGB codes `linearise` reads.
//
// WebCodecs hands an AVIF back as its luma and chroma planes, and this is the step libavif takes on
// the server before the same codes cross: video range undone, BT.2020's matrix, full scale.
import lanes;
import light;
import packed;
import video_range;

struct Params {
    uint width;
    uint height;
    /// Luma pixels per chroma pixel, as a shift: 1 for 4:2:0, 0 for 4:4:4.
    uint chroma_shift;
    /// What divides a sample onto `video_range`'s ten-bit scale: 1 for ten bits, 4 for twelve.
    float depth;
    /// Where each plane starts and how far apart its rows are, in samples: luma, blue, red.
    uint4 offset;
    uint4 stride;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> planes;
[vk::binding(2, 0)] RWStructuredBuffer<uint> out_codes;

float sample_at(uint plane, uint2 at)
{
    let index = params.offset[plane] + at.y * params.stride[plane] + at.x;
    return float(half_of(planes[index >> 1], index));
}

/// One destination sample: its pixel's PQ signal, one channel of it, at sixteen bits.
///
/// Nearest chroma, as the viewer's stage reads it, so the mockup and the photo it opened from are
/// one picture.
uint code_of(uint sample)
{
    let pixel = sample / 3;
    let at = uint2(pixel % params.width, pixel / params.width);
    let chroma_at = at >> params.chroma_shift;
    let signal = pq_of_video(float3(sample_at(0, at), sample_at(1, chroma_at), sample_at(2, chroma_at))
        / params.depth).v;
    return uint(round(signal[sample % 3] * 65535.0));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void planes_to_codes(uint3 id : SV_DispatchThreadID)
{
    let word = linear(id);
    let samples = params.width * params.height * 3;
    if (word * 2 >= samples) { return; }

    let low = code_of(word * 2);
    uint high = 0;
    if (word * 2 + 1 < samples) { high = code_of(word * 2 + 1); }
    out_codes[word] = low | (high << 16);
}
