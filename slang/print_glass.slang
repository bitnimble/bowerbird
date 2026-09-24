module print_glass;
import print_material;
import print_noise;
import px;

public static const float GLASS_INDEX = 1.52;
static const Extent<Millimetre> GLASS_THICKNESS = { 2.0 };

static const Extent<Millimetre> GLASS_WAVE = { 70.0 };
static const float GLASS_SLOPE = 0.005;

/// How far a pane's own waviness turns its normal, against a position on it in millimetres.
///
/// **Glass in a frame is not an optical flat, and the difference is the whole of whether a
/// reflection reads as glass.** Drawn sheet keeps a long, shallow wave from the line it was rolled
/// on, and a pane held in a rebate adds its own bow - together a few thousandths of a radian over
/// a hand's width, which bends the straight edge of a mirrored lamp into a curve. Left flat, the
/// lamp arrives as a rectangle with four exact corners: the one thing in the picture that could
/// only have been computed.
public float2 glass_wave(float2 millimetres)
{
    let at = millimetres / GLASS_WAVE.d;
    return GLASS_SLOPE * float2(value_noise(at), value_noise(at + float2(31.7, 11.9)));
}

static const float COATED_REFLECTANCE = 0.004;

/// One surface of the pane, anti-reflection coated as framing glass is.
///
/// **Bare glass mirrors a lamp at any tilt, and a framed print does not.** The coating holds each
/// surface near a twentieth of bare glass's four percent until Fresnel's own rise takes over, so a
/// pane tipped back a few degrees shows the picture and only a steep one fills with the room.
float coated_interface(float cosine)
{
    let bare = dielectric_fresnel(cosine, GLASS_INDEX);
    let normal = dielectric_fresnel(1.0, GLASS_INDEX);
    return COATED_REFLECTANCE + (bare - normal) * (1.0 - COATED_REFLECTANCE) / (1.0 - normal);
}

public float glass_reflectance(float cosine)
{
    let interface = coated_interface(cosine);
    return 2.0 * interface / (1.0 + interface);
}

/// What the front surface alone sends back, the rest of [`glass_reflectance`] being the second
/// surface's own image of the same room, two thicknesses of glass to the side of it.
public float glass_front_reflectance(float cosine)
{
    return coated_interface(cosine);
}

/// How far the second surface's image sits from the first, in print lengths.
public float glass_ghost_offset(float cosine, float print_long_mm)
{
    let sine = sqrt(max(0.0, 1.0 - cosine * cosine)) / GLASS_INDEX;
    return 2.0 * (GLASS_THICKNESS.d / print_long_mm) * sine / sqrt(max(1e-6, 1.0 - sine * sine));
}

static const float GLASS_PI = 3.141592653589793;
static const float GLASS_HAZE = 0.03;
static const float HAZE_SPREAD = 0.02;

/// The share of a mirrored source a pane scatters around the image instead of into it, against the
/// angle outside the image's own edge.
///
/// **A lamp in real glass has a halo, and without one its image is a decal.** A pane's surface is
/// not polished to a mirror and its bulk is not perfectly clear, so a few percent of what it
/// reflects leaves within a couple of degrees of the specular direction rather than along it. The
/// core of a mirrored lamp clips whatever is done here - it is a hundred times a paper white - so
/// the only part of it a reader can actually see the shape of is this skirt; drawn without one the
/// image ends where the arithmetic says it ends, a step from clipped white to the mat, which no
/// glass does. Integrating the pixel does not reach it either, because the step is a fraction of a
/// pixel wide and a halo is several across. From the edge, not the centre: around a lamp wider than
/// the halo, a centred one is swallowed by the core it should be ringing.
public float glass_haze(float outside)
{
    let x = outside / HAZE_SPREAD;
    let falloff = 1.0 + x * x;
    return GLASS_HAZE / (GLASS_PI * HAZE_SPREAD * HAZE_SPREAD * falloff * falloff);
}

public float glass_mirrored()
{
    return 1.0 - GLASS_HAZE;
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
