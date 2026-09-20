// What the filter calendar draws under each day, and which month it opens at.
import { runInAction } from 'mobx';
import { describe, expect, test } from 'bun:test';
import { ListingStore } from '../listing_store';
import { StacksStore } from '../stacks_store';
import { dayDensities } from '../photo_filters';

const DAYS = [
  { day: '2024-03-01', count: 1 },
  { day: '2024-03-02', count: 12 },
  { day: '2024-03-09', count: 400 },
];

function store(): ListingStore {
  const store = new ListingStore(new StacksStore());
  runInAction(() => (store.photoDays = DAYS));
  return store;
}

describe('how busy a day was', () => {
  test('the busiest day is solid and every other day is visible under it', () => {
    const density = dayDensities(DAYS);

    expect(density.get('2024-03-09')).toBe(1);
    // Linear against 400 would put a one-frame day at 0.0025, which is nothing on
    // screen; the log ramp leaves it a tenth of the busiest.
    expect(density.get('2024-03-01')).toBeGreaterThan(0.1);
    expect(density.get('2024-03-02')).toBeGreaterThan(density.get('2024-03-01') ?? 0);
    expect(density.get('2024-03-02')).toBeLessThan(1);
  });

  test('a day the collection holds nothing on has no dot', () => {
    expect(store().dayDensity.get('2024-03-03')).toBeUndefined();
  });

  test('an empty collection asks for no maximum of nothing', () => {
    expect([...dayDensities([]).keys()]).toEqual([]);
    expect(new ListingStore(new StacksStore()).lastPhotoDay).toBeUndefined();
  });

  test('the calendar opens at the last day the collection holds a photograph', () => {
    expect(store().lastPhotoDay).toBe('2024-03-09');
    expect(store().firstPhotoDay).toBe('2024-03-01');
  });
});
