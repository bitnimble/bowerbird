// Phase 0(a): one invocation per 8x8 half-res block, its mean and its Laplacian variance.
//
// `o32_ne_block_stats.comp`. The blocks are CFA-aware - stride 2 in both axes off the
// channel's own offset - so each of the four filter positions is measured on its own.

@group(0) @binding(0) var<storage, read> raw: array<f32>;
@group(0) @binding(1) var<storage, read_write> blk_mean: array<f32>;
@group(0) @binding(2) var<storage, read_write> blk_var: array<f32>;

struct Push {
  width: i32,
  height: i32,
  n_bx: i32,
  n_by: i32,
  n_blocks_per_ch: i32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const BLOCK: i32 = 8;

/// Rank `n/2` by partial selection sort, which is what the reference's MAD reads.
fn lower_median(arr: ptr<function, array<f32, 96>>, n: i32) -> f32 {
  let rank = n / 2;
  for (var k = 0; k <= rank; k++) {
    var min_idx = k;
    var min_val = (*arr)[k];
    for (var j = k + 1; j < n; j++) {
      if ((*arr)[j] < min_val) { min_val = (*arr)[j]; min_idx = j; }
    }
    (*arr)[min_idx] = (*arr)[k];
    (*arr)[k] = min_val;
  }
  return (*arr)[rank];
}

@compute @workgroup_size(64)
fn ne_block_stats(@builtin(global_invocation_id) id: vec3u) {
  let bi_global = i32(id.x);
  let total_blocks = 4 * pc.n_blocks_per_ch;
  if (bi_global >= total_blocks) { return; }

  let ch = bi_global / pc.n_blocks_per_ch;
  let bi_in_ch = bi_global - ch * pc.n_blocks_per_ch;
  let by = bi_in_ch / pc.n_bx;
  let bx = bi_in_ch - by * pc.n_bx;
  let dy0 = (ch >> 1u) & 1;
  let dx0 = ch & 1;

  let y0 = by * BLOCK;
  let x0 = bx * BLOCK;

  var sum = 0.0;
  for (var y = y0; y < y0 + BLOCK; y++) {
    for (var x = x0; x < x0 + BLOCK; x++) {
      sum += raw[(2 * y + dy0) * pc.width + (2 * x + dx0)];
    }
  }
  let bm = sum / f32(BLOCK * BLOCK);

  // 48 horizontal and 48 vertical three-tap Laplacians, inside the block.
  var laps: array<f32, 96>;
  var nl = 0;
  for (var y = y0; y < y0 + BLOCK; y++) {
    for (var x = x0; x < x0 + BLOCK - 2; x++) {
      let row = (2 * y + dy0) * pc.width;
      let v0 = raw[row + (2 * x + dx0)];
      let v1 = raw[row + (2 * (x + 1) + dx0)];
      let v2 = raw[row + (2 * (x + 2) + dx0)];
      laps[nl] = abs(v0 - 2.0 * v1 + v2);
      nl++;
    }
  }
  for (var y = y0; y < y0 + BLOCK - 2; y++) {
    for (var x = x0; x < x0 + BLOCK; x++) {
      let col = 2 * x + dx0;
      let v0 = raw[(2 * y + dy0) * pc.width + col];
      let v1 = raw[(2 * (y + 1) + dy0) * pc.width + col];
      let v2 = raw[(2 * (y + 2) + dy0) * pc.width + col];
      laps[nl] = abs(v0 - 2.0 * v1 + v2);
      nl++;
    }
  }

  // MAD to a sigma, then the variance a three-tap Laplacian has on iid noise: 6 sigma².
  let med = lower_median(&laps, nl);
  let sigma_lap = med / 0.6745;
  blk_var[bi_global] = (sigma_lap * sigma_lap) / 6.0;
  blk_mean[bi_global] = bm;
}
