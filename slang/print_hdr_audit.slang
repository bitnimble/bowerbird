import prelude;
import light;
import primaries;
import px;

[vk::binding(0, 0)] Texture2D<float4> canvas;
[vk::binding(1, 0)] Texture2D<uint4> pq_canvas;
[vk::binding(2, 0)] Texture2D<float4> doubled_canvas;
[vk::binding(3, 0)] Texture2D<float4> proof_canvas;
[vk::binding(4, 0)] RWStructuredBuffer<float4> results;
groupshared float4 values[256];

float3 linear_canvas(float3 coded)
{
    return sign(coded) * float3(srgb_eotf(abs(coded.x)), srgb_eotf(abs(coded.y)), srgb_eotf(abs(coded.z))) * 203.0;
}

void decode_pq(out Colour<DisplayNits> nits, Colour<Pq> coded)
{
    let e = pow(clamp(coded.v, 0.0, 1.0), 1.0 / PQ_M2);
    nits.v = 10000.0 * pow(max(e - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * e), 1.0 / PQ_M1);
}

[shader("compute")]
[numthreads(64, 1, 1)]
void audit(uint lane : SV_GroupIndex)
{
    uint width;
    uint height;
    canvas.GetDimensions(width, height);
    float4 range = float4(1e10, 0.0, 0.0, 0.0);
    float4 counts = float4(0.0);
    float4 errors = float4(0.0);
    float4 highlights = float4(0.0);
    let probe_radius = exactly<Drawn>(64.0);
    let background = linear_canvas(canvas.Load(int3(0, 0, 0)).xyz);
    let centre = int3(width / 2, height / 2, 0);
    let first_centre = linear_canvas(canvas.Load(centre).xyz);
    let second_centre = linear_canvas(doubled_canvas.Load(centre).xyz);
    let exposure_ratio = max(second_centre.x, max(second_centre.y, second_centre.z))
        / max(max(first_centre.x, max(first_centre.y, first_centre.z)), 1e-6);
    for (uint index = lane; index < width * height; index += 64) {
        let at = int3(index % width, index / width, 0);
        let coded = canvas.Load(at).xyz;
        Colour<DisplayNits> nits;
        nits.v = linear_canvas(coded);
        Colour<DisplayNits> doubled;
        doubled.v = linear_canvas(doubled_canvas.Load(at).xyz);
        Colour<Pq> pq_codes;
        pq_codes.v = float3(pq_canvas.Load(at).xyz) / 65535.0;
        Colour<DisplayNits> reference;
        decode_pq(reference, pq_codes);
        let p3_reference = mul(R2020_TO_P3, reference.v);
        let error = abs(nits.v - p3_reference);
        errors.x = max(errors.x, max(error.x, max(error.y, error.z)));
        let relative = error / max(abs(p3_reference), float3(1.0));
        errors.y = max(errors.y, max(relative.x, max(relative.y, relative.z)));
        let proof_error = abs(coded - proof_canvas.Load(at).xyz);
        errors.z = max(errors.z, max(proof_error.x, max(proof_error.y, proof_error.z)));
        let centre = float2(at.xy) - float2(width, height) * 0.5;
        if (dot(centre, centre) < probe_radius.d * probe_radius.d) {
            let expected = exposure_ratio * nits.v;
            let scaling_error = abs(doubled.v - expected) / max(abs(expected), float3(1.0));
            errors.w = max(errors.w, max(scaling_error.x, max(scaling_error.y, scaling_error.z)));
        }
        if (all(abs(nits.v - background) < 0.03)) { continue; }
        let luminance = dot(reference.v, LUMA);
        range.x = min(range.x, luminance);
        range.y = max(range.y, luminance);
        range.z = max(range.z, max(nits.v.x, max(nits.v.y, nits.v.z)));
        range.w = max(range.w, max(coded.x, max(coded.y, coded.z)));
        counts += float4(luminance, float(luminance > 203.0), 1.0, float(min(nits.v.x, min(nits.v.y, nits.v.z)) < 0.0));
        highlights += float4(float(luminance > 500.0), float(luminance > 1000.0), float(luminance > 2000.0), 0.0);
    }
    values[lane] = range;
    values[64 + lane] = counts;
    values[128 + lane] = errors;
    values[192 + lane] = highlights;
    GroupMemoryBarrierWithGroupSync();
    for (uint stride = 32; stride > 0; stride /= 2) {
        if (lane < stride) {
            values[lane].x = min(values[lane].x, values[lane + stride].x);
            values[lane].yzw = max(values[lane].yzw, values[lane + stride].yzw);
            values[64 + lane] += values[64 + lane + stride];
            values[128 + lane] = max(values[128 + lane], values[128 + lane + stride]);
            values[192 + lane] += values[192 + lane + stride];
        }
        GroupMemoryBarrierWithGroupSync();
    }
    if (lane == 0) {
        results[0] = values[0];
        results[1] = values[64];
        results[2] = values[128];
        results[3] = values[192];
    }
}
