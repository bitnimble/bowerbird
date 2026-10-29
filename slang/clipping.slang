// Where a photosite stops being read at face value, for the two passes that reason about a clipped
// highlight: `highlight_field.slang`, which measures the light around one, and `assemble.slang`,
// which reconstructs it.
module clipping;

import light;

/// How near its ceiling a channel counts as having saturated.
///
/// **Not equality**: an interpolated channel on a blown plateau comes back a hair under the clip,
/// and an exact test leaves it unraised.
public static const float SATURATED_AT = 0.995;

/// Where a photosite is full enough that what it reads stops being taken at face value.
///
/// Wide on purpose: the band is the width of the gradient a blown edge renders with.
public static const float BLOWN_FROM = 0.75;

/// How far under the clip the light lending a reconstruction its colour may be: from none of it
/// kept to all of it. A light well under the clip says little about what is past it; a blue sky
/// does not colour a cloud.
public static const Stops LENT_FROM = { -1.5 };
public static const Stops LENT_TO = { -0.25 };

public float3 running_out(float3 fill)
{
    return smoothstep(BLOWN_FROM, SATURATED_AT, fill);
}
