// The colour model at a list of scene colours, for the fit that builds it.
//
// `colour` is the grade; this runs its stages over samples handed in rather than over a frame, so
// the fit measures the model it is choosing on the arithmetic that will render it. A sample is
// scene-linear with diffuse white at 1.0 - the fit's own domain - and the uniform meets it with
// `white`, `reference` and `exposure` at their identities, so `curves_at` reads the curves at the
// sample itself.
import prelude;
import colour;
import lanes;
import light;

struct Params {
    int count;
    /// How much of the model to run: `TONE`, `TONE_MATRIX` or `FULL`.
    int stage;
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Per sample: the scene colour, and the neighbourhood's brightness the lattice reads.
[vk::binding(5, 0)] StructuredBuffer<float4> input;
/// Per sample: the stage's colour, then its luma - the layout `fit_score.slang` reads as `below`.
[vk::binding(6, 0)] RWStructuredBuffer<float4> output;

static const int TONE = 0;
static const int TONE_MATRIX = 1;
static const int FULL = 2;

[shader("compute")]
[numthreads(64, 1, 1)]
void fit_model(uint3 id : SV_DispatchThreadID)
{
    let i = linear(id);
    if (i >= uint(pc.count)) { return; }
    let sample = input[i];
    // **`SceneNits`, because the fit's uniform puts `reference` at 1.** A sample is scene-relative
    // with diffuse white at 1.0, and `curves_at` divides by the reference on the way in - so the
    // two domains are the same number here, and only here. That identity is the reason this
    // dispatch can run the grade's own stages over samples that never were a frame.
    var v = curves_at(measured<SceneNits>(sample.xyz), gain(1.0));
    if (pc.stage >= TONE_MATRIX) { v = apply_matrix(v); }
    if (pc.stage >= FULL) { v = finish_chroma(v, v, sample.w); }
    output[i] = float4(v.v, luma_of(v).v);
}
