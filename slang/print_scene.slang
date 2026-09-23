module print_scene;
import light;
import px;
import print_material;
import print_light;
import print_parameters;
import print_geometry;
import print_glass;
import print_environment;
import print_noise;
import prelude;
[vk::binding(1, 1)] StructuredBuffer<float> print_albedo;
[vk::binding(2, 1)] public StructuredBuffer<float> print_light_calibration;

public static const uint LIGHT_SAMPLES = 128;

static const float3 MAT_ALBEDO = float3(0.86, 0.845, 0.81);

/// What a pane hands back to what it covers, summed over every trip between the two.
///
/// **A framed picture is brighter than the same picture unframed, and its own colour is what
/// brightens it.** A tenth of what a mat sends up comes back down off the underside of the glass to
/// be diffused again, and a tenth of that again, so the series is worth a tenth of the sheet rather
/// than a tenth of a percent - which is enough to see, and it lands per channel, so a deep red under
/// the pane comes back redder while the mat beside it barely moves.
float3 glass_trapped(float3 albedo)
{
    let underside = 1.0 - print_light_calibration[5];
    return 1.0 / (1.0 - underside * saturate(albedo));
}

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
    // The sheet hung facing the reader, never the pose: a camera meters a room once and a print
    // turned in the hand does not re-expose it, so metering the turned normal would move the
    // background and every unturned thing in the picture along with the sheet.
    let surround = room_illuminance(float3(0.0, 0.0, 1.0));
    // The lamp's incidence on that same facing sheet, not `print_light_calibration[1]`, which is
    // the cosine the current pose presents: metering through it re-exposes the whole scene as the
    // sheet turns, and turned far enough it forgets the lamp and exposes for the room instead.
    let facing = print.illumination.x * max(print.light.z, 0.0);
    let received = measured<Illuminance>(surround.v + facing);
    let minimum = exactly<Illuminance>(50.0);
    let white = exactly<DisplayNits>(203.0);
    return gain(PRINT_PI * white.v / max(received.v, minimum.v));
}

/// The ambient the reader set, and what the lamp returns off the room's own surfaces.
Light<Illuminance> room_lit()
{
    return measured<Illuminance>(print.illumination.z);
}

/// The lamp's own output, never its incidence on the sheet: `print_light_calibration[1]` is the
/// cosine the *pose* presents to the lamp, and it falls to zero exactly when the sheet is turned
/// away - which is the one case a room's bounce is the whole of the light reaching it.
Light<Illuminance> bounce_lit()
{
    return measured<Illuminance>(ROOM_BOUNCE * print.illumination.x);
}

public Colour<DisplayNits> print_background()
{
    let lit = measured<Illuminance>(room_lit().v + bounce_lit().v);
    return measured<DisplayNits>(0.18 * lit.v / PRINT_PI * print_illuminant() * print_exposure().g);
}

/// The room's radiance along a world direction, read by a lobe of the given roughness from a
/// surface the reader is looking at along `world_view`.
public Light<DisplayNits> room_radiance(float3 world_direction, float3 world_view, float roughness)
{
    let spread = min(2.0 * roughness * roughness, 1.0);
    let lit = room_lit().v * print_light_calibration[6] * room_profile(world_direction.y, spread)
        + bounce_lit().v * print_light_calibration[10] * bounce_profile(world_direction.y, spread);
    return measured<DisplayNits>(lit * reader_share(world_direction, world_view, spread));
}

/// The room's illuminance on a surface facing a world direction.
public Light<Illuminance> room_illuminance(float3 world_normal)
{
    let up = world_normal.y;
    let zonal = float3(1.0, up, 0.5 * (3.0 * up * up - 1.0));
    // Clamped per profile, not on the sum: three bands of a room whose light is all on one side
    // ring below zero on the other, and a floor's bounce owes an upturned sheet nothing rather
    // than owing it a debt against the ceiling's.
    let ambient = max(dot(zonal, float3(print_light_calibration[7], print_light_calibration[8],
        print_light_calibration[9])), 0.0);
    let bounced = max(dot(zonal, float3(print_light_calibration[11], print_light_calibration[12],
        print_light_calibration[13])), 0.0);
    return measured<Illuminance>(room_lit().v * ambient + bounce_lit().v * bounced);
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

public float paper_roughness(float3 position, float2 footprint)
{
    let millimetres = position.xy * print.surface.z;
    let width = footprint * print.surface.z;
    let fine = exactly<Millimetre>(0.35);
    let coarse = exactly<Millimetre>(1.1);
    let filtered1 = exp(-0.5 * dot(width, width) / (fine.d * fine.d));
    let filtered2 = exp(-0.5 * dot(width, width) / (coarse.d * coarse.d));
    let variation = 0.65 * filtered1 * value_noise(millimetres / fine.d)
        + 0.35 * filtered2 * value_noise(millimetres / coarse.d + float2(19.3, 7.1));
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

/// Which of [`print_direct_coefficients`]'s four a caller is going to read.
///
/// A framed pixel shows the photograph, or the mat, or the moulding, and integrating the emitter
/// against all three costs two extra occlusion tests and a second direction per light sample for
/// answers the pixel then discards.
public static const uint WANT_PAPER = 1u;
public static const uint WANT_MAT = 2u;
public static const uint WANT_RIM = 4u;
public static const uint WANT_ALL = 7u;

/// How much of the sky an emitter has to cover before its diffuse term needs sampling at all.
///
/// **The two halves of one integral want sample counts two orders apart.** What a lamp a degree
/// across does to a diffuse surface is its own mean radiance times one cosine, because every
/// geometric factor is constant across a face that small - `MEAN_SOFTBOX` is that mean in closed
/// form, so one evaluation at the centre is not an estimate of the integral but the integral. What
/// it does to a gloss surface is a lobe narrower than the lamp, and that is what [`light_samples`]
/// is sized for; integrating both at the specular's count is most of a framed gloss frame spent
/// resolving a curve that was already flat.
///
/// A near softbox is the case this cannot have: half a radian across and a print length away, its
/// own inverse square and cosine vary over its face by a quarter. Past a hundredth of a steradian
/// the diffuse pays the full count.
static const float DIFFUSE_SOLID_ANGLE = 0.01;
static const uint BROAD_LOBE_SAMPLES = 16;

static const float LOBE_REACH = 32.0;
static const float REACH_FLOOR = 3.0;

/// **Four tests instead of one per sample.** The moulding shadows a surface through a rectangular
/// hole, so the directions it lets through form a convex cone, and the emitter is convex too - which
/// makes its four corners clearing the hole enough to say every direction between them does. A print
/// well inside its own aperture is that case for almost every pixel, and without this the frame
/// costs the sheet a ray-box test against each of its samples.
bool emitter_clear(float3 local_point, float3 world_point, float3 light_tangent, float3 light_bitangent,
    Extent<PrintUnit> distance, Extent<PrintUnit> half_width, float2 aperture, float front)
{
    if (print.framing.x < 0.5) { return false; }
    for (uint corner = 0; corner < 4; corner += 1) {
        let edge = float2(float(corner & 1u), float(corner >> 1)) * 2.0 - 1.0;
        let point = print.light.xyz * distance.d + half_width.d
            * (edge.x * light_tangent + edge.y / SOFTBOX_ASPECT * light_bitangent);
        let towards = paper_inverse(normalize(point - world_point));
        if (frame_occluded(local_point, towards, aperture, front)) { return false; }
    }
    return true;
}

/// Whether the lobe reflected towards the reader can see the lamp at all.
///
/// A sheet's specular is zero wherever the mirror direction misses the emitter by more than the
/// lobe's own reach, which on a gloss paper is most of the sheet - and the samples that answer it
/// are the expensive ones.
///
/// **A share of the peak is the wrong thing to measure a tail against, because the peak is what
/// roughness moves.** `LOBE_REACH` is where GGX has fallen a millionth under its own peak, which is
/// the same angle in lobe widths whatever the lobe - and a mirror-smooth paper's peak is four
/// hundred thousand, so a millionth of it is still a nit. `REACH_FLOOR` is the other reading of the
/// same tail, putting the cut where the density itself falls under a fixed level, which is where the
/// term is worth a fraction of a code of anybody's white. Narrowing either one clips the tail into a
/// visible step around the glare, and the cached lighting field shows it first, since its texels and
/// the per-pixel draw then disagree about where the step is.
bool specular_reaches(float3 position, float3 world_view, float3 world_normal, float alpha,
    Extent<PrintUnit> distance, Extent<PrintUnit> half_width)
{
    let towards = print.light.xyz * distance.d - position;
    let range = length(towards);
    let apart = acos(clamp(dot(towards / range, reflect(-world_view, world_normal)), -1.0, 1.0));
    let reach = max(LOBE_REACH * alpha, REACH_FLOOR * sqrt(alpha));
    return apart < atan(1.5 * half_width.d / range) + reach;
}

public float4 print_direct_coefficients(PrintHit hit, float roughness, uint count, uint wanted)
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
    let clear = emitter_clear(hit.position, position, light_tangent, light_bitangent,
        distance, half_width, aperture, front);
    let mat_clear = (wanted & WANT_MAT) == 0u || emitter_clear(mat_position, world_mat,
        light_tangent, light_bitangent, distance, half_width, aperture, front);
    // A penumbra is the one place the emitter's own face matters to a diffuse surface, and it is
    // where a short count bands rather than converging slowly.
    let shadowed = print.framing.x > 0.5 && !(clear && mat_clear);
    let solid = 4.0 * half_width.d * half_width.d / (SOFTBOX_ASPECT * distance.d * distance.d);
    let averaged = !shadowed && solid <= DIFFUSE_SOLID_ANGLE;
    let diffuse_count = averaged ? 1u : count;
    var diffuse = float3(0.0);
    for (uint i = 0; i < diffuse_count; i += 1) {
        let emitter_at = averaged ? float2(0.0) : 2.0 * quadrature(i, diffuse_count) - 1.0;
        let radiance = averaged ? MEAN_SOFTBOX : softbox_profile(emitter_at);
        let point = light * distance.d + half_width.d
            * (emitter_at.x * light_tangent + emitter_at.y / SOFTBOX_ASPECT * light_bitangent);
        let delta = point - position;
        let direction = normalize(delta);
        let incident = float3(dot(direction, tangent), dot(direction, bitangent), dot(direction, world_normal));
        let emitter_cosine = dot(light, direction);
        if (incident.z > 0.0 && emitter_cosine > 0.0 && (wanted & (WANT_PAPER | WANT_RIM)) != 0u) {
            let pdf = dot(delta, delta) * SOFTBOX_ASPECT / (4.0 * half_width.d * half_width.d * emitter_cosine);
            let carried = radiance * incident.z / pdf;
            if ((wanted & WANT_PAPER) != 0u) {
                var transmission = 1.0;
                if (print.framing.x > 0.5) {
                    let local_direction = paper_inverse(direction);
                    transmission = !clear && frame_occluded(hit.position, local_direction, aperture, front)
                        ? 0.0 : glass_transmittance(local_direction.z);
                }
                diffuse.x += carried * transmission * body * (1.0 - paper_albedo(incident.z, roughness));
            }
            if (print.framing.x > 0.5 && (wanted & WANT_RIM) != 0u) {
                diffuse.z += carried / PRINT_PI;
            }
        }
        if (print.framing.x > 0.5 && (wanted & WANT_MAT) != 0u) {
            let mat_delta = point - world_mat;
            let mat_direction = normalize(mat_delta);
            let cosine = dot(mat_direction, world_normal);
            let emitter_cosine = dot(light, mat_direction);
            let local_direction = paper_inverse(mat_direction);
            if (cosine > 0.0 && emitter_cosine > 0.0 && !frame_occluded(mat_position, local_direction, aperture, front)) {
                let pdf = dot(mat_delta, mat_delta) * SOFTBOX_ASPECT / (4.0 * half_width.d * half_width.d * emitter_cosine);
                diffuse.y += radiance * cosine * glass_transmittance(local_direction.z) / (PRINT_PI * pdf);
            }
        }
    }
    diffuse /= float(diffuse_count);
    if ((wanted & WANT_PAPER) == 0u || !specular_reaches(position, world_view, world_normal, alpha, distance, half_width)) {
        return float4(diffuse.x, 0.0, diffuse.y, diffuse.z);
    }
    // Where the lobe is wider than the emitter, the emitter's face carries as little of the
    // specular's shape as it does of the diffuse's, and the full count buys the same answer.
    let specular_count = mixed || shadowed ? count : min(count, BROAD_LOBE_SAMPLES);
    var specular = 0.0;
    for (uint i = 0; i < specular_count; i += 1) {
        let sample = quadrature(i, specular_count);
        let emitter_at = 2.0 * sample - 1.0;
        let point = light * distance.d + half_width.d
            * (emitter_at.x * light_tangent + emitter_at.y / SOFTBOX_ASPECT * light_bitangent);
        let delta = point - position;
        let direction = normalize(delta);
        let incident = float3(dot(direction, tangent), dot(direction, bitangent), dot(direction, world_normal));
        let emitter_cosine = dot(light, direction);
        if (incident.z > 0.0 && emitter_cosine > 0.0) {
            let pdf = dot(delta, delta) * SOFTBOX_ASPECT / (4.0 * half_width.d * half_width.d * emitter_cosine);
            var transmission = 1.0;
            if (print.framing.x > 0.5) {
                let local_direction = paper_inverse(direction);
                transmission = !clear && frame_occluded(hit.position, local_direction, aperture, front)
                    ? 0.0 : glass_transmittance(local_direction.z);
            }
            let lobe_pdf = mixed ? normal_pdf(local_view, incident, alpha) : 0.0;
            specular += softbox_profile(emitter_at) * incident.z * transmission
                * specular_brdf(local_view, incident, alpha, print.material.w) / (pdf + lobe_pdf);
        }
        if (!mixed) { continue; }
        let half = visible_normal(local_view, alpha, sample);
        let reflected = reflect(-local_view, half);
        if (reflected.z > 0.0) {
            let world_direction = tangent * reflected.x + bitangent * reflected.y + world_normal * reflected.z;
            let emitter = softbox_hit(position, world_direction, light_tangent, light_bitangent, distance, half_width);
            if (emitter.x > 0.0) {
                var transmission = 1.0;
                if (print.framing.x > 0.5) {
                    let local_direction = paper_inverse(world_direction);
                    transmission = !clear && frame_occluded(hit.position, local_direction, aperture, front)
                        ? 0.0 : glass_transmittance(local_direction.z);
                }
                specular += transmission * softbox_profile(emitter.yz) * reflected.z
                    * specular_brdf(local_view, reflected, alpha, print.material.w)
                    / (emitter.x + normal_pdf(local_view, reflected, alpha));
            }
        }
    }
    return float4(diffuse.x, specular / float(specular_count), diffuse.y, diffuse.z);
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
    let direction = reflect(-hit.view, normalize(float3(-glass_wave(at.xy * print.surface.z), 1.0)));
    if (direction.z <= 0.0) { return float3(0.0); }
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
    let ghost_at = float3(at.xy - sideways * lateral, at.z);
    var direct = 0.0;
    let emitter = softbox_hit(paper_rotation(at), world, tangent, bitangent, distance, half_width);
    if (emitter.x > 0.0) { direct += front * softbox_profile(emitter.yz) * source; }
    let ghost = softbox_hit(paper_rotation(ghost_at), world, tangent, bitangent, distance, half_width);
    if (ghost.x > 0.0) { direct += (total - front) * softbox_profile(ghost.yz) * source; }
    // The skirt the pane scatters around that image, which is the part of it a reader can see the
    // shape of: `MEAN_SOFTBOX` is the emitter's profile averaged over its own face, so this is the
    // source's whole irradiance handed to the haze lobe.
    let solid = 4.0 * half_width.d * half_width.d
        / (SOFTBOX_ASPECT * distance.d * distance.d);
    let haze = total * source * solid * MEAN_SOFTBOX * glass_haze(dot(world, print.light.xyz));
    let radiance = measured<DisplayNits>(
        total * room_radiance(world, paper_rotation(hit.view), 0.0).v + glass_mirrored() * direct + haze);
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
    let mat = MAT_ALBEDO
        * (ambient.v * print_light_calibration[5] + source.v * direct.z) * print_illuminant();
    var substrate = mat;
    if (photo_coverage > 0.0) {
        substrate = lerp(mat, print_from_coefficients(reflectance, hit, roughness, direct), photo_coverage);
    }
    substrate *= glass_trapped(lerp(MAT_ALBEDO, reflectance, photo_coverage));
    let transmitted = substrate * glass_transmittance(hit.view.z);
    return lerp(rim, transmitted + glass_reflected_light(hit), glass_coverage);
}

public Colour<DisplayNits> reflected_print_samples(float3 reflectance, PrintHit hit, float roughness, uint count)
{
    let direct = print.illumination.x == 0.0 ? float4(0.0)
        : print_direct_coefficients(hit, roughness, count, WANT_PAPER);
    return measured<DisplayNits>(print_from_coefficients(reflectance, hit, roughness, direct));
}

/// What a framed pixel can show, and so what its light integration has to answer for.
///
/// The surface presentation flattens every pixel onto the photograph before sampling, so it wants
/// all three; the scene one puts each pixel on one material, and only the edges between them - the
/// footprint's own width - can need two at once.
uint framed_wants(PrintHit hit, float2 footprint)
{
    if (print.illumination.w > 0.5) { return WANT_ALL; }
    if (hit.material == BACK || (hit.material == RIM && hit.normal.z < 0.5)) { return WANT_RIM; }
    let aperture = frame_aperture(hit.half);
    var wanted = frame_rectangle_coverage(hit.position.xy, aperture, footprint) < 1.0 ? WANT_RIM : 0u;
    let photo = hit.normal.z < 0.5 ? 0.0 : frame_rectangle_coverage(hit.position.xy, hit.half, footprint);
    if (photo > 0.0) { wanted |= WANT_PAPER; }
    if (photo < 1.0) { wanted |= WANT_MAT; }
    return wanted;
}

public Colour<DisplayNits> reflected_print(float3 reflectance, PrintHit hit, float2 footprint)
{
    let roughness = paper_roughness(hit.position, footprint);
    if (print.framing.x > 0.5) {
        let direct = print.illumination.x == 0.0 ? float4(0.0)
            : print_direct_coefficients(hit, roughness, light_samples(roughness),
                framed_wants(hit, footprint));
        return measured<DisplayNits>(framed_from_coefficients(reflectance, hit, roughness, direct, footprint));
    }
    return reflected_print_samples(reflectance, hit, roughness, light_samples(roughness));
}
