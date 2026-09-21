module print_scene;
import light;
import px;
import print_material;
import print_light;
import print_parameters;
import print_geometry;
import prelude;
[vk::binding(1, 1)] StructuredBuffer<float> print_albedo;
[vk::binding(2, 1)] public StructuredBuffer<float> print_light_calibration;

public static const uint LIGHT_SAMPLES = 128;

public float3 print_illuminant()
{
    return float3(print_light_calibration[2], print_light_calibration[3], print_light_calibration[4]);
}

public Gain print_exposure()
{
    let received = measured<Illuminance>(print.illumination.z + print.illumination.x * print_light_calibration[1]);
    let minimum = exactly<Illuminance>(50.0);
    let white = exactly<DisplayNits>(203.0);
    return gain(PRINT_PI * white.v / max(received.v, minimum.v));
}

public Colour<DisplayNits> print_background()
{
    let ambient = measured<Illuminance>(print.illumination.z);
    return measured<DisplayNits>(0.18 * ambient.v / PRINT_PI * print_illuminant() * print_exposure().g);
}

public float paper_albedo(float cosine, float roughness)
{
    let x = sqrt(saturate(cosine)) * float(ALBEDO_VIEWS - 1);
    let y = saturate((roughness - 0.03) / 0.97) * float(ALBEDO_ROUGHNESSES - 1);
    let left = min(uint(x), ALBEDO_VIEWS - 2);
    let row = min(uint(y), ALBEDO_ROUGHNESSES - 2);
    let first = lerp(print_albedo[row * ALBEDO_STRIDE + left], print_albedo[row * ALBEDO_STRIDE + left + 1], x - float(left));
    let second = lerp(print_albedo[(row + 1) * ALBEDO_STRIDE + left], print_albedo[(row + 1) * ALBEDO_STRIDE + left + 1], x - float(left));
    return lerp(first, second, y - float(row));
}

public float paper_average_albedo(float roughness)
{
    let y = saturate((roughness - 0.03) / 0.97) * float(ALBEDO_ROUGHNESSES - 1);
    let row = min(uint(y), ALBEDO_ROUGHNESSES - 2);
    return lerp(print_albedo[row * ALBEDO_STRIDE + ALBEDO_VIEWS],
        print_albedo[(row + 1) * ALBEDO_STRIDE + ALBEDO_VIEWS], y - float(row));
}

public float3 paper_brdf(float3 reflectance, float3 view, float3 incident, float roughness)
{
    if (view.z <= 0.0 || incident.z <= 0.0) { return float3(0.0); }
    let transmission = (1.0 - paper_albedo(view.z, roughness)) * (1.0 - paper_albedo(incident.z, roughness));
    let diffuse = transmission / (PRINT_PI * (1.0 - paper_average_albedo(roughness)));
    return reflectance * diffuse + specular_brdf(view, incident, roughness * roughness, print.material.w);
}

float grain_value(int2 cell)
{
    var hash = uint(cell.x) * 0x8da6b343u ^ uint(cell.y) * 0xd8163841u;
    hash ^= hash >> 16;
    hash *= 0x7feb352du;
    hash ^= hash >> 15;
    return float(hash & 0x00ffffffu) / 8388607.5 - 1.0;
}

float paper_grain(float2 at)
{
    let cell = int2(floor(at));
    let fraction = frac(at);
    let blend = fraction * fraction * (3.0 - 2.0 * fraction);
    return lerp(lerp(grain_value(cell), grain_value(cell + int2(1, 0)), blend.x),
        lerp(grain_value(cell + int2(0, 1)), grain_value(cell + int2(1, 1)), blend.x), blend.y);
}

public float paper_roughness(float3 position, float2 footprint)
{
    let millimetres = position.xy * print.surface.z;
    let width = footprint * print.surface.z;
    let fine = exactly<Millimetre>(0.35);
    let coarse = exactly<Millimetre>(1.1);
    let filtered1 = exp(-0.5 * dot(width, width) / (fine.d * fine.d));
    let filtered2 = exp(-0.5 * dot(width, width) / (coarse.d * coarse.d));
    let variation = 0.65 * filtered1 * paper_grain(millimetres / fine.d)
        + 0.35 * filtered2 * paper_grain(millimetres / coarse.d + float2(19.3, 7.1));
    return clamp(print.material.x * exp(0.35 * print.surface.w * variation), 0.03, 1.0);
}

public float3 softbox_hit(float3 position, float3 direction, float3 tangent, float3 bitangent,
    Extent<PrintUnit> distance, Extent<PrintUnit> half_width)
{
    let cosine = dot(print.light.xyz, direction);
    if (cosine <= 0.0) { return float3(0.0); }
    let along = (distance.d - dot(print.light.xyz, position)) / cosine;
    if (along <= 0.0) { return float3(0.0); }
    let offset = position + along * direction - print.light.xyz * distance.d;
    let at = float2(dot(offset, tangent), dot(offset, bitangent) * SOFTBOX_ASPECT) / half_width.d;
    if (any(abs(at) > 1.0)) { return float3(0.0); }
    return float3(along * along * SOFTBOX_ASPECT / (4.0 * half_width.d * half_width.d * cosine), at);
}

public float2 print_direct_coefficients(PrintHit hit, float roughness, uint count)
{
    let world_normal = paper_rotation(hit.normal);
    let world_view = paper_rotation(hit.view);
    let position = paper_rotation(hit.position);
    let tangent = normalize(abs(world_normal.z) < 0.99 ? cross(float3(0.0, 0.0, 1.0), world_normal)
        : cross(float3(0.0, 1.0, 0.0), world_normal));
    let bitangent = cross(world_normal, tangent);
    let local_view = float3(dot(world_view, tangent), dot(world_view, bitangent), max(dot(world_view, world_normal), 1e-5));
    let albedo = paper_albedo(local_view.z, roughness);
    let light = print.light.xyz;
    let light_tangent = normalize(abs(light.z) < 0.99 ? cross(float3(0.0, 0.0, 1.0), light)
        : cross(float3(0.0, 1.0, 0.0), light));
    let light_bitangent = cross(light, light_tangent);
    let distance = exactly<PrintUnit>(print.surface.x);
    let half_width = exactly<PrintUnit>(print.surface.y);
    let alpha = roughness * roughness;
    let body = (1.0 - albedo) / (PRINT_PI * (1.0 - paper_average_albedo(roughness)));
    var direct = float2(0.0);
    for (uint i = 0; i < count; i += 1) {
        let sample = quadrature(i, count);
        let emitter_at = 2.0 * sample - 1.0;
        let point = light * distance.d + half_width.d
            * (emitter_at.x * light_tangent + emitter_at.y / SOFTBOX_ASPECT * light_bitangent);
        let delta = point - position;
        let direction = normalize(delta);
        let incident = float3(dot(direction, tangent), dot(direction, bitangent), dot(direction, world_normal));
        let emitter_cosine = dot(light, direction);
        if (incident.z > 0.0 && emitter_cosine > 0.0) {
            let pdf = dot(delta, delta) * SOFTBOX_ASPECT / (4.0 * half_width.d * half_width.d * emitter_cosine);
            let specular = specular_brdf(local_view, incident, alpha, print.material.w);
            let diffuse = body * (1.0 - paper_albedo(incident.z, roughness));
            direct += softbox_profile(emitter_at) * incident.z
                * float2(diffuse / pdf, specular / (pdf + normal_pdf(local_view, incident, alpha)));
        }
        let half = visible_normal(local_view, alpha, sample);
        let reflected = reflect(-local_view, half);
        if (reflected.z > 0.0) {
            let world_direction = tangent * reflected.x + bitangent * reflected.y + world_normal * reflected.z;
            let emitter = softbox_hit(position, world_direction, light_tangent, light_bitangent, distance, half_width);
            if (emitter.x > 0.0) {
                direct.y += softbox_profile(emitter.yz) * reflected.z
                    * specular_brdf(local_view, reflected, alpha, print.material.w)
                    / (emitter.x + normal_pdf(local_view, reflected, alpha));
            }
        }
    }
    return direct / float(count);
}

public float3 print_from_coefficients(float3 reflectance, PrintHit hit, float roughness, float2 direct)
{
    let albedo = paper_albedo(max(dot(hit.view, hit.normal), 1e-5), roughness);
    let ambient = print.illumination.z / PRINT_PI * (albedo + reflectance * (1.0 - albedo));
    return (ambient + print.illumination.x * print_light_calibration[0]
        * (direct.x * reflectance + direct.y)) * print_illuminant();
}

public Colour<DisplayNits> reflected_print_samples(float3 reflectance, PrintHit hit, float roughness, uint count)
{
    let direct = print.illumination.x == 0.0 ? float2(0.0) : print_direct_coefficients(hit, roughness, count);
    return measured<DisplayNits>(print_from_coefficients(reflectance, hit, roughness, direct));
}

public Colour<DisplayNits> reflected_print(float3 reflectance, PrintHit hit, float2 footprint)
{
    return reflected_print_samples(reflectance, hit, paper_roughness(hit.position, footprint), LIGHT_SAMPLES);
}
