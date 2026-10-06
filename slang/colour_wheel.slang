// ZCAM hue around the centre and chroma outward, at one lightness, drawn as the stage draws a picture.
import light;
import prelude;
import index_space;
import primaries;

struct Wheel
{
    float lightness;
    float chroma_top;
    float side;
    float reference;
    float sdr_white;
};
[vk::binding(0, 0)] ConstantBuffer<Wheel> wheel;

[shader("vertex")]
float4 wheel_vs(uint i : SV_VertexID) : SV_Position
{
    float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    return float4(corners[i], 0.0, 1.0);
}

[shader("fragment")]
float4 backdrop(float4 pos : SV_Position) : SV_Target
{
    let half_side = 0.5 * wheel.side;
    let out = float2(pos.x - half_side, half_side - pos.y) / half_side * wheel.chroma_top;
    let colour = rendered_of(exactly<Opponent>(float3(wheel.lightness, out)));
    let nits = measured<DisplayNits>(colour.v * wheel.reference);
    return float4(srgb_oetf_signed(on_the_canvas(nits, wheel.sdr_white).v), 1.0);
}
