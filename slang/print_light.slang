module print_light;

public static const float SOFTBOX_ASPECT = 1.5;

public float softbox_profile(float2 at)
{
    let taper = max(float2(0.0), 1.0 - at * at);
    return taper.x * taper.x * taper.y * taper.y;
}
