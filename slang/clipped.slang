// The alignment luma's mark for a window holding a saturated photosite: its light says nothing
// about where its content sits, so neither the search nor the refinement may compare it.
module clipped;

public static const float CLIPPED = -1.0e9;

public bool usable(float luma)
{
    return luma > -1.0e8;
}

/// Whether a photosite reading `value` is at its `ceiling`, near enough that what it reads is the
/// clip rather than the light.
public bool at_ceiling(float value, float ceiling)
{
    return value >= ceiling * 0.98;
}
