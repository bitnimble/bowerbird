import { expect, test } from 'bun:test';
import { Fade } from '../fade';

test('moves to its target over its time, and turns back from wherever it is', () => {
  const fade = new Fade(100);
  expect(fade.at(0)).toBe(0);
  fade.toward(1, 1000);
  expect(fade.at(1000)).toBe(0);
  expect(fade.at(1025)).toBeCloseTo(0.25);
  fade.toward(0, 1050);
  expect(fade.at(1050)).toBeCloseTo(0.5);
  expect(fade.at(1100)).toBeCloseTo(0.25);
  expect(fade.at(1150)).toBe(0);
  expect(fade.at(5000)).toBe(0);
});
