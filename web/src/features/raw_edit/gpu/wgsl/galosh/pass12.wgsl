// Phase 5: the denoise itself - two passes of 8x8 Walsh-Hadamard shrinkage, overlapped.
//
// `o32_pass12.comp`. Pass 1 thresholds each block's AC coefficients against a BayesShrink
// level and builds a pilot estimate; pass 2 uses that pilot for a Wiener gain on the same
// blocks. Both accumulate through a Kaiser window over all sixteen stride-2 phases, so what
// comes out is an average of sixteen overlapping estimates rather than a tiling.
//
// **The block is sixteen vector registers, not an array, and that is the whole performance
// story.** The reference keeps its 8x8 block in `float block[64]` and finds its median by
// partially sorting a second 63-element array. Neither can live in registers - a GPU gives
// a dynamically-indexed local array a *scratch* allocation in device memory, and once one
// of a kernel's arrays is there the rest of the working set follows - so every one of the
// ~2600 element accesses a block costs becomes an uncoalesced round trip to memory.
// Measured on RADV, transcribed literally: 10.3s for a 12MP frame, and a 24MP one lost the
// device to its watchdog. The reference's own answer is a subgroup kernel that spreads the
// 64 coefficients across 32 lanes; this is the same idea without needing subgroups, and it
// is why every index below is a constant.
//
// This is the file's one deviation from a literal transcription. The arithmetic and its
// order are unchanged, which `examples/galosh_parity.rs` holds against the C reference.
//
// The reference's `phase_stride` knob is dropped: it subsamples the cycle spin for a video
// mode, production runs every phase, and it is the only thing in either loop that could
// make a barrier non-uniform.

@group(0) @binding(0) var<storage, read> in_buf: array<f32>;
@group(0) @binding(1) var<storage, read_write> out_buf: array<f32>;

struct Push {
  width: i32,
  height: i32,
  sigma_strength: f32,
};
@group(0) @binding(20) var<uniform> pc: Push;

const BS: i32 = 8;
const BP: i32 = 64;
const STRIDE: i32 = 2;
const PHASE_MOD: i32 = BS / STRIDE;
const N_PHASES: i32 = PHASE_MOD * PHASE_MOD;
/// Enough context that every block a tile's interior needs is stride-aligned inside it.
const HALO: i32 = BS - STRIDE;
const WIENER_FLOOR: f32 = 0.125;

const TILE_SIZE: i32 = 28;
const TILE_W: i32 = TILE_SIZE + 2 * HALO;
const TILE_PIXELS: i32 = TILE_W * TILE_W;
const WG_SIZE: i32 = 64;

/// Kaiser, beta 2.0, N 8, as the two halves of a row.
const KAISER_LO = vec4f(0.34012, 0.59885, 0.84123, 0.97659);
const KAISER_HI = vec4f(0.97659, 0.84123, 0.59885, 0.34012);

var<workgroup> tile_in: array<f32, 1600>;
var<workgroup> numer: array<f32, 1600>;
var<workgroup> denom: array<f32, 1600>;
var<workgroup> pilot: array<f32, 1600>;

/// One row of a block: `lo` is columns 0-3, `hi` columns 4-7.
struct Half {
  lo: vec4f,
  hi: vec4f,
};

/// An 8x8 block, one field per row.
struct Block {
  r0: Half,
  r1: Half,
  r2: Half,
  r3: Half,
  r4: Half,
  r5: Half,
  r6: Half,
  r7: Half,
};

fn wht8(x: Half) -> Half {
  let a = vec4f(x.lo.x + x.lo.y, x.lo.x - x.lo.y, x.lo.z + x.lo.w, x.lo.z - x.lo.w);
  let e = vec4f(x.hi.x + x.hi.y, x.hi.x - x.hi.y, x.hi.z + x.hi.w, x.hi.z - x.hi.w);
  let b = vec4f(a.x + a.z, a.y + a.w, a.x - a.z, a.y - a.w);
  let f = vec4f(e.x + e.z, e.y + e.w, e.x - e.z, e.y - e.w);
  return Half(b + f, b - f);
}

/// The transpose, which is what lets one row butterfly serve both axes.
fn transposed(b: Block) -> Block {
  return Block(
    Half(
      vec4f(b.r0.lo.x, b.r1.lo.x, b.r2.lo.x, b.r3.lo.x),
      vec4f(b.r4.lo.x, b.r5.lo.x, b.r6.lo.x, b.r7.lo.x),
    ),
    Half(
      vec4f(b.r0.lo.y, b.r1.lo.y, b.r2.lo.y, b.r3.lo.y),
      vec4f(b.r4.lo.y, b.r5.lo.y, b.r6.lo.y, b.r7.lo.y),
    ),
    Half(
      vec4f(b.r0.lo.z, b.r1.lo.z, b.r2.lo.z, b.r3.lo.z),
      vec4f(b.r4.lo.z, b.r5.lo.z, b.r6.lo.z, b.r7.lo.z),
    ),
    Half(
      vec4f(b.r0.lo.w, b.r1.lo.w, b.r2.lo.w, b.r3.lo.w),
      vec4f(b.r4.lo.w, b.r5.lo.w, b.r6.lo.w, b.r7.lo.w),
    ),
    Half(
      vec4f(b.r0.hi.x, b.r1.hi.x, b.r2.hi.x, b.r3.hi.x),
      vec4f(b.r4.hi.x, b.r5.hi.x, b.r6.hi.x, b.r7.hi.x),
    ),
    Half(
      vec4f(b.r0.hi.y, b.r1.hi.y, b.r2.hi.y, b.r3.hi.y),
      vec4f(b.r4.hi.y, b.r5.hi.y, b.r6.hi.y, b.r7.hi.y),
    ),
    Half(
      vec4f(b.r0.hi.z, b.r1.hi.z, b.r2.hi.z, b.r3.hi.z),
      vec4f(b.r4.hi.z, b.r5.hi.z, b.r6.hi.z, b.r7.hi.z),
    ),
    Half(
      vec4f(b.r0.hi.w, b.r1.hi.w, b.r2.hi.w, b.r3.hi.w),
      vec4f(b.r4.hi.w, b.r5.hi.w, b.r6.hi.w, b.r7.hi.w),
    ),
  );
}

fn wht_rows(b: Block) -> Block {
  return Block(
    wht8(b.r0),
    wht8(b.r1),
    wht8(b.r2),
    wht8(b.r3),
    wht8(b.r4),
    wht8(b.r5),
    wht8(b.r6),
    wht8(b.r7),
  );
}

fn scaled(b: Block, by: f32) -> Block {
  return Block(
    Half(b.r0.lo * by, b.r0.hi * by),
    Half(b.r1.lo * by, b.r1.hi * by),
    Half(b.r2.lo * by, b.r2.hi * by),
    Half(b.r3.lo * by, b.r3.hi * by),
    Half(b.r4.lo * by, b.r4.hi * by),
    Half(b.r5.lo * by, b.r5.hi * by),
    Half(b.r6.lo * by, b.r6.hi * by),
    Half(b.r7.lo * by, b.r7.hi * by),
  );
}

fn wht2d(b: Block, normalize: bool) -> Block {
  let transformed = transposed(wht_rows(transposed(wht_rows(b))));
  if (normalize) {
    return scaled(transformed, 1.0 / 64.0);
  }
  return transformed;
}

fn tile_row(base: i32) -> Half {
  return Half(
    vec4f(tile_in[base], tile_in[base + 1], tile_in[base + 2], tile_in[base + 3]),
    vec4f(tile_in[base + 4], tile_in[base + 5], tile_in[base + 6], tile_in[base + 7]),
  );
}

fn pilot_row(base: i32) -> Half {
  return Half(
    vec4f(pilot[base], pilot[base + 1], pilot[base + 2], pilot[base + 3]),
    vec4f(pilot[base + 4], pilot[base + 5], pilot[base + 6], pilot[base + 7]),
  );
}

fn tile_block(at: i32) -> Block {
  return Block(
    tile_row(at),
    tile_row(at + TILE_W),
    tile_row(at + 2 * TILE_W),
    tile_row(at + 3 * TILE_W),
    tile_row(at + 4 * TILE_W),
    tile_row(at + 5 * TILE_W),
    tile_row(at + 6 * TILE_W),
    tile_row(at + 7 * TILE_W),
  );
}

fn pilot_block(at: i32) -> Block {
  return Block(
    pilot_row(at),
    pilot_row(at + TILE_W),
    pilot_row(at + 2 * TILE_W),
    pilot_row(at + 3 * TILE_W),
    pilot_row(at + 4 * TILE_W),
    pilot_row(at + 5 * TILE_W),
    pilot_row(at + 6 * TILE_W),
    pilot_row(at + 7 * TILE_W),
  );
}

/// One row of a block as the bit patterns of its magnitudes, which sort as the magnitudes do.
struct Bits {
  lo: vec4u,
  hi: vec4u,
};

struct Bits16 {
  a: Bits,
  b: Bits,
};

struct Bits32 {
  a: Bits,
  b: Bits,
  c: Bits,
  d: Bits,
};

fn bits_of(h: Half) -> Bits {
  return Bits(bitcast<vec4u>(abs(h.lo)), bitcast<vec4u>(abs(h.hi)));
}

fn reversed(x: Bits) -> Bits {
  return Bits(x.hi.wzyx, x.lo.wzyx);
}

/// Four ascending, from a bitonic four.
fn clean4(v: vec4u) -> vec4u {
  let a = min(v.xy, v.zw);
  let b = max(v.xy, v.zw);
  let l = min(vec2u(a.x, b.x), vec2u(a.y, b.y));
  let h = max(vec2u(a.x, b.x), vec2u(a.y, b.y));
  return vec4u(l.x, h.x, l.y, h.y);
}

fn sort4(v: vec4u) -> vec4u {
  return clean4(vec4u(min(v.x, v.y), max(v.x, v.y), max(v.z, v.w), min(v.z, v.w)));
}

/// Eight ascending, from a bitonic eight.
fn clean8(x: Bits) -> Bits {
  return Bits(clean4(min(x.lo, x.hi)), clean4(max(x.lo, x.hi)));
}

fn sort8(x: Bits) -> Bits {
  return clean8(Bits(sort4(x.lo), sort4(x.hi).wzyx));
}

/// Sixteen ascending, from a bitonic sixteen.
fn clean16(p: Bits, q: Bits) -> Bits16 {
  let l = Bits(min(p.lo, q.lo), min(p.hi, q.hi));
  let h = Bits(max(p.lo, q.lo), max(p.hi, q.hi));
  return Bits16(clean8(l), clean8(h));
}

/// Sixteen ascending, from two ascending eights: reversing the second makes them one bitonic.
fn merge16(a: Bits, b: Bits) -> Bits16 {
  return clean16(a, reversed(b));
}

/// Thirty-two ascending, from two ascending sixteens.
fn merge32(a: Bits16, b: Bits16) -> Bits32 {
  let x0 = reversed(b.b);
  let x1 = reversed(b.a);
  let l = clean16(
    Bits(min(a.a.lo, x0.lo), min(a.a.hi, x0.hi)),
    Bits(min(a.b.lo, x1.lo), min(a.b.hi, x1.hi)),
  );
  let h = clean16(
    Bits(max(a.a.lo, x0.lo), max(a.a.hi, x0.hi)),
    Bits(max(a.b.lo, x1.lo), max(a.b.hi, x1.hi)),
  );
  return Bits32(l.a, l.b, h.a, h.b);
}

/// The MAD of the 63 AC coefficients, as a per-coefficient variance.
///
/// What is sorted is the magnitudes' *bit patterns*: the IEEE encoding of a non-negative float
/// is monotonic in its value, so the k-th smallest pattern is the k-th smallest magnitude,
/// exactly. A network rather than a loop because every index has to be a constant, for the
/// reason the header gives - and a network rather than the bisection over the pattern space it
/// replaced, which was equally exact but spent 31 rounds counting all 64 against a midpoint:
/// 1625ms of this kernel's 4354ms on a 61MP frame.
fn mad_sigma_y_sq(b: Block) -> f32 {
  var head = bits_of(b.r0);
  // The DC term is not one of the 63; no magnitude's pattern reaches this one, so it sorts past
  // all of them and out of the rank below.
  head.lo.x = 0xffffffffu;

  let ab = merge32(
    merge16(sort8(head), sort8(bits_of(b.r1))),
    merge16(sort8(bits_of(b.r2)), sort8(bits_of(b.r3))),
  );
  let cd = merge32(
    merge16(sort8(bits_of(b.r4)), sort8(bits_of(b.r5))),
    merge16(sort8(bits_of(b.r6)), sort8(bits_of(b.r7))),
  );

  // The last merge stops at its first step, which already separates the 32 smallest of the 64
  // from the 32 largest: the largest of those is the 32nd, so what would have put them in order
  // is a max instead.
  let x0 = reversed(cd.d);
  let x1 = reversed(cd.c);
  let x2 = reversed(cd.b);
  let x3 = reversed(cd.a);
  let l0 = Bits(min(ab.a.lo, x0.lo), min(ab.a.hi, x0.hi));
  let l1 = Bits(min(ab.b.lo, x1.lo), min(ab.b.hi, x1.hi));
  let l2 = Bits(min(ab.c.lo, x2.lo), min(ab.c.hi, x2.hi));
  let l3 = Bits(min(ab.d.lo, x3.lo), min(ab.d.hi, x3.hi));
  let top = max(
    max(max(l0.lo, l0.hi), max(l1.lo, l1.hi)),
    max(max(l2.lo, l2.hi), max(l3.lo, l3.hi)),
  );
  let pair = max(top.xy, top.zw);

  let sy = bitcast<f32>(max(pair.x, pair.y)) / 0.6745;
  return (sy * sy) / f32(BP);
}

/// A row hard-thresholded, and how many of its coefficients survived.
struct Kept {
  row: Half,
  count: f32,
};

fn threshold(h: Half, lambda: f32) -> Kept {
  let lo = abs(h.lo) >= vec4f(lambda);
  let hi = abs(h.hi) >= vec4f(lambda);
  let count = dot(select(vec4f(0.0), vec4f(1.0), lo), vec4f(1.0))
    + dot(select(vec4f(0.0), vec4f(1.0), hi), vec4f(1.0));
  return Kept(
    Half(select(vec4f(0.0), h.lo, lo), select(vec4f(0.0), h.hi, hi)),
    count,
  );
}

/// The Wiener gain a row's pilot asks for, and the energy it carries.
struct Gained {
  row: Half,
  energy: f32,
};

fn wiener(noisy: Half, pilot_row_: Half, sigma_sq_unorm: f32) -> Gained {
  let s2_lo = pilot_row_.lo * pilot_row_.lo;
  let s2_hi = pilot_row_.hi * pilot_row_.hi;
  // **The divisor is floored because both of its terms can be zero at once, and `max` does not
  // agree about NaN across backends.** `sigma_sq_unorm` is exactly zero whenever the luma slider
  // is - an ordinary position, since colour alone satisfies `does_anything` - and a block that is
  // exactly flat, a clipped highlight or shadows the conditioning clamped to zero, has every AC
  // coefficient of its pilot at zero too. That is 0/0. WGSL's `max` propagates the NaN and
  // Metal's `fmax` returns the other operand, so the two hosts would take different branches
  // through the fallback below on the same photograph, which is the one thing the shared shaders
  // exist to prevent.
  let floor_ = vec4f(1e-20);
  let w_lo = max(s2_lo / max(s2_lo + vec4f(sigma_sq_unorm), floor_), vec4f(WIENER_FLOOR));
  let w_hi = max(s2_hi / max(s2_hi + vec4f(sigma_sq_unorm), floor_), vec4f(WIENER_FLOOR));
  return Gained(
    Half(noisy.lo * w_lo, noisy.hi * w_hi),
    dot(w_lo, w_lo) + dot(w_hi, w_hi),
  );
}

fn accumulate(h: Half, at: i32, weight: f32, row_window: f32) {
  let wlo = weight * row_window * KAISER_LO;
  let whi = weight * row_window * KAISER_HI;
  numer[at] += wlo.x * h.lo.x;
  numer[at + 1] += wlo.y * h.lo.y;
  numer[at + 2] += wlo.z * h.lo.z;
  numer[at + 3] += wlo.w * h.lo.w;
  numer[at + 4] += whi.x * h.hi.x;
  numer[at + 5] += whi.y * h.hi.y;
  numer[at + 6] += whi.z * h.hi.z;
  numer[at + 7] += whi.w * h.hi.w;
  denom[at] += wlo.x;
  denom[at + 1] += wlo.y;
  denom[at + 2] += wlo.z;
  denom[at + 3] += wlo.w;
  denom[at + 4] += whi.x;
  denom[at + 5] += whi.y;
  denom[at + 6] += whi.z;
  denom[at + 7] += whi.w;
}

fn accumulate_block(b: Block, at: i32, weight: f32) {
  accumulate(b.r0, at, weight, KAISER_LO.x);
  accumulate(b.r1, at + TILE_W, weight, KAISER_LO.y);
  accumulate(b.r2, at + 2 * TILE_W, weight, KAISER_LO.z);
  accumulate(b.r3, at + 3 * TILE_W, weight, KAISER_LO.w);
  accumulate(b.r4, at + 4 * TILE_W, weight, KAISER_HI.x);
  accumulate(b.r5, at + 5 * TILE_W, weight, KAISER_HI.y);
  accumulate(b.r6, at + 6 * TILE_W, weight, KAISER_HI.z);
  accumulate(b.r7, at + 7 * TILE_W, weight, KAISER_HI.w);
}

@compute @workgroup_size(8, 8)
fn pass12(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_id) local: vec3u,
) {
  let tile_x = i32(group.x) * TILE_SIZE;
  let tile_y = i32(group.y) * TILE_SIZE;
  let lid = i32(local.y) * 8 + i32(local.x);

  // The reference iterates blocks over `ref in [0, dim - BS]`; a block anchored outside
  // that never existed on the CPU side and must not be accumulated here either.
  let img_rmax = pc.height - BS;
  let img_cmax = pc.width - BS;

  for (var i = lid; i < TILE_PIXELS; i += WG_SIZE) {
    let gx = tile_x - HALO + (i % TILE_W);
    let gy = tile_y - HALO + (i / TILE_W);
    var v = 0.0;
    if (gx >= 0 && gx < pc.width && gy >= 0 && gy < pc.height) {
      v = in_buf[gy * pc.width + gx];
    }
    tile_in[i] = v;
    numer[i] = 0.0;
    denom[i] = 0.0;
  }
  workgroupBarrier();

  let n_blocks_dim = (TILE_W - BS) / STRIDE + 1;
  let sigma_sq = pc.sigma_strength * pc.sigma_strength;
  let lambda_max_unorm = pc.sigma_strength * sqrt(2.0 * log(f32(BP))) * sqrt(f32(BP));
  let sigma_sq_unorm = sigma_sq * f32(BP);

  for (var phase = 0; phase < N_PHASES; phase++) {
    let px = phase % PHASE_MOD;
    let py = phase / PHASE_MOD;
    let bpd = (n_blocks_dim - px + PHASE_MOD - 1) / PHASE_MOD;
    let bpd_y = (n_blocks_dim - py + PHASE_MOD - 1) / PHASE_MOD;
    let n_blocks = bpd * bpd_y;

    for (var bi = lid; bi < n_blocks; bi += WG_SIZE) {
      let bx = (bi % bpd) * PHASE_MOD + px;
      let by = (bi / bpd) * PHASE_MOD + py;
      if (bx >= n_blocks_dim || by >= n_blocks_dim) { continue; }

      let ref_c = bx * STRIDE;
      let ref_r = by * STRIDE;
      if (tile_y - HALO + ref_r < 0 || tile_y - HALO + ref_r > img_rmax) { continue; }
      if (tile_x - HALO + ref_c < 0 || tile_x - HALO + ref_c > img_cmax) { continue; }

      let at = ref_r * TILE_W + ref_c;
      var b = wht2d(tile_block(at), false);

      let sigma_x_sq = max(mad_sigma_y_sq(b) - sigma_sq, 0.0);
      var lambda = 1e30;
      if (sigma_x_sq >= 1e-10) {
        lambda = min((sigma_sq / sqrt(sigma_x_sq)) * sqrt(f32(BP)), lambda_max_unorm);
      }

      // Hard threshold, not soft. A soft one here is a different algorithm, and the
      // reference records having shipped that by accident once.
      let dc = b.r0.lo.x;
      let k0 = threshold(b.r0, lambda);
      let k1 = threshold(b.r1, lambda);
      let k2 = threshold(b.r2, lambda);
      let k3 = threshold(b.r3, lambda);
      let k4 = threshold(b.r4, lambda);
      let k5 = threshold(b.r5, lambda);
      let k6 = threshold(b.r6, lambda);
      let k7 = threshold(b.r7, lambda);
      var kept = k0.count + k1.count + k2.count + k3.count + k4.count + k5.count + k6.count
        + k7.count;
      if (abs(dc) >= lambda) {
        kept -= 1.0;
      }
      b = Block(k0.row, k1.row, k2.row, k3.row, k4.row, k5.row, k6.row, k7.row);
      b.r0.lo.x = dc;

      accumulate_block(wht2d(b, true), at, 1.0 / (kept + 1.0));
    }
    workgroupBarrier();
  }

  for (var i = lid; i < TILE_PIXELS; i += WG_SIZE) {
    let d = denom[i];
    pilot[i] = select(tile_in[i], numer[i] / d, d > 1e-10);
    numer[i] = 0.0;
    denom[i] = 0.0;
  }
  workgroupBarrier();

  for (var phase = 0; phase < N_PHASES; phase++) {
    let px = phase % PHASE_MOD;
    let py = phase / PHASE_MOD;
    let bpd = (n_blocks_dim - px + PHASE_MOD - 1) / PHASE_MOD;
    let bpd_y = (n_blocks_dim - py + PHASE_MOD - 1) / PHASE_MOD;
    let n_blocks = bpd * bpd_y;

    for (var bi = lid; bi < n_blocks; bi += WG_SIZE) {
      let bx = (bi % bpd) * PHASE_MOD + px;
      let by = (bi / bpd) * PHASE_MOD + py;
      if (bx >= n_blocks_dim || by >= n_blocks_dim) { continue; }

      let ref_c = bx * STRIDE;
      let ref_r = by * STRIDE;
      if (tile_y - HALO + ref_r < 0 || tile_y - HALO + ref_r > img_rmax) { continue; }
      if (tile_x - HALO + ref_c < 0 || tile_x - HALO + ref_c > img_cmax) { continue; }

      let at = ref_r * TILE_W + ref_c;
      let noisy = wht2d(tile_block(at), false);
      let guide = wht2d(pilot_block(at), false);

      let g0 = wiener(noisy.r0, guide.r0, sigma_sq_unorm);
      let g1 = wiener(noisy.r1, guide.r1, sigma_sq_unorm);
      let g2 = wiener(noisy.r2, guide.r2, sigma_sq_unorm);
      let g3 = wiener(noisy.r3, guide.r3, sigma_sq_unorm);
      let g4 = wiener(noisy.r4, guide.r4, sigma_sq_unorm);
      let g5 = wiener(noisy.r5, guide.r5, sigma_sq_unorm);
      let g6 = wiener(noisy.r6, guide.r6, sigma_sq_unorm);
      let g7 = wiener(noisy.r7, guide.r7, sigma_sq_unorm);
      // The DC coefficient's gain is 1 rather than the pilot's, so its energy is 1 too and
      // the floor the rest were held to is not part of it.
      // Floored for the same reason as `wiener` above: a flat block at zero luma is 0/0 here too.
      let dc_s2 = guide.r0.lo.x * guide.r0.lo.x;
      let dc_w = max(dc_s2 / max(dc_s2 + sigma_sq_unorm, 1e-20), WIENER_FLOOR);
      var energy = g0.energy + g1.energy + g2.energy + g3.energy + g4.energy + g5.energy
        + g6.energy + g7.energy - dc_w * dc_w + 1.0;
      var b = Block(g0.row, g1.row, g2.row, g3.row, g4.row, g5.row, g6.row, g7.row);
      b.r0.lo.x = noisy.r0.lo.x;

      accumulate_block(wht2d(b, true), at, 1.0 / max(energy, 1e-6));
    }
    workgroupBarrier();
  }

  for (var i = lid; i < TILE_SIZE * TILE_SIZE; i += WG_SIZE) {
    let lx = i % TILE_SIZE;
    let ly = i / TILE_SIZE;
    let idx = (ly + HALO) * TILE_W + (lx + HALO);
    let gx = tile_x + lx;
    let gy = tile_y + ly;
    if (gx < pc.width && gy < pc.height) {
      let d = denom[idx];
      out_buf[gy * pc.width + gx] = select(tile_in[idx], numer[idx] / d, d > 1e-10);
    }
  }
}
