// The matched colour's differences, smoothed the way the camera smooths its own.
//
// A camera's rendering smooths the chroma of its display-encoded output over a few pixels
// while leaving the light sharp, so a colour feature narrower than that is flattened in its
// picture - the red that skin scatters under a shadow's edge - and stood sharp in ours, below
// the resolution of every colour- and place-indexed stage of the match.
//
// So `matched_nits` reads each pixel's light with its neighbourhood's colour, and the
// neighbourhood's colour is *the model's own output*: this pass runs `matched_scene` at a
// texel per `edit.chroma_shrink` pixels, encodes it for display, and a separable Gaussian
// follows. That shrink is a share of the photograph rather than a count of this frame's
// pixels (`gpu::chroma_shrink`), which is what keeps the footprint the same picture's worth
// of colour whether the frame is a 3840 rendition or the sensor's own size.
// After the model rather than before it, because in the scene lit skin carries less red than
// shadowed skin and a blur of the input drags each side's colour across the edge; in the
// matched output the two agree, and the blur only flattens what the camera flattens.
//
// Once per upload, beside `mean_frame`: `matched_scene` is the frame and the fit alone.
import prelude;
import edit;
import colour;
import px;
import light;

struct Push {
    /// The textures' size, in texels.
    uint width;
    uint height;
    /// 1 to blur along x, 0 along y.
    uint horizontal;
    uint pad0;
};

[vk::binding(20, 0)] ConstantBuffer<Push> pc;
[vk::binding(23, 0)] Texture2D<float4> from;
[vk::image_format("rgba16f")]
[vk::binding(22, 0)] WTexture2D<float4> to;

/// The Gaussian's sigma over the shrunk texture, in its texels, and how far it reaches.
///
/// In texels and not pixels on purpose, now that a texel is a share of the photograph: the
/// blur then covers that share at every output size without a second number to scale.
static const float SIGMA = 1.45;
static const int REACH = 4;

/// How far two texels' colours may differ and still be averaged together.
///
/// **A plain Gaussian cannot tell noise from a boundary, and at this footprint that matters.**
/// A texel is a 960th of the photograph and the blur reaches four of them, so on a 61MP frame
/// the kernel spans about sixty pixels - wider than most of the painted detail in a photograph
/// of a painted thing. Run flat, it carries a saturated neighbour's colour across the edge into
/// whatever sits beside it: measured against the camera's own JPEG on DSC05443's carvings, a
/// tenth of the coloured pixels came back with a third more chroma than the camera gives them,
/// dragged off the vermilion beam behind.
///
/// So the weight is bilateral on chroma, which is the only thing `matched_nits` takes from this
/// texture. Sensor noise is small in this space and stays inside the kernel; a real colour
/// boundary is several times this and the two sides stop averaging. In the encoded units the
/// texture holds, where diffuse white is 1.
static const float CHROMA_KEEP = 0.04;

/// What a texel's colour is, apart from its brightness - the axis the blur acts on and the only
/// one `matched_nits` reads back.
float3 chroma_of(float3 encoded)
{
    return encoded - dot(LUMA, encoded);
}

/// The match over one texel's pixels, encoded for display. Run with `has_smoothed` clear.
///
/// The texels partition the *photograph*, so a frame whose origin is not a multiple of
/// the shrink opens with a partial one - anchored there so a tile and the whole render
/// average the same pixels into every texel they share (`mean_frame.slang`).
[shader("compute")]
[numthreads(8, 8, 1)]
void model(uint3 id : SV_DispatchThreadID)
{
    // **Measured, not written down.** The shrink is a share of the photograph in the pixels of
    // the frame this dispatch is over (`gpu::chroma_shrink`), and `Output` has no `exact` - so a
    // constant four here would not compile, which is the whole of what the module is for.
    let shrink = measured<Output>(max(edit.chroma_shrink, 1u));
    let phase = uint2(edit.surround_left % shrink.n, edit.surround_top % shrink.n);
    let cells = uint2(
        (edit.width + phase.x + shrink.n - 1) / shrink.n,
        (edit.height + phase.y + shrink.n - 1) / shrink.n);
    if (id.x >= cells.x || id.y >= cells.y) { return; }
    let x0 = max(id.x * shrink.n, phase.x) - phase.x;
    let y0 = max(id.y * shrink.n, phase.y) - phase.y;
    let x1 = min((id.x + 1) * shrink.n - phase.x, edit.width);
    let y1 = min((id.y + 1) * shrink.n - phase.y, edit.height);
    var sum = float3(0.0);
    var count = 0.0;
    for (uint y = y0; y < y1; y++) {
        for (uint x = x0; x < x1; x++) {
            sum += nits_at(x, y);
            count += 1.0;
        }
    }
    let centre = float2(float(x0 + x1), float(y0 + y1)) * 0.5;
    let matched = matched_scene(measured<SceneNits>(sum / max(count, 1.0)), centre).v;
    to.Store(id.xy, float4(pow(max(matched, float3(0.0)), float3(1.0 / CHROMA_GAMMA)), 1.0));
}

[shader("compute")]
[numthreads(8, 8, 1)]
void blur(uint3 id : SV_DispatchThreadID)
{
    if (id.x >= pc.width || id.y >= pc.height) { return; }
    let mine = chroma_of(from.Load(int3(int2(id.xy), 0)).rgb);
    var sum = float3(0.0);
    var weight = 0.0;
    for (int k = -REACH; k <= REACH; k++) {
        let at = pc.horizontal != 0
            ? int2(clamp(int(id.x) + k, 0, int(pc.width) - 1), int(id.y))
            : int2(int(id.x), clamp(int(id.y) + k, 0, int(pc.height) - 1));
        let v = from.Load(int3(at, 0)).rgb;
        let apart = chroma_of(v) - mine;
        let w = exp(-float(k * k) / (2.0 * SIGMA * SIGMA))
            * exp(-dot(apart, apart) / (2.0 * CHROMA_KEEP * CHROMA_KEEP));
        sum += v * w;
        weight += w;
    }
    to.Store(id.xy, float4(sum / weight, 1.0));
}
