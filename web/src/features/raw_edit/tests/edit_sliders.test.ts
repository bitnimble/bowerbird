import { expect, test } from 'bun:test';
import { DETAIL, LIGHT, sliderValue, snapped } from '../edit_sliders';

test('measured slider previews and commits keep following the camera at the snapped neutral', () => {
  for (const [spec, measured] of [[LIGHT[0]!, 0.347], [DETAIL[0]!, 24.2], [DETAIL[1]!, 75.8]] as const) {
    const neutral = snapped(measured, spec);
    expect(sliderValue(neutral, spec, neutral)).toBeNull();
    expect(sliderValue(neutral + spec.step, spec, neutral)).toBe(neutral + spec.step);
  }
  expect(sliderValue(0, LIGHT[1]!, 0)).toBe(0);
});
