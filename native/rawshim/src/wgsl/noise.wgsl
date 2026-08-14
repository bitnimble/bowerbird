// What the prepared frame's noise is, measured where the frame already is.
//
// `noise::sample` reads two numbers off every 8x8 block - its mean level, and the median absolute
// Laplacian of its neighbourhood - and reads them twice: once off the coded plane to parameterise
// the stabilising transform, once through that transform to get the sigma the shrinkage will see.
// On the CPU that is four whole-frame passes and 1021ms of a 61MP open.
//
// **Only the per-pixel and per-block work is here; the quantiles are not.** `base::measure` says
// where the line is and why it is there.

/// The neighbourhood a block statistic is taken over, and `noise::BLOCK`'s pair - the host asserts
/// the two agree, because a frame tiled one way and measured another has no error that shows.
const BLOCK: u32 = 8u;
/// Laplacians in a block: horizontal then vertical, three taps each.
const LAPS: u32 = 2u * BLOCK * (BLOCK - 2u);
/// The order statistic `select_nth_unstable_by` is asked for.
const MID: u32 = LAPS / 2u;

struct Params {
  width: u32,
  height: u32,
  blocks_x: u32,
  blocks_y: u32,
  /// The stabilising transform, pre-composed by the host: `scale * sqrt(alpha * level + c)`.
  /// `transform` is 0 on the pass that measures the plane against itself, before any of the three
  /// is known.
  alpha: f32,
  c: f32,
  scale: f32,
  transform: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> frame: array<u32>;
@group(0) @binding(2) var<storage, read_write> plane: array<f32>;
/// Per block: its mean level, and its sigma.
@group(0) @binding(3) var<storage, read_write> stats: array<vec2f>;

fn sample_at(at: u32) -> f32 {
  let word = frame[at / 2u];
  return f32(select(word >> 16u, word & 0xffffu, (at & 1u) == 0u));
}

/// Rec.2020 luma of the prepared frame, normalised - `noise::luma`'s weights, which are not
/// `image::LUMA`'s.
@compute @workgroup_size(64)
fn noise_luma(@builtin(global_invocation_id) id: vec3u) {
  let at = id.x;
  if (at >= params.width * params.height) { return; }
  let p = at * 3u;
  plane[at] =
    (0.2627 * sample_at(p) + 0.6780 * sample_at(p + 1u) + 0.0593 * sample_at(p + 2u)) / 65535.0;
}

/// The plane the Laplacians are read off, which on the second pass is the stabilised one.
///
/// **Recomputed per read rather than written out as a plane of its own.** It is pointwise and pure,
/// so the value is the one a stored plane would have held, and storing it would cost a second pass
/// and a second 244MB buffer at 61MP to save six square roots a pixel.
fn noise_at(at: u32) -> f32 {
  let level = plane[at];
  if (params.transform == 0u) { return level; }
  return params.scale * sqrt(max(params.alpha * level + params.c, 0.0));
}

/// One 8x8 block: where it sits on the level plane, and how much it deviates on the noise one.
@compute @workgroup_size(64)
fn noise_blocks(@builtin(global_invocation_id) id: vec3u) {
  let block = id.x;
  if (block >= params.blocks_x * params.blocks_y) { return; }
  let x0 = (block % params.blocks_x) * BLOCK;
  let y0 = (block / params.blocks_x) * BLOCK;

  var laps: array<f32, LAPS>;
  var sum = 0.0;
  var n = 0u;
  for (var y = 0u; y < BLOCK; y++) {
    let row = (y0 + y) * params.width + x0;
    for (var x = 0u; x < BLOCK; x++) {
      sum += plane[row + x];
    }
    for (var x = 0u; x < BLOCK - 2u; x++) {
      laps[n] = abs(noise_at(row + x) - 2.0 * noise_at(row + x + 1u) + noise_at(row + x + 2u));
      n++;
    }
  }
  for (var y = 0u; y < BLOCK - 2u; y++) {
    for (var x = 0u; x < BLOCK; x++) {
      let at = (y0 + y) * params.width + x0 + x;
      laps[n] = abs(noise_at(at) - 2.0 * noise_at(at + params.width)
        + noise_at(at + 2u * params.width));
      n++;
    }
  }

  // The exact order statistic the CPU takes, by partial selection: the median of 96 is one
  // invocation's own business, and a workgroup-wide sort would need 24KB of shared memory to hold
  // one block per lane.
  for (var i = 0u; i <= MID; i++) {
    var least = i;
    for (var j = i + 1u; j < LAPS; j++) {
      if (laps[j] < laps[least]) { least = j; }
    }
    let swap = laps[i];
    laps[i] = laps[least];
    laps[least] = swap;
  }

  // The median absolute Laplacian of iid noise is 0.6745 * sqrt(6) sigma.
  stats[block] = vec2f(sum / f32(BLOCK * BLOCK), laps[MID] / 1.6521);
}
