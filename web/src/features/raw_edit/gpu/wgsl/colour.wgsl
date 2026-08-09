// Scene-linear `u16` RGB to display-referred nits.
//
// The whole grade as a function rather than a pass. The CPU implementation this replaced
// kept its stages apart because each was a loop over 30M samples, where here the pixel is
// already in a register when the next stage wants it.
//
// The neutral and matched arms are both here rather than specialised into two pipelines,
// because a frame whose fit declined and one whose fit landed differ by a branch on a
// uniform, which every invocation in the dispatch takes the same way.
//
// The two lookups are textures with a filtering sampler rather than storage buffers with
// the blend written out, which is the same data read the way the hardware reads it. The
// buffer form was a transcription of `hdr_fit`'s, where an interpolation is arithmetic
// because there is nothing else it could be; here a texture unit does the fetch, the
// weights and the blend as one instruction. The chroma map is the extreme case: eight
// corners times four components was thirty-two dependent scalar loads for one trilinear
// that `textureSampleLevel` performs in a single fetch, and it measured at 2.6ms of a
// 15ms tick.
//
// The tone curve does NOT take that filter, and the difference is not luck. Hardware
// filter weights carry about eight fractional bits; against a chroma correction that is
// nothing, and against a tone curve read where the PQ curve is steep it is everything -
// parity went from 6 counts to 1735 in the shadows. What saves the chroma map is that its
// corrections multiply chroma differences, which vanish exactly where PQ gets steep.

// The frame stays as it arrived: interleaved RGB `u16` of normalised PQ, three to a pixel, in
// the buffer it was uploaded into. Not a texture, and not padded to four components - that
// padding is a constant 65535 costing a quarter of 481MB at 61MP, plus a second copy of the
// whole frame to write it. Nothing samples this level bilinearly, so a texture bought only
// the 2D cache and a raster scan does not need it.
@group(0) @binding(1) var<storage, read> frame: array<u32>;
@group(0) @binding(2) var curves: texture_2d<f32>;
@group(0) @binding(3) var chroma: texture_3d<f32>;
@group(0) @binding(4) var<storage, read> matrix: array<f32>;
@group(0) @binding(7) var lerp: sampler;
// The rest of the node, past the four a single `rgba16float` texel holds. The alternatives
// to more textures all cost the hardware trilinear: packing two nodes per texel breaks
// filtering on whichever axis is doubled, and widening the volume means interpolating in the
// shader. Another volume is one more fetch and nothing else.
@group(0) @binding(10) var chroma_luma: texture_3d<f32>;
// The ninth value, in a volume of its own. Eight fill two `rgba16float` texels exactly, so
// the chroma-to-lightness pair costs one more fetch and three spare slots per node.
@group(0) @binding(11) var chroma_tint: texture_3d<f32>;
// `decode.wgsl` fills it, once per device. Read-only here, which is why it is filled there.
@group(0) @binding(12) var<storage, read> nits_of_code: array<f32>;

/// One `u16` of the stream, which is half of a word. Three samples to a pixel means no
/// pixel is word-aligned, so there is no reading one as a struct.
fn sample_at(index: u32) -> u32 {
  let word = frame[index / 2u];
  return select(word & 0xffffu, word >> 16u, (index & 1u) == 1u);
}

/// The frame's codes at a pixel, by its index in the raster. The buffer is linear, so a
/// caller walking it in one dimension needs no `x` and `y` to get back.
fn level_of(pixel: u32) -> vec3f {
  let base = pixel * 3u;
  return vec3f(f32(sample_at(base)), f32(sample_at(base + 1u)), f32(sample_at(base + 2u)));
}

/// The frame's codes at a pixel, full resolution, as the buffer holds them.
fn level_at(x: u32, y: u32) -> vec3f {
  return level_of(at(x, y));
}

/// A code back to the nits `tone::encode_base` coded, which is `level * reference / white`.
///
/// So dividing by `tick.reference` gives the `level / white` every stage below wants, and the
/// frame's own diffuse white lands at 1.0 exactly as it did when the buffer held levels.
///
/// Rounded rather than interpolated between entries: a code is what the buffer holds, and the
/// only callers with a fractional one are averaging codes they already read through here.
fn nits_of(code: vec3f) -> vec3f {
  return vec3f(
    nits_of_code[u32(code.r)],
    nits_of_code[u32(code.g)],
    nits_of_code[u32(code.b)],
  );
}

fn nits_at(x: u32, y: u32) -> vec3f {
  return nits_of(level_at(x, y));
}

fn nits_of_index(pixel: u32) -> vec3f {
  return nits_of(level_of(pixel));
}

/// `hdr_fit::sample_curve`: linear interpolation over BINS samples spanning 0..ceiling.
///
/// A row per channel, and the interpolation written out rather than sampled, for the
/// precision reason above.
fn sample_curve(channel: u32, x: f32) -> f32 {
  let bins = tick.curve_bins;
  let t = clamp(x / tick.trust_ceiling, 0.0, 1.0) * f32(bins - 1u);
  let below = min(u32(t), bins - 2u);
  let row = i32(channel);
  let lo = textureLoad(curves, vec2i(i32(below), row), 0).r;
  let hi = textureLoad(curves, vec2i(i32(below) + 1, row), 0).r;
  return mix(lo, hi, t - f32(below));
}

/// `hdr_fit::tone`, which is the per-channel tone at a given exposure scale.
///
/// The shared gain matters: below the ceiling it is 1 and the stage is separable, which is
/// almost every pixel. Above it, `hdr_fit::tone` divides the pixel down into the curve's
/// domain and multiplies the result back out, so the three channels move together. Skipping
/// that leaves highlights wrong by hundreds of counts, which is exactly where a grade is
/// judged.
fn curves_at(nits: vec3f, scale: f32) -> vec3f {
  let scene = nits * scale / tick.reference;
  let s = max(max(scene.r, max(scene.g, scene.b)) / tick.trust_ceiling, 1.0);
  return vec3f(
    sample_curve(0u, scene.r / s),
    sample_curve(1u, scene.g / s),
    sample_curve(2u, scene.b / s),
  ) * s;
}

/// The exposed colour's luma, carried onto the base colour's ratios, which is what keeps hue
/// still as the slider moves.
///
/// Also why the peak cannot be precomputed as a curve: the exposure arrives as a gain that
/// depends on the pixel's own luma, not as a global one.
fn toned(nits: vec3f) -> vec3f {
  let base = curves_at(nits, 1.0);
  if (tick.exposure == 1.0) { return base; }
  let lit = curves_at(nits, tick.exposure);
  let base_luma = dot(LUMA, base);
  let lit_luma = dot(LUMA, lit);
  // Black has no ratios to hold and the two lumas vanish together, so the quotient there
  // is noise over noise; the exposed pixel is already the right answer.
  if (base_luma <= 0.0) { return lit; }
  return base * (lit_luma / base_luma);
}

/// `ChromaMap::axis`, as a texture coordinate: the node index, at its texel centre.
fn axis(value: f32, nodes: u32, low: f32, scale: f32) -> f32 {
  let t = min(max((value - low) * scale, 0.0), f32(nodes - 1u));
  return (t + 0.5) / f32(nodes);
}

/// `ChromaMap::correct`, trilinear over the same eight corners: the corrected chroma pair,
/// then the corrected lightness.
///
/// Two fetches at the same coordinate, one per volume, so both halves of a node are
/// blended over the same eight corners with the same weights - which is what keeps this
/// equal to the CPU's single interpolation rather than merely close to it.
fn correct(level: f32, d0: f32, d2: f32) -> vec3f {
  let at = vec3f(
    // A span per axis. Red-green and blue-yellow are not distributed alike in a frame, and
    // one span for both leaves the narrower axis' outer nodes permanently empty.
    axis(d0, tick.chroma_count, tick.chroma_low, tick.chroma_scale),
    axis(d2, tick.chroma_count, tick.chroma_low_by, tick.chroma_scale_by),
    axis(sqrt(max(level, 0.0)), tick.level_count, 0.0, tick.level_scale),
  );
  let cell = textureSampleLevel(chroma, lerp, at, 0.0);
  // The volume holds the gain's *deviation* from 1, and the 1 is added here. Half floats
  // carry a fixed relative precision, so storing 1.02 spends it all on the 1 and leaves
  // 2^-11 of full scale on the part that matters; storing 0.02 spends it on the 0.02.
  // It is worth 16x here, and it has to be: the 2x2 above multiplies chroma differences,
  // which are small, where this multiplies luma itself. Stored as a gain the parity
  // fixtures miss by 1.33 against a bound of 0.5, all of it f16.
  // `.r` and `.g` are the luma-to-chroma pair and carry `level`, which is what lets a node
  // move a colour that arrived with no chroma at all - the only part of this that acts on a
  // neutral, and so the only part that can express a cast. They need no deviation trick:
  // zero already means no tint.
  let rest = textureSampleLevel(chroma_luma, lerp, at, 0.0);
  let tint = textureSampleLevel(chroma_tint, lerp, at, 0.0);
  // The third component is the corrected lightness outright, not a gain: it depends on
  // chroma as well as level, so there is no single factor to multiply by. That is what lets
  // a small saturated object take a different lightness correction from the surroundings it
  // shares a node with, where one gain per node could only give them the average.
  return vec3f(
    cell.x * d0 + cell.y * d2 + rest.r * level,
    cell.z * d0 + cell.w * d2 + rest.g * level,
    (1.0 + rest.b) * level + rest.a * d0 + tint.r * d2,
  );
}

/// `hdr_fit::finish_chroma`, given a colour the matrix has already been through.
fn finish_chroma(m: vec3f) -> vec3f {
  let l = dot(LUMA, m);
  if (tick.has_chroma == 0u) {
    if (tick.saturation == 1.0) { return m; }
    return vec3f(l) + (m - vec3f(l)) * tick.saturation;
  }
  let d = correct(l, m.r - l, m.b - l);
  // The middle channel is not free: LUMA . d is zero by construction, so the two
  // coordinates carried through the map determine the third.
  let dg = -(LUMA.r * d.x + LUMA.b * d.y) / LUMA.g;
  // The map is read at the level the colour arrived with, so the lookup cannot depend on
  // its own output. `d.z` is the corrected lightness outright rather than a gain on `l`,
  // and is floored at zero: a chroma term large enough to go negative is a node the fit had
  // no business trusting, and black is the honest answer there rather than a wrapped colour.
  let lit = max(d.z, 0.0);
  return vec3f(lit + d.x, lit + dg, lit + d.y);
}

fn apply_matrix(t: vec3f) -> vec3f {
  return vec3f(
    matrix[0] * t.r + matrix[1] * t.g + matrix[2] * t.b,
    matrix[3] * t.r + matrix[4] * t.g + matrix[5] * t.b,
    matrix[6] * t.r + matrix[7] * t.g + matrix[8] * t.b,
  );
}

/// The frame's own luma at a pixel, scene-relative, before the match and before the exposure.
///
/// What `detail.wgsl` blurred, and so the only value a difference against that blur is
/// meaningful in. Both arms hand it to `adjusted` beside the graded colour, because the
/// presence sliders act on the base's detail while everything else acts on the graded pixel.
fn base_luma(nits: vec3f) -> f32 {
  return dot(LUMA, nits) / tick.reference;
}

/// The matched colour in nits, before any roll-off. Shared with the peak pass so the two
/// cannot measure one thing and grade another.
///
/// The reader's own adjustments go in between, while the colour is still scene-relative -
/// `finish_chroma` leaves diffuse white at 1.0, which is the space `adjusted` is written
/// against. Inside this function rather than at its callers precisely because the peak pass
/// calls it too: a highlight lift has to move the knee it will be rolled against, or the
/// roll-off would clip exactly what the slider just raised.
///
/// `uv` is where in the frame `nits` was read, which the presence sliders need and nothing
/// else does. Threaded rather than derived, because the three callers know it in three
/// different ways - a raster index, a canvas position, a kept candidate.
fn matched_nits(nits: vec3f, uv: vec2f) -> vec3f {
  return adjusted(finish_chroma(apply_matrix(toned(nits))), base_luma(nits), uv) * tick.reference;
}

/// The neutral arm: one shared curve, so channel ratios survive whatever the input.
///
/// The frame arrives anchored - `tone::encode_base` divided by diffuse white and multiplied
/// by the reference before coding - so what the levels form of this divided out is already
/// done, and the exposure is what is left. It cancelled out of `source_peak` there and does
/// here too: the ratio of the frame's peak to its own white is what the roll-off is against,
/// and a gain moves both.
fn neutral_nits(nits: vec3f, uv: vec2f) -> vec3f {
  let source_peak = (tick.source_level / tick.white) * tick.reference;
  // Adjusted in the same scene-relative space the matched arm uses, so one set of sliders
  // means one thing whether or not the fit landed.
  //
  // The knee does not move with it here, unlike the matched arm: this arm's peak comes off
  // `source_level` rather than being measured, so a highlight lift can push past it. What
  // catches that is `display_nits`' clamp - the top of the range rather than a curve into
  // it. Worth knowing before reaching for a big lift on a frame whose fit declined.
  let scene = adjusted(nits * tick.exposure / tick.reference, base_luma(nits), uv) * tick.reference;
  return rolled(scene, rolloff(source_peak, tick.peak));
}
