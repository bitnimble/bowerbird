import { describe, expect, test } from 'bun:test';
import { newLibraryStart } from '../new_library_start';

describe('newLibraryStart', () => {
  test('is the folder the libraries share', () => {
    expect(newLibraryStart(['/photos/A', '/photos/B'])).toBe('/photos');
    expect(newLibraryStart(['/photos/2024/A', '/photos/2024/B', '/photos/2025/C'])).toBe('/photos');
  });

  test('is the parent of a root that every library sits under, wherever it comes in the list', () => {
    expect(newLibraryStart(['/photos/A'])).toBe('/photos');
    expect(newLibraryStart(['/photos', '/photos/2024'])).toBe('/');
    expect(newLibraryStart(['/photos/2024', '/photos'])).toBe('/');
    expect(newLibraryStart(['/photos/2024/A', '/photos/2025', '/photos'])).toBe('/');
  });

  test('is the filesystem root when the libraries share nothing', () => {
    expect(newLibraryStart(['/photos/A', '/mnt/scans'])).toBe('/');
  });

  test('is nothing to go on when there are no libraries', () => {
    expect(newLibraryStart([])).toBeUndefined();
    expect(newLibraryStart(['/'])).toBeUndefined();
  });
});
