// What every pass is told about the frame and the tick.
//
// One layout for all of them so a pass can be added without a second uniform to keep in
// step. `std140`-ish by hand: everything is 4 bytes and the two-component members are
// placed where 8-byte alignment already holds. `TICK_UNIFORM_FLOATS` in `shaders.ts`
// writes it, field for field, in this order.

struct Tick {
  width: u32,
  height: u32,
  // `tone::Levels` divided by the exposure, which is how the grade moves the anchor
  // rather than the pixels (`tone::grade`).
  white: f32,
  source_level: f32,
  reference: f32,
  peak: f32,
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
};

@group(0) @binding(0) var<uniform> tick: Tick;

fn at(x: u32, y: u32) -> u32 { return y * tick.width + x; }
