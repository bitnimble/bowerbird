// The photographer's own adjustments, between the camera's rendering and the roll-off.
//
// **Where, and why there.** The camera match reproduces what the body would have made;
// these are what the reader then wants instead. So they sit after `finish_chroma` and
// before the roll-off - late enough that the picture being adjusted is the one on screen,
// early enough that the roll-off still maps whatever comes out into the display's range.
// `peak.wgsl` measures the scene peak through the same function, so a highlight lift moves
// the knee with it rather than being clipped by a knee placed on the unadjusted frame.
//
// **The space is scene-relative: 1.0 is the frame's own diffuse white.** Not nits, and not
// the code the buffer holds. That is what makes one set of constants right for every photo
// - a stop below white means the same thing whatever the frame was metered at - and it is
// the value `matched_nits` already has in hand before it multiplies by the reference.
//
// **Tone acts on luma, carried onto the colour's ratios.** The same trick `toned` uses for
// the exposure, and for the same reason: scaling the three channels by a curve of each
// channel turns a saturated red into a different hue as it brightens. One curve, evaluated
// on luma, applied as a ratio, holds hue exactly.
//
// **The three presence sliders read a neighbourhood, and it arrives as a texture.** Texture,
// clarity and dehaze cannot be functions of the pixel, so `detail.wgsl` blurs the frame once
// and this samples it. What that costs here is a coordinate: every caller has to say *where*
// in the frame the colour it is handing over came from, which is why `adjusted` takes a `uv`
// and the two arms thread it down from their own callers.
//
// The blur is of the frame as it arrived - before the match, the exposure and every slider -
// so the difference this reads is in the base's own stops rather than the graded pixel's.
// That is deliberate and it is what makes the pass a one-off: an exposure is an additive
// constant in stops and cancels out of a difference, where a blur of the graded frame would
// have to be rebuilt on every pointer move.
@group(0) @binding(13) var detail: texture_2d<f32>;
// The reader's temperature and tint, already solved into one matrix by `white_balance.wgsl`.
// Rows of four, and the identity where the pair is at the frame's own illuminant - so the
// check below is about skipping nine multiplies rather than about correctness.
@group(0) @binding(14) var<storage, read> balance: array<f32>;

/// Stops relative to diffuse white. 0 is white, -3 is three stops under it.
///
/// Floored rather than guarded at the call site: `log2(0)` is -inf, and every weight below
/// is a Gaussian on this value, so an unfloored black would come back NaN and paint a hole.
fn stops_below_white(luma: f32) -> f32 {
  return log2(max(luma, 1.0 / 65536.0));
}

/// A zone's pull at a given exposure, as a Gaussian on stops.
///
/// Overlapping on purpose. Camera Raw's four tonal sliders do not partition the range, they
/// lean on it - which is what lets shadows and blacks both act on a dark pixel and sum to
/// something smooth, rather than meeting at a seam a gradient would show.
fn zone(at: f32, centre: f32, width: f32) -> f32 {
  let d = (at - centre) / width;
  return exp(-d * d);
}

/// Middle grey, as a fraction of diffuse white.
///
/// The pivot contrast turns about. A pivot at white would darken everything as contrast
/// rises, because there would be nothing above the pivot to lift.
const PIVOT: f32 = 0.18;

/// What a slider at 100 is worth, in stops at its zone's centre.
///
/// The highlight and shadow pair get more range than whites and blacks because they act on
/// the midtones, where a photograph carries most of its information and where a correction
/// is usually wanted; the endpoints are for trimming, and a stop is already a lot there.
const ZONE_STOPS: f32 = 1.5;
const END_STOPS: f32 = 1.0;

/// How far contrast bends the curve. 0.6 puts a slider at 100 near a 1.5x slope through the
/// pivot, which is a strong but still photographic S.
const CONTRAST_SLOPE: f32 = 0.6;

/// The tonal sliders as one curve on luma.
fn tone_adjusted(luma: f32) -> f32 {
  var l = luma;

  // Contrast first, as a power about the pivot: a straight line in log space, so it cannot
  // introduce an inflection the four zone gains would then have to fight.
  if (tick.contrast != 0.0) {
    let k = pow(2.0, -tick.contrast / 100.0 * CONTRAST_SLOPE);
    l = PIVOT * pow(max(l, 0.0) / PIVOT, 1.0 / k);
  }

  // Then the four zones, summed in stops. Summed rather than applied in sequence so the
  // order among them cannot matter - four gains that compose by multiplication are four
  // that commute, and nobody has to remember which the panel lists first.
  let at = stops_below_white(l);
  var gain = 0.0;
  gain += tick.highlights / 100.0 * ZONE_STOPS * zone(at, -1.0, 1.6);
  gain += tick.shadows / 100.0 * ZONE_STOPS * zone(at, -4.0, 1.8);
  // The endpoints are one-sided: a `whites` slider that lifted the midtones would be a
  // second exposure control, and `blacks` the same at the other end.
  gain += tick.whites / 100.0 * END_STOPS * zone(at, 0.5, 1.4) * step(-1.5, at);
  gain += tick.blacks / 100.0 * END_STOPS * zone(at, -6.5, 1.8) * (1.0 - step(-4.0, at));

  return l * pow(2.0, gain);
}

/// Saturation and vibrance, about the colour's own luma.
///
/// Vibrance after saturation and weighted against what is already there: that weighting is
/// the whole difference between the two controls. A saturated colour is near its limit and
/// pushing it further only clips a channel, where a muted one has room - so vibrance lifts
/// what is flat and leaves what is vivid, which is why it is the one people reach for first.
fn chroma_adjusted(colour: vec3f, luma: f32) -> vec3f {
  var out = colour;

  if (tick.sat_adjust != 0.0) {
    // -100 lands at 0, which is grey outright, and +100 at twice the distance from it.
    let sat = 1.0 + tick.sat_adjust / 100.0;
    out = vec3f(luma) + (out - vec3f(luma)) * sat;
  }

  if (tick.vibrance != 0.0) {
    // Chroma relative to the colour's own brightness, so the weighting reads the same in a
    // shadow as in a highlight rather than treating every dark pixel as muted.
    let chroma = length(out - vec3f(luma)) / max(luma, 1.0 / 65536.0);
    let room = 1.0 / (1.0 + chroma * 2.0);
    out = vec3f(luma) + (out - vec3f(luma)) * (1.0 + tick.vibrance / 100.0 * room);
  }

  return out;
}

/// The frame rebalanced to the illuminant the reader asked for.
///
/// A matrix rather than three gains, because the diagonal that a balance really is lives in
/// cone space and this colour is in Rec.2020 - the two conversions either side of it are
/// constant, so they are folded in once per dispatch rather than per pixel.
fn balanced(colour: vec3f) -> vec3f {
  return vec3f(
    balance[0] * colour.r + balance[1] * colour.g + balance[2] * colour.b,
    balance[4] * colour.r + balance[5] * colour.g + balance[6] * colour.b,
    balance[8] * colour.r + balance[9] * colour.g + balance[10] * colour.b,
  );
}

/// What a presence slider at 100 is worth, in stops of its own band added back.
const DETAIL_STOPS: f32 = 0.6;

/// How far local contrast may move one pixel, in stops.
///
/// A blurred neighbourhood is a poor predictor of the pixel exactly at a hard edge, where the
/// difference between the two is the whole step rather than the texture in it. Unbounded, a
/// specular highlight against a dark ground takes several stops of lift and solarises; the
/// clamp turns that into a wide soft halo, which is what every unsharp mask trades for.
const DETAIL_LIMIT: f32 = 2.0;

/// Texture and clarity, as one gain in stops on the pixel's own band of detail.
///
/// **Two disjoint bands, not two radii of the same operator.** Texture takes what is finer
/// than the fine blur and clarity what sits between the two blurs, so a photograph with both
/// raised is not lifted twice through the frequencies they share - which is what a pair of
/// plain unsharp masks against the same pixel would do.
///
/// `blur` is what `detail.wgsl` wrote: fine luma, coarse luma, coarse dark channel, all in
/// stops relative to diffuse white.
fn local_contrast(base_stops: f32, blur: vec3f) -> f32 {
  let fine = clamp(base_stops - blur.r, -DETAIL_LIMIT, DETAIL_LIMIT);
  let coarse = clamp(blur.r - blur.g, -DETAIL_LIMIT, DETAIL_LIMIT);
  // Held off the ends of the range. Local contrast that pushes a highlight past white or a
  // shadow under black is clipping rather than contrast, and a clipped edge is exactly what
  // the eye reads as a halo. Broad enough to leave the midtones at full strength.
  let room = zone(base_stops, -2.5, 3.5);
  return room * DETAIL_STOPS * (tick.texture_adjust * fine + tick.clarity * coarse) / 100.0;
}

/// The airlight dehaze subtracts, in the scene-relative units this file works in.
///
/// Diffuse white, rather than a brightest pixel measured off the frame. Haze *is* the scene's
/// black point lifted towards the sky's own brightness, so white is where it sits by
/// definition - and a measured airlight would need a reduction over the frame that nothing
/// else in this pipeline wants, for a number that would then move as the reader cropped.
const AIRLIGHT: f32 = 1.0;

/// The most of the airlight a slider at 100 may take out.
///
/// Short of all of it: transmission approaches zero as this approaches 1, and the division
/// below amplifies whatever the sensor left in the shadows faster than it removes any haze.
const DEHAZE_STRENGTH: f32 = 0.9;

/// The atmospheric scattering model, inverted: `I = J*t + A*(1 - t)` solved for `J`.
///
/// `t` is the transmission, estimated from the dark channel in the way the prior prescribes -
/// a patch whose darkest channel is bright is a patch full of airlight, so `t` falls as the
/// dark channel rises. Per channel rather than on luma, and that is not an oversight: the
/// airlight subtracted is neutral, so removing it moves a colour away from grey. Dehaze
/// looking like a saturation control is the model's own behaviour rather than a term anyone
/// added.
///
/// The negative half adds haze instead, through the same expression: a slider below zero
/// makes `t` greater than 1, and the result is a blend towards the airlight.
///
/// **The airlight is a fixed point, and everything above it is expanded rather than bounded.**
/// `I = A` comes back as `A` whatever `t` is, so the operator pulls the shadows down and
/// leaves white where it was - which is the shape haze removal should have. Above white it
/// multiplies the excess by `1/t`, and that is left unbounded: haze cannot lift a scene *past*
/// the airlight, so a pixel up there is a specular the prior does not describe, and the strong
/// end of the slider is reached only where the neighbourhood is already near white and has
/// little excess to multiply. Where the two do coincide - sun on water under a white sky - a
/// full-strength dehaze does lift the specular by a couple of stops, and what catches it is the
/// roll-off, which is the same thing that catches a bright scene. Worth knowing before reading
/// a blown highlight there as a bug in the estimate.
fn dehazed(colour: vec3f, dark_stops: f32) -> vec3f {
  let omega = tick.dehaze / 100.0 * DEHAZE_STRENGTH;
  let dark = clamp(exp2(dark_stops) / AIRLIGHT, 0.0, 1.0);
  // Floored well off zero: the model divides by this, and the estimate is a blurred prior
  // rather than a measurement, so the last stretch towards zero is noise gain.
  let transmission = clamp(1.0 - omega * dark, 0.15, 3.0);
  return max((colour - vec3f(AIRLIGHT * (1.0 - transmission))) / transmission, vec3f(0.0));
}

/// Every adjustment, on a scene-relative colour where 1.0 is diffuse white.
///
/// `base_luma` is the *frame's* own luma at this pixel, in the same units, before the match
/// and before the exposure - which is the domain `detail.wgsl` blurred, and so the only one a
/// difference against that blur means anything in. `uv` is where in the frame the colour came
/// from, normalised.
///
/// Returns the colour untouched where nothing is set, which is the common case: an unedited
/// photo, and every photo in a library nobody has opened the editor on.
fn adjusted(colour: vec3f, base_luma: f32, uv: vec2f) -> vec3f {
  let local = tick.texture_adjust != 0.0 || tick.clarity != 0.0 || tick.dehaze != 0.0;
  let rebalanced = tick.temperature > 0.0;
  if (!local && !rebalanced && tick.contrast == 0.0 && tick.highlights == 0.0
      && tick.shadows == 0.0 && tick.whites == 0.0 && tick.blacks == 0.0
      && tick.vibrance == 0.0 && tick.sat_adjust == 0.0) {
    return colour;
  }

  // Fetched once for all three, and only where one of them is set: the tonal sliders are far
  // commoner and have no business paying for a texture read.
  var blur = vec3f(0.0);
  if (local) { blur = textureSampleLevel(detail, lerp, uv, 0.0).rgb; }

  // White balance first, and everything below is then grading the frame the reader says the
  // light actually was. It is also the only stage here that changes what a *neutral* is, so
  // running it after the tone curve would mean the zones had been measured against a grey the
  // reader has since moved.
  //
  // First among *these*, which still puts it after the camera match - and that is a choice
  // rather than an accident of where this function sits. The match was fitted against the
  // body's own JPEG of this frame, at the illuminant the body chose, so feeding it a rebalanced
  // colour asks it about a picture it never saw. Both orders are an approximation of a
  // re-decode; this one keeps the match answering the question it was fitted on.
  var out = colour;
  if (rebalanced) { out = max(balanced(out), vec3f(0.0)); }

  // Dehaze next, because it is a claim about what the scene was before the air got in the
  // way; everything below is then grading the recovered scene rather than the veil.
  if (tick.dehaze != 0.0) { out = dehazed(out, blur.b); }

  let luma = dot(LUMA, out);
  // Black has no ratios to carry and no luma to divide by. Nothing left can lift it off zero
  // either - every control below is a gain - so it is already the answer.
  if (luma <= 0.0) { return out; }

  var toned_luma = tone_adjusted(luma);
  if (tick.texture_adjust != 0.0 || tick.clarity != 0.0) {
    toned_luma = toned_luma * exp2(local_contrast(stops_below_white(base_luma), blur));
  }
  let held = out * (toned_luma / luma);
  return chroma_adjusted(held, toned_luma);
}
