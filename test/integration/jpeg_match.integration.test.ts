import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { applyColour, applyMatchProfile, deltaE76, fitMatchProfile, fitProfileFor } from '../../src/services/processing/jpeg_match';
import { readDistortionSpline, SPLINE_UNIT } from '../../src/services/processing/lens_corrections';
import { decodeRaw, readEmbeddedJpeg } from '../../src/services/processing/raw_decoder';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
const TIMEOUT = 120_000;

describe('lens correction metadata', () => {
  test('reads the ILCE-6300 distortion spline out of a real ARW', async () => {
    const knots = readDistortionSpline(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
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
      const jpegBytes = readEmbeddedJpeg(FIXTURE)!;
      const jpeg = await sharp(jpegBytes).rotate().resize(400, 400, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
      const render = decodeRaw(FIXTURE, 8, 'srgb');
      const plain = await sharp(render.data, { raw: { width: render.width, height: render.height, channels: 3 } })
        .resize(jpeg.info.width, jpeg.info.height, { fit: 'fill' })
        .raw()
        .toBuffer();

      let before = 0;
      let after = 0;
      let counted = 0;
      for (let i = 0; i < plain.length; i += 3 * 37) {
        const target = [jpeg.data[i]!, jpeg.data[i + 1]!, jpeg.data[i + 2]!];
        const source = [plain[i]!, plain[i + 1]!, plain[i + 2]!];
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
      const jpegBytes = readEmbeddedJpeg(FIXTURE)!;
      const upright = await sharp(jpegBytes).rotate().raw().toBuffer({ resolveWithObject: true });
      const { width, height } = upright.info;

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
      const target = await sharp(distorted, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();

      // Empty rawBytes forces the fitted path: the question is whether the search
      // finds a displacement, not whether it can read one.
      const fitted = await fitProfileFor(decodeRaw(FIXTURE, 8, 'srgb'), target, new Uint8Array(0));
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
      const render = decodeRaw(FIXTURE, 8, 'srgb');
      const raw = { raw: { width: render.width, height: render.height, channels: 3 } };
      const SIZE = 800;

      const applied = await applyMatchProfile(render, profile);
      const beforeResize = await sharp(applied.data, {
        raw: { width: applied.width, height: applied.height, channels: 3 },
      })
        .resize(SIZE, SIZE, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const sized = await sharp(render.data, raw).resize(SIZE, SIZE, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
      const afterResize = await applyMatchProfile(
        { width: sized.info.width, height: sized.info.height, channels: 3, depth: 8, data: sized.data },
        profile,
      );

      expect(afterResize.width).toBe(beforeResize.info.width);
      expect(afterResize.height).toBe(beforeResize.info.height);
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
      const render = decodeRaw(FIXTURE, 8, 'srgb');
      const corrected = await applyMatchProfile(render, profile!);
      expect(corrected.width).toBe(render.width);
      expect(corrected.height).toBe(render.height);
      expect(corrected.depth).toBe(8);
      expect(corrected.data.length).toBe(render.data.length);
      // A transform that returned the render untouched would pass every size
      // assertion above while doing nothing.
      expect(corrected.data.equals(render.data)).toBe(false);
    },
    TIMEOUT,
  );
});
