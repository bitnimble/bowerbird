// The K16 chroma upsample's jinc weights, shared by the two kernels that gather with them.
//
// jinc(x) = 2·J1(pi·x)/(pi·x) sampled offline, per sub-pixel phase and 5x5 tap: for each `si` the
// offsets are (ry, rx) = (dy - oy, dx - ox), r = 2·hypot, and the weight is jinc(r)·jinc(r/3)
// inside r < 3. The negative side lobes are the point; `sum_w` normalises.
//
// **One copy, because both gathers have to mean the same filter.** `k16_jbu_3p` upsamples the
// quarter-resolution chroma and `k16_inverse_fused` the half-resolution chroma straight into the
// inverse; they run at different scales on the same weights, so a number edited in one place and
// not the other is two different filters that still both compile.
module k16;

public static const float K16_W[100] = {
    // si = 0 (oy 0.00, ox 0.00)
    0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 1.3804738955e-02, -3.6724216895e-02, 1.3804738955e-02, 0.0,
    0.0, -3.6724216895e-02, 1.0, -3.6724216895e-02, 0.0,
    0.0, 1.3804738955e-02, -3.6724216895e-02, 1.3804738955e-02, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0,
    // si = 1 (oy 0.00, ox 0.50)
    0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 3.5811194091e-04, 3.5811194091e-04, 0.0,
    0.0, 0.0, 1.5746368940e-01, 1.5746368940e-01, 0.0,
    0.0, 0.0, 3.5811194091e-04, 3.5811194091e-04, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0,
    // si = 2 (oy 0.50, ox 0.00)
    0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 3.5811194091e-04, 1.5746368940e-01, 3.5811194091e-04, 0.0,
    0.0, 3.5811194091e-04, 1.5746368940e-01, 3.5811194091e-04, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0,
    // si = 3 (oy 0.50, ox 0.50)
    0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, -7.2646353170e-02, -7.2646353170e-02, 0.0,
    0.0, 0.0, -7.2646353170e-02, -7.2646353170e-02, 0.0,
    0.0, 0.0, 0.0, 0.0, 0.0
};
