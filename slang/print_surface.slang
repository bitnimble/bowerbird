import light;
import px;
import prelude;
import primaries;
import print_scene;
import print_geometry;
import print_parameters;
import catmull_rom;

struct SurfaceView {
    float4 region;
    float4 canvas_shape;
};
[vk::binding(0, 0)] ConstantBuffer<SurfaceView> surface_view;
[vk::binding(1, 0)] Texture2D<float4> pigment;
[vk::binding(2, 0)] Texture3D<float4> lighting;
[vk::binding(3, 0)] SamplerState filtering;
[vk::binding(4, 0)] [format("rgba16f")] WTexture3D<float4> lighting_out;

static const float FRAME_EDGE_SAMPLES = 0.375;

float2 frame_field_edge(float2 half)
{
    let aperture = frame_aperture(half);
    let light = paper_inverse(print.light.xyz);
    let spread = print.surface.y / print.surface.x;
    let reach = abs(light.xy) + spread + aperture / print.surface.x;
    return clamp(frame_front_depth() * reach / (2.0 * aperture * max(light.z - spread, 0.1)), 0.02, 0.4);
}

float frame_field_position(float at, float edge)
{
    if (at < FRAME_EDGE_SAMPLES) { return at * (edge / FRAME_EDGE_SAMPLES); }
    if (at > 1.0 - FRAME_EDGE_SAMPLES) { return 1.0 - (1.0 - at) * (edge / FRAME_EDGE_SAMPLES); }
    return edge + (at - FRAME_EDGE_SAMPLES) * ((1.0 - 2.0 * edge) / (1.0 - 2.0 * FRAME_EDGE_SAMPLES));
}

float frame_field_sample(float at, float edge)
{
    if (at < edge) { return at * (FRAME_EDGE_SAMPLES / edge); }
    if (at > 1.0 - edge) { return 1.0 - (1.0 - at) * (FRAME_EDGE_SAMPLES / edge); }
    return FRAME_EDGE_SAMPLES + (at - edge) * ((1.0 - 2.0 * FRAME_EDGE_SAMPLES) / (1.0 - 2.0 * edge));
}

[shader("compute")]
[numthreads(8, 8, 1)]
void build_lighting(uint3 id : SV_DispatchThreadID)
{
    uint width;
    uint height;
    uint layers;
    lighting_out.GetDimensions(width, height, layers);
    if (id.x >= width || id.y >= height || id.z >= layers) { return; }
    var uv = float2(id.xy) / float2(width - 1, height - 1);
    if (print.framing.x > 0.5) {
        let shape = surface_view.canvas_shape.zw;
        let edge = frame_field_edge(shape / max(shape.x, shape.y));
        uv = float2(frame_field_position(uv.x, edge.x), frame_field_position(uv.y, edge.y));
    }
    var hit = paper_surface_hit(uv, surface_view.canvas_shape.zw);
    if (print.framing.x > 0.5) {
        hit.position = float3((uv - 0.5) * float2(2.0, -2.0) * frame_aperture(hit.half), 0.0);
    }
    let lower = max(0.03, print.material.x * exp(-0.35 * print.surface.w));
    let upper = min(1.0, print.material.x * exp(0.35 * print.surface.w));
    let fraction = layers == 1 ? 0.0 : float(id.z) / float(layers - 1);
    let roughness = exp(lerp(log(lower), log(upper), fraction));
    let coefficients = print_direct_coefficients(hit, roughness, light_samples(roughness)) * print_light_calibration[0];
    lighting_out.Store(int3(id), coefficients);
}

float4 surface_coefficients(float2 uv, float2 size, float z)
{
    let at = uv * (size - 1.0);
    // The frame's glass mirrors the emitter whatever the paper's roughness is, so a narrow
    // light leaves a sharp field there that linear taps step across.
    if (print.surface.y / print.surface.x >= 0.177 || (print.material.x >= 0.05 && print.framing.x < 0.5)) {
        return lighting.SampleLevel(filtering, float3((at + 0.5) / size, z), 0.0);
    }
    let base = floor(at);
    let x = cubic_weights(at.x - base.x);
    let y = cubic_weights(at.y - base.y);
    let weights_x = float3(x.x, x.y + x.z, x.w);
    let weights_y = float3(y.x, y.y + y.z, y.w);
    let points_x = float3(-1.0, x.z / (x.y + x.z), 2.0);
    let points_y = float3(-1.0, y.z / (y.y + y.z), 2.0);
    var sum = float4(0.0);
    for (uint j = 0; j < 3; j += 1) {
        for (uint i = 0; i < 3; i += 1) {
            let point = (base + float2(points_x[i], points_y[j]) + 0.5) / size;
            sum += weights_x[i] * weights_y[j] * lighting.SampleLevel(filtering, float3(point, z), 0.0);
        }
    }
    return max(sum, float4(0.0));
}

float3 surface_nits(float2 pos)
{
    let shape = surface_view.canvas_shape.zw;
    let scale = surface_view.region.zw / surface_view.canvas_shape.xy;
    let border = print.framing.y * min(shape.x, shape.y);
    let uv = (surface_view.region.xy + pos * scale - border) / shape;
    let hit = paper_surface_hit(uv, shape);
    let footprint = 2.0 * scale / max(shape.x, shape.y);
    let on_photo = print.framing.x < 0.5 || all(abs(hit.position.xy) < hit.half + footprint);
    let roughness = on_photo ? paper_roughness(hit.position, footprint) : print.material.x;
    uint width;
    uint height;
    uint layers;
    lighting.GetDimensions(width, height, layers);
    let lower = max(0.03, print.material.x * exp(-0.35 * print.surface.w));
    let upper = min(1.0, print.material.x * exp(0.35 * print.surface.w));
    let fraction = saturate(log(roughness / lower) / max(log(upper / lower), 1e-7));
    let z = (0.5 + fraction * float(layers - 1)) / float(layers);
    var field_uv = print.framing.x > 0.5
        ? 0.5 + (uv - 0.5) * hit.half / frame_aperture(hit.half) : uv;
    if (print.framing.x > 0.5) {
        let edge = frame_field_edge(hit.half);
        field_uv = float2(frame_field_sample(field_uv.x, edge.x), frame_field_sample(field_uv.y, edge.y));
    }
    let direct = print.illumination.x == 0.0 ? float4(0.0)
        : surface_coefficients(field_uv, float2(width, height), z) / print_light_calibration[0];
    let colour = pigment.Load(int3(int2(pos), 0)).rgb;
    let reflectance = mul(SRGB_TO_R2020, lerp(float3(print.material.z), float3(print.material.y), colour));
    if (print.framing.x > 0.5) {
        return framed_from_coefficients(reflectance, hit, roughness, direct, footprint) * print_exposure().g;
    }
    return print_from_coefficients(reflectance, hit, roughness, direct) * print_exposure().g;
}

[shader("vertex")]
float4 vs(uint i : SV_VertexID) : SV_Position
{
    float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    return float4(corners[i], 0.0, 1.0);
}

[shader("fragment")]
float4 fs(float4 pos : SV_Position) : SV_Target
{
    let nits = measured<DisplayNits>(surface_nits(pos.xy));
    return float4(srgb_oetf_signed(mul(R2020_TO_P3, nits.v) / 203.0), 1.0);
}

[shader("fragment")]
uint4 fs_pq(float4 pos : SV_Position) : SV_Target
{
    let nits = surface_nits(pos.xy);
    let codes = float3(pq(measured<DisplayNits>(nits.r)).v, pq(measured<DisplayNits>(nits.g)).v,
        pq(measured<DisplayNits>(nits.b)).v);
    return uint4(uint3(round(codes * 65535.0)), 65535);
}
