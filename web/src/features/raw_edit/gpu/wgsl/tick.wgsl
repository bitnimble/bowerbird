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
  // `hdr_fit::TRUST_CEILING * white`, above which the matched path stops being separable.
  ceiling: f32,
  matched: u32,
  saturation: f32,
  has_chroma: u32,
  curve_bins: u32,
  trust_ceiling: f32,
  chroma_count: u32,
  level_count: u32,
  chroma_low: f32,
  chroma_scale: f32,
  level_scale: f32,
  sdr_white: f32,
  /// Rows apart the peak's quantile samples, so it reads about a million pixels.
  row_stride: u32,
  /// How many the open sampled, which is the population the quantile's rank is over.
  peak_samples: u32,
  /// Whether the histogram holds only the brightest of them, which scales that rank.
  from_candidates: u32,
  /// The part of the frame on screen, in source pixels, and the canvas showing it.
  region_origin: vec2f,
  region_size: vec2f,
  canvas_size: vec2f,
  /// The coarsest mip the frame has, which is how far out the draw can average.
  max_lod: u32,
  pad: u32,
};

@group(0) @binding(0) var<uniform> tick: Tick;

fn at(x: u32, y: u32) -> u32 { return y * tick.width + x; }
fn in_frame(id: vec3u) -> bool { return id.x < tick.width && id.y < tick.height; }
