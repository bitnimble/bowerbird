// A PQ still's light as a platform that shows a PQ video's SDR range differently from a still's
// shows it (`sdr_match.slang`), for Firefox's 10-bit copy there (`TenBitCopies`).
//
// Sixteen-bit full-range codes, two to a word with the first in the low half: the RGB samples
// libavif decoded the still to, rewritten in place before the copy is encoded. Each sample is
// matched on its own, which is the channel-at-a-time curve SDR is read through.
import lanes;
import light;
import prelude;
import sdr_match;

struct Params {
    uint words;
    uint unused0;
    float still_white;
    float white;
    uint reads_sdr_as_power;
    uint unused1;
    uint unused2;
    uint unused3;
};

[vk::binding(0, 0)] RWStructuredBuffer<uint> codes;
[vk::binding(1, 0)] ConstantBuffer<Params> pc;

uint rematched(uint code)
{
    let nits = pq_inv<DisplayNits>(measured<Pq>(float(code) / 65535.0));
    let shown = matched_channel(
        nits.v / pc.still_white, measured<DisplayNits>(pc.white), pc.reads_sdr_as_power);
    let signal = pq(shown).v;
    return uint(clamp(round(signal * 65535.0), 0.0, 65535.0));
}

[shader("compute")]
[numthreads(64, 1, 1)]
void rematch_pq(uint3 id : SV_DispatchThreadID)
{
    let at = linear(id);
    if (at >= pc.words) { return; }
    let word = codes[at];
    codes[at] = rematched(word & 0xffffu) | (rematched(word >> 16) << 16);
}
