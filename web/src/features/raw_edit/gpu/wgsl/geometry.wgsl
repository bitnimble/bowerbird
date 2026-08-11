// The reader's crop, straighten and quarter turn, as a coordinate mapping.
//
// **`image::Plan::at` in WGSL, and the two are held together by
// `the_draw_places_a_pixel_where_the_gather_does`.** They cannot be one implementation the way
// the grade is: a rendition applies geometry inside the *gather* that corrects the lens, on the
// CPU, over a frame it is producing; the editor applies it in the draw, to a frame already
// warped at the open. Same mapping, two places it has to happen. So what keeps them honest is a
// probe, and this is its own file so that probe needs a uniform and one buffer rather than the
// whole colour pipeline `frame.wgsl` drags in.
//
// Declares no bindings: everything it reads is `tick`.

/// Where an output pixel sits in the frame, after the crop, the straighten and the turn.
fn geometry_at(out_pixel: vec2f) -> vec2f {
  // **Returned untouched rather than computed to the same answer**, and this arm is not an
  // optimisation. The arithmetic below ends at `full/2 + (p - full/2)`, which in `f32` is not
  // `p`: at a few thousand pixels the cancellation costs enough that `floor` lands on the
  // neighbouring texel, and an uncropped frame stopped reproducing the parity fixtures byte
  // for byte. It is also the common case - most photographs are not cropped - and skips thirty
  // flops per tap.
  if (edit.rotate == 0u && edit.crop_angle == 0.0 && edit.has_keystone == 0u
      && edit.crop_left == 0.0 && edit.crop_top == 0.0
      && edit.crop_right == 1.0 && edit.crop_bottom == 1.0
      && edit.output_width == edit.width && edit.output_height == edit.height) {
    return out_pixel;
  }

  let full = vec2f(f32(edit.width), f32(edit.height));
  let out = vec2f(f32(edit.output_width), f32(edit.output_height));
  let radians = edit.crop_angle * 0.017453292519943295;
  let c = cos(radians);
  let s = sin(radians);
  // The bounding box the straighten needs, which is the frame the crop is a fraction of.
  let straight = vec2f(
    full.x * abs(c) + full.y * abs(s),
    full.x * abs(s) + full.y * abs(c),
  );

  // The quarter turn first, because it relabels the output grid rather than transforming the
  // picture: undoing it here leaves everything below in the straightened frame's own axes.
  // `span - c`, not `span - 1 - c`: `out_pixel` is a position, where a pixel covers `[k, k+1)`
  // and its centre is `k + 0.5`, so the mirror of the grid is its width. Written for indices it
  // is a whole pixel out - the far edge folds to -0.25 and clamps, and every turned frame the
  // editor drew sat one column off the rendition of the same edit.
  var uv = out_pixel;
  var span = out;
  if (edit.rotate == 90u) {
    uv = vec2f(out_pixel.y, out.x - out_pixel.x);
    span = vec2f(out.y, out.x);
  } else if (edit.rotate == 180u) {
    uv = vec2f(out.x - out_pixel.x, out.y - out_pixel.y);
  } else if (edit.rotate == 270u) {
    uv = vec2f(out.y - out_pixel.y, out_pixel.x);
    span = vec2f(out.y, out.x);
  }

  let origin = vec2f(edit.crop_left * straight.x, edit.crop_top * straight.y);
  let stride = vec2f(
    (edit.crop_right - edit.crop_left) * straight.x / max(span.x, 1.0),
    (edit.crop_bottom - edit.crop_top) * straight.y / max(span.y, 1.0),
  );
  // Into the straightened frame, then back through the straighten to the frame itself.
  // Rotating about the straightened box's centre rather than the frame's is what makes the
  // crop fractions mean what Camera Raw says they mean.
  let at = origin + uv * stride - straight * 0.5;
  let straightened = vec2f(at.x * c + at.y * s, -at.x * s + at.y * c);
  return full * 0.5 + keystoned(straightened, full);
}

/// A point of the corrected picture, back where it came from in the frame.
///
/// In and out as offsets from the frame's centre in pixels; the matrix is in fractions, so the
/// frame's size goes on and comes back off around it. `image::keystoned` says this again in
/// Rust, and the probe holds the two together over every pixel of a frame.
///
/// Last in the chain here, which is first on the way the picture travels: the reader
/// straightened and cropped what they saw *after* the perspective was corrected.
fn keystoned(from_centre: vec2f, full: vec2f) -> vec2f {
  if (edit.has_keystone == 0u) {
    return from_centre;
  }
  let p = (from_centre + full * 0.5) / full;
  let w = edit.keystone_6 * p.x + edit.keystone_7 * p.y + 1.0;
  let source = vec2f(
    (edit.keystone_0 * p.x + edit.keystone_1 * p.y + edit.keystone_2) / w,
    (edit.keystone_3 * p.x + edit.keystone_4 * p.y + edit.keystone_5) / w,
  );
  return source * full - full * 0.5;
}
