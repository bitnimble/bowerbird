// The lens distortion correction the camera recorded for the shot it just took.
//
// Sony writes it into the RAW as a spline: IFD0 -> SubIFD (tag 0x014a) -> tag
// 0x7037, an SSHORT array whose first element is the number of knots that follow.
// The knots are evenly spaced from the frame centre to the corner and give the
// radial displacement in units of 1/16384 of the half-diagonal, anchored at zero
// in the centre. Plain TIFF parsing reaches all of it; none of Sony's enciphered
// 0x94xx blocks are involved.
//
// Verified against an independent fit of the render against the embedded JPEG: at
// 28mm the spline says -2.83% at the corner and the fit says -2.78%. The values
// track focal length per shot rather than coming from a static table - the 28-75
// zoom crosses zero near 32mm and reaches +4.5% at 75mm - which is why this beats
// any profile that could be downloaded and stored.
//
// Only Sony is implemented. Canon records an equivalent, but CR2/CR3 have not been
// checked against a real file, so they fall through to `null` and the caller fits
// the geometry instead (see `fitDistortion`).

/** A knot value of this many units is one half-diagonal of displacement. */
export const SPLINE_UNIT = 16384;

const DISTORTION_TAG = 0x7037;
const SUBIFD_TAG = 0x014a;
const TYPE_SHORT = 3;
const TYPE_SSHORT = 8;
const TYPE_LONG = 4;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

// A correction beyond this is not a lens profile, it is a misparse. The largest
// seen on real files is the RX100M3's -10.5%.
const PLAUSIBLE_CORNER = 0.25;
const MAX_IFD_ENTRIES = 512;

interface Entry {
  tag: number;
  type: number;
  count: number;
  start: number;
}

/**
 * Radial distortion knots, centre to corner, in `SPLINE_UNIT`s. Null when the
 * file records none, which is most bodies older than about 2012.
 */
export function readDistortionSpline(bytes: Uint8Array): number[] | null {
  if (bytes.length < 8) return null;
  const order = String.fromCharCode(bytes[0]!, bytes[1]!);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const readIfd = (offset: number): Entry[] => {
    if (offset <= 0 || offset + 2 > bytes.length) return [];
    const count = view.getUint16(offset, little);
    if (count === 0 || count > MAX_IFD_ENTRIES) return [];
    if (offset + 2 + count * 12 + 4 > bytes.length) return [];
    const entries: Entry[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = offset + 2 + i * 12;
      const type = view.getUint16(at + 2, little);
      const unit = TYPE_SIZE[type];
      if (unit == null) continue;
      const n = view.getUint32(at + 4, little);
      const size = unit * n;
      // A value of four bytes or fewer is stored in the entry, not pointed at.
      entries.push({ tag: view.getUint16(at, little), type, count: n, start: size <= 4 ? at + 8 : view.getUint32(at + 8, little) });
    }
    return entries;
  };

  for (const entry of readIfd(view.getUint32(4, little))) {
    if (entry.tag !== SUBIFD_TAG || entry.type !== TYPE_LONG) continue;
    for (let k = 0; k < entry.count; k += 1) {
      const at = entry.start + k * 4;
      if (at + 4 > bytes.length) break;
      const knots = findSpline(readIfd(view.getUint32(at, little)), view, bytes.length, little);
      if (knots) return knots;
    }
  }
  return null;
}

function findSpline(entries: Entry[], view: DataView, length: number, little: boolean): number[] | null {
  for (const entry of entries) {
    if (entry.tag !== DISTORTION_TAG) continue;
    if (entry.type !== TYPE_SSHORT && entry.type !== TYPE_SHORT) continue;
    if (entry.count < 2 || entry.start + entry.count * 2 > length) continue;

    // The count is per tag and per body, not a constant: the ILCE-7CR writes 16
    // knots and the ILCE-6300 writes 11, and within one RX100M3 file the
    // vignetting tag uses a different count from this one. Trust the prefix only
    // when it fits the tag it came from.
    const declared = view.getInt16(entry.start, little);
    if (declared < 2 || declared > entry.count - 1) continue;

    const knots: number[] = [];
    for (let i = 1; i <= declared; i += 1) knots.push(view.getInt16(entry.start + i * 2, little));
    if (Math.abs(knots[knots.length - 1]! / SPLINE_UNIT) > PLAUSIBLE_CORNER) continue;
    return knots;
  }
  return null;
}

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
