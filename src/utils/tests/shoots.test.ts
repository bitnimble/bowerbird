import { mostSpecificShoot, shootContains } from '../shoots';

describe('shootContains', () => {
  it('requires a trailing separator so NYC does not capture sibling NYC2', () => {
    expect(shootContains('NYC', 'NYC/a.arw')).toBe(true);
    expect(shootContains('NYC', 'NYC/Day1/a.arw')).toBe(true);
    expect(shootContains('NYC', 'NYC2/a.arw')).toBe(false);
    expect(shootContains('NYC', 'NYC')).toBe(false);
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
