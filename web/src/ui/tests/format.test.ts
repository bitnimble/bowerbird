import { expect, test } from 'bun:test';
import { fileSizeLabel } from '../format';

test('formats disk usage from empty storage through terabytes', () => {
  expect(fileSizeLabel(0)).toBe('0 KB');
  expect(fileSizeLabel(512 * 1024)).toBe('512 KB');
  expect(fileSizeLabel(1.5 * 1024 ** 2)).toBe('1.5 MB');
  expect(fileSizeLabel(2.5 * 1024 ** 3)).toBe('2.5 GB');
  expect(fileSizeLabel(3.5 * 1024 ** 4)).toBe('3.5 TB');
});
