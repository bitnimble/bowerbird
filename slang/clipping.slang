// Where a photosite stops being read at face value, for the two passes that reason about a clipped
// highlight: `highlight_field.slang`, which measures the light around one, and `assemble.slang`,
// which reconstructs it.
module clipping;

/// How near its ceiling a channel counts as having saturated.
///
/// **Not equality**: an interpolated channel on a blown plateau comes back a hair under the clip,
/// and an exact test leaves it unraised.
public static const float SATURATED_AT = 0.995;

/// Where a photosite is full enough that what it reads stops being taken at face value.
///
/// Wide on purpose: the band is the width of the gradient a blown edge renders with.
public static const float BLOWN_FROM = 0.75;

public float3 running_out(float3 fill)
{
    return smoothstep(BLOWN_FROM, SATURATED_AT, fill);
}
