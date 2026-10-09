import { expect, test } from 'bun:test';
import { sharpeningOf } from '../sharpening';

test("an unset sharpening is the denoiser's default, and a set one is kept", () => {
  expect(sharpeningOf(null, 'galosh')).toBe(50);
  expect(sharpeningOf(null, 'pmrid')).toBe(50);
  expect(sharpeningOf(null, 'upscaler')).toBe(35);
  expect(sharpeningOf(80, 'upscaler')).toBe(80);
  expect(sharpeningOf(0, 'upscaler')).toBe(0);
});
