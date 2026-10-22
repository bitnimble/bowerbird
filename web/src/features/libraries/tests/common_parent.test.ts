import { describe, expect, test } from 'bun:test';
import { commonParent } from '../common_parent';

describe('commonParent', () => {
  test('is the folder the libraries share', () => {
    expect(commonParent(['/pictures/A', '/pictures/B'])).toBe('/pictures');
    expect(commonParent(['/pictures/2024/A', '/pictures/2024/B', '/pictures/2025/C'])).toBe(
      '/pictures',
    );
  });

  test('is the parent of a root that every library sits under, wherever it comes in the list', () => {
    expect(commonParent(['/pictures/A'])).toBe('/pictures');
    expect(commonParent(['/pictures', '/pictures/2024'])).toBe('/');
    expect(commonParent(['/pictures/2024', '/pictures'])).toBe('/');
    expect(commonParent(['/pictures/2024/A', '/pictures/2025', '/pictures'])).toBe('/');
  });

  test('is the filesystem root when the libraries share nothing', () => {
    expect(commonParent(['/pictures/A', '/mnt/scans'])).toBe('/');
  });

  test('is nothing to go on when there are no libraries', () => {
    expect(commonParent([])).toBeUndefined();
    expect(commonParent(['/'])).toBeUndefined();
  });
});
