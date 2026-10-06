// The colour wheel's view of a photograph, in ZCAM lightness and opponent pair.
import light;
import prelude;
import edit;
import colour;
import index_space;

[vk::binding(23, 0)] StructuredBuffer<float4> places;
/// `scatter`: two per block, each half's colour and its share of the block. `field`: one per place.
[vk::binding(24, 0)] RWStructuredBuffer<float4> answers;

static const float SHOWN_APART = 0.5;

float3 read_at(float3 nits, float2 at)
{
    return opponent_of(edits_index(measured<SceneNits>(nits), at)).v;
}

[shader("compute")]
[numthreads(64, 1, 1)]
void scatter(uint3 id: SV_DispatchThreadID)
{
    let cells = mean_cells();
    if (id.x >= cells.x * cells.y) { return; }
    let cell = uint2(id.x % cells.x, id.x / cells.x);
    let first = mean_half(cell, 0);
    let second = mean_half(cell, 1);
    let at = (float2(cell) + float2(0.5)) * float(max(edit.mean_block, 1u));
    if (second.a < SHOWN_APART) {
        let box = first.a * first.rgb + (1.0 - first.a) * second.rgb;
        answers[id.x * 2] = float4(read_at(box, at), 1.0);
        answers[id.x * 2 + 1] = float4(0.0);
        return;
    }
    answers[id.x * 2] = float4(read_at(first.rgb, at), first.a);
    answers[id.x * 2 + 1] = float4(read_at(second.rgb, at), 1.0 - first.a);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void field(uint3 id: SV_DispatchThreadID)
{
    uint count;
    uint stride;
    places.GetDimensions(count, stride);
    if (id.x >= count) { return; }
    let from = rendered_of(exactly<Opponent>(places[id.x].xyz));
    let to = edit.matched == 0 ? from : finish_chroma(from, from, 0.0);
    answers[id.x] = float4(opponent_of(to).v, 1.0);
}
