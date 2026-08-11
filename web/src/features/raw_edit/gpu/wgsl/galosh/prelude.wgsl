// What every GALOSH kernel shares: the names of the scalar block it reads.
//
// The reference passes scalars as Vulkan push constants, one block per kernel. WGSL has no
// push constants, so each kernel declares its own `Push` at binding 20 - the field names are
// the kernel's own - and the host writes one 256-byte-aligned slot per dispatch and binds it
// with a dynamic offset. Binding 20 rather than the next free number so the buffers can keep
// the binding indices the reference host blueprint's dispatch table lists them under, which
// is what makes a dispatch auditable against the reference.

// `params_buf` slots, as `galosh.cl` lines 6346-6367 number them. Every consumer reads them
// off the device: only α, σ² and the IRLS scale ever cross back to the host.
const P_SIGMA_CH0: i32 = 0;
const P_UNIFIED_SIGMA: i32 = 4;
const P_INV_SG: i32 = 5;
const P_DARK_REF0: i32 = 6;
const P_S_SCALE: i32 = 10;
const P_ALPHA: i32 = 13;
const P_SIGMA_SQ: i32 = 14;
const P_DARK_THRESH: i32 = 15;
// Two of the eight slots the o32 path leaves free, holding the IRLS bounds that the
// reference passes as kernel arguments off a host readback. See `irls_seed`.
const P_S_MIN: i32 = 16;
const P_S_MAX: i32 = 17;

const FLT_MAX: f32 = 3.402823466e+38;

/// Knuth TwoSum: `(s, c) += v`, where the sum's true value is `s + c`.
///
/// Not decoration. The reference accumulated these sums in `f64` and needed `shaderFloat64`
/// for it; compensated f32 is what replaced that, and it is what holds the dark reference
/// and the inverse table to the canonical answer. Nothing on this path may be compiled with
/// fast math: reassociation cancels the error terms the scheme is made of.
fn kacc(s: ptr<function, f32>, c: ptr<function, f32>, v: f32) {
  let t = *s + v;
  let vp = t - *s;
  let sp = t - vp;
  let e = (v - vp) + (*s - sp);
  *s = t;
  *c = *c + e;
}

/// `(s, c) += (s2, c2)`, carrying both compensations plus the new error.
fn kcombine(s: ptr<function, f32>, c: ptr<function, f32>, s2: f32, c2: f32) {
  let t = *s + s2;
  let vp = t - *s;
  let sp = t - vp;
  let e = (s2 - vp) + (*s - sp);
  *s = t;
  *c = *c + c2 + e;
}
