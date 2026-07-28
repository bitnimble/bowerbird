// The unit a camera's distortion spline is written in: 1/16384 of the half-diagonal,
// anchored at zero in the frame centre.
//
// All that is left here. Reading the spline out of a file is `lens.rs`, evaluating and
// warping through it is `image.rs`, and fitting one is `fit.rs` - a camera's own spline
// and a fitted polynomial are interchangeable there, which is the point of expressing
// both as knots. The model is verified per shot rather than per body: at 28mm the
// spline says -2.83% at the corner where an independent fit says -2.78%, and the values
// track focal length, so the 28-75 zoom crosses zero near 32mm and reaches +4.5% at
// 75mm. That is why this beats any downloadable profile.
export const SPLINE_UNIT = 16384;
