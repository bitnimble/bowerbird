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
    if (edit.curve_is_camera != 0 && edit.exposure == edit.camera_exposure && sliders_at_rest()) {
        answers[id.x] = float4(original, 1.0);
        return;
    }
    let undone = camera_undone(measured<Graded>(original));
    let exposed = times(undone, gain_of(stops(edit.exposure)));
    let luma = luma_of(exposed).v;
    if (luma <= 0.0) {
        let lifted = curve_light(curve_evaluated(CurveCode(0.0), false)).g;
        answers[id.x] = float4(float3(lifted), 1.0);
        return;
    }
    let toned = tone_adjusted(luma, 0.0, 0.0, tone_pivot().v);
    let curved = curve_light(curve_evaluated(curve_code(gain(toned)), false)).g;
    let residual = camera_floor_residual(measured<Graded>(original));
    answers[id.x] = float4(exposed.v * (curved / luma) * residual.g, 1.0);
}

[numthreads(64, 1, 1)]
void knee_probe(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= edit.width) { return; }
    let sample = inputs[id.x];
    let knee = rolloff(exactly<DisplayNits>(sample.y), exactly<DisplayNits>(sample.z), exactly<DisplayNits>(sample.w));
    answers[id.x] = float4(roll(exactly<DisplayNits>(sample.x), knee).v, min(sample.x, sample.z), 0.0, 1.0);
}
