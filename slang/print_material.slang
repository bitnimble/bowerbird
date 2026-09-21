module print_material;

public static const float PRINT_PI = 3.141592653589793;
public static const uint ALBEDO_VIEWS = 128;
public static const uint ALBEDO_ROUGHNESSES = 64;
public static const uint ALBEDO_STRIDE = ALBEDO_VIEWS + 1;

public float dielectric_fresnel(float cosine, float eta)
{
    if (eta == 1.0) { return 0.0; }
    let c = saturate(abs(cosine));
    let transmitted = 1.0 - (1.0 - c * c) / (eta * eta);
    if (transmitted <= 0.0) { return 1.0; }
    let t = sqrt(transmitted);
    let parallel = (eta * c - t) / (eta * c + t);
    let perpendicular = (c - eta * t) / (c + eta * t);
    return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}

public float ggx_lambda(float cosine, float alpha)
{
    let c = max(cosine, 1e-6);
    return 0.5 * (sqrt(1.0 + alpha * alpha * (1.0 - c * c) / (c * c)) - 1.0);
}

public float ggx_density(float cosine, float alpha)
{
    let denominator = (1.0 - cosine) * (1.0 + cosine) + alpha * alpha * cosine * cosine;
    return alpha * alpha / (PRINT_PI * denominator * denominator);
}

public float3 visible_normal(float3 view, float alpha, float2 sample)
{
    let stretched = normalize(float3(alpha * view.xy, view.z));
    let radius = length(stretched.xy);
    let tangent = radius > 1e-6 ? float3(-stretched.y, stretched.x, 0.0) / radius : float3(1.0, 0.0, 0.0);
    let bitangent = cross(stretched, tangent);
    let r = sqrt(sample.x);
    let angle = 2.0 * PRINT_PI * sample.y;
    let x = r * cos(angle);
    let blend = 0.5 * (1.0 + stretched.z);
    let y = (1.0 - blend) * sqrt(max(0.0, 1.0 - x * x)) + blend * r * sin(angle);
    let normal = x * tangent + y * bitangent + sqrt(max(0.0, 1.0 - x * x - y * y)) * stretched;
    return normalize(float3(alpha * normal.xy, max(0.0, normal.z)));
}

public float specular_brdf(float3 view, float3 incident, float alpha, float eta)
{
    if (view.z <= 0.0 || incident.z <= 0.0) { return 0.0; }
    let half = normalize(view + incident);
    let masking = 1.0 / (1.0 + ggx_lambda(view.z, alpha) + ggx_lambda(incident.z, alpha));
    let fresnel_cosine = sqrt(max(0.0, 0.5 * (1.0 + dot(view, incident))));
    return ggx_density(half.z, alpha) * dielectric_fresnel(fresnel_cosine, eta)
        * masking / (4.0 * view.z * incident.z);
}

public float normal_pdf(float3 view, float3 incident, float alpha)
{
    if (incident.z <= 0.0) { return 0.0; }
    let half = normalize(view + incident);
    return ggx_density(half.z, alpha) / (4.0 * view.z * (1.0 + ggx_lambda(view.z, alpha)));
}

public float2 quadrature(uint index, uint count)
{
    return float2((float(index) + 0.5) / float(count), frac(float(index) * 0.61803398875));
}

public float directional_albedo(float cosine, float roughness, float eta, uint count)
{
    let view = float3(sqrt(max(0.0, 1.0 - cosine * cosine)), 0.0, cosine);
    let alpha = roughness * roughness;
    let lambda_view = ggx_lambda(cosine, alpha);
    var sum = 0.0;
    for (uint i = 0; i < count; i += 1) {
        let half = visible_normal(view, alpha, quadrature(i, count));
        let direction = reflect(-view, half);
        if (direction.z > 0.0) {
            sum += dielectric_fresnel(dot(view, half), eta)
                * (1.0 + lambda_view) / (1.0 + lambda_view + ggx_lambda(direction.z, alpha));
        }
    }
    return sum / float(count);
}
