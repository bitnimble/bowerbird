// A rectangle of one packed frame copied into another (`retouched_frame.rs`): a removal's original
// cut out of the frame before it is painted over, and put back over a copy of the frame to see
// under it.
//
// **A kernel, not a buffer copy.** A pixel is three `u16` and a word two, so a row of an odd-width
// frame starts halfway through a word and `copy_buffer_to_buffer`, which moves whole words from
// word-aligned offsets, cannot start there.
//
// **One invocation a destination word**, over every word from the rectangle's first sample to its
// last: each word is written once, whole, and its half outside the rectangle is kept, so two rows
// that meet inside one word cannot race.
import lanes;
import packed;

struct Params {
    /// Row lengths in pixels.
    uint src_width;
    uint dst_width;
    uint2 src_at;
    uint2 dst_at;
    uint2 size;
    /// The destination word the rectangle's first sample is in, and how many words from there to
    /// the one its last sample is in.
    uint first_word;
    uint words;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<uint> src;
[vk::binding(2, 0)] RWStructuredBuffer<uint> dst;

/// Sample `at` of the destination: the source's where the rectangle holds it, and what the
/// destination already holds everywhere else.
uint sample_at(uint at, uint word)
{
    let pixel = at / 3;
    let x = pixel % params.dst_width;
    let y = pixel / params.dst_width;
    if (x < params.dst_at.x || x >= params.dst_at.x + params.size.x
        || y < params.dst_at.y || y >= params.dst_at.y + params.size.y) {
        return half_of(word, at);
    }
    let from = ((params.src_at.y + y - params.dst_at.y) * params.src_width
        + params.src_at.x + x - params.dst_at.x) * 3 + at % 3;
    return half_of(src[from / 2], from);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void copy_rect(uint3 id : SV_DispatchThreadID)
{
    let i = linear(id);
    if (i >= params.words) { return; }
    let word = params.first_word + i;
    let held = dst[word];
    dst[word] = sample_at(word * 2, held) | (sample_at(word * 2 + 1, held) << 16);
}
