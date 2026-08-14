// What every pass is told about the frame and the edit.
//
// One layout for all of them so a pass can be added without a second uniform to keep in
// step. `std140`-ish by hand: everything is 4 bytes and the two-component members are
// placed where 8-byte alignment already holds. `EDIT_UNIFORM_FLOATS` in `shaders.ts`
// writes it, field for field, in this order.

struct Edit {
  width: u32,
  height: u32,
  // `tone::Levels` divided by the exposure, which is how the grade moves the anchor
  // rather than the pixels (`tone::grade`).
  white: f32,
  source_level: f32,
  reference: f32,
  peak: f32,
  /// The photographer's exposure **in stops**, which is the unit `EditDoc` stores.
  ///
  /// Stops rather than the `2^EV` gain the two hosts used to convert it into. That conversion
  /// is a rule, and a rule each host applies is a rule each host can get wrong - `job.rs`
  /// carried a guard refusing a non-positive gain precisely because "a caller sent stops where
  /// a multiplier belongs" was a reachable mistake. Carrying the document's own unit and
  /// raising it here makes both the conversion and the guard unnecessary.
  exposure: f32,
  /// Which transfer `encode` writes: 0 is PQ at 16 bits, 1 is sRGB at 8.
  ///
  /// This is the whole of what SDR means to the pipeline. The grade is the same either way
  /// - `job::peak_nits` puts an SDR target's peak at diffuse white, so its highlights roll
  /// into white through the same BT.2390 curve rather than clipping - and the two diverge
  /// only here, at the primaries and the transfer. A second entry point would have been a
  /// second copy of the grade to keep in step.
  ///
  /// It took the spare word this struct already carried, so no offset moved.
  output: u32,
  matched: u32,
  saturation: f32,
  has_chroma: u32,
  curve_bins: u32,
  trust_ceiling: f32,
  chroma_count: u32,
  level_count: u32,
  chroma_low: f32,
  chroma_scale: f32,
  chroma_low_by: f32,
  chroma_scale_by: f32,
  level_scale: f32,
  sdr_white: f32,
  /// Rows apart the peak's quantile samples, so it reads about a million pixels.
  row_stride: u32,
  /// How many the open sampled, which is the population the quantile's rank is over.
  peak_samples: u32,
  /// The part of the frame on screen, in source pixels, and the canvas showing it.
  region_origin: vec2f,
  region_size: vec2f,
  canvas_size: vec2f,
  /// The coarsest mip the frame has, which is how far out the draw can average.
  max_lod: u32,
  pad: u32,

  /// The photographer's own adjustments, on Camera Raw's -100..100 scales
  /// (`EditDocSchema`). Zero is no change, which is what an unedited photo carries.
  ///
  /// Appended after `pad` rather than placed among the scalars above: everything from
  /// `region_origin` on is `vec2f`, and WGSL puts those on a multiple of eight, so
  /// inserting a scalar earlier moves every field after it and the binding comes back
  /// rejected. Growing the tail moves nothing.
  ///
  /// `sat_adjust` rather than `saturation`, which is taken - that one is the camera
  /// match's own fit multiplier around 1.0 and not a slider anybody moves.
  contrast: f32,
  highlights: f32,
  shadows: f32,
  whites: f32,
  blacks: f32,
  vibrance: f32,
  sat_adjust: f32,

  /// The presence three, which read `detail.wgsl`'s blur rather than the pixel alone.
  ///
  /// `texture_adjust` rather than `texture`, in the same spirit as `sat_adjust` above: a
  /// member called `texture` beside a file full of `texture_2d` and `textureSampleLevel`
  /// reads as a type wherever it appears.
  texture_adjust: f32,
  clarity: f32,
  dehaze: f32,

  /// The illuminant the camera balanced this frame for, which is the baseline the reader's
  /// pair moves away from (`white_balance.wgsl`).
  as_shot_temperature: f32,
  as_shot_tint: f32,
  /// And what the reader asked for, straight off the document.
  ///
  /// **Neither host resolves these; the shader does.** The document holds null for a half the
  /// reader has not moved, and what null means - the frame's own illuminant - is a rule, so
  /// having each host apply it is two implementations of one rule. They were not the same rule:
  /// one stood a missing tint up as the frame's and the other as zero, which is the Planckian
  /// locus, and the rendition came out a different colour from the picture the reader approved.
  /// So the hosts copy the document and `balance_set` says which halves it actually held.
  temperature: f32,
  tint: f32,
  /// Bit 0 for the temperature, bit 1 for the tint. Zero is "as shot", which is what an
  /// unedited photo carries.
  balance_set: u32,

  /// The reader's crop, as fractions of the *straightened* frame - Camera Raw's definition
  /// and `EditDocSchema`'s. Left, top, right, bottom.
  crop_left: f32,
  crop_top: f32,
  crop_right: f32,
  crop_bottom: f32,
  /// The straighten, in degrees, and the quarter turn after it.
  crop_angle: f32,
  rotate: u32,
  /// The size of the picture this produces, which is what the region is a window on.
  ///
  /// Sent rather than derived: it is `displaySize` on the client and `hdr::cropped_size`
  /// natively, and the turn's own arithmetic reads the *output* grid's dimensions - so a
  /// shader computing them again would be a third answer to a question two hosts already
  /// agree on.
  output_width: u32,
  output_height: u32,

  /// The perspective correction, row-major, the ninth element dropped because it is always 1.
  ///
  /// Corrected back to source and in fractions of the frame - the direction the draw reads and
  /// the units that mean the same thing at every rendition size.
  ///
  /// Written out as scalars rather than held in an `array<f32, 8>` or a `mat3x3f`: a uniform
  /// array of scalars is laid out at a sixteen-byte stride, and a matrix as three `vec4f`, so
  /// either would put holes in the middle of a struct both hosts fill in a flat loop.
  keystone_0: f32,
  keystone_1: f32,
  keystone_2: f32,
  keystone_3: f32,
  keystone_4: f32,
  keystone_5: f32,
  keystone_6: f32,
  keystone_7: f32,
  /// Whether there is one. Zero is a photograph nobody corrected, which is most of them.
  has_keystone: u32,

  /// The long edge `detail.wgsl`'s working texture would have for the *whole photograph*.
  ///
  /// **Because a frame can be a piece of one.** The guided filter's window is a fraction of that
  /// long edge, and a host reading it off the texture it allocated would filter a loupe tile at a
  /// fraction of the tile - a twelfth of the scale the export uses, so the same Clarity produces
  /// local contrast the reader cannot find again in the file they get. Equal to the texture's own
  /// long edge for every whole frame, which is every rendition and the editor's own.
  detail_long: u32,

  /// How many of the frame's pixels each of that texture's texels covers.
  ///
  /// The partition is a step rather than a division so that it is the same partition wherever a
  /// window of the photograph starts: a division puts a tile's texel boundaries between the
  /// frame's and averages a different set of pixels into each one.
  detail_step: u32,
};

@group(0) @binding(0) var<uniform> edit: Edit;

fn at(x: u32, y: u32) -> u32 { return y * edit.width + x; }
