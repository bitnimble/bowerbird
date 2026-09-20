// The filter a resample uses, wherever one happens.
module catmull_rom;

/// Catmull-Rom weights for the four taps around a fractional offset.
///
/// **`warp` and `frame` have to agree about this exactly**, and that is why it is not written
/// twice: the first is the gather a rendition runs at the open and the second is the draw the
/// reader looks at, so a coefficient that differed between them would resample a straighten or a
/// keystone one way on screen and another in the file, with nothing on either side saying which
/// was meant.
///
/// Interpolating (B=0, C=1/2), so a mapping that lands on a whole pixel returns that pixel rather
/// than a blend of its neighbours: an unrotated frame is untouched by this.
public float4 cubic_weights(float t)
{
    let t2 = t * t;
    let t3 = t2 * t;
    return float4(
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2));
}
