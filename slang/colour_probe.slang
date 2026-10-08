// The colour wheel's view of a photograph, in ZCAM lightness and opponent pair.
import light;
import edit;
import colour;
import index_space;

[vk::binding(23, 0)] StructuredBuffer<float4> places;
/// `scatter`: one per sampled pixel, `DOTS_ACROSS` to a row. `field`: one per place.
[vk::binding(24, 0)] RWStructuredBuffer<float4> answers;

/// `colour_wheel::DOTS_ACROSS`.
static const uint DOTS_ACROSS = 64;

[shader("compute")]
[numthreads(64, 1, 1)]
void scatter(uint3 id: SV_DispatchThreadID)
{
    uint count;
    uint stride;
    answers.GetDimensions(count, stride);
    if (id.x >= count) { return; }
    let down = count / DOTS_ACROSS;
    let x = uint((float(id.x % DOTS_ACROSS) + 0.5) * float(edit.width) / float(DOTS_ACROSS));
    let y = uint((float(id.x / DOTS_ACROSS) + 0.5) * float(edit.height) / float(down));
    let shown = before_edits(measured<SceneNits>(nits_at(x, y)), float2(float(x), float(y)) + 0.5);
    answers[id.x] = float4(opponent_of(shown).v, 1.0);
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
