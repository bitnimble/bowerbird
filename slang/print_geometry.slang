module print_geometry;
import px;
import print_parameters;

static const Extent<PrintUnit> CAMERA_DISTANCE = { 3.4 };
static const Extent<Millimetre> HALF_THICKNESS = { 0.15 };
static const Extent<PrintUnit> PAPER_BEND = { 0.01 };

public float3 paper_rotation(float3 point)
{
    let r = print.rotation;
    let yawed = float3(r.y * point.x + r.x * point.z, point.y, -r.x * point.x + r.y * point.z);
    return float3(yawed.x, r.w * yawed.y - r.z * yawed.z, r.z * yawed.y + r.w * yawed.z);
}

float3 paper_inverse(float3 point)
{
    let r = print.rotation;
    let pitched = float3(point.x, r.w * point.y + r.z * point.z, -r.z * point.y + r.w * point.z);
    return float3(r.y * pitched.x - r.x * pitched.z, pitched.y, r.x * pitched.x + r.y * pitched.z);
}

float3 paper_ray(float2 pixel, float2 canvas)
{
    let at = (pixel - canvas * 0.5) / min(canvas.x, canvas.y);
    return paper_inverse(normalize(float3(at.x, -at.y, -1.45)));
}

public struct PrintHit {
    public bool hit;
    public float coverage;
    public float2 uv;
    public float3 normal;
    public float3 view;
    public float3 position;
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
    answer.position = float3(point, PAPER_BEND.d * point[axis] * point[axis] + HALF_THICKNESS.d / print.surface.z);
    var normal = float3(0.0, 0.0, 1.0);
    normal[axis] = -2.0 * PAPER_BEND.d * point[axis];
    answer.normal = normalize(normal);
    answer.view = normalize(paper_inverse(float3(0.0, 0.0, CAMERA_DISTANCE.d)) - answer.position);
    return answer;
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
    float bend, out PrintHit answer)
{
    let ray = paper_ray(pixel, canvas);
    let axis = half.x >= half.y ? 0u : 1u;
    answer.hit = false;
    answer.coverage = 0.0;
    answer.position = float3(0.0);
    answer.uv = float2(0.5);
    answer.normal = float3(0.0, 0.0, 1.0);
    answer.view = -ray;
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
    let half = float3(shape / max(shape.x, shape.y), HALF_THICKNESS.d / print.surface.z);
    let origin = paper_inverse(float3(0.0, 0.0, CAMERA_DISTANCE.d));
    PrintHit answer;
    paper_intersection(pixel, canvas, half, origin, PAPER_BEND.d, answer);
    return answer;
}

bool paper_near_pixel(float2 pixel, float2 canvas, float3 half, float3 origin, float bend, float padding)
{
    let ray = paper_ray(pixel, canvas);
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
    let half = float3(shape / max(shape.x, shape.y), HALF_THICKNESS.d / print.surface.z);
    let origin = paper_inverse(float3(0.0, 0.0, CAMERA_DISTANCE.d));
    let bend = PAPER_BEND.d;
    PrintHit answer;
    paper_intersection(pixel, canvas, half, origin, bend, answer);
    let padding = (CAMERA_DISTANCE.d + length(half + float3(0.0, 0.0, bend))) / (1.45 * min(canvas.x, canvas.y));
    if (!paper_near_pixel(pixel, canvas, half, origin, bend, padding)) { return answer; }
    var full = answer.hit;
    PrintHit sample;
    for (uint corner = 0; corner < 4; corner += 1) {
        let offset = float2(float(corner & 1u), float(corner >> 1)) - 0.5;
        paper_intersection(pixel + offset, canvas, half, origin, bend, sample);
        full = full && sample.hit;
    }
    if (full) { return answer; }
    var columns = 8u;
    var rows = 8u;
    if (abs(paper_rotation(float3(0.0, 0.0, 1.0)).z) < 0.05) {
        let projected_x = paper_rotation(float3(half.x, 0.0, 0.0)).xy;
        let projected_y = paper_rotation(float3(0.0, half.y, 0.0)).xy;
        let along = normalize(dot(projected_x, projected_x) > dot(projected_y, projected_y) ? projected_x : projected_y);
        let thickness = 2.0 * half.z * 1.45 * min(canvas.x, canvas.y) / (CAMERA_DISTANCE.d + length(half));
        let across = min(ceil(2.0 / thickness), 256.0);
        columns = uint(max(8.0, ceil(across * abs(along.y))));
        rows = uint(max(8.0, ceil(across * abs(along.x))));
    }
    var covered = float(answer.hit);
    for (uint y = 0; y < rows; y += 1) {
        for (uint x = 0; x < columns; x += 1) {
            let offset = (float2(float(x), float(y)) + 0.5) / float2(float(columns), float(rows)) - 0.5;
            paper_intersection(pixel + offset, canvas, half, origin, bend, sample);
            covered += float(sample.hit);
            if (!answer.hit && sample.hit) { answer = sample; }
        }
    }
    answer.coverage = covered / float(columns * rows + 1);
    return answer;
}

public float2 paper_uv(float2 pixel, float2 canvas, float2 shape, PrintHit hit)
{
    let origin = paper_inverse(float3(0.0, 0.0, CAMERA_DISTANCE.d));
    let ray = paper_ray(pixel, canvas);
    let cosine = dot(ray, hit.normal);
    let safe = abs(cosine) < 1e-7 ? (cosine < 0.0 ? -1e-7 : 1e-7) : cosine;
    let distance = dot(hit.position - origin, hit.normal) / safe;
    let point = origin + distance * ray;
    return float2(point.x, -point.y) / (shape / max(shape.x, shape.y)) * 0.5 + 0.5;
}
