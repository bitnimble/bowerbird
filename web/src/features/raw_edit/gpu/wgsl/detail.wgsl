// The neighbourhood the presence sliders read, built once per frame.
//
// Texture, clarity and dehaze are the three adjustments that are not functions of the pixel:
// each asks how the pixel compares to what surrounds it, at a different distance. So they
// need a neighbourhood, and a neighbourhood is a pass rather than a term.
//
// **Edge-aware, and that is the whole point of this file.** A Gaussian is not: it averages
// straight across a hard edge, so the difference the grade reads is large on *both* sides of
// one, with opposite signs - a bright rim on the light side and a dark rim on the dark side.
// That is a halo, it is what an unsharp mask trades away, and it is why clarity and dehaze
// stopped at the edges of objects rather than reaching into them. `adjust.wgsl`'s
// `DETAIL_LIMIT` existed to turn the resulting solarisation into a *soft* halo instead.
//
// What replaces it is the guided filter (He, Sun & Tang): over a window, fit the one linear
// model `q = a*I + b` that best explains the input from the guide, then average the models
// rather than the pixels. Where the window is flat the fit is a constant and the output is the
// mean, which smooths; where it straddles an edge the variance is large, `a` goes to 1 and the
// output follows the guide, which does not. Two box means and a division - O(1) per pixel
// whatever the radius, no pyramid, and nothing that has to be searched.
//
// It is also what the dehaze literature prescribes for exactly this step. The dark channel
// prior gives a piecewise-constant transmission that has to be refined against the image
// before it means anything, and the reference refinement is soft matting, of which the guided
// filter is the cheap and near-equal stand-in. A Gaussian there is not a stand-in for anything:
// it smears the transmission across object boundaries, so near a high-contrast edge the
// transmission belongs to neither side.
//
// **Built once, off the frame as it arrived, and never rebuilt.** The neighbourhood is of the
// base - the demosaiced, lens-corrected, denoised samples in the buffer - before the camera
// match, before the exposure and before every slider. That is what makes one build enough: the
// grade uses `pixel_stops - neighbourhood_stops`, and the exposure is an *additive* constant in
// stops, so it cancels out of the difference exactly. Building it after the grade instead would
// put this inside the tick, where it would run on every pointer move over a 61MP frame.
//
// **Working resolution, not the frame's.** Two things follow from it. The passes cost the same
// whatever the sensor is, which is what keeps this off the tick's budget; and a radius stated
// as a fraction of *this* texture is a fraction of the picture, so the grid tile and the
// full-size rendition of one photograph get the same clarity rather than the same pixel count
// of it. A radius in frame pixels would make an 800px tile look nothing like the 3840px view
// it is a thumbnail of.

/// The long edge of the working texture, and the whole of what the two hosts must agree on.
///
/// Both allocate the texture themselves, and a host that sized it differently would filter at a
/// different fraction of the picture - the editor's clarity and the rendition's would not be
/// the same picture, which is the divergence DESIGN 21.1 is about. Declared here and pinned
/// on both sides (`gpu.rs`'s shader-size test, `tests/peak_constants.test.ts`).
///
/// 512 rather than something nearer a sensor: nothing below is a detail operator - the finest
/// band this can express is a 512th of the frame, already finer than a reader can see a texture
/// slider act on - and the *difference* the grade reads is against the full-resolution pixel
/// either way, so the detail in a texture slider comes from the pixel and not from here.
const DETAIL_LONG: u32 = 512u;

/// The fine reference's blur, as a sigma in fractions of the working texture's long edge.
///
/// **Not zero, and that is not obvious.** Where the frame is larger than the working texture
/// the shrink below is already an area average over a wide footprint, so the texture slider's
/// band - the pixel against this - exists without any blur here at all. Where it is *not*
/// larger, which is every frame under 512px and so every grid tile, the footprint is one pixel
/// and the reference would be the pixel itself: a difference of exactly zero, and a texture
/// slider that does nothing on precisely the sizes a reader is most likely to be looking at.
/// Floored at half a texel, which is where a Gaussian stops meaning anything on a grid.
const FINE_SIGMA: f32 = 1.0 / 1024.0;

/// The guided filter's window, as a fraction of the working texture's long edge.
///
/// A 64th, which is the scale clarity has always acted at: coarse enough that what is left over
/// is local contrast rather than noise, fine enough that it is not simply the exposure.
const GUIDE_RADIUS: f32 = 1.0 / 64.0;

/// How much local contrast the fit is allowed to call noise, in stops squared.
///
/// The guided filter's `eps`, and the only number in it with a photographic meaning: a window
/// whose variance is below this is treated as flat and smoothed, and one above it as an edge
/// and followed. 0.16 is (0.4 stops)^2 - four tenths of a stop of local variation is texture,
/// and a step bigger than that is a thing in the photograph.
///
/// Too small and the filter becomes the identity and there is no detail to lift; too large and
/// it becomes a box blur and the halos come back. It is the one dial to turn if either happens.
const GUIDE_EPS: f32 = 0.16;

@group(0) @binding(1) var<storage, read> frame: array<u32>;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var written: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var<storage, read> nits_of_code: array<f32>;
/// The moments and the coefficients, at 32 bits.
///
/// **Not `rgba16float`, and this is not a style choice.** A variance is `mean(I*I) -
/// mean(I)^2`, a difference of two numbers that are nearly equal and, in stops, as large as
/// 256. At half precision that subtraction keeps about two digits, and the two digits it keeps
/// are the ones that decide whether a window is an edge - so the filter would take flat sky for
/// an edge in one tile and not the next. Loaded rather than sampled, so nothing here needs the
/// format to be filterable.
@group(0) @binding(15) var moments: texture_2d<f32>;
@group(0) @binding(16) var moments_out: texture_storage_2d<rgba32float, write>;

fn sample_at(index: u32) -> u32 {
  let word = frame[index / 2u];
  return select(word & 0xffffu, word >> 16u, (index & 1u) == 1u);
}

/// The frame's colour at a pixel, scene-relative: 1.0 is the frame's own diffuse white.
///
/// The same units `adjust.wgsl` grades in, which is the point - what this pass writes is
/// subtracted from a value the grade computes, so the two have to be anchored alike.
fn scene_at(x: u32, y: u32) -> vec3f {
  let base = (y * edit.width + x) * 3u;
  return vec3f(
    nits_of_code[sample_at(base)],
    nits_of_code[sample_at(base + 1u)],
    nits_of_code[sample_at(base + 2u)],
  ) / edit.reference;
}

/// Stops relative to diffuse white, floored so black is a number rather than -inf.
///
/// `adjust.wgsl`'s `stops_below_white` with the same floor, and it has to be the same floor:
/// the grade subtracts one from the other, so a difference there would be a constant offset
/// across the darkest part of every frame - which reads as a texture slider that lifts the
/// shadows.
fn stops(v: f32) -> f32 {
  return log2(max(v, 1.0 / 65536.0));
}

/// The box radius in texels, from the fraction above and the *photograph's* working long edge.
///
/// `edit.detail_long` rather than the texture this pass is writing: the two are the same number
/// for a whole frame and they are not for a piece of one, and it is the photograph that decides
/// what the window means. A loupe tile taking its own would filter at a twelfth of the scale its
/// export uses, which is a Clarity that acts on the grain instead of the picture.
fn guide_radius() -> i32 {
  return max(i32(round(f32(edit.detail_long) * GUIDE_RADIUS)), 1);
}

/// The fine reference: a small Gaussian on the guide, for the band the texture slider reads.
///
/// Two-dimensional rather than separable, and that costs nothing: the working texture's long
/// edge is `DETAIL_LONG` at most, so the sigma is at its half-texel floor and the radius is two
/// - twenty-five taps, once, over half a megapixel.
///
/// Not edge-aware, and it does not need to be. A halo is what happens when a *wide* average
/// crosses an edge and the difference against it is large on both sides; two texels of blur
/// puts the rim inside the edge itself, which is what a sharpen is.
fn fine_blurred(at: vec2i, size: vec2i) -> f32 {
  // The photograph's working long edge, for the reason `guide_radius` gives: `size` is this
  // texture's, and this texture holds a tile where the loupe is asking.
  let sigma = max(f32(edit.detail_long) * FINE_SIGMA, 0.5);
  let radius = i32(ceil(3.0 * sigma));
  var sum = 0.0;
  var weight = 0.0;
  for (var dy = -radius; dy <= radius; dy = dy + 1) {
    for (var dx = -radius; dx <= radius; dx = dx + 1) {
      let tap = clamp(at + vec2i(dx, dy), vec2i(0), size - vec2i(1));
      let near = exp(-0.5 * f32(dx * dx + dy * dy) / (sigma * sigma));
      sum = sum + textureLoad(source, tap, 0).r * near;
      weight = weight + near;
    }
  }
  return sum / weight;
}

/// The frame at working resolution: luma in stops, and its dark channel.
///
/// An area average over the whole footprint rather than a point sample, because a point
/// sample of a 61MP frame at a 512th of its width is aliasing - and the difference against
/// it is what the grade calls detail, so the aliased frequencies would come back as a
/// texture slider that made noise.
///
/// Beside it, the *minimum* over the footprint of the minimum of the three channels, which is
/// the dark-channel prior dehaze is built on: a haze-free patch nearly always has some channel
/// near black somewhere in it, so a patch whose darkest channel is bright is a patch full of
/// airlight. A min filter alone is piecewise constant, and a piecewise constant transmission is
/// a visible block edge in the sky - which is what the fit downstream is for.
@compute @workgroup_size(8, 8)
fn shrink(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(written);
  if (id.x >= size.x || id.y >= size.y) { return; }

  // The footprint as a partition of the frame, so every source pixel belongs to exactly one
  // texel and none is read twice.
  //
  // **A fixed number of pixels per texel rather than the frame divided by the texture**, which
  // is what makes the partition translation-invariant: a frame that is a *window* on a
  // photograph gets the photograph's own texel boundaries, provided its origin is a whole
  // number of them (`job::grown` snaps it). Dividing instead put the window's texels between
  // the frame's, so a loupe tile averaged different pixels into every one of them and its
  // Clarity was fitted from a picture the export never sees.
  let step = max(edit.detail_step, 1u);
  let x0 = id.x * step;
  let x1 = min(x0 + step, edit.width);
  let y0 = id.y * step;
  let y1 = min(y0 + step, edit.height);
  if (x0 >= edit.width || y0 >= edit.height) { return; }

  var sum = 0.0;
  var count = 0.0;
  var dark = 1e30;
  for (var y = y0; y < y1; y = y + 1u) {
    for (var x = x0; x < x1; x = x + 1u) {
      let scene = scene_at(x, y);
      sum = sum + dot(LUMA, scene);
      dark = min(dark, min(scene.r, min(scene.g, scene.b)));
      count = count + 1.0;
    }
  }

  // The guide in `r`, the dark channel in `g`. What the filter makes of them lands in a
  // texture of its own, so this one stays the unfiltered pair every later pass reads.
  let luma = stops(sum / max(count, 1.0));
  textureStore(written, vec2i(i32(id.x), i32(id.y)), vec4f(luma, stops(dark), 0.0, 0.0));
}

/// The four products the two fits need, per texel, before any of them is averaged.
///
/// One texture for both filters because they share a guide: the self-guided one that smooths
/// the luma needs `I` and `I*I`, and the one that refines the dark channel against that same
/// luma needs `p` and `I*p` as well. Averaging four channels once is a box blur; averaging
/// them separately would be two.
@compute @workgroup_size(8, 8)
fn moments_of(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(moments_out);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(i32(id.x), i32(id.y));
  let pair = textureLoad(source, at, 0);
  let guide = pair.r;
  let dark = pair.g;
  textureStore(moments_out, at, vec4f(guide, guide * guide, dark, guide * dark));
}

/// How far apart in stops two texels have to be before they stop being averaged together.
///
/// The range term of the mean below. Half a stop: further apart than any texture on one
/// surface, closer than any boundary between two.
const WINDOW_RANGE: f32 = 0.5;

/// The mean the whole filter is built on: over the window, but only over what belongs to it.
///
/// **A box window is where the halo came from, and the fit was never the problem.** A guided
/// filter is two means - one to gather the moments the model is fitted from, one to average the
/// models afterwards - and both were boxes. So a texel of sky a few texels from a rock had its
/// statistics taken over a window containing rock: the variance came out huge, `a` stayed near
/// one instead of collapsing to zero, and the intercept it carries is a share of the *rock's*
/// mean. The neighbourhood that texel reports is then darker than the sky it is in, the tone
/// group weights it differently from the sky further out, and the reader gets a strip along the
/// edge - measured on a hard edge at 6% of the flat side's value, decaying over fifty pixels,
/// which is exactly what a halo looks like.
///
/// Weighting each tap by how near its own value is to this texel's fixes it at the source: a
/// sky texel gathers sky and averages models fitted on sky, and never sees the rock, because
/// the rock describes a brightness it does not have. Which is the intensity axis a bilateral
/// grid separates on - done in place at working resolution, where the data and the bindings
/// already are, rather than by building the grid and slicing it.
///
/// One entry point for both means because they are the same operation over the same four
/// channels; only what is in them differs.
///
/// Not separable, so this is `(2r+1)^2` taps rather than `2(2r+1)`: a bilateral weight depends
/// on the tap, so the two axes do not factor. At a 512px working texture and a radius of eight
/// that is 289 taps a texel, twice, over a quarter of a megapixel - affordable exactly because
/// it is not in the tick. Clamped at the frame's edges rather than weighted for them: a border
/// is not a black surround, and a window that read one would drag the fit towards nothing along
/// the outermost band of the picture.
@compute @workgroup_size(8, 8)
fn window_mean(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(moments_out));
  let at = vec2i(i32(id.x), i32(id.y));
  if (at.x >= size.x || at.y >= size.y) { return; }
  let radius = guide_radius();
  let here = textureLoad(source, at, 0).r;

  var sum = vec4f(0.0);
  var total = 0.0;
  for (var dy = -radius; dy <= radius; dy = dy + 1) {
    for (var dx = -radius; dx <= radius; dx = dx + 1) {
      let tap = clamp(at + vec2i(dx, dy), vec2i(0), size - vec2i(1));
      let apart = (here - textureLoad(source, tap, 0).r) / WINDOW_RANGE;
      let agrees = exp(-0.5 * apart * apart);
      sum = sum + textureLoad(moments, tap, 0) * agrees;
      total = total + agrees;
    }
  }
  // The centre tap always agrees with itself, so the total is never zero.
  textureStore(moments_out, at, sum / total);
}

/// The two linear models, from the averaged moments.
///
/// `a = cov(I, p) / (var(I) + eps)` and `b = mean(p) - a * mean(I)`, which is the least-squares
/// fit of `p` from `I` over the window with a ridge term. The ridge *is* the edge test: where
/// the window is flat, `var` is small against `eps`, `a` collapses towards zero and `b` towards
/// the mean, so the output is the mean and the detail is thrown away; where it straddles an
/// edge, `var` dominates, `a` goes to `cov/var` and the output follows the guide over the step.
///
/// `var` is floored at zero before use. It is a difference of two averages that are equal in a
/// flat window, and floating point does not always agree that they are - a negative variance
/// there would flip the sign of `a` and put an inverted edge in the smoothed image.
@compute @workgroup_size(8, 8)
fn coefficients(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(moments_out);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let at = vec2i(i32(id.x), i32(id.y));
  let mean = textureLoad(moments, at, 0);

  let variance = max(mean.y - mean.x * mean.x, 0.0);
  let covariance = mean.w - mean.x * mean.z;
  // The self-guided fit, where `p` is `I`: the covariance is the variance, so `a` is the one
  // number below and `b` follows from it. Written out rather than reusing the pair arithmetic,
  // because `cov(I, I)` computed as `mean(I*I) - mean(I)^2` and `var(I)` computed the same way
  // are the same expression and the division would be `v / (v + eps)` either way.
  let smooth_a = variance / (variance + GUIDE_EPS);
  let smooth_b = mean.x * (1.0 - smooth_a);
  let dark_a = covariance / (variance + GUIDE_EPS);
  let dark_b = mean.z - dark_a * mean.x;
  textureStore(moments_out, at, vec4f(smooth_a, smooth_b, dark_a, dark_b));
}

/// The models averaged and evaluated, which is the filter's output.
///
/// Averaging the coefficients rather than applying each window's own is what makes the result
/// continuous: a pixel is inside many windows, each of which fitted a slightly different line,
/// and the mean of those lines evaluated at the pixel is the filter. Applying one window's fit
/// per pixel would leave the model's own discontinuities in the picture.
///
/// `r` is the fine reference and the other two are the fits, all evaluated here so the grade
/// reads one texture: the pixel against `r` is texture's band, `r` against `g` is clarity's,
/// and `b` is the transmission dehaze inverts.
///
/// Both fits are evaluated at the *unfiltered* guide, which is what they were fitted from -
/// evaluating them at the fine blur instead would put half a texel of the model's own smoothing
/// into a band it is meant to be the reference for.
@compute @workgroup_size(8, 8)
fn apply_guided(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(written));
  let at = vec2i(i32(id.x), i32(id.y));
  if (at.x >= size.x || at.y >= size.y) { return; }
  let guide = textureLoad(source, at, 0).r;
  let fit = textureLoad(moments, at, 0);
  textureStore(
    written,
    at,
    vec4f(fine_blurred(at, size), fit.x * guide + fit.y, fit.z * guide + fit.w, 0.0),
  );
}
