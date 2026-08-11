// The neighbourhood the presence sliders read, built once per frame.
//
// Texture, clarity and dehaze are the three adjustments that are not functions of the pixel:
// each asks how the pixel compares to what surrounds it, at a different distance. So they
// need a blur, and a blur is a pass rather than a term - which is why `adjust.wgsl` carried a
// note saying they were missing rather than an approximation of them.
//
// **Built once, off the frame as it arrived, and never rebuilt.** The blur is of the base -
// the demosaiced, lens-corrected, denoised samples in the buffer - before the camera match,
// before the exposure and before every slider. That is what makes one build enough: the grade
// uses `pixel_stops - blur_stops`, and the exposure is an *additive* constant in stops, so it
// cancels out of the difference exactly. Blurring after the grade instead would put this pass
// inside the tick, where it would run on every pointer move over a 61MP frame.
//
// **Working resolution, not the frame's.** Two things follow from it. The blurs cost the same
// whatever the sensor is, which is what keeps this off the tick's budget; and a radius stated
// as a fraction of *this* texture is a fraction of the picture, so the grid tile and the
// full-size rendition of one photograph get the same clarity rather than the same pixel count
// of it. A radius in frame pixels would make an 800px tile look nothing like the 3840px view
// it is a thumbnail of.
//
// Three passes: an area-average down to working resolution, then a separable Gaussian across
// and down. The separable pair is what makes the coarse radius affordable - 2*(3*sigma)+1
// taps twice, rather than the square of it.

/// The long edge of the working texture, and the whole of what the two hosts must agree on.
///
/// Both allocate the texture themselves, and a host that sized it differently would blur at a
/// different fraction of the picture - the editor's clarity and the rendition's would not be
/// the same picture, which is the divergence DESIGN 21.1 is about. Declared here and pinned
/// on both sides (`gpu.rs`'s shader-size test, `tests/peak_constants.test.ts`).
///
/// 512 rather than something nearer a sensor: the coarse blur costs the *cube* of this - the
/// texels grow as the square and the radius with it, the radius being a fixed fraction - and
/// nothing below is a detail operator anyway. The finest band this can express is a 512th of
/// the frame, already finer than a reader can see a texture slider act on.
const DETAIL_LONG: u32 = 512u;

/// The two radii, as sigmas in fractions of the working texture's long edge.
///
/// A decade apart on purpose, so the bands they define barely overlap: `texture` gets what is
/// finer than the fine blur and `clarity` gets what lies between the two, rather than both
/// lifting the same frequencies and a photograph with both up going twice as hard as either.
const FINE_SIGMA: f32 = 1.0 / 1024.0;
const COARSE_SIGMA: f32 = 1.0 / 64.0;

@group(0) @binding(1) var<storage, read> frame: array<u32>;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var written: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var<storage, read> nits_of_code: array<f32>;

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

/// The frame at working resolution: luma in stops, and its dark channel.
///
/// An area average over the whole footprint rather than a point sample, because a point
/// sample of a 61MP frame at a 512th of its width is aliasing - and the difference against
/// it is what the grade calls detail, so the aliased frequencies would come back as a
/// texture slider that made noise.
///
/// The third channel is the *minimum* over the footprint of the minimum of the three
/// channels, which is the dark-channel prior dehaze is built on: a haze-free patch nearly
/// always has some channel near black somewhere in it, so a patch whose darkest channel is
/// bright is a patch full of airlight. Taken as a min here and smoothed by the coarse
/// Gaussian below, which is the cheap stand-in for the soft matting the literature refines it
/// with - a min filter alone is piecewise constant, and a piecewise constant transmission is a
/// visible block edge in the sky.
@compute @workgroup_size(8, 8)
fn shrink(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(written);
  if (id.x >= size.x || id.y >= size.y) { return; }

  // The footprint as a partition of the frame, so every source pixel belongs to exactly one
  // texel and none is read twice. At least one pixel wide: the host never scales up, but a
  // frame one pixel narrower than the working texture would otherwise leave a texel empty.
  let x0 = (id.x * edit.width) / size.x;
  let x1 = min(max(x0 + 1u, ((id.x + 1u) * edit.width) / size.x), edit.width);
  let y0 = (id.y * edit.height) / size.y;
  let y1 = min(max(y0 + 1u, ((id.y + 1u) * edit.height) / size.y), edit.height);

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

  // The same value in both luma channels: the two blurs below read one each, and giving them
  // separate inputs would mean two shrink passes for one downscale.
  let luma = stops(sum / max(count, 1.0));
  textureStore(written, vec2i(i32(id.x), i32(id.y)), vec4f(luma, luma, stops(dark), 0.0));
}

/// One axis of both Gaussians, and of the dark channel's.
///
/// One loop for both radii rather than two passes: the coarse one bounds the walk and the
/// fine weight is added only where it is not already negligible, so the fine blur costs its
/// own handful of taps and not the coarse one's.
///
/// Clamped at the edges rather than weighted for them. A frame's border is not a black
/// surround, and a Gaussian that read one would darken the outermost band of every blur -
/// which the grade would then read as detail and lift.
fn blurred(at: vec2i, axis: vec2i) {
  let size = vec2i(textureDimensions(written));
  if (at.x >= size.x || at.y >= size.y) { return; }

  let long = f32(max(size.x, size.y));
  // Floored at half a texel, which is where a Gaussian stops meaning anything on a grid. It
  // binds whenever the working texture is smaller than `DETAIL_LONG`, which is every frame
  // narrower than that - the grid tile, mostly.
  let fine = max(long * FINE_SIGMA, 0.5);
  let coarse = max(long * COARSE_SIGMA, 1.0);
  let radius = i32(ceil(3.0 * coarse));
  let fine_radius = i32(ceil(3.0 * fine));

  var fine_sum = 0.0;
  var fine_weight = 0.0;
  var coarse_sum = vec2f(0.0);
  var coarse_weight = 0.0;
  for (var d = -radius; d <= radius; d = d + 1) {
    let tap = clamp(at + axis * d, vec2i(0), size - vec2i(1));
    let value = textureLoad(source, tap, 0);
    let x = f32(d);
    let weight = exp(-0.5 * x * x / (coarse * coarse));
    coarse_sum = coarse_sum + value.gb * weight;
    coarse_weight = coarse_weight + weight;
    if (d >= -fine_radius && d <= fine_radius) {
      let near = exp(-0.5 * x * x / (fine * fine));
      fine_sum = fine_sum + value.r * near;
      fine_weight = fine_weight + near;
    }
  }

  let coarsened = coarse_sum / coarse_weight;
  textureStore(written, at, vec4f(fine_sum / fine_weight, coarsened.x, coarsened.y, 0.0));
}

@compute @workgroup_size(8, 8)
fn blur_x(@builtin(global_invocation_id) id: vec3u) {
  blurred(vec2i(i32(id.x), i32(id.y)), vec2i(1, 0));
}

@compute @workgroup_size(8, 8)
fn blur_y(@builtin(global_invocation_id) id: vec3u) {
  blurred(vec2i(i32(id.x), i32(id.y)), vec2i(0, 1));
}
