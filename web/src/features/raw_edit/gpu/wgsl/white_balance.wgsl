// The reader's temperature and tint, as one matrix on the frame.
//
// **Here rather than on either host, because both would need it.** A tick recomputes this
// whenever the slider moves and a rendition needs the same answer, so writing it twice is the
// divergence DESIGN 21.1 is about - and this one would be invisible, since two Robertson
// searches disagreeing by a few Kelvin renders as a picture rather than as an error. The
// pattern is `decode.wgsl`'s: one invocation fills a small buffer, and everything that grades
// reads it.
//
// The inverse - what the *camera* balanced for, from its multipliers and its own matrix - is
// `white_balance.rs`, and has no twin here: the client never sees a camera matrix, and the
// answer is wanted once per open rather than once per tick.
//
// **What the frame already is.** The decode balanced it against the camera's own multipliers,
// so a neutral surface under the as-shot illuminant comes out grey. Asking for a different
// illuminant therefore is not "apply a white balance" but "undo that one and apply this
// instead", which in cone space is a ratio: the two illuminants' cone responses, divided. The
// output white cancels out of that ratio entirely, which is why nothing here mentions D65.
//
// Sliding *up* in Kelvin says the light was bluer than the camera assumed, so more blue is
// divided out and the picture gets warmer. That is Camera Raw's direction, and it is the
// physical one.

@group(0) @binding(14) var<storage, read_write> balance_out: array<f32>;

/// Robertson's 31 isotherms: reciprocal megakelvin, CIE 1960 `u` and `v`, and the isotherm's
/// slope. `white_balance.rs` carries the same table and `the_locus_table_matches_the_shader`
/// holds the two together - it is 124 transcribed numbers, and a digit wrong in the middle of
/// it would bend one stretch of the slider and nothing else.
var<private> LOCUS: array<vec4f, 31> = array<vec4f, 31>(
  vec4f(  0.0, 0.18006, 0.26352,   -0.24341),
  vec4f( 10.0, 0.18066, 0.26589,   -0.25479),
  vec4f( 20.0, 0.18133, 0.26846,   -0.26876),
  vec4f( 30.0, 0.18208, 0.27119,   -0.28539),
  vec4f( 40.0, 0.18293, 0.27407,   -0.30470),
  vec4f( 50.0, 0.18388, 0.27709,   -0.32675),
  vec4f( 60.0, 0.18494, 0.28021,   -0.35156),
  vec4f( 70.0, 0.18611, 0.28342,   -0.37915),
  vec4f( 80.0, 0.18740, 0.28668,   -0.40955),
  vec4f( 90.0, 0.18880, 0.28997,   -0.44278),
  vec4f(100.0, 0.19032, 0.29326,   -0.47888),
  vec4f(125.0, 0.19462, 0.30141,   -0.58204),
  vec4f(150.0, 0.19962, 0.30921,   -0.70471),
  vec4f(175.0, 0.20525, 0.31647,   -0.84901),
  vec4f(200.0, 0.21142, 0.32312,   -1.0182),
  vec4f(225.0, 0.21807, 0.32909,   -1.2168),
  vec4f(250.0, 0.22511, 0.33439,   -1.4512),
  vec4f(275.0, 0.23247, 0.33904,   -1.7298),
  vec4f(300.0, 0.24010, 0.34308,   -2.0637),
  vec4f(325.0, 0.24702, 0.34655,   -2.4681),
  vec4f(350.0, 0.25591, 0.34951,   -2.9641),
  vec4f(375.0, 0.26400, 0.35200,   -3.5814),
  vec4f(400.0, 0.27218, 0.35407,   -4.3633),
  vec4f(425.0, 0.28039, 0.35577,   -5.3762),
  vec4f(450.0, 0.28863, 0.35714,   -6.7262),
  vec4f(475.0, 0.29685, 0.35823,   -8.5955),
  vec4f(500.0, 0.30505, 0.35907,  -11.324),
  vec4f(525.0, 0.31320, 0.35968,  -15.628),
  vec4f(550.0, 0.32129, 0.36011,  -23.325),
  vec4f(575.0, 0.32931, 0.36038,  -40.770),
  vec4f(600.0, 0.33724, 0.36051, -116.45),
);

/// Adobe's tint units per unit of `uv` off the locus. Negative, which is what puts a positive
/// tint towards magenta.
const TINT_SCALE: f32 = -3000.0;

/// XYZ to the Bradford cone responses, and Rec.2020 linear to the same, and back.
///
/// The space an illuminant change is a *diagonal* in - three gains rather than nine terms - and
/// sharpened cones rather than plain XYZ because that is what makes the diagonal a good
/// approximation: von Kries in XYZ moves saturated colours visibly.
///
/// Column-major, as `mat3x3f` takes it, so each `vec3f` is a column and this is the transpose
/// of the row-major form `white_balance.rs` holds. Literals because the file has to stay valid
/// WGSL on its own; `the_cone_matrices_match_the_shader` pins them against that side's.
const XYZ_TO_CONE = mat3x3f(
  vec3f( 0.895100, -0.750200,  0.038900),
  vec3f( 0.266400,  1.713500, -0.068500),
  vec3f(-0.161400,  0.036700,  1.029600),
);

const R2020_TO_CONE = mat3x3f(
  vec3f(  0.641020,  -0.028459,   0.006822),
  vec3f(  0.305534,   1.054288,  -0.011914),
  vec3f( -0.004280,   0.013857,   1.094898),
);

const CONE_TO_R2020 = mat3x3f(
  vec3f(  1.540081,   0.041693,  -0.009142),
  vec3f( -0.446186,   0.936292,   0.012968),
  vec3f(  0.011667,  -0.011687,   0.913128),
);

/// The chromaticity of an illuminant, from Camera Raw's two numbers.
///
/// Robertson's method run forwards: find the two isotherms the reciprocal temperature falls
/// between, interpolate the locus point and the isotherm direction across them, then step
/// along that direction by the tint. Reciprocal temperature rather than temperature because
/// that is the axis the table is uniform in, and the one a slider feels linear on.
fn xy_of(temperature: f32, tint: f32) -> vec2f {
  let mireds = 1.0e6 / max(temperature, 1.0);
  // The last pair rather than none, for anything past the blue end of the table, which is
  // where Adobe's own search also stops.
  var index = 29;
  for (var i = 0; i < 29; i = i + 1) {
    if (mireds < LOCUS[i + 1][0]) {
      index = i;
      break;
    }
  }

  let lo = LOCUS[index];
  let hi = LOCUS[index + 1];
  let f = (hi[0] - mireds) / (hi[0] - lo[0]);
  var u = lo[1] * f + hi[1] * (1.0 - f);
  var v = lo[2] * f + hi[2] * (1.0 - f);

  // Each isotherm's direction normalised *before* the blend, not after: they are directions
  // rather than displacements, and mixing them by length would swing the tint axis towards
  // whichever of the two happens to be steeper.
  let lo_length = sqrt(1.0 + lo[3] * lo[3]);
  let hi_length = sqrt(1.0 + hi[3] * hi[3]);
  var du = f / lo_length + (1.0 - f) / hi_length;
  var dv = lo[3] * f / lo_length + hi[3] * (1.0 - f) / hi_length;
  let length = sqrt(du * du + dv * dv);
  du = du / length;
  dv = dv / length;

  let offset = tint / TINT_SCALE;
  u = u + du * offset;
  v = v + dv * offset;

  let denominator = u - 4.0 * v + 2.0;
  return vec2f(1.5 * u / denominator, v / denominator);
}

/// A chromaticity as tristimulus values at unit luminance.
fn xyz_of(xy: vec2f) -> vec3f {
  let y = max(xy.y, 1.0e-6);
  return vec3f(xy.x / y, 1.0, (1.0 - xy.x - xy.y) / y);
}

/// The whole balance as one matrix on a Rec.2020 linear colour, written for the grade to read.
///
/// One invocation: this reads four uniforms and nothing else, so it is the same answer for
/// every pixel in the dispatch and no pixel has any business computing it. Which is the point
/// of the pass - two locus searches of up to thirty steps each, then two matrix products - and
/// per pixel that costs about what the rest of the grade does.
@compute @workgroup_size(1)
fn balance() {
  var m = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0));

  // Zero means as shot, which is what an unedited photo carries and what a file whose camera
  // recorded no usable multipliers carries permanently. Identity rather than a guess: there is
  // no illuminant to move away from.
  //
  // So is the pair written out explicitly at the frame's own illuminant, and that arm is not
  // redundant. The two constants below are rounded literals rather than exact inverses, so
  // `CONE_TO_R2020 * R2020_TO_CONE` is the identity to about a millionth - enough to move the
  // odd count, which would make "As Shot" a *slightly* different picture from having never
  // touched the slider. It is the same illuminant; it has to be the same bytes.
  let moved = tick.temperature != tick.as_shot_temperature || tick.tint != tick.as_shot_tint;
  if (tick.temperature > 0.0 && moved) {
    let was = XYZ_TO_CONE * xyz_of(xy_of(tick.as_shot_temperature, tick.as_shot_tint));
    let wanted = XYZ_TO_CONE * xyz_of(xy_of(tick.temperature, tick.tint));
    let gain = was / wanted;
    let diagonal =
      mat3x3f(vec3f(gain.x, 0.0, 0.0), vec3f(0.0, gain.y, 0.0), vec3f(0.0, 0.0, gain.z));
    m = CONE_TO_R2020 * diagonal * R2020_TO_CONE;

    // Renormalised so a neutral keeps its luminance. Without it the whole grade breathes as
    // the reader drags temperature: `white`, the measured scene peak and the roll-off knee are
    // all levels, and a balance that moved them would be an exposure slider with a colour on
    // it.
    let white = m * vec3f(1.0);
    m = m * (1.0 / max(dot(LUMA, white), 1.0e-6));
  }

  // Rows of four, because that is what the grade indexes and a row of three would put every
  // one after the first at an offset nobody can read at a glance.
  for (var row = 0; row < 3; row = row + 1) {
    balance_out[row * 4] = m[0][row];
    balance_out[row * 4 + 1] = m[1][row];
    balance_out[row * 4 + 2] = m[2][row];
  }
}
