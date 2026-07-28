// Radial geometry: evaluating a distortion model, and warping through one.
//
// Reading the model out of the file is in `native/rawshim/src/lens.rs`, not here.
// It used to be here, and that meant handing JavaScript the entire RAW - 60-120MB
// per photo - to find one tag in the first few kilobytes of it.
//
// A camera's own spline and a fitted polynomial are interchangeable here, which is
// the point of expressing both as knots: the model is verified per shot rather than
// per body, and at 28mm the spline says -2.83% at the corner where an independent
// fit says -2.78%. The values track focal length - the 28-75 zoom crosses zero near
// 32mm and reaches +4.5% at 75mm - which is why this beats any downloadable profile.

/** A knot value of this many units is one half-diagonal of displacement. */
export const SPLINE_UNIT = 16384;

/**
 * Where a destination radius samples from, both radii normalised so 1.0 is the
 * half-diagonal.
 *
 * `crop` is the overall rescale the camera applied so the corrected frame still
 * fills the sensor. The spline does not carry it and it is not reliably derivable
 * - for pincushion the tightest fill predicts it exactly, but for barrel the
 * camera is more conservative than that - so the caller fits it.
 */
export function sampleRadius(knots: readonly number[], radius: number, crop: number): number {
  if (knots.length === 0) return crop * radius;
  const position = Math.min(knots.length - 1, Math.max(0, radius * (knots.length - 1)));
  const index = Math.floor(position);
  const next = Math.min(knots.length - 1, index + 1);
  const value = knots[index]! + (knots[next]! - knots[index]!) * (position - index);
  return crop * radius * (1 + value / SPLINE_UNIT);
}

/** A radial model as a knot list, so a fitted polynomial and a camera spline are interchangeable downstream. */
export function polynomialKnots(k1: number, k2: number, count = 16): number[] {
  return Array.from({ length: count }, (_, i) => {
    const u = i / (count - 1);
    const r2 = u * u;
    return Math.round((k1 * r2 + k2 * r2 * r2) * SPLINE_UNIT);
  });
}

// Entries in the radius lookup the warp indexes by r^2. Radii are normalised to
// the half-diagonal, so r^2 runs exactly 0..1 over the frame and the table needs
// no range beyond that. 4096 buckets put the spline's own kinks several buckets
// apart on a 16-knot curve, and the residual interpolation error is far below the
// bilinear sampling that follows it.
const RATIO_TABLE_LAST = 4096;

/**
 * `sampleRadius(r) / r` sampled over r^2, which is the form the warp wants: it has
 * dx and dy, so it has r^2 for free, and turning that into a ratio via the table
 * skips the sqrt, the spline walk and the division that a direct evaluation needs
 * at every pixel.
 */
function ratioTable(knots: readonly number[], crop: number): Float64Array {
  const table = new Float64Array(RATIO_TABLE_LAST + 1);
  for (let slot = 0; slot <= RATIO_TABLE_LAST; slot += 1) {
    const radius = Math.sqrt(slot / RATIO_TABLE_LAST);
    // At the centre the ratio is the crop alone: the spline is anchored at zero
    // there, and dividing a zero radius by itself is not defined.
    table[slot] = radius === 0 ? crop : sampleRadius(knots, radius, crop) / radius;
  }
  return table;
}

type ArrayConstructorOf<T> = new (length: number) => T;

/**
 * Bilinear resample of `source` onto a `width`x`height` grid through a radial
 * model.
 *
 * The SDR path warps in Rust, inside the fit. This is here for the HDR fit, which
 * works on 16-bit scene-linear samples and on the Float64 planes it derives from
 * them - neither of which the 8-bit Rust operations have a shape for.
 */
export function warp<T extends Uint8Array | Uint16Array | Float64Array>(
  source: { width: number; height: number; data: T },
  width: number,
  height: number,
  knots: readonly number[],
  crop: number,
): { width: number; height: number; data: T } {
  const count = width * height * 3;
  // Not `new source.data.constructor(...)`: for a Buffer that is a deprecated
  // constructor which refuses to allocate.
  const out = (
    Buffer.isBuffer(source.data) ? Buffer.allocUnsafe(count) : new (source.data.constructor as ArrayConstructorOf<T>)(count)
  ) as T;
  const half = Math.hypot(width / 2, height / 2);
  const scaleX = source.width / width;
  const scaleY = source.height / height;
  const ratios = ratioTable(knots, crop);
  const centreX = source.width / 2;
  const centreY = source.height / 2;
  const stepX = half * scaleX;
  const stepY = half * scaleY;
  const edgeX = source.width - 1;
  const edgeY = source.height - 1;
  for (let y = 0; y < height; y += 1) {
    const dy = (y - height / 2) / half;
    const dy2 = dy * dy;
    for (let x = 0; x < width; x += 1) {
      const dx = (x - width / 2) / half;
      // Indexed by r^2, so the per-pixel work is a multiply and two loads: no
      // sqrt, no walk along the spline, and no divide to turn a radius back into
      // a ratio. Direction is unchanged by a radial model, so scaling the
      // components by the ratio is the whole transform.
      const t = (dx * dx + dy2) * RATIO_TABLE_LAST;
      const slot = t < RATIO_TABLE_LAST ? t | 0 : RATIO_TABLE_LAST - 1;
      const low = ratios[slot]!;
      const ratio = low + (ratios[slot + 1]! - low) * (t - slot);
      const px = centreX + dx * ratio * stepX;
      const py = centreY + dy * ratio * stepY;
      const o = (y * width + x) * 3;
      if (px < 0 || py < 0 || px >= edgeX || py >= edgeY) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        continue;
      }
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const i00 = (y0 * source.width + x0) * 3;
      const i01 = i00 + source.width * 3;
      for (let c = 0; c < 3; c += 1) {
        out[o + c] =
          source.data[i00 + c]! * (1 - fx) * (1 - fy) +
          source.data[i00 + 3 + c]! * fx * (1 - fy) +
          source.data[i01 + c]! * (1 - fx) * fy +
          source.data[i01 + 3 + c]! * fx * fy;
      }
    }
  }
  return { width, height, data: out };
}
