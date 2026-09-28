// How the colour fit sorts the camera's rendering into kinds of colour: the census that weights
// its pairs, and the objective that scores a candidate per class, read the same answer.
module fit_class;

/// Below this Lab chroma a colour has no hue worth sorting by.
public static const float NEUTRAL_CHROMA = 6.0;

/// Chroma per unit of lightness past which a colour is vivid. Per lightness because a dark red and
/// a lit orange wall reach the same chroma.
public static const float VIVID = 1.0;

/// CIE L*a*b* of a linear-light sRGB triple, D65, held to the gamut first.
///
/// `> 0.0` rather than a `clamp`, so a negative zero or a NaN out of the matrix lands on positive
/// zero rather than in the distance. Out of gamut still has to land somewhere, and the
/// alternative is a Lab reading for a colour sRGB cannot print.
public float3 lab_of(float3 v)
{
    let r = v.x > 0.0 ? min(v.x, 1.0) : 0.0;
    let g = v.y > 0.0 ? min(v.y, 1.0) : 0.0;
    let b = v.z > 0.0 ? min(v.z, 1.0) : 0.0;
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let fx = x > 0.008856 ? pow(x, 1.0 / 3.0) : 7.787 * x + 16.0 / 116.0;
    let fy = y > 0.008856 ? pow(y, 1.0 / 3.0) : 7.787 * y + 16.0 / 116.0;
    let fz = z > 0.008856 ? pow(z, 1.0 / 3.0) : 7.787 * z + 16.0 / 116.0;
    return float3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}

public float chroma_of(float3 lab)
{
    return sqrt(lab.y * lab.y + lab.z * lab.z);
}

public bool vivid(float3 lab)
{
    return chroma_of(lab) >= VIVID * lab.x;
}
