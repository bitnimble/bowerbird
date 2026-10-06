// ZCAM hue around the centre and chroma outward, at one lightness, drawn as the stage draws a picture.
import light;
import prelude;
import index_space;
import primaries;
import kernel_reach;

struct Wheel
{
    float lightness;
    float chroma_top;
    float side;
    float reference;
    float sdr_white;
    /// How dark what the selected kernel does not reach is drawn, zero where none is selected.
    float shade;
    float pad0;
    float pad1;
    float4 centre;
    float4 reach;
    /// The selected node's output colour, ZCAM lightness and opponent pair, then the radius it is
    /// drawn at as a share of `chroma_top`: zero where none is selected.
    float4 output;
    /// `lattice::NODE_FEATHER`.
    float4 feather;
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
    if (length(out - wheel.output.yz) < wheel.output.w * wheel.chroma_top) {
        return float4(coded_at(exactly<Opponent>(wheel.output.xyz)), 1.0);
    }
    let opponent = exactly<Opponent>(float3(wheel.lightness, out));
    let share = kernel_weight(wheel.centre, wheel.reach, wheel.feather, lattice_at(opponent, 0.0));
    return float4(coded_at(opponent) * (1.0 - wheel.shade * (1.0 - share)), 1.0);
}

float3 coded_at(Colour<Opponent> opponent)
{
    let nits = measured<DisplayNits>(rendered_of(opponent).v * wheel.reference);
    return srgb_oetf_signed(on_the_canvas(nits, wheel.sdr_white).v);
}
