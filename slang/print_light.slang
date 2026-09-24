module print_light;

static const float LAMP_PI = 3.141592653589793;

/// A ceiling downlight's opal diffuser across its face, a unit disc: flat through the middle and
/// falling to nothing at the rim, so its mirror image has no edge a pixel can alias.
public float lamp_profile(float2 at)
{
    let squared = dot(at, at);
    return max(0.0, 1.0 - squared * squared);
}

/// [`lamp_profile`] averaged over the disc.
public static const float MEAN_LAMP = 2.0 / 3.0;

/// The lamp's face for a lamp of `radius`.
public float lamp_area(float radius)
{
    return LAMP_PI * radius * radius;
}

/// A point on the unit disc for one on the unit square, keeping the square's strata (Shirley and
/// Chiu's concentric map).
public float2 lamp_point(float2 square)
{
    let at = 2.0 * square - 1.0;
    if (at.x == 0.0 && at.y == 0.0) { return float2(0.0); }
    let quarter = 0.25 * LAMP_PI;
    if (abs(at.x) > abs(at.y)) {
        let angle = quarter * at.y / at.x;
        return at.x * float2(cos(angle), sin(angle));
    }
    let angle = 2.0 * quarter - quarter * at.x / at.y;
    return at.y * float2(cos(angle), sin(angle));
}
