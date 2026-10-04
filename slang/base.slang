// The base frame's own stages, the ones between the demosaic and the grade.
//
// The coding is a table the host fills (`base.rs`'s `coding_curve`, over `tone::pq`), so ST 2084
// is evaluated once per level in `f64` rather than once per sample in `f32` - `coded` below says
// what the difference is worth. `colour` reads the same curve back through its own table.
//
// **The frame is sixteen bits packed two to a word** (`packed`): half-float levels in, PQ codes
// out, which is the layout the editor holds and the one a rendition reads back.
import lanes;
import packed;

struct Params {
    /// Words in the frame, which is `samples` rounded up.
    uint words;
    /// Samples in the frame, three per pixel. The last word holds one of them when this is odd.
    uint samples;
    float2 pad;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] RWStructuredBuffer<uint> frame;
[vk::binding(2, 0)] StructuredBuffer<uint> curve;

/// One level's half-float bits, coded.
///
/// **A lookup rather than the curve, for `condition`'s reason.** The domain is sixteen bits, so it
/// is 65536 entries and the host can evaluate ST 2084 into them in `f64` once. Evaluating `pq` here
/// instead is `f32` per sample, and the two answers differ by a count on a fifth of a real frame.
/// `tone::pq` fills it; `params.scale` is folded in there too, so this is the whole of the
/// arithmetic.
///
/// Two entries to a word, packed as the frame is, since what comes out is a code and not a signal.
uint coded(uint bits)
{
    return half_of(curve[bits / 2], bits);
}

/// Phase 1: scene-linear levels to normalised PQ, in place.
///
/// One invocation per word rather than per sample, so the read and the write are one each: a
/// sample is sixteen bits and the smallest thing a shader can address is thirty-two, so per-sample
/// invocations would each read a word, modify a half and write it back - two invocations racing
/// on every word.
[shader("compute")]
[numthreads(64, 1, 1)]
void encode_base(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= params.words) { return; }

    let word = frame[at];
    let low = coded(word & 0xffff);
    // The odd tail. A frame with an odd sample count leaves half of the last word unused, and it
    // has to stay as it was rather than being coded as though it were a sample - it is read back
    // as bytes, and a frame whose length is odd would come back with a coded zero after its end.
    uint high = word >> 16;
    if (at * 2 + 1 < params.samples) {
        high = coded(high);
    }
    frame[at] = low | (high << 16);
}
