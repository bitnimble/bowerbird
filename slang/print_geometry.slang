module print_geometry;
import px;
import print_parameters;

static const Extent<PrintUnit> CAMERA_DISTANCE = { 3.4 };
static const Extent<Millimetre> HALF_THICKNESS = { 0.15 };
static const Extent<PrintUnit> PAPER_BEND = { 0.01 };
static const Extent<Millimetre> FRAME_RAIL = { 8.0 };
static const Extent<Millimetre> FRAME_HALF_DEPTH = { 9.0 };
static const Extent<Millimetre> FRAME_GLASS_DEPTH = { 4.0 };
static const Extent<Millimetre> FRAME_MAT_DEPTH = { 1.4 };

public static const uint PHOTO = 0u;
public static const uint MAT = 1u;
public static const uint RIM = 2u;
public static const uint BACK = 3u;

public float2 frame_outer_half(float2 half)
{
    return half + 2.0 * print.framing.y * min(half.x, half.y);
}

public float print_camera_distance()
{
    return CAMERA_DISTANCE.d * (1.0 + 2.0 * print.framing.y);
}

public float2 frame_aperture(float2 half)
{
    let rail = min(FRAME_RAIL.d / print.surface.z, print.framing.y * min(half.x, half.y));
    return frame_outer_half(half) - rail;
}

public float frame_front_depth()
{
    return FRAME_HALF_DEPTH.d / print.surface.z;
}

public float frame_glass_depth()
{
    return FRAME_GLASS_DEPTH.d / print.surface.z;
}

public float frame_mat_depth()
{
    return FRAME_MAT_DEPTH.d / print.surface.z;
}

public bool frame_occluded(float3 point, float3 direction, float2 aperture, float front)
{
    if (print.framing.x < 0.5 || point.z >= front) { return false; }
    if (direction.z <= 0.0) { return true; }
    if (any(abs(point.xy) > aperture)) { return false; }
    let at = point.xy + direction.xy * ((front - point.z) / direction.z);
    return any(abs(at) > aperture);
}

public float3 paper_rotation(float3 point)
{
    let r = print.rotation;
    let yawed = float3(r.y * point.x + r.x * point.z, point.y, -r.x * point.x + r.y * point.z);
    return float3(yawed.x, r.w * yawed.y - r.z * yawed.z, r.z * yawed.y + r.w * yawed.z);
}

public float3 paper_inverse(float3 point)
{
    let r = print.rotation;
    let pitched = float3(point.x, r.w * point.y + r.z * point.z, -r.z * point.y + r.w * point.z);
    return float3(r.y * pitched.x - r.x * pitched.z, pitched.y, r.x * pitched.x + r.y * pitched.z);
}

static const float PRINT_FOCAL = 1.45;

/// The camera's focal length over the canvas's short edge, which the reader's zoom lengthens.
///
/// Fitted to the sheet's own outline (`outer`, the sheet's half extents with its long edge at one)
/// rather than to its long edge alone. Held against the short edge alone, a landscape sheet on a
/// landscape canvas lays its long edge along the canvas's long one and fills half the frame, where
/// a portrait one fills it: `PRINT_FOCAL` is the fit a portrait sheet gets, and every other shape
/// is brought to the same margin.
public float print_focal(float2 canvas, float2 outer)
{
    let across = canvas / min(canvas.x, canvas.y);
    let reach = max(outer.x / across.x, outer.y / across.y);
    return PRINT_FOCAL * print.view.x * print_camera_distance() / (CAMERA_DISTANCE.d * reach);
}

float3 paper_ray(float2 pixel, float2 canvas, float2 outer)
{
    let at = (pixel - canvas * 0.5) / min(canvas.x, canvas.y) - print.view.yz;
    return paper_inverse(normalize(float3(at.x, -at.y, -print_focal(canvas, outer))));
}

public struct PrintHit {
    public bool hit;
    public float coverage;
    public float2 uv;
    public float3 normal;
    public float3 view;
    public float3 position;
    public uint material;
    public float2 half;
};

public PrintHit paper_surface_hit(float2 uv, float2 shape)
{
    let half = shape / max(shape.x, shape.y);
    let point = (uv - 0.5) * float2(2.0, -2.0) * half;
    let axis = shape.x >= shape.y ? 0u : 1u;
    PrintHit answer;
    answer.hit = true;
    answer.coverage = 1.0;
    answer.uv = uv;
    answer.material = PHOTO;
    answer.half = half;
    answer.position = float3(point, PAPER_BEND.d * point[axis] * point[axis] + HALF_THICKNESS.d / print.surface.z);
    var normal = float3(0.0, 0.0, 1.0);
    normal[axis] = -2.0 * PAPER_BEND.d * point[axis];
    answer.normal = normalize(normal);
    if (print.framing.x > 0.5) {
        answer.position.z = 0.0;
        answer.normal = float3(0.0, 0.0, 1.0);
        if (any(abs(point) > half)) {
            answer.material = MAT;
            answer.position.z = frame_mat_depth();
        }
        if (any(abs(point) > frame_aperture(half))) {
            answer.material = RIM;
            answer.position.z = frame_front_depth();
        }
        answer.hit = all(abs(point) <= frame_outer_half(half));
        answer.coverage = float(answer.hit);
    }
    answer.view = normalize(paper_inverse(float3(0.0, 0.0, print_camera_distance())) - answer.position);
    return answer;
}

void frame_candidate(float distance, float3 normal, float3 origin, float3 ray, uint material,
    inout float nearest, inout PrintHit answer)
{
    if (distance <= 0.0 || distance >= nearest) { return; }
    nearest = distance;
    answer.hit = true;
    answer.position = origin + distance * ray;
    answer.uv = float2(answer.position.x, -answer.position.y) / answer.half * 0.5 + 0.5;
    answer.normal = normal;
    answer.material = material;
}

void frame_box(float3 low, float3 high, float3 origin, float3 ray, uint material,
    inout float nearest, inout PrintHit answer)
{
    if (any((abs(ray) < 1e-10) && ((origin < low) || (origin > high)))) { return; }
    let inverse = float3(abs(ray.x) < 1e-10 ? 1e10 : 1.0 / ray.x,
        abs(ray.y) < 1e-10 ? 1e10 : 1.0 / ray.y, abs(ray.z) < 1e-10 ? 1e10 : 1.0 / ray.z);
    let one = (low - origin) * inverse;
    let two = (high - origin) * inverse;
    let near = min(one, two);
    let far = max(one, two);
    let enter = max(near.x, max(near.y, near.z));
    let leave = min(far.x, min(far.y, far.z));
    if (leave < max(enter, 0.0)) { return; }
    let entering = enter > 0.0;
    let distance = entering ? enter : leave;
    let planes = entering ? near : far;
    let axis = planes.x == distance ? 0u : (planes.y == distance ? 1u : 2u);
    var normal = float3(0.0);
    normal[axis] = (entering ? -1.0 : 1.0) * (ray[axis] < 0.0 ? -1.0 : 1.0);
    frame_candidate(distance, normal, origin, ray, material, nearest, answer);
}

void frame_ring(float2 outer, float2 inner, float bottom, float top, float3 origin, float3 ray,
    uint material, inout float nearest, inout PrintHit answer)
{
    frame_box(float3(-outer, bottom), float3(-inner.x, outer.y, top), origin, ray, material, nearest, answer);
    frame_box(float3(inner.x, -outer.y, bottom), float3(outer, top), origin, ray, material, nearest, answer);
    frame_box(float3(-inner.x, -outer.y, bottom), float3(inner.x, -inner.y, top), origin, ray, material, nearest, answer);
    frame_box(float3(-inner.x, inner.y, bottom), float3(inner.x, outer.y, top), origin, ray, material, nearest, answer);
}

void frame_intersection(float3 origin, float3 ray, float2 half, float4 dimensions, inout PrintHit answer)
{
    let outer = frame_outer_half(half);
    let aperture = dimensions.xy;
    let front = dimensions.z;
    var nearest = 1e20;
    if (ray.z < -1e-10) {
        let distance = -origin.z / ray.z;
        let at = origin.xy + ray.xy * distance;
        if (all(abs(at) <= half)) {
            frame_candidate(distance, float3(0.0, 0.0, 1.0), origin, ray, PHOTO, nearest, answer);
        }
    }
    frame_ring(aperture, half, 0.0, dimensions.w, origin, ray, MAT, nearest, answer);
    frame_ring(outer, aperture, -front, front, origin, ray, RIM, nearest, answer);
    frame_box(float3(-outer, -front), float3(outer, 0.0), origin, ray, BACK, nearest, answer);
    answer.coverage = float(answer.hit);
}

void paper_candidate(float distance, float3 normal, float3 origin, float3 ray, float3 half,
    float bend, uint axis, inout float nearest, inout PrintHit answer)
{
    if (distance <= 0.0 || distance >= nearest) { return; }
    let point = origin + distance * ray;
    if (any(abs(point.xy) > half.xy + 1e-6)
        || abs(point.z - bend * point[axis] * point[axis]) > half.z + 1e-6) { return; }
    nearest = distance;
    answer.hit = true;
    answer.position = point;
    answer.uv = float2(point.x / half.x, -point.y / half.y) * 0.5 + 0.5;
    if (normal.z != 0.0) {
        var slope = float3(0.0, 0.0, 1.0);
        slope[axis] = -2.0 * bend * point[axis];
        answer.normal = normalize(slope) * normal.z;
    } else { answer.normal = normal; }
}

void paper_surface(float depth, float sign, float3 origin, float3 ray, float3 half,
    float bend, uint axis, inout float nearest, inout PrintHit answer)
{
    let a = bend * ray[axis] * ray[axis];
    let b = 2.0 * bend * origin[axis] * ray[axis] - ray.z;
    let c = bend * origin[axis] * origin[axis] + depth - origin.z;
    let normal = float3(0.0, 0.0, sign);
    if (a < 1e-10) {
        if (abs(b) > 1e-10) { paper_candidate(-c / b, normal, origin, ray, half, bend, axis, nearest, answer); }
        return;
    }
    let discriminant = b * b - 4.0 * a * c;
    if (discriminant < 0.0) { return; }
    let q = -0.5 * (b + (b < 0.0 ? -1.0 : 1.0) * sqrt(discriminant));
    paper_candidate(q / a, normal, origin, ray, half, bend, axis, nearest, answer);
    if (abs(q) > 1e-10) { paper_candidate(c / q, normal, origin, ray, half, bend, axis, nearest, answer); }
}

void paper_intersection(float2 pixel, float2 canvas, float3 half, float3 origin,
    float bend, float4 frame, out PrintHit answer)
{
    let ray = paper_ray(pixel, canvas, half.xy);
    let axis = half.x >= half.y ? 0u : 1u;
    answer.hit = false;
    answer.coverage = 0.0;
    answer.position = float3(0.0);
    answer.uv = float2(0.5);
    answer.normal = float3(0.0, 0.0, 1.0);
    answer.view = -ray;
    answer.material = PHOTO;
    answer.half = half.xy;
    if (print.framing.x > 0.5) {
        answer.half -= 2.0 * print.framing.y * min(half.x, half.y) / (1.0 + 2.0 * print.framing.y);
        frame_intersection(origin, ray, answer.half, frame, answer);
        return;
    }
    var nearest = 1e20;
    paper_surface(half.z, 1.0, origin, ray, half, bend, axis, nearest, answer);
    paper_surface(-half.z, -1.0, origin, ray, half, bend, axis, nearest, answer);
    if (abs(ray.x) > 1e-10) {
        paper_candidate((-half.x - origin.x) / ray.x, float3(-1.0, 0.0, 0.0), origin, ray, half, bend, axis, nearest, answer);
        paper_candidate((half.x - origin.x) / ray.x, float3(1.0, 0.0, 0.0), origin, ray, half, bend, axis, nearest, answer);
    }
    if (abs(ray.y) > 1e-10) {
        paper_candidate((-half.y - origin.y) / ray.y, float3(0.0, -1.0, 0.0), origin, ray, half, bend, axis, nearest, answer);
        paper_candidate((half.y - origin.y) / ray.y, float3(0.0, 1.0, 0.0), origin, ray, half, bend, axis, nearest, answer);
    }
    answer.coverage = float(answer.hit);
}

public PrintHit paper_hit(float2 pixel, float2 canvas, float2 shape)
{
    let framed = print.framing.x > 0.5;
    let photo_half = shape / max(shape.x, shape.y);
    let frame = float4(frame_aperture(photo_half), frame_front_depth(), frame_mat_depth());
    let half = float3(frame_outer_half(photo_half),
        framed ? frame.z : HALF_THICKNESS.d / print.surface.z);
    let origin = paper_inverse(float3(0.0, 0.0, print_camera_distance()));
    PrintHit answer;
    paper_intersection(pixel, canvas, half, origin, framed ? 0.0 : PAPER_BEND.d, frame, answer);
    return answer;
}

bool paper_near_pixel(float2 pixel, float2 canvas, float3 half, float3 origin, float bend, float padding)
{
    let ray = paper_ray(pixel, canvas, half.xy);
    let inverse = float3(
        abs(ray.x) < 1e-10 ? 1e10 : 1.0 / ray.x,
        abs(ray.y) < 1e-10 ? 1e10 : 1.0 / ray.y,
        abs(ray.z) < 1e-10 ? 1e10 : 1.0 / ray.z);
    let one = (-half - padding - origin) * inverse;
    let two = (half + float3(0.0, 0.0, bend) + padding - origin) * inverse;
    let near = min(one, two);
    let far = max(one, two);
    return max(max(near.x, near.y), max(near.z, 0.0)) <= min(min(far.x, far.y), far.z);
}

public PrintHit paper_covered(float2 pixel, float2 canvas, float2 shape)
{
    let framed = print.framing.x > 0.5;
    let photo_half = shape / max(shape.x, shape.y);
    let frame = float4(frame_aperture(photo_half), frame_front_depth(), frame_mat_depth());
    let half = float3(frame_outer_half(photo_half),
        framed ? frame.z : HALF_THICKNESS.d / print.surface.z);
    let camera = print_camera_distance();
    let origin = paper_inverse(float3(0.0, 0.0, camera));
    let bend = framed ? 0.0 : PAPER_BEND.d;
    PrintHit answer;
    paper_intersection(pixel, canvas, half, origin, bend, frame, answer);
    let focal = print_focal(canvas, half.xy);
    let padding = (camera + length(half + float3(0.0, 0.0, bend))) / (focal * min(canvas.x, canvas.y));
    if (!paper_near_pixel(pixel, canvas, half, origin, bend, padding)) { return answer; }
    var full = answer.hit;
    PrintHit sample;
    for (uint corner = 0; corner < 4; corner += 1) {
        let offset = float2(float(corner & 1u), float(corner >> 1)) - 0.5;
        paper_intersection(pixel + offset, canvas, half, origin, bend, frame, sample);
        full = full && sample.hit;
    }
    if (full) { return answer; }
    var columns = 8u;
    var rows = 8u;
    if (abs(paper_rotation(float3(0.0, 0.0, 1.0)).z) < 0.05) {
        let projected_x = paper_rotation(float3(half.x, 0.0, 0.0)).xy;
        let projected_y = paper_rotation(float3(0.0, half.y, 0.0)).xy;
        let along = normalize(dot(projected_x, projected_x) > dot(projected_y, projected_y) ? projected_x : projected_y);
        let thickness = 2.0 * half.z * focal * min(canvas.x, canvas.y) / (camera + length(half));
        let across = min(ceil(2.0 / thickness), 256.0);
        columns = uint(max(8.0, ceil(across * abs(along.y))));
        rows = uint(max(8.0, ceil(across * abs(along.x))));
    }
    var covered = float(answer.hit);
    for (uint y = 0; y < rows; y += 1) {
        for (uint x = 0; x < columns; x += 1) {
            let offset = (float2(float(x), float(y)) + 0.5) / float2(float(columns), float(rows)) - 0.5;
            paper_intersection(pixel + offset, canvas, half, origin, bend, frame, sample);
            covered += float(sample.hit);
            if (!answer.hit && sample.hit) { answer = sample; }
        }
    }
    answer.coverage = covered / float(columns * rows + 1);
    return answer;
}

public float2 paper_uv(float2 pixel, float2 canvas, float2 shape, PrintHit hit)
{
    let origin = paper_inverse(float3(0.0, 0.0, print_camera_distance()));
    let ray = paper_ray(pixel, canvas, frame_outer_half(shape / max(shape.x, shape.y)));
    let cosine = dot(ray, hit.normal);
    let safe = abs(cosine) < 1e-7 ? (cosine < 0.0 ? -1e-7 : 1e-7) : cosine;
    let distance = dot(hit.position - origin, hit.normal) / safe;
    let point = origin + distance * ray;
    return float2(point.x, -point.y) / (shape / max(shape.x, shape.y)) * 0.5 + 0.5;
}
