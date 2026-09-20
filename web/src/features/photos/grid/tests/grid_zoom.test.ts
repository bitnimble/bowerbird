// The grid's zoom is a column count rather than a tile width.
import { expect, test } from 'bun:test';
import { gridColumns, tileWidthForColumns } from '../grid_layout';
import { ListingStore } from '../listing_store';
import { StacksStore } from '../stacks_store';

// Out to the widest, where the steps are a pixel of tile apart and a round trip through
// `gridColumns` has the least room to land back on the count the reader picked.
const WIDTHS = [390, 860, 1920, 3840, 5120];

function store(width: number): ListingStore {
  const built = new ListingStore(new StacksStore());
  built.viewportWidth = width;
  built.tileSize = 240;
  return built;
}

// What the slider hands the presenter, and what the presenter makes of it.
const tileFor = (s: ListingStore, step: number): number =>
  tileWidthForColumns(s.viewportWidth, s.maxZoom + 1 - step);

test('no two steps of the track draw the same grid, on any width', () => {
  for (const width of WIDTHS) {
    const s = store(width);
    const counts = new Set<number>();
    for (let step = 1; step <= s.maxZoom; step++) counts.add(gridColumns(width, tileFor(s, step)));
    expect(counts.size, `${width}px`).toBe(s.maxZoom);
  }
});

test('the top of the track is one photograph across, whatever the window', () => {
  for (const width of WIDTHS) {
    const s = store(width);
    expect(gridColumns(width, tileFor(s, s.maxZoom)), `${width}px`).toBe(1);
  }
});

test('the zoom reads back as the step that set it', () => {
  for (const width of WIDTHS) {
    const s = store(width);
    for (let step = 1; step <= s.maxZoom; step++) {
      s.tileSize = tileFor(s, step);
      expect(s.zoom, `${width}px`).toBe(step);
    }
  }
});
