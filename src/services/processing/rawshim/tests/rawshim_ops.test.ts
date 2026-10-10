import { expect, test } from 'bun:test';
import path from 'node:path';
import { isUpscalable } from '../rawshim_ops';

const FIXTURES = path.join(import.meta.dir, '../../../../../test/fixtures');

test('the upscaler takes a Bayer RAW, and neither an X-Trans one nor a file it cannot read', () => {
  expect(isUpscalable(path.join(FIXTURES, 'DSC02981.ARW'))).toBe(true);
  expect(isUpscalable(path.join(FIXTURES, 'AFXT2721.RAF'))).toBe(false);
  expect(isUpscalable(path.join(FIXTURES, 'missing.ARW'))).toBe(false);
});
