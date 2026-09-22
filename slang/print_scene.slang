module print_scene;
import light;
import px;
import print_material;
import print_light;
import print_parameters;
import print_geometry;
import print_glass;
import print_environment;
import prelude;
[vk::binding(1, 1)] StructuredBuffer<float> print_albedo;
[vk::binding(2, 1)] public StructuredBuffer<float> print_light_calibration;

public static const uint LIGHT_SAMPLES = 128;

/// Whether sampling the lobe is worth anything beside sampling the emitter.
///
/// **Two strategies are one strategy and a source of noise when the emitter is the smaller of the
/// two.** A lamp a degree across under a paper lobe ten times that is found exactly by sampling the
/// emitter, where sampling the lobe hits it once in a hundred tries for a hundred times the value -
/// the mean is the same either way and the variance is not, and that variance is what the cached
/// field and the per-pixel draw then disagree by.
public bool print_lobe_sampled(float roughness)
{
    return print.surface.y > 0.5 * roughness * roughness * print.surface.x;
}

/// How many samples of the emitter a draw is worth.
///
/// **This is the whole of the print's cost**, paid per canvas pixel on the scene path and per field
/// texel on the surface one, and a reader whose device is slow enough for a frame of it to outrun a
/// driver's watchdog loses the tab rather than the frame rate. The count is what the noisier of the
/// strategies in play needs: where the lobe is sampled as well, that is the emitter's own ceiling;
/// where the emitter alone is, a quarter of them land within a thousand-sample render.
public uint light_samples(float roughness)
{
    return print_lobe_sampled(roughness) ? LIGHT_SAMPLES : 64;
}

public float3 print_illuminant()
{
    return float3(print_light_calibration[2], print_light_calibration[3], print_light_calibration[4]);
}

public Gain print_exposure()
{
    // The room's illuminance on the sheet as it is turned, so that turning it towards the ceiling
    // moves its reflections rather than its exposure - the camera meters what it is shown.
    let surround = room_illuminance(paper_rotation(float3(0.0, 0.0, 1.0)));
    let received = measured<Illuminance>(surround.v + print.illumination.x * print_light_calibration[1]);
    let minimum = exactly<Illuminance>(50.0);
    let white = exactly<DisplayNits>(203.0);
    return gain(PRINT_PI * white.v / max(received.v, minimum.v));
}

public Colour<DisplayNits> print_background()
{
    let ambient = measured<Illuminance>(print.illumination.z);
    return measured<DisplayNits>(0.18 * ambient.v / PRINT_PI * print_illuminant() * print_exposure().g);
}

/// The room's radiance along a world direction, read by a lobe of the given roughness from a
/// surface the reader is looking at along `world_view`.
public Light<DisplayNits> room_radiance(float3 world_direction, float3 world_view, float roughness)
{
    let ambient = measured<Illuminance>(print.illumination.z);
    let spread = min(2.0 * roughness * roughness, 1.0);
    return measured<DisplayNits>(ambient.v * print_light_calibration[6]
        * room_profile(world_direction.y, spread)
        * reader_share(dot(world_direction, world_view), spread));
}

/// The room's illuminance on a surface facing a world direction.
public Light<Illuminance> room_illuminance(float3 world_normal)
{
    let ambient = measured<Illuminance>(print.illumination.z);
    let up = world_normal.y;
    return measured<Illuminance>(ambient.v * (print_light_calibration[7] + print_light_calibration[8] * up
        + print_light_calibration[9] * 0.5 * (3.0 * up * up - 1.0)));
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

public float4 print_direct_coefficients(PrintHit hit, float roughness, uint count)
{
    let aperture = frame_aperture(hit.half);
    if (print.framing.x > 0.5 && print.illumination.w > 0.5) {
        hit.position = float3(clamp(hit.position.xy, -aperture, aperture), 0.0);
        hit.normal = float3(0.0, 0.0, 1.0);
        hit.material = PHOTO;
        hit.view = normalize(paper_inverse(float3(0.0, 0.0, print_camera_distance())) - hit.position);
    }
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
    // Balance-weighted while both strategies run, and weighted against the emitter alone where only
    // that one does, so the estimate is the same on either side of the gate.
    let mixed = print_lobe_sampled(roughness);
    let body = (1.0 - albedo) / (PRINT_PI * (1.0 - paper_average_albedo(roughness)));
    let front = frame_front_depth();
    let mat_position = float3(hit.position.xy, hit.material == PHOTO ? frame_mat_depth() : hit.position.z);
    let world_mat = paper_rotation(mat_position);
    var direct = float4(0.0);
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
            var transmission = 1.0;
            if (print.framing.x > 0.5) {
                let local_direction = paper_inverse(direction);
                transmission = frame_occluded(hit.position, local_direction, aperture, front)
                    ? 0.0 : glass_transmittance(local_direction.z);
            }
            let lobe_pdf = mixed ? normal_pdf(local_view, incident, alpha) : 0.0;
            direct.xy += softbox_profile(emitter_at) * incident.z
                * float2(transmission * diffuse / pdf, transmission * specular / (pdf + lobe_pdf));
            if (print.framing.x > 0.5) {
                direct.w += softbox_profile(emitter_at) * incident.z / (PRINT_PI * pdf);
            }
        }
        if (print.framing.x > 0.5) {
            let mat_delta = point - world_mat;
            let mat_direction = normalize(mat_delta);
            let cosine = dot(mat_direction, world_normal);
            let emitter_cosine = dot(light, mat_direction);
            let local_direction = paper_inverse(mat_direction);
            if (cosine > 0.0 && emitter_cosine > 0.0 && !frame_occluded(mat_position, local_direction, aperture, front)) {
                let pdf = dot(mat_delta, mat_delta) * SOFTBOX_ASPECT / (4.0 * half_width.d * half_width.d * emitter_cosine);
                direct.z += softbox_profile(emitter_at) * cosine * glass_transmittance(local_direction.z) / (PRINT_PI * pdf);
            }
        }
        let half = visible_normal(local_view, alpha, sample);
        let reflected = reflect(-local_view, half);
        if (mixed && reflected.z > 0.0) {
            let world_direction = tangent * reflected.x + bitangent * reflected.y + world_normal * reflected.z;
            let emitter = softbox_hit(position, world_direction, light_tangent, light_bitangent, distance, half_width);
            if (emitter.x > 0.0) {
                var transmission = 1.0;
                if (print.framing.x > 0.5) {
                    let local_direction = paper_inverse(world_direction);
                    transmission = frame_occluded(hit.position, local_direction, aperture, front)
                        ? 0.0 : glass_transmittance(local_direction.z);
                }
                direct.y += transmission * softbox_profile(emitter.yz) * reflected.z
                    * specular_brdf(local_view, reflected, alpha, print.material.w)
                    / (emitter.x + normal_pdf(local_view, reflected, alpha));
            }
        }
    }
    return direct / float(count);
}

public float3 print_from_coefficients(float3 reflectance, PrintHit hit, float roughness, float4 direct)
{
    let albedo = paper_albedo(max(dot(hit.view, hit.normal), 1e-5), roughness);
    let diffuse_transmission = print.framing.x > 0.5 ? print_light_calibration[5] : 1.0;
    let specular_transmission = print.framing.x > 0.5 ? glass_transmittance(hit.view.z) : 1.0;
    let mirrored = paper_rotation(reflect(-hit.view, hit.normal));
    let sheen = albedo * room_radiance(mirrored, paper_rotation(hit.view), roughness).v * specular_transmission;
    let body = reflectance * (1.0 - albedo) * diffuse_transmission
        * room_illuminance(paper_rotation(hit.normal)).v / PRINT_PI;
    return (sheen + body + print.illumination.x * print_light_calibration[0]
        * (direct.x * reflectance + direct.y)) * print_illuminant();
}

float frame_rectangle_coverage(float2 point, float2 half, float2 footprint)
{
    let covered = saturate((half - abs(point)) / max(footprint, float2(1e-6)) + 0.5);
    return covered.x * covered.y;
}

float3 glass_reflected_light(PrintHit hit)
{
    if (hit.view.z <= 0.0) { return float3(0.0); }
    let at = hit.position + hit.view * ((frame_glass_depth() - hit.position.z) / hit.view.z);
    let direction = float3(-hit.view.xy, hit.view.z);
    if (frame_occluded(at, direction, frame_aperture(hit.half), frame_front_depth())) { return float3(0.0); }
    let light = print.light.xyz;
    let tangent = normalize(abs(light.z) < 0.99 ? cross(float3(0.0, 0.0, 1.0), light)
        : cross(float3(0.0, 1.0, 0.0), light));
    let bitangent = cross(light, tangent);
    let world = paper_rotation(direction);
    let distance = exactly<PrintUnit>(print.surface.x);
    let half_width = exactly<PrintUnit>(print.surface.y);
    let source = print.illumination.x * print_light_calibration[0];
    let front = glass_front_reflectance(hit.view.z);
    let total = glass_reflectance(hit.view.z);
    // The second surface's image of the lamp, a glass thickness to the side of the first: two
    // reflections of one lamp is what tells a reader they are looking through glass at all.
    let lateral = glass_ghost_offset(hit.view.z, print.surface.z);
    let sideways = length(hit.view.xy) > 1e-6 ? normalize(hit.view.xy) : float2(0.0);
    var direct = 0.0;
    let emitter = softbox_hit(paper_rotation(at), world, tangent, bitangent, distance, half_width);
    if (emitter.x > 0.0) { direct += front * softbox_profile(emitter.yz) * source; }
    let ghost_at = float3(at.xy - sideways * lateral, at.z);
    let ghost = softbox_hit(paper_rotation(ghost_at), world, tangent, bitangent, distance, half_width);
    if (ghost.x > 0.0) { direct += (total - front) * softbox_profile(ghost.yz) * source; }
    let radiance = measured<DisplayNits>(total * room_radiance(world, paper_rotation(hit.view), 0.0).v + direct);
    return radiance.v * print_illuminant();
}

public float3 framed_from_coefficients(float3 reflectance, PrintHit hit, float roughness,
    float4 direct, float2 footprint)
{
    let source = measured<DisplayNits>(print.illumination.x * print_light_calibration[0]);
    let ambient = measured<DisplayNits>(room_illuminance(paper_rotation(hit.normal)).v / PRINT_PI);
    let rim = float3(0.018) * (ambient.v + source.v * direct.w) * print_illuminant();
    if (hit.material == BACK) {
        return float3(0.12, 0.085, 0.055) * (ambient.v + source.v * direct.w) * print_illuminant();
    }
    if (hit.material == RIM && (print.illumination.w < 0.5 || hit.normal.z < 0.5)) { return rim; }
    let glass_coverage = print.illumination.w < 0.5 ? 1.0
        : frame_rectangle_coverage(hit.position.xy, frame_aperture(hit.half), footprint);
    if (glass_coverage == 0.0) { return rim; }
    let photo_coverage = print.illumination.w < 0.5 ? float(hit.material == PHOTO)
        : (hit.normal.z < 0.5 ? 0.0 : frame_rectangle_coverage(hit.position.xy, hit.half, footprint));
    let mat = float3(0.86, 0.845, 0.81)
        * (ambient.v * print_light_calibration[5] + source.v * direct.z) * print_illuminant();
    var substrate = mat;
    if (photo_coverage > 0.0) {
        substrate = lerp(mat, print_from_coefficients(reflectance, hit, roughness, direct), photo_coverage);
    }
    let transmitted = substrate * glass_transmittance(hit.view.z);
    return lerp(rim, transmitted + glass_reflected_light(hit), glass_coverage);
}

public Colour<DisplayNits> reflected_print_samples(float3 reflectance, PrintHit hit, float roughness, uint count)
{
    let direct = print.illumination.x == 0.0 ? float4(0.0) : print_direct_coefficients(hit, roughness, count);
    return measured<DisplayNits>(print_from_coefficients(reflectance, hit, roughness, direct));
}

public Colour<DisplayNits> reflected_print(float3 reflectance, PrintHit hit, float2 footprint)
{
    let roughness = paper_roughness(hit.position, footprint);
    if (print.framing.x > 0.5) {
        let direct = print.illumination.x == 0.0 ? float4(0.0)
            : print_direct_coefficients(hit, roughness, light_samples(roughness));
        return measured<DisplayNits>(framed_from_coefficients(reflectance, hit, roughness, direct, footprint));
    }
    return reflected_print_samples(reflectance, hit, roughness, light_samples(roughness));
}
