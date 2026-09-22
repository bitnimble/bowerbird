module print_glass;
import print_material;
import px;

public static const float GLASS_INDEX = 1.52;
static const Extent<Millimetre> GLASS_THICKNESS = { 2.0 };

public float glass_reflectance(float cosine)
{
    let interface = dielectric_fresnel(cosine, GLASS_INDEX);
    return 2.0 * interface / (1.0 + interface);
}

/// What the front surface alone sends back, the rest of [`glass_reflectance`] being the second
/// surface's own image of the same room, two thicknesses of glass to the side of it.
public float glass_front_reflectance(float cosine)
{
    return dielectric_fresnel(cosine, GLASS_INDEX);
}

/// How far the second surface's image sits from the first, in print lengths.
public float glass_ghost_offset(float cosine, float print_long_mm)
{
    let sine = sqrt(max(0.0, 1.0 - cosine * cosine)) / GLASS_INDEX;
    return 2.0 * (GLASS_THICKNESS.d / print_long_mm) * sine / sqrt(max(1e-6, 1.0 - sine * sine));
}

public float glass_transmittance(float cosine)
{
    return 1.0 - glass_reflectance(cosine);
}

public float glass_diffuse_transmittance()
{
    var transmission = 0.0;
    for (uint i = 0; i < 128; i += 1) {
        transmission += glass_transmittance(sqrt((float(i) + 0.5) / 128.0));
    }
    return transmission / 128.0;
}
