import { expect, test } from 'bun:test';
import { DETAIL, LIGHT, sliderValue, snapped } from '../edit_sliders';

test('following slider previews and commits keep following at the snapped neutral', () => {
  for (const [spec, measured] of [
    [DETAIL[0]!, 24.2],
    [DETAIL[1]!, 75.8],
  ] as const) {
    const neutral = snapped(measured, spec);
    expect(sliderValue(neutral, spec, neutral)).toBeNull();
    expect(sliderValue(neutral + spec.step, spec, neutral)).toBe(neutral + spec.step);
  }
  const sharpening = DETAIL.find((spec) => spec.key === 'sharpening')!;
  expect(sliderValue(35, sharpening, 35)).toBeNull();
  expect(sliderValue(50, sharpening, 35)).toBe(50);
  expect(sliderValue(0, LIGHT[0]!, 0)).toBe(0);
  expect(sliderValue(0, LIGHT[1]!, 0)).toBe(0);
});
