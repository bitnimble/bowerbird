import { describe, it, expect } from 'bun:test';
import { foldersOutside, mostSpecificShoot, shootContains } from '../shoots';

describe('shootContains', () => {
  it('requires a trailing separator so NYC does not capture sibling NYC2', () => {
    expect(shootContains('NYC', 'NYC/a.arw')).toBe(true);
    expect(shootContains('NYC', 'NYC/Day1/a.arw')).toBe(true);
    expect(shootContains('NYC', 'NYC2/a.arw')).toBe(false);
    expect(shootContains('NYC', 'NYC')).toBe(false);
  });
});

describe('foldersOutside', () => {
  const folders = ['NYC', 'NYC/Day1', 'NYC2', 'NYC2/Day1', 'LA'];

  it('drops a hidden shoot and everything under it, and no sibling that starts the same', () => {
    expect(foldersOutside(folders, ['NYC'])).toEqual(['NYC2', 'NYC2/Day1', 'LA']);
  });

  it('keeps the tree whole when nothing is away, which is every library that hides nothing', () => {
    expect(foldersOutside(folders, [])).toEqual(folders);
  });

  it('takes a descendant named on its own without touching its parent', () => {
    expect(foldersOutside(folders, ['NYC/Day1'])).toEqual(['NYC', 'NYC2', 'NYC2/Day1', 'LA']);
  });
});

describe('mostSpecificShoot', () => {
  const shoots = [
    { id: 'nyc', folder_path: 'NYC' },
    { id: 'day1', folder_path: 'NYC/Day1' },
  ];

  it('returns the longest matching folder', () => {
    expect(mostSpecificShoot('NYC/Day1/x.arw', shoots)?.id).toBe('day1');
    expect(mostSpecificShoot('NYC/other.arw', shoots)?.id).toBe('nyc');
  });

  it('returns null when nothing matches', () => {
    expect(mostSpecificShoot('LA/x.arw', shoots)).toBeNull();
  });
});
