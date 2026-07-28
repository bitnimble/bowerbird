import { describe, expect, test } from 'bun:test';
import { applyColour, applyMatchProfile, deltaE76, fitMatchProfile, fitProfileFor } from '../../src/services/processing/jpeg_match';
import { SPLINE_UNIT } from '../../src/services/processing/lens_corrections';
import {
  decodeEmbedded,
  decodeRawImage,
  encodeJpeg,
  freeImage,
  imageFromRgb,
  pixels,
  readDistortionSpline,
  renderImage,
  type ImageHandle,
} from '../../src/services/processing/rawshim_ops';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const TIMEOUT = 120_000;

/** The handle's pixels, with the handle released. */
function take(image: ImageHandle): { width: number; height: number; data: Buffer } {
  try {
    return { width: image.width, height: image.height, data: pixels(image) };
  } finally {
    freeImage(image);
  }
}

describe('lens correction metadata', () => {
  test('reads the ILCE-6300 distortion spline out of a real ARW', () => {
    // Through the shim, because the parser lives in Rust now (native/.../lens.rs).
    // Its own tests use synthetic TIFFs, which cannot catch a wrong assumption
    // about how Sony actually nests this; only a real file can.
    const knots = readDistortionSpline(FIXTURE);
    expect(knots).not.toBeNull();
    // This body writes 11 knots, not the ILCE-7CR's 16.
    expect(knots!.length).toBe(11);
    // Anchored at zero in the centre, and a small correction on a 50mm prime.
    expect(Math.abs(knots![0]!)).toBeLessThanOrEqual(2);
    expect(knots![knots!.length - 1]! / SPLINE_UNIT).toBeCloseTo(-0.0029, 3);
  });
});

describe('fitMatchProfile', () => {
  test(
    'matches the camera JPEG far more closely than the raw render does',
    async () => {
      const profile = await fitMatchProfile(FIXTURE);
      expect(profile).not.toBeNull();

      // Held out inside the fit, so this is not a training score.
      expect(profile!.deltaE).toBeLessThan(2.5);

      // What the render looks like before any transform, on the same pixels, to
      // show the fit is doing the work rather than the metric being generous.
      const jpeg = take(decodeEmbedded(FIXTURE, 400)!);
      const plain = take(renderImage(decodeRawImage(FIXTURE, 8, 'srgb', 400), null, 400));
      // Both fitted to the same long edge, and the render and its own embedded
      // preview share an aspect, so this is a like-for-like comparison.
      expect([plain.width, plain.height]).toEqual([jpeg.width, jpeg.height]);

      let before = 0;
      let after = 0;
      let counted = 0;
      for (let i = 0; i < plain.data.length; i += 3 * 37) {
        const target = [jpeg.data[i]!, jpeg.data[i + 1]!, jpeg.data[i + 2]!];
        const source = [plain.data[i]!, plain.data[i + 1]!, plain.data[i + 2]!];
        before += deltaE76(source, target);
        after += deltaE76(applyColour(profile!.colour, source), target);
        counted += 1;
      }
      expect(counted).toBeGreaterThan(100);
      expect(after / counted).toBeLessThan(before / counted);
    },
    TIMEOUT,
  );

  test(
    'recovers a distortion that was injected on purpose',
    async () => {
      // The check this module exists to keep honest. Three earlier detectors
      // reported "no distortion" on a frame that had 4.4% of it, because a radial
      // model and a radial error will always find each other and a null result
      // looks the same as no sensitivity. So: warp the camera's JPEG by a known
      // amount, hand it back as the target, and require the fit to notice.
      const upright = take(decodeEmbedded(FIXTURE)!);
      const { width, height } = upright;

      // A 3% centre-to-corner pincushion, applied by resampling the JPEG.
      const K1 = 0.03;
      const distorted = Buffer.allocUnsafe(width * height * 3);
      const half = Math.hypot(width / 2, height / 2);
      for (let y = 0; y < height; y += 1) {
        const dy = (y - height / 2) / half;
        for (let x = 0; x < width; x += 1) {
          const dx = (x - width / 2) / half;
          const factor = 1 + K1 * (dx * dx + dy * dy);
          const px = width / 2 + dx * factor * half;
          const py = height / 2 + dy * factor * half;
          const o = (y * width + x) * 3;
          if (px < 0 || py < 0 || px >= width - 1 || py >= height - 1) {
            distorted[o] = 0;
            distorted[o + 1] = 0;
            distorted[o + 2] = 0;
            continue;
          }
          const x0 = Math.floor(px);
          const y0 = Math.floor(py);
          const fx = px - x0;
          const fy = py - y0;
          const i00 = (y0 * width + x0) * 3;
          const i01 = i00 + width * 3;
          for (let c = 0; c < 3; c += 1) {
            distorted[o + c] =
              upright.data[i00 + c]! * (1 - fx) * (1 - fy) +
              upright.data[i00 + 3 + c]! * fx * (1 - fy) +
              upright.data[i01 + c]! * (1 - fx) * fy +
              upright.data[i01 + 3 + c]! * fx * fy;
          }
        }
      }
      const injected = imageFromRgb(distorted, width, height);
      let target: Buffer;
      try {
        target = encodeJpeg(injected, 0, 95);
      } finally {
        freeImage(injected);
      }

      // Null knots force the fitted path: the question is whether the search finds
      // a displacement, not whether it can read one.
      const render = decodeRawImage(FIXTURE, 8, 'srgb', 0);
      let fitted;
      try {
        fitted = fitProfileFor(render, target, null);
      } finally {
        freeImage(render);
      }
      expect(fitted).not.toBeNull();
      expect(fitted!.distortionSource).toBe('fitted');

      // The target samples outward, so the map from target back to render carries
      // the same sign as the injected coefficient. Compare centre-to-corner
      // displacement rather than raw coefficients, since crop and knots trade off.
      const knots = fitted!.distortion!;
      const recovered = (knots[knots.length - 1]! - knots[0]!) / SPLINE_UNIT;
      expect(recovered).toBeGreaterThan(K1 / 2);
      expect(recovered).toBeLessThan(K1 * 2);
    },
    TIMEOUT,
  );

  test(
    'fits the same profile twice, so renditions built at different times agree',
    async () => {
      // Load-bearing: the profile is deliberately not stored anywhere. The grid and
      // the full view are fitted in one job, but the max-resolution export is built
      // on demand later and refits from scratch. If the fit were not deterministic
      // those two copies of one photo would be graded differently, and the only
      // remedy would be persisting the profile.
      const first = await fitMatchProfile(FIXTURE);
      const second = await fitMatchProfile(FIXTURE);
      expect(first).not.toBeNull();
      expect(second!.deltaE).toBe(first!.deltaE);
      expect(second!.crop).toBe(first!.crop);
      expect(second!.distortionSource).toBe(first!.distortionSource);
      expect(second!.distortion).toEqual(first!.distortion);
      expect(second!.colour.matrix).toEqual(first!.colour.matrix);
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Array.from(second!.colour.curves[channel]!)).toEqual(Array.from(first!.colour.curves[channel]!));
      }
    },
    TIMEOUT,
  );

  test(
    'gives the same picture whether applied before or after the resize',
    async () => {
      // The worker applies the profile to the *sized* image, because warping a
      // 60MP decode to produce an 800px tile costs seconds per rendition. That is
      // only legitimate if the order does not matter: the distortion model is in
      // normalised radii and the colour transform is a per-pixel lookup, so it
      // should not. This is the check on that reasoning.
      const profile = (await fitMatchProfile(FIXTURE))!;
      const render = decodeRawImage(FIXTURE, 8, 'srgb', 0);
      const SIZE = 800;

      let beforeResize: ReturnType<typeof take>;
      let afterResize: ReturnType<typeof take>;
      try {
        const graded = applyMatchProfile(render, profile);
        try {
          beforeResize = take(renderImage(graded, null, SIZE));
        } finally {
          freeImage(graded);
        }
        afterResize = take(renderImage(render, profile, SIZE));
      } finally {
        freeImage(render);
      }

      expect(afterResize.width).toBe(beforeResize.width);
      expect(afterResize.height).toBe(beforeResize.height);
      let total = 0;
      let counted = 0;
      for (let i = 0; i < afterResize.data.length; i += 3) {
        total += deltaE76(
          [beforeResize.data[i]!, beforeResize.data[i + 1]!, beforeResize.data[i + 2]!],
          [afterResize.data[i]!, afterResize.data[i + 1]!, afterResize.data[i + 2]!],
        );
        counted += 1;
      }
      // Resampling order still moves a few edge pixels, so this is "the same
      // picture", not "the same bytes".
      expect(total / counted).toBeLessThan(1);
    },
    TIMEOUT,
  );

  test(
    'applying a profile leaves the render the same size and shape',
    async () => {
      const profile = await fitMatchProfile(FIXTURE);
      const handle = decodeRawImage(FIXTURE, 8, 'srgb', 0);
      let render: ReturnType<typeof take>;
      let corrected: ReturnType<typeof take>;
      try {
        corrected = take(applyMatchProfile(handle, profile!));
        render = { width: handle.width, height: handle.height, data: pixels(handle) };
      } finally {
        freeImage(handle);
      }
      expect(corrected.width).toBe(render.width);
      expect(corrected.height).toBe(render.height);
      expect(corrected.data.length).toBe(render.data.length);
      // A transform that returned the render untouched would pass every size
      // assertion above while doing nothing.
      expect(corrected.data.equals(render.data)).toBe(false);
    },
    TIMEOUT,
  );
});
