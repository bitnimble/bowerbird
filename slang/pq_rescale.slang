// A PQ picture's light under one gain, for Firefox's 10-bit copy on a platform that shows a PQ
// video's SDR white somewhere other than the 203 nits a rendition codes it at (`TenBitCopies`).
//
// Sixteen-bit full-range codes, two to a word with the first in the low half: the RGB samples
// libavif decoded the still to, rescaled in place before the copy is encoded.
import light;
import prelude;

struct Params {
    uint words;
    /// Words one row of the dispatch grid covers, so a frame past 65535 groups spills into `y`.
    uint row;
    float gain;
    uint unused;
};

[vk::binding(0, 0)] RWStructuredBuffer<uint> codes;
[vk::binding(1, 0)] ConstantBuffer<Params> pc;

uint rescaled(uint code)
{
    let nits = pq_inv<DisplayNits>(measured<Pq>(float(code) / 65535.0));
    let signal = pq(measured<DisplayNits>(nits.v * pc.gain)).v;
    return uint(clamp(round(signal * 65535.0), 0.0, 65535.0));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void rescale_pq(uint3 id : SV_DispatchThreadID)
{
    let at = id.y * pc.row + id.x;
    if (at >= pc.words) { return; }
    let word = codes[at];
    codes[at] = rescaled(word & 0xffffu) | (rescaled(word >> 16) << 16);
}
