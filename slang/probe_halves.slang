// `packed`'s `half_bits` over every value `the_half_conversion_rounds_alike_on_every_adapter`
// feeds it, each float's bits replaced by its half's.
import packed;

[vk::binding(0, 0)] RWStructuredBuffer<uint> words;

[shader("compute")]
[numthreads(64, 1, 1)]
void probe_halves(uint3 id : SV_DispatchThreadID)
{
    uint count;
    uint stride;
    words.GetDimensions(count, stride);
    if (id.x >= count) { return; }
    words[id.x] = half_bits(asfloat(words[id.x]));
}
