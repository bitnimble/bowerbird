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
fn noise_luma(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let at = linear(id, groups);
  if (at >= params.width * params.height) { return; }
  let p = at * 3u;
  plane[at] =
    (0.2627 * sample_at(p) + 0.6780 * sample_at(p + 1u) + 0.0593 * sample_at(p + 2u)) / 65535.0;
}

/// One row of a block: columns 0-3, then 4-7.
struct Row8 {
  lo: vec4f,
  hi: vec4f,
};

/// **A block is sixteen vector registers, not an array, and every index below is a constant.** A
/// dynamically indexed local array gets a *scratch* allocation in device memory, and once one of a
/// kernel's arrays is there the rest of the working set follows - so the 96 Laplacians would be an
/// uncoalesced round trip apiece. `pass12.wgsl`'s header measures what that costs.
fn plane_row(at: u32) -> Row8 {
  return Row8(
    vec4f(plane[at], plane[at + 1u], plane[at + 2u], plane[at + 3u]),
    vec4f(plane[at + 4u], plane[at + 5u], plane[at + 6u], plane[at + 7u]),
  );
}

/// The plane the Laplacians are read off, which on the second pass is the stabilised one.
///
/// **Recomputed per block rather than written out as a plane of its own.** It is pointwise and
/// pure, so the value is the one a stored plane would have held, and storing it would cost a second
/// pass and a second 244MB buffer at 61MP to save six square roots a pixel.
fn noise_row(r: Row8) -> Row8 {
  if (params.transform == 0u) { return r; }
  return Row8(
    params.scale * sqrt(max(params.alpha * r.lo + params.c, vec4f(0.0))),
    params.scale * sqrt(max(params.alpha * r.hi + params.c, vec4f(0.0))),
  );
}

/// Left to right along the row, row by row down the block, which is the order `noise::blocks` adds
/// them in: a mean of 64 floats summed in another order is a different mean, and the level it comes
/// out at is which bin the block's sigma is counted in.
fn row_sum(acc: f32, r: Row8) -> f32 {
  return acc + r.lo.x + r.lo.y + r.lo.z + r.lo.w + r.hi.x + r.hi.y + r.hi.z + r.hi.w;
}

/// The six horizontal Laplacians of one row.
struct Lap6 {
  a: vec4f,
  b: vec2f,
};

fn lap_h(r: Row8) -> Lap6 {
  return Lap6(
    abs(r.lo - 2.0 * vec4f(r.lo.yzw, r.hi.x) + vec4f(r.lo.zw, r.hi.xy)),
    abs(r.hi.xy - 2.0 * r.hi.yz + r.hi.zw),
  );
}

/// The eight vertical Laplacians of one row and the two below it.
fn lap_v(a: Row8, b: Row8, c: Row8) -> Row8 {
  return Row8(abs(a.lo - 2.0 * b.lo + c.lo), abs(a.hi - 2.0 * b.hi + c.hi));
}

/// Eight Laplacian magnitudes as their bit patterns, which sort as the magnitudes do.
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

struct Bits64 {
  lo: Bits32,
  hi: Bits32,
};

fn bits_of(r: Row8) -> Bits {
  return Bits(bitcast<vec4u>(r.lo), bitcast<vec4u>(r.hi));
}

fn min_bits(p: Bits, q: Bits) -> Bits {
  return Bits(min(p.lo, q.lo), min(p.hi, q.hi));
}

fn max_bits(p: Bits, q: Bits) -> Bits {
  return Bits(max(p.lo, q.lo), max(p.hi, q.hi));
}

fn reversed(x: Bits) -> Bits {
  return Bits(x.hi.wzyx, x.lo.wzyx);
}

fn reversed32(x: Bits32) -> Bits32 {
  return Bits32(reversed(x.d), reversed(x.c), reversed(x.b), reversed(x.a));
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
  return Bits16(clean8(min_bits(p, q)), clean8(max_bits(p, q)));
}

/// Thirty-two ascending, from a bitonic thirty-two.
fn clean32(x: Bits32) -> Bits32 {
  let l = clean16(min_bits(x.a, x.c), min_bits(x.b, x.d));
  let h = clean16(max_bits(x.a, x.c), max_bits(x.b, x.d));
  return Bits32(l.a, l.b, h.a, h.b);
}

/// Sixty-four ascending, from a bitonic sixty-four.
fn clean64(x: Bits64) -> Bits64 {
  let l = clean32(Bits32(
    min_bits(x.lo.a, x.hi.a),
    min_bits(x.lo.b, x.hi.b),
    min_bits(x.lo.c, x.hi.c),
    min_bits(x.lo.d, x.hi.d),
  ));
  let h = clean32(Bits32(
    max_bits(x.lo.a, x.hi.a),
    max_bits(x.lo.b, x.hi.b),
    max_bits(x.lo.c, x.hi.c),
    max_bits(x.lo.d, x.hi.d),
  ));
  return Bits64(l, h);
}

/// Reversing the second run is what makes two ascending ones a single bitonic one.
fn merge16(a: Bits, b: Bits) -> Bits16 {
  return clean16(a, reversed(b));
}

fn merge32(a: Bits16, b: Bits16) -> Bits32 {
  return clean32(Bits32(a.a, a.b, reversed(b.b), reversed(b.a)));
}

fn merge64(a: Bits32, b: Bits32) -> Bits64 {
  return clean64(Bits64(a, reversed32(b)));
}

/// The 49th smallest of 96 Laplacian magnitudes - `noise::blocks`' `select_nth_unstable_by(48,
/// f32::total_cmp)`, exactly, ties included.
///
/// What is ranked is the magnitudes' *bit patterns*: `total_cmp` on a non-negative float is its
/// IEEE encoding read as an integer, so the CPU's comparator and this one are the same order, and
/// the k-th smallest pattern is the k-th smallest magnitude. A network rather than the partial
/// selection it replaced, which took 48 passes over all 96 through a dynamically indexed array.
fn median96(
  s0: Bits, s1: Bits, s2: Bits, s3: Bits, s4: Bits, s5: Bits,
  s6: Bits, s7: Bits, s8: Bits, s9: Bits, s10: Bits, s11: Bits,
) -> f32 {
  let a = merge32(merge16(sort8(s0), sort8(s1)), merge16(sort8(s2), sort8(s3)));
  let b = merge32(merge16(sort8(s4), sort8(s5)), merge16(sort8(s6), sort8(s7)));
  let c = merge32(merge16(sort8(s8), sort8(s9)), merge16(sort8(s10), sort8(s11)));
  let ab = merge64(a, b);

  // The 96 are ranked as 128, the fourth thirty-two being a sentinel that no magnitude's pattern
  // reaches: `abs` clears the sign bit, which is the only thing that sorts above 0x7fffffff. That
  // makes two of the last merge's steps free rather than folded - a sentinel decides its comparator
  // on its own - and the rank falls in one half of each step that is left, so what would have
  // ordered the other half is not run at all.
  let rc = reversed32(c);
  let low = Bits32(
    min_bits(ab.hi.a, rc.a),
    min_bits(ab.hi.b, rc.b),
    min_bits(ab.hi.c, rc.c),
    min_bits(ab.hi.d, rc.d),
  );
  let h2 = Bits32(
    max_bits(ab.lo.a, low.a),
    max_bits(ab.lo.b, low.b),
    max_bits(ab.lo.c, low.c),
    max_bits(ab.lo.d, low.d),
  );
  let h3 = Bits16(max_bits(h2.a, h2.c), max_bits(h2.b, h2.d));

  let m = min_bits(h3.a, h3.b);
  let v = min(m.lo, m.hi);
  let pair = min(v.xy, v.zw);
  return bitcast<f32>(min(pair.x, pair.y));
}

/// One 8x8 block: where it sits on the level plane, and how much it deviates on the noise one.
@compute @workgroup_size(64)
fn noise_blocks(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(num_workgroups) groups: vec3u,
) {
  let block = linear(id, groups);
  if (block >= params.blocks_x * params.blocks_y) { return; }
  let x0 = (block % params.blocks_x) * BLOCK;
  let y0 = (block / params.blocks_x) * BLOCK;
  let at = y0 * params.width + x0;
  let w = params.width;

  let p0 = plane_row(at);
  let p1 = plane_row(at + w);
  let p2 = plane_row(at + 2u * w);
  let p3 = plane_row(at + 3u * w);
  let p4 = plane_row(at + 4u * w);
  let p5 = plane_row(at + 5u * w);
  let p6 = plane_row(at + 6u * w);
  let p7 = plane_row(at + 7u * w);

  var sum = 0.0;
  sum = row_sum(sum, p0);
  sum = row_sum(sum, p1);
  sum = row_sum(sum, p2);
  sum = row_sum(sum, p3);
  sum = row_sum(sum, p4);
  sum = row_sum(sum, p5);
  sum = row_sum(sum, p6);
  sum = row_sum(sum, p7);

  let n0 = noise_row(p0);
  let n1 = noise_row(p1);
  let n2 = noise_row(p2);
  let n3 = noise_row(p3);
  let n4 = noise_row(p4);
  let n5 = noise_row(p5);
  let n6 = noise_row(p6);
  let n7 = noise_row(p7);

  let h0 = lap_h(n0);
  let h1 = lap_h(n1);
  let h2 = lap_h(n2);
  let h3 = lap_h(n3);
  let h4 = lap_h(n4);
  let h5 = lap_h(n5);
  let h6 = lap_h(n6);
  let h7 = lap_h(n7);

  // Forty-eight horizontal and forty-eight vertical, grouped eight at a time in whatever order the
  // row shapes fall into - a rank does not care which Laplacian is which, only how many are below.
  let sigma = median96(
    Bits(bitcast<vec4u>(h0.a), bitcast<vec4u>(h1.a)),
    Bits(bitcast<vec4u>(h2.a), bitcast<vec4u>(h3.a)),
    Bits(bitcast<vec4u>(vec4f(h0.b, h1.b)), bitcast<vec4u>(vec4f(h2.b, h3.b))),
    Bits(bitcast<vec4u>(h4.a), bitcast<vec4u>(h5.a)),
    Bits(bitcast<vec4u>(h6.a), bitcast<vec4u>(h7.a)),
    Bits(bitcast<vec4u>(vec4f(h4.b, h5.b)), bitcast<vec4u>(vec4f(h6.b, h7.b))),
    bits_of(lap_v(n0, n1, n2)),
    bits_of(lap_v(n1, n2, n3)),
    bits_of(lap_v(n2, n3, n4)),
    bits_of(lap_v(n3, n4, n5)),
    bits_of(lap_v(n4, n5, n6)),
    bits_of(lap_v(n5, n6, n7)),
  );

  // The median absolute Laplacian of iid noise is 0.6745 * sqrt(6) sigma.
  stats[block] = vec2f(sum / f32(BLOCK * BLOCK), sigma / 1.6521);
}
