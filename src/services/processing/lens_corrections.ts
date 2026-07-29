// The unit a camera's distortion spline is written in: 1/16384 of the half-diagonal,
// anchored at zero in the frame centre.
//
// All that is left here. Reading the spline out of a file is `lens.rs`, the lensfun
// profile that stands in where a body recorded none is `lensfun.rs`, evaluating and
// warping through either is `image.rs`, and fitting one is `fit.rs` - all three
// sources are interchangeable there, which is the point of expressing them as knots.
// The camera's own is preferred because it is verified per shot rather than per body:
// at 28mm the spline says -2.83% at the corner where an independent fit says -2.78%,
// and the values track focal length, so the 28-75 zoom crosses zero near 32mm and
// reaches +4.5% at 75mm. A downloadable profile has one answer per lens and cannot
// follow that.
export const SPLINE_UNIT = 16384;
