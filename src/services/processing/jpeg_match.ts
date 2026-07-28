// Deriving, per photo, the transform that makes a RAW render look like the
// camera's own JPEG - the maker's colour treatment and whichever picture profile
// the photographer had set, without hosting any profile of our own.
//
// The search itself is in Rust (`native/rawshim/src/fit.rs`), because it is one
// job: it evaluates tens of candidate geometries, each of which warps, blurs,
// pairs and solves, and running any part of that from here meant crossing the FFI
// boundary inside the loop. What stays on this side is what the search needs from
// the file - the camera's recorded distortion spline, which is plain TIFF parsing
// - and the reporting the result is judged by.
//
// Order matters and is not negotiable, and it is the reason the module is shaped
// this way: geometry first, colour second. A colour transform is fitted from pixel
// pairs, and a pair means nothing unless both pixels show the same point in the
// scene. On a frame whose JPEG is distortion-corrected, fitting colour first
// plateaus at deltaE 16 no matter how much capacity the colour model is given -
// including a 33^3 LUT - because no tone curve can map a pixel onto a different
// pixel's colour.
//
// Geometry comes from the camera where it recorded it (`lens_corrections.ts`) and
// is fitted otherwise, which is the common case: 14 of 20 Sony bodies measured
// record nothing. Colour is always fitted, since nothing in the file describes the
// picture profile.

import { readDistortionSpline } from './lens_corrections';
import { readEmbeddedJpeg } from './raw_decoder';
import { decodeRawImage, fitProfile, freeImage, renderImage, type ColourTransform, type FittedProfile, type ImageHandle } from './rawshim_ops';

/**
 * The fitted transform, geometry and colour together.
 *
 * Carries the flattened struct the fit produced, so applying it is one call back
 * into Rust rather than a reconstruction: the readable fields are for reporting
 * and for tests, not for re-deriving the transform here.
 */
export type MatchProfile = FittedProfile;

function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Fits the transform that takes a render of `rawFilePath` to its embedded JPEG.
 *
 * Null when the file has no embedded JPEG to match, or when the best match is
 * still too far off to be worth applying - in which case the caller renders
 * untransformed rather than shipping a bad grade.
 *
 * `render` is the caller's own 8-bit sRGB decode of the same file. Pass it
 * whenever one is already in hand: decoding a 60MP frame costs about two seconds,
 * which is a large share of the whole fit, and doing it again here would be for an
 * identical result.
 */
export async function fitMatchProfile(rawFilePath: string, render?: ImageHandle): Promise<MatchProfile | null> {
  const jpegBytes = readEmbeddedJpeg(rawFilePath);
  if (!jpegBytes) return null;
  const rawBytes = new Uint8Array(await Bun.file(rawFilePath).arrayBuffer());
  if (render != null) return fitProfileFor(render, jpegBytes, rawBytes);

  const own = decodeRawImage(rawFilePath, 8, 'srgb', 0);
  try {
    return fitProfileFor(own, jpegBytes, rawBytes);
  } finally {
    freeImage(own);
  }
}

/**
 * The fit itself, separated from reading the file so a test can hand it a target
 * it constructed. `rawBytes` supplies the camera's recorded correction; pass an
 * empty array to exercise the fitted fallback.
 */
export function fitProfileFor(render: ImageHandle, jpegBytes: Buffer, rawBytes: Uint8Array): MatchProfile | null {
  if (render.depth !== 8) throw new Error(`the fit needs an 8-bit render, got ${render.depth}`);
  return fitProfile(render, jpegBytes, readDistortionSpline(rawBytes));
}

/**
 * Applies a fitted profile to a render, at the size it arrived at.
 *
 * The caller owns the returned handle. A rendition wants `renderImage` instead,
 * which fits to a size and grades in one call.
 */
export function applyMatchProfile(image: ImageHandle, profile: MatchProfile): ImageHandle {
  if (image.depth !== 8) throw new Error(`applyMatchProfile needs an 8-bit render, got ${image.depth}`);
  return renderImage(image, profile, 0);
}

/** The colour half of a profile, for one pixel. For reporting; renders go through Rust. */
export function applyColour(transform: ColourTransform, rgb: readonly number[]): [number, number, number] {
  const { curves, matrix } = transform;
  const r = curves[0][clamp8(Math.round(rgb[0]!))]!;
  const g = curves[1][clamp8(Math.round(rgb[1]!))]!;
  const b = curves[2][clamp8(Math.round(rgb[2]!))]!;
  return [
    clamp8(matrix[0]![0]! * r + matrix[0]![1]! * g + matrix[0]![2]! * b),
    clamp8(matrix[1]![0]! * r + matrix[1]![1]! * g + matrix[1]![2]! * b),
    clamp8(matrix[2]![0]! * r + matrix[2]![1]! * g + matrix[2]![2]! * b),
  ];
}

// ------------------------------------------------------------------------ deltaE

function toLinear(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function toLab(rgb: readonly number[]): [number, number, number] {
  const r = toLinear(rgb[0]!);
  const g = toLinear(rgb[1]!);
  const b = toLinear(rgb[2]!);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fy = f(y);
  return [116 * fy - 16, 500 * (f(x) - fy), 200 * (fy - f(z))];
}

/** How the two fits report, and the only measure they report comparably in. */
export function deltaE76(a: readonly number[], b: readonly number[]): number {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
