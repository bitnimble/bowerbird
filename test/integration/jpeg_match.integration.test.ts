import { beforeAll, describe, expect, test } from 'bun:test';
import { SPLINE_UNIT } from '../../src/services/processing/lens_corrections';
import {
  readDistortionSpline,
  readHeaderFields,
  readLensfunKnots,
} from '../../src/services/processing/rawshim_ops';
import {
  compareRenders,
  fitInjected,
  fitSummary,
  matchAgainstPreview,
  type ProfileSummary,
} from '../../src/services/processing/rawshim_debug';

const FIXTURE = `${import.meta.dir}/../fixtures/DSC02981.ARW`;
/// A body that records no spline of its own, so the database is the only geometry.
const CANON_FIXTURE = `${import.meta.dir}/../fixtures/IMG_5360.CR3`;
const TIMEOUT = 120_000;

// A pure function of the file, so one serves every case that is not specifically
// about refitting.
let profile: ProfileSummary;

beforeAll(() => {
  profile = fitSummary(FIXTURE);
});

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

  test('resolves a third-party lens name against the lensfun database', () => {
    // The case the database exists for: a Canon body records no spline, and the
    // string it writes matches nothing exactly - "TAMRON SP 70-200mm F/2.8 Di VC
    // USD A009" against lensfun's "Tamron SP 70-200mm f/2.8 Di VC USD A009". Only
    // a real database can say whether the scored search still lands on it.
    const header = readHeaderFields(CANON_FIXTURE);
    const knots = readLensfunKnots(
      header.cameraMake!,
      header.cameraModel!,
      header.lensModel!,
      header.focalLength!,
      header.aperture!,
      header.width,
      header.height,
    );
    expect(knots).not.toBeNull();
    expect(knots!.length).toBe(16);
    expect(knots![0]).toBe(0);
    // Barely anything at 70mm, which is where this lens crosses over.
    expect(knots![15]! / SPLINE_UNIT).toBeCloseTo(-0.0024, 3);
  });

  test('refuses a lens the shot could not have been taken with', () => {
    // The guard that makes the scored search safe to trust: it returns everything
    // it scored above zero, so without a range check a 70-200 answers for a 24mm
    // frame and the render gets warped by a curve from the wrong lens.
    const header = readHeaderFields(CANON_FIXTURE);
    const knots = readLensfunKnots(
      header.cameraMake!,
      header.cameraModel!,
      header.lensModel!,
      24,
      2.8,
      header.width,
      header.height,
    );
    expect(knots).toBeNull();
  });

  test('never takes the database over a spline the body recorded', () => {
    // The order is measured, not assumed: over 83 Sony frames carrying both, the
    // spline beat lensfun 31 to 4, because a spline is recorded per shot and a
    // profile is one average of every copy of the lens. lensfun has this exact
    // lens, so nothing but the priority keeps it out.
    //
    // Not asserted as 'camera': this frame is a 50mm prime bent by 0.29% at the
    // corner, and correcting by that much does not beat leaving it alone, so the
    // fit correctly settles on no geometry at all. What must never happen is the
    // database being consulted behind the body's back.
    expect(profile.distortionSource).not.toBe('lensfun');
  });
});

describe('fitMatchProfile', () => {
  test(
    'matches the camera JPEG far more closely than the raw render does',
    () => {
      // Held out inside the fit, so this is not a training score.
      expect(profile.deltaE).toBeLessThan(2.5);

      // The render before any transform against the render with the colour half
      // applied, both measured against the camera's own preview - so the fit is
      // shown to be doing the work rather than the metric being generous.
      const { meanDeltaE, counted, sizes, preview } = matchAgainstPreview(FIXTURE, 400);
      // Both fitted to the same long edge, and the render and its own embedded
      // preview share an aspect, so this is a like-for-like comparison.
      expect(sizes[0]).toEqual(preview);
      expect(counted).toBeGreaterThan(100);
      const [before, after] = meanDeltaE;
      expect(after!).toBeLessThan(before!);
    },
    TIMEOUT,
  );

  test(
    'recovers a distortion that was injected on purpose',
    () => {
      // The check this module exists to keep honest. Three earlier detectors
      // reported "no distortion" on a frame that had 4.4% of it, because a radial
      // model and a radial error will always find each other and a null result
      // looks the same as no sensitivity. So: warp the camera's JPEG by a known
      // amount, hand it back as the target, and require the fit to notice.
      //
      // The warp runs natively, since the alternative is shipping the preview out
      // to be distorted here and the distorted copy back in. The fit is forced onto
      // its fitted path: the question is whether the search finds a displacement,
      // not whether it can read one off the file.
      const K1 = 0.03;
      const fitted = fitInjected(FIXTURE, K1);
      expect(fitted.distortionSource).toBe('fitted');

      // The target samples outward, so the map from target back to render carries
      // the same sign as the injected coefficient. Compare centre-to-corner
      // displacement rather than raw coefficients, since crop and knots trade off.
      const knots = fitted.distortion!;
      const recovered = (knots[knots.length - 1]! - knots[0]!) / SPLINE_UNIT;
      expect(recovered).toBeGreaterThan(K1 / 2);
      expect(recovered).toBeLessThan(K1 * 2);
    },
    TIMEOUT,
  );

  test(
    'fits the same profile twice, so renditions built at different times agree',
    () => {
      // Load-bearing: the profile is deliberately not stored anywhere. The grid and
      // the full view are fitted in one job, but the max-resolution export is built
      // on demand later and refits from scratch. If the fit were not deterministic
      // those two copies of one photo would be graded differently, and the only
      // remedy would be persisting the profile.
      //
      // Two genuinely separate fits, which is why `fitSummary` is the one call in
      // this module that is never memoised: a cache would answer both with the same
      // object and this test would pass without the fit being deterministic at all.
      const second = fitSummary(FIXTURE);
      expect(second.deltaE).toBe(profile.deltaE);
      expect(second.crop).toBe(profile.crop);
      expect(second.distortionSource).toBe(profile.distortionSource);
      expect(second.distortion).toEqual(profile.distortion);
      expect(second.matrix).toEqual(profile.matrix);
      expect(second.curves).toEqual(profile.curves);
    },
    TIMEOUT,
  );

  test(
    'gives the same picture whether applied before or after the resize',
    () => {
      // The worker applies the profile to the *sized* image, because warping a
      // 60MP decode to produce an 800px tile costs seconds per rendition. That is
      // only legitimate if the order does not matter: the distortion model is in
      // normalised radii and the colour transform is a per-pixel lookup, so it
      // should not. This is the check on that reasoning.
      const SIZE = 800;
      const compared = compareRenders(
        FIXTURE,
        { matched: true, size: SIZE, beforeResize: true },
        { matched: true, size: SIZE },
      );

      expect(compared.b).toEqual(compared.a);
      // Resampling order still moves a few edge pixels, so this is "the same
      // picture", not "the same bytes".
      expect(compared.meanDeltaE).toBeLessThan(1);
    },
    TIMEOUT,
  );

  /**
   * How far apart two fits put a corner pixel, in pixels of a 3840px-long-edge frame.
   *
   * A radial model scales a pixel's distance from centre by `crop * (1 + knot/SPLINE)`,
   * so the corner - where the spline's last knot applies and the lever is longest - is
   * where any disagreement is largest. Reducing both fits to that one number is what
   * makes them comparable when they took different routes: a tier, a knot count and a
   * crop are three ways of saying something the eye only ever sees as displacement.
   */
  const cornerGap = (a: ProfileSummary, b: ProfileSummary): number => {
    const scale = (p: ProfileSummary): number => p.crop * (1 + (p.distortion?.at(-1) ?? 0) / 16384);
    // Half-diagonal of a 3:2 frame at a 3840px long edge.
    const radius = Math.hypot(3840 / 2, 2560 / 2);
    return Math.abs(scale(a) - scale(b)) * radius;
  };

  // An HDR job wants only the geometry, and holds a scene-linear decode already, so it
  // fits off that rather than demosaicing the file a second time in 8-bit. The two
  // renders differ in tone - LibRaw auto-brightens its sRGB path where the linear one
  // is deliberately scene-referred - so what survives that has to be checked rather
  // than assumed.
  //
  // What is pinned is the match, not the route to it. The knots are exact where both
  // fits keep a curve, because those come off the file or the database rather than off
  // the pixels. The *tier* is deliberately not pinned: `fit.rs` keeps a known curve
  // only where it beats correcting nothing, and on IMG_5360 lensfun wins that by
  // 0.0028 deltaE76 - so any perturbation at all decides it, and the 8-bit fit takes
  // the curve where this one declines it. Both land within three thousandths of a
  // deltaE of the camera, which is what the fit is actually for; the tolerance below
  // is what says so.
  for (const [body, file] of [
    ['a body on the lensfun tier', CANON_FIXTURE],
    ['a body that corrected nothing', FIXTURE],
  ] as const) {
    test(
      `matches the camera as closely off either decode, on ${body}`,
      () => {
        const viaSdr = fitSummary(file, { size: 640 });
        const viaLinear = fitSummary(file, { viaLinear: true, size: 3840 });

        // The point of the fit: how close to the camera it lands. A render whose
        // tone was too far off to search against would show up here as a match that
        // is plainly worse, not as one that took a different road to the same place.
        expect(viaLinear.deltaE).toBeLessThan(viaSdr.deltaE + 0.1);

        // And how far apart the two geometries actually put the picture, which is
        // the thing that matters and the thing the tier is only a proxy for.
        //
        // Bounded rather than pinned, because on IMG_5360 the two land on opposite
        // sides of a decision worth 0.0028 deltaE76 - lensfun's curve barely beats
        // correcting nothing - and pinning the tier there pins a coin toss. What
        // must not happen is the two disagreeing by a lot, which is what a linear
        // fit that had quietly stopped resolving geometry at all would look like on
        // a body that needs it: an uncorrected 4.5% barrel is ~100px at this radius,
        // where the coin toss is 17.
        expect(cornerGap(viaSdr, viaLinear)).toBeLessThan(30);

        // Where both keep a curve it must be the same curve, since those knots are
        // read from the file or the database rather than fitted from pixels.
        if (viaLinear.distortion != null && viaSdr.distortion != null) {
          expect(viaLinear.distortion).toEqual(viaSdr.distortion);
          // The crop is scanned against the render, so it may land a hair apart.
          expect(Math.abs(viaLinear.crop - viaSdr.crop)).toBeLessThan(0.002);
        }
      },
      TIMEOUT,
    );
  }

  test(
    'applying a profile leaves the render the same size and shape',
    () => {
      const compared = compareRenders(FIXTURE, { matched: true }, {});
      expect(compared.a).toEqual(compared.b);
      // A transform that returned the render untouched would pass every size
      // assertion above while doing nothing.
      expect(compared.identical).toBe(false);
    },
    TIMEOUT,
  );
});
