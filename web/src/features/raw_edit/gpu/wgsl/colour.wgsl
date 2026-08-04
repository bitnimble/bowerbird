// Scene-linear `u16` RGB to display-referred nits.
//
// `hdr::grade_prepared`, as a function rather than a pass: the CPU keeps its stages apart
// because each is a loop over 30M samples, where here the pixel is already in a register
// when the next stage wants it.
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

// The frame stays as it arrived: interleaved RGB `u16`, three to a pixel, in the buffer it
// was uploaded into. Not a texture, and not padded to four components - that padding is a
// constant 65535 costing a quarter of 481MB at 61MP, plus a second copy of the whole frame
// to write it. Nothing samples this level bilinearly, so a texture bought only the 2D cache
// and a raster scan does not need it.
@group(0) @binding(1) var<storage, read> frame: array<u32>;
@group(0) @binding(2) var curves: texture_2d<f32>;
@group(0) @binding(3) var chroma: texture_3d<f32>;
@group(0) @binding(4) var<storage, read> matrix: array<f32>;
@group(0) @binding(7) var lerp: sampler;

/// One `u16` of the stream, which is half of a word. Three samples to a pixel means no
/// pixel is word-aligned, so there is no reading one as a struct.
fn sample_at(index: u32) -> u32 {
  let word = frame[index / 2u];
  return select(word & 0xffffu, word >> 16u, (index & 1u) == 1u);
}

/// The frame's levels at a pixel, full resolution.
fn level_at(x: u32, y: u32) -> vec3f {
  let base = at(x, y) * 3u;
  return vec3f(f32(sample_at(base)), f32(sample_at(base + 1u)), f32(sample_at(base + 2u)));
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

/// `MatchedGrade::curves`, which is the per-channel tone at a given exposure scale.
///
/// The shared gain matters: below the ceiling it is 1 and the stage is separable, which is
/// almost every pixel and what the CPU's lookup table is for. Above it, `hdr_fit::tone`
/// divides the pixel down into the curve's domain and multiplies the result back out, so
/// the three channels move together. Skipping that leaves highlights wrong by hundreds of
/// counts, which is exactly where a grade is judged.
fn curves_at(level: vec3f, scale: f32) -> vec3f {
  let scene = level * scale / tick.white;
  let s = max(max(scene.r, max(scene.g, scene.b)) / tick.trust_ceiling, 1.0);
  return vec3f(
    sample_curve(0u, scene.r / s),
    sample_curve(1u, scene.g / s),
    sample_curve(2u, scene.b / s),
  ) * s;
}

/// `MatchedGrade::toned`: the exposed colour's luma, carried onto the base colour's
/// ratios, which is what keeps hue still as the slider moves.
///
/// Also why the peak cannot be precomputed as a curve: the exposure arrives as a gain that
/// depends on the pixel's own luma, not as a global one.
fn toned(level: vec3f) -> vec3f {
  let base = curves_at(level, 1.0);
  if (tick.exposure == 1.0) { return base; }
  let lit = curves_at(level, tick.exposure);
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

/// `ChromaMap::correct`, trilinear over the same eight corners - in one fetch, since a
/// 2x2 per node is four components and a node lattice is a volume.
fn correct(level: f32, d0: f32, d2: f32) -> vec2f {
  let cell = textureSampleLevel(chroma, lerp, vec3f(
    axis(d0, tick.chroma_count, tick.chroma_low, tick.chroma_scale),
    axis(d2, tick.chroma_count, tick.chroma_low, tick.chroma_scale),
    axis(sqrt(max(level, 0.0)), tick.level_count, 0.0, tick.level_scale),
  ), 0.0);
  return vec2f(cell.x * d0 + cell.y * d2, cell.z * d0 + cell.w * d2);
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
  return vec3f(l + d.x, l + dg, l + d.y);
}

fn apply_matrix(t: vec3f) -> vec3f {
  return vec3f(
    matrix[0] * t.r + matrix[1] * t.g + matrix[2] * t.b,
    matrix[3] * t.r + matrix[4] * t.g + matrix[5] * t.b,
    matrix[6] * t.r + matrix[7] * t.g + matrix[8] * t.b,
  );
}

/// The matched colour in nits, before any roll-off. Shared with the peak pass so the two
/// cannot measure one thing and grade another.
fn matched_nits(level: vec3f) -> vec3f {
  return finish_chroma(apply_matrix(toned(level))) * tick.reference;
}

/// The neutral arm: one shared curve, so channel ratios survive whatever the input.
fn neutral_nits(level: vec3f) -> vec3f {
  let white = tick.white / tick.exposure;
  let source_level = tick.source_level / tick.exposure;
  let source_peak = (source_level / white) * tick.reference;
  return rolled((level / white) * tick.reference, rolloff(source_peak, tick.peak));
}
