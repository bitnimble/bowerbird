import { expect, test } from 'bun:test';
import { sharpenOf, sharpeningOf } from '../sharpening';

test("an unset sharpening is the denoiser's default, and a set one is kept", () => {
  expect(sharpeningOf(null, 'galosh')).toBe(50);
  expect(sharpeningOf(null, 'pmrid')).toBe(50);
  expect(sharpeningOf(null, 'upscaler')).toBe(35);
  expect(sharpeningOf(80, 'upscaler')).toBe(80);
  expect(sharpeningOf(0, 'upscaler')).toBe(0);
});

test('GALOSH sharpens 25 past its slider, so its default reads as sharp as Best at its own', () => {
  expect(sharpenOf(null, 'galosh')).toBe(0.75);
  expect(sharpenOf(0, 'galosh')).toBe(0.25);
  expect(sharpenOf(100, 'galosh')).toBe(1.25);
  expect(sharpenOf(null, 'upscaler')).toBe(0.35);
  expect(sharpenOf(null, 'pmrid')).toBe(0.5);
});
