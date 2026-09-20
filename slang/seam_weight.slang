// How much of the side a pixel is on it takes, by how far it is from a seam: the merge's feather
// and a removal's, which are one rule so one blend means the same in both.
module seam_weight;

/// `smoothstep(-edge, edge, x)`: half at the seam, all of it `edge` inside, none `edge` outside.
/// `x` is signed, positive inside. No edge is a hard cut.
public float smooth_between(float edge, float x)
{
    if (edge <= 0.0) { return x >= 0.0 ? 1.0 : 0.0; }
    let t = clamp((x + edge) / (2.0 * edge), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
