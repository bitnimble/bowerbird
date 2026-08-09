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
// Not here: texture, clarity and dehaze. Those are local-contrast operators - they need the
// pixel's neighbourhood, not just the pixel - and a per-pixel function is the wrong shape
// for them. They want a blur pass of their own.

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

/// Every adjustment, on a scene-relative colour where 1.0 is diffuse white.
///
/// Returns the colour untouched where nothing is set, which is the common case: an unedited
/// photo, and every photo in a library nobody has opened the editor on.
fn adjusted(colour: vec3f) -> vec3f {
  if (tick.contrast == 0.0 && tick.highlights == 0.0 && tick.shadows == 0.0
      && tick.whites == 0.0 && tick.blacks == 0.0
      && tick.vibrance == 0.0 && tick.sat_adjust == 0.0) {
    return colour;
  }

  let luma = dot(LUMA, colour);
  // Black has no ratios to carry and no luma to divide by. Nothing here can lift it off
  // zero either - every control above is a gain - so it is already the answer.
  if (luma <= 0.0) { return colour; }

  let toned_luma = tone_adjusted(luma);
  let held = colour * (toned_luma / luma);
  return chroma_adjusted(held, toned_luma);
}
