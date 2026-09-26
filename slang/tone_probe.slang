import prelude;
import adjust;
import edit;
import light;

[vk::binding(22, 0)] StructuredBuffer<float4> inputs;
[vk::binding(23, 0)] RWStructuredBuffer<float4> answers;

[numthreads(64, 1, 1)]
void curve_draw(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= edit.width) { return; }
    let original = inputs[id.x].xyz;
    if (sliders_at_camera()) {
        answers[id.x] = float4(original, 1.0);
        return;
    }
    Colour<Scene> undone;
    camera_undone(measured<Rendered>(original), undone);
    let exposed = times(undone, gain_of(stops(edit.exposure)));
    let luma = luma_of(exposed).v;
    if (luma <= 0.0) {
        CurveCode black;
        black.v = 0.0;
        CurveCode lifted;
        Gain light;
        curve_evaluated(black, false, lifted);
        curve_light(lifted, light);
        answers[id.x] = float4(float3(light.g), 1.0);
        return;
    }
    Light<Scene> pivot;
    tone_pivot(pivot);
    let toned = tone_adjusted(luma, 0.0, 0.0, pivot.v);
    CurveCode code;
    CurveCode curved;
    Gain light;
    curve_code(gain(toned), code);
    curve_evaluated(code, false, curved);
    curve_light(curved, light);
    Gain residual;
    camera_floor_residual(measured<Rendered>(original), residual);
    answers[id.x] = float4(exposed.v * (light.g / luma) * residual.g, 1.0);
}

[numthreads(64, 1, 1)]
void knee_probe(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= edit.width) { return; }
    let sample = inputs[id.x];
    let knee = rolloff(exactly<DisplayNits>(sample.y), exactly<DisplayNits>(sample.z), exactly<DisplayNits>(sample.w));
    answers[id.x] = float4(roll(exactly<DisplayNits>(sample.x), knee).v, min(sample.x, sample.z), 0.0, 1.0);
}
