// Half-size decoding is a real quality trade - a faint checkerboard on dark edges
// - bought for about 40% of the decode. It is only acceptable where the halved
// frame still exceeds what is being built, so the gate is the whole feature.
//   docker exec bowerbird-dev bun test test/integration
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { decodeRaw } from '../../src/services/processing/raw_decoder';

// The fixture is 24MP, which is below the threshold by design, so the halving side
// needs a sensor big enough to halve. There is no committed fixture that large - a
// 61MP RAW is ~70MB - so those cases run against a real library when one is present
// and skip otherwise, rather than failing on a fresh checkout.
const BIG = `${import.meta.dir}/../../.photos/Test/DSC03451.ARW`; // 61MP
const SMALL = `${import.meta.dir}/../fixtures/DSC02981.ARW`; // 24MP
const FULL_RENDITION = 3840;
const TIMEOUT = 120_000;
const withBig = test.skipIf(!existsSync(BIG));

const longEdge = (image: { width: number; height: number }): number => Math.max(image.width, image.height);

describe('half-size decoding', () => {
  withBig(
    'halves a 61MP frame, because 4864 still clears a 3840 rendition',
    async () => {
      const whole = decodeRaw(BIG, 8, 'srgb');
      const halved = decodeRaw(BIG, 8, 'srgb', { atLeastLongEdge: FULL_RENDITION });
      expect(longEdge(halved)).toBeLessThan(longEdge(whole));
      expect(longEdge(halved)).toBeGreaterThanOrEqual(FULL_RENDITION);
      // Close to exactly half; LibRaw rounds and the masked-border crop is halved
      // alongside, so this is not an equality.
      expect(longEdge(halved) / longEdge(whole)).toBeGreaterThan(0.45);
      expect(longEdge(halved) / longEdge(whole)).toBeLessThan(0.55);
      // Aspect must survive the halving, or the crop insets were scaled wrongly and
      // the frame is stretched.
      expect(halved.width / halved.height).toBeCloseTo(whole.width / whole.height, 2);
    },
    TIMEOUT,
  );

  test(
    'leaves a 24MP frame alone, because halving it would fall short',
    async () => {
      // 6024 halves to about 3012, under the 3840 a full rendition wants, so
      // asking for that size must not get a half decode.
      const whole = decodeRaw(SMALL, 8, 'srgb');
      const asked = decodeRaw(SMALL, 8, 'srgb', { atLeastLongEdge: FULL_RENDITION });
      expect(longEdge(asked)).toBe(longEdge(whole));
      expect(asked.width).toBe(whole.width);
      expect(asked.height).toBe(whole.height);
    },
    TIMEOUT,
  );

  withBig(
    'never halves when the caller needs native resolution',
    async () => {
      // A max-resolution rendition passes 0, which has to mean "the whole frame"
      // rather than "no constraint, do as you like".
      const whole = decodeRaw(BIG, 8, 'srgb');
      for (const options of [{}, { atLeastLongEdge: 0 }]) {
        const image = decodeRaw(BIG, 8, 'srgb', options);
        expect(image.width).toBe(whole.width);
        expect(image.height).toBe(whole.height);
      }
    },
    TIMEOUT,
  );

  withBig(
    'produces a sane picture, not a misplaced struct write',
    async () => {
      // The half_size flag is written into LibRaw's params by a runtime-located
      // offset. A wrong address would land on a neighbouring field - four_color_rgb
      // and use_auto_wb are both nearby - so this checks the result still looks
      // like the same photograph rather than only checking its dimensions.
      const halved = decodeRaw(BIG, 8, 'srgb', { atLeastLongEdge: FULL_RENDITION });
      const whole = decodeRaw(BIG, 8, 'srgb');

      const mean = (image: { width: number; height: number; data: Buffer }): [number, number, number] => {
        const totals = [0, 0, 0];
        let counted = 0;
        for (let i = 0; i + 2 < image.data.length; i += 3 * 997) {
          totals[0]! += image.data[i]!;
          totals[1]! += image.data[i + 1]!;
          totals[2]! += image.data[i + 2]!;
          counted += 1;
        }
        return [totals[0]! / counted, totals[1]! / counted, totals[2]! / counted];
      };

      const a = mean(whole);
      const b = mean(halved);
      // Same exposure and same white balance: a stray write to use_auto_wb or
      // four_color_rgb would move these well beyond a few levels.
      for (let channel = 0; channel < 3; channel += 1) {
        expect(Math.abs(a[channel]! - b[channel]!)).toBeLessThan(6);
      }
    },
    TIMEOUT,
  );
});
