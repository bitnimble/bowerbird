// The perspective correction, from the lines the reader drew on the picture.
//
// **The reader states what should have been parallel, and the correction follows.** Two lines
// down a pair of edges that are vertical in the world meet, in the picture, at a vanishing
// point; sending that point to infinity is exactly what makes them parallel again. A second
// pair does the same for the horizontal, and the line joining the two vanishing points - the
// horizon of the plane - is what a projective map has to send to infinity to fix both at once.
//
// So there is no fitting and nothing iterative here: four numbers of input per line, two cross
// products, and the answer. What the sliders in other tools do is this with the vanishing point
// guessed rather than pointed at.
//
// Everything below works in *pixels* of the frame, because the scale that keeps the corrected
// picture the size of the one it came from is only uniform in pixels; the matrix that leaves is
// in fractions, so it means the same thing at a tile and at native resolution.

/** A line the reader drew, as fractions of the frame. Endpoints, not a direction. */
export interface KeystoneGuide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The correction, row-major, with the ninth element dropped - it is always 1.
 *
 * **Corrected to source**, which is the direction a gather reads: every renderer here asks
 * where an output pixel comes from, never where a source pixel goes.
 */
export type Keystone = [number, number, number, number, number, number, number, number];

type Vec3 = [number, number, number];
type Mat3 = [number, number, number, number, number, number, number, number, number];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const multiply = (a: Mat3, b: Mat3): Mat3 => {
  const out = Array.from<number>({ length: 9 }).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += a[row * 3 + k]! * b[k * 3 + column]!;
      out[row * 3 + column] = sum;
    }
  }
  return out as Mat3;
};

const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1];

const apply = (m: Mat3, p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
  m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
  m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
];

function invert(m: Mat3): Mat3 | null {
  const a = m[4] * m[8] - m[5] * m[7];
  const b = m[5] * m[6] - m[3] * m[8];
  const c = m[3] * m[7] - m[4] * m[6];
  const determinant = m[0] * a + m[1] * b + m[2] * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const inverse = 1 / determinant;
  return [
    a * inverse,
    (m[2] * m[7] - m[1] * m[8]) * inverse,
    (m[1] * m[5] - m[2] * m[4]) * inverse,
    b * inverse,
    (m[0] * m[8] - m[2] * m[6]) * inverse,
    (m[2] * m[3] - m[0] * m[5]) * inverse,
    c * inverse,
    (m[1] * m[6] - m[0] * m[7]) * inverse,
    (m[0] * m[4] - m[1] * m[3]) * inverse,
  ];
}

/** Whether a line is more down the picture than across it, which is the pair it belongs to. */
export function isUpright(guide: KeystoneGuide): boolean {
  return Math.abs(guide.y2 - guide.y1) >= Math.abs(guide.x2 - guide.x1);
}

/** Where two lines meet, as a homogeneous point - `w` of zero being "they already are parallel". */
function meeting(a: Vec3, b: Vec3): Vec3 {
  return cross(a, b);
}

const lineThrough = (guide: KeystoneGuide, width: number, height: number): Vec3 =>
  cross(
    [guide.x1 * width, guide.y1 * height, 1],
    [guide.x2 * width, guide.y2 * height, 1],
  );

/**
 * The correction two or four guides ask for, or null where they ask for nothing.
 *
 * Null rather than the identity, and the caller stores the null: "no keystone" has to be a
 * state the document can hold, or a photo nobody has corrected would carry a matrix that a
 * later change of convention could reinterpret.
 *
 * Null also covers the degenerate answers, which are reachable by hand: two guides the reader
 * left parallel name a vanishing point at infinity and a correction of nothing, and guides
 * crossing *inside* the frame name a horizon through the picture, where the map would fold the
 * frame through itself and show it mirrored.
 */
export function keystoneFromGuides(
  guides: readonly KeystoneGuide[],
  frame: { width: number; height: number },
): Keystone | null {
  const { width, height } = frame;
  if (width <= 0 || height <= 0) return null;

  const upright = guides.filter(isUpright).map((guide) => lineThrough(guide, width, height));
  const level = guides.filter((guide) => !isUpright(guide)).map((guide) => lineThrough(guide, width, height));

  // The horizon: through both vanishing points where the reader gave both pairs, and through
  // the one they did give otherwise. A single pair fixes a single axis, and the direction it
  // must leave alone is the point at infinity of the other one.
  let horizon: Vec3;
  if (upright.length >= 2 && level.length >= 2) {
    horizon = cross(meeting(upright[0]!, upright[1]!), meeting(level[0]!, level[1]!));
  } else if (upright.length >= 2) {
    horizon = cross(meeting(upright[0]!, upright[1]!), [1, 0, 0]);
  } else if (level.length >= 2) {
    horizon = cross(meeting(level[0]!, level[1]!), [0, 1, 0]);
  } else {
    return null;
  }

  // Scaled by the frame, so the comparison is "how far outside the picture is the horizon"
  // rather than a bare number whose size depends on the units above.
  const reach = Math.hypot(horizon[0] * width, horizon[1] * height);
  if (!Number.isFinite(reach) || Math.abs(horizon[2]) < 1e-9 || reach / Math.abs(horizon[2]) < 1e-6) {
    return null;
  }
  // **About the middle of the picture, not the corner the pixel grid happens to start at.**
  //
  // `x/w` written about the origin fixes that origin and nothing else, and every other point
  // moves relative to it - so with the origin in the top-left the correction comes out with a
  // shear in it. A symmetric leaning building, corrected, ended up leaning 16 degrees as a
  // rigid block: its two edges parallel, which is all the reader asked for and all a
  // parallelism test can see, and the whole thing tilted. Centred, the map's derivative at the
  // middle of the frame is exactly the identity - no shear and no stretch there - and what is
  // left either side of it is the perspective the reader actually asked to have corrected.
  const centre = { x: width / 2, y: height / 2 };
  // The same horizon, said in coordinates measured from the centre: a line travels by the
  // transpose of the map its points travel by, which for a translation is this.
  const middle = horizon[0] * centre.x + horizon[1] * centre.y + horizon[2];
  if (!(Math.abs(middle) > 1e-12)) return null;
  const rectify = multiply(
    translate(centre.x, centre.y),
    multiply(
      [1, 0, 0, 0, 1, 0, horizon[0] / middle, horizon[1] / middle, 1],
      translate(-centre.x, -centre.y),
    ),
  );

  const corners: Vec3[] = [
    [0, 0, 1],
    [width, 0, 1],
    [width, height, 1],
    [0, height, 1],
  ];
  const moved: { x: number; y: number }[] = [];
  for (const corner of corners) {
    const at = apply(rectify, corner);
    // A corner on the far side of the horizon comes back with a negative weight: the map has
    // folded the frame through the line it sends to infinity, and no scaling recovers that.
    if (!(at[2] > 1e-9)) return null;
    moved.push({ x: at[0] / at[2], y: at[1] / at[2] });
  }

  const left = Math.min(...moved.map((p) => p.x));
  const right = Math.max(...moved.map((p) => p.x));
  const top = Math.min(...moved.map((p) => p.y));
  const bottom = Math.max(...moved.map((p) => p.y));
  if (!(right > left) || !(bottom > top)) return null;

  // **Fitted, not filled, and uniform.** The correction stretches one end of the picture and
  // squeezes the other, so its bounding box is a different shape from the frame; scaling each
  // axis to fill would undo part of the correction by re-stretching it. Fitting keeps every
  // pixel the reader corrected on screen, with the blank wedges a perspective correction always
  // leaves - which is what the crop tool is for.
  const scale = Math.min(width / (right - left), height / (bottom - top));
  const fit: Mat3 = [
    scale,
    0,
    width / 2 - scale * (left + right) / 2,
    0,
    scale,
    height / 2 - scale * (top + bottom) / 2,
    0,
    0,
    1,
  ];

  const inverse = invert(multiply(fit, rectify));
  if (inverse == null) return null;

  // Into fractions of the frame: `diag(w, h)` on the way in, its inverse on the way out. The
  // matrix then says the same thing about an 800px tile and a 61MP native rendition, which is
  // what lets one document drive both.
  const scaled = multiply(
    multiply([1 / width, 0, 0, 0, 1 / height, 0, 0, 0, 1], inverse),
    [width, 0, 0, 0, height, 0, 0, 0, 1],
  );
  if (!scaled.every((value) => Number.isFinite(value)) || Math.abs(scaled[8]) < 1e-12) return null;
  const normalised = scaled.map((value) => value / scaled[8]) as Mat3;
  return normalised.slice(0, 8) as Keystone;
}

/** Where a corrected point comes from, as fractions. The renderers' map, for tests and the UI. */
export function keystoneAt(keystone: Keystone, x: number, y: number): { x: number; y: number } {
  const w = keystone[6] * x + keystone[7] * y + 1;
  return {
    x: (keystone[0] * x + keystone[1] * y + keystone[2]) / w,
    y: (keystone[3] * x + keystone[4] * y + keystone[5]) / w,
  };
}

/**
 * Where a point of the source ends up, which is the correction as the reader sees it happen.
 *
 * The other direction from everything that renders, and only the overlay wants it: it draws
 * the guides where the corrected picture put them. Null where the matrix cannot be inverted,
 * which `keystoneFromGuides` does not produce but a document from elsewhere could.
 */
export function keystoneShows(keystone: Keystone, x: number, y: number): { x: number; y: number } | null {
  const forward = invert([...keystone, 1] as Mat3);
  if (forward == null) return null;
  const at = apply(forward, [x, y, 1]);
  if (Math.abs(at[2]) < 1e-12) return null;
  return { x: at[0] / at[2], y: at[1] / at[2] };
}

/**
 * The line `a`-`b` after the correction, as `[a, b, c]` of `ax + by + c = 0`.
 *
 * A line does not travel the way a point does: with the matrix reading corrected back to
 * source, a source line arrives by transposing it, and no inverse is needed. Two lines are
 * parallel exactly when the point they meet at has a zero weight, which is what makes this the
 * honest way to ask whether the correction did what it was asked.
 */
export function keystonedLine(keystone: Keystone, guide: KeystoneGuide): Vec3 {
  const line = cross([guide.x1, guide.y1, 1], [guide.x2, guide.y2, 1]);
  const m = [...keystone, 1] as Mat3;
  return [
    m[0] * line[0] + m[3] * line[1] + m[6] * line[2],
    m[1] * line[0] + m[4] * line[1] + m[7] * line[2],
    m[2] * line[0] + m[5] * line[1] + m[8] * line[2],
  ];
}
