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
