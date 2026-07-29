import { describe, expect, test } from 'bun:test';
import type { PhotoSummary } from '../../../api/client';
import { PhotosStore } from '../photos_store';
import type { AppSettingsStore } from '../../settings/app_settings_store';
import type { LibrariesStore } from '../../libraries/libraries_store';

// Where a band is drawn, and what the grid asks to load around it. The row
// arithmetic in bands.ts is exercised on its own; this is about the store using
// it correctly, which is where both of the positioning bugs actually lived.

function photo(id: string, stackId: string | null = null, stackSize = 1): PhotoSummary {
  return {
    id,
    library_id: 'lib',
    shoot_id: null,
    file_path: `${id}.arw`,
    width: 3000,
    height: 2000,
    ordering_date: '2026-01-01T00:00:00.000Z',
    triage: 'untriaged',
    rating: 0,
    is_missing: false,
    is_deleted: false,
    tile_built_at: null,
    renditions_built_at: null,
    date_updated: null,
    viewer_rendition: null,
    stack_id: stackId,
    stack_size: stackSize,
  };
}

function storeWith(total: number, options: { rowHeight: number; columns: number }): PhotosStore {
  const store = new PhotosStore({} as AppSettingsStore, {} as LibrariesStore);
  store.source = { kind: 'library', libraryId: 'lib' };
  store.total = total;
  store.mode = 'list'; // one column, a fixed row height, so the arithmetic is legible
  store.viewportWidth = options.columns * 200;
  store.viewportHeight = options.rowHeight * 4;
  for (let i = 0; i < total; i++) store.rows.set(i, photo(`p${i}`));
  return store;
}

describe('a band is drawn at its own first row', () => {
  test('scrolling into a tall band does not slide its members down the page', () => {
    const store = storeWith(40, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    store.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]]);
    // Far enough in that the band's first rows are above the fold.
    store.scrollTop = 5 * store.rowHeight;

    const band = store.sections.find((section) => section.kind === 'band');
    expect(band).toBeDefined();
    // The band hangs under the row its tile sits in - display row 1 - wherever
    // the viewport happens to start. Anchoring it to the first *visible* row
    // slid every member down and painted them over the grid below.
    expect(band?.top).toBe(1 * store.rowHeight);
  });
});

describe('a band never starves the grid of blocks', () => {
  test('a band taller than the viewport still asks for something to load', () => {
    const store = storeWith(40, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 40 }, (_, i) => photo(`m${i}`));
    store.expansions = new Map([['s1', { stackId: 's1', position: 7, photos: members }]]);
    // Inside the band, where no row of the collection is on screen at all.
    store.scrollTop = 12 * store.rowHeight;

    expect(store.sections.every((section) => section.kind === 'band')).toBe(true);
    // Answering "nothing visible" here stopped every fetch and made Select
    // visible a silent no-op.
    expect(store.visible.to).toBeGreaterThan(store.visible.from);
    expect(store.visible.from).toBe(7);
  });
});

describe('the keyboard cursor accounts for open bands', () => {
  test('scrolling to a photo below a band targets the row it is actually drawn on', () => {
    const store = storeWith(40, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 6 }, (_, i) => photo(`m${i}`));
    store.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]]);
    store.scrollTop = 0;
    store.focusIndex = 20;

    // Photo 20 sits on collection row 20, but six band rows are inserted above
    // it, so it is drawn on display row 26. Targeting row 20 left the cursor a
    // whole band-height off screen.
    const drawnAt = 26 * store.rowHeight;
    const target = store.focusScrollTop;
    expect(target).not.toBeNull();
    expect(target).toBeCloseTo(drawnAt + store.rowHeight - 3 - store.viewportHeight, 0);
  });
});

describe('members of an open band are findable by id', () => {
  test('a photo held only in a band can still be located', () => {
    const store = storeWith(4, { rowHeight: 65, columns: 1 });
    const members = [photo('m0'), photo('m1')];
    store.expansions = new Map([['s1', { stackId: 's1', position: 1, photos: members }]]);
    // Rating and the triage verdicts start by locating the photo; a band member
    // is in no row, so without this they silently did nothing.
    expect(store.photoFor('m1')?.id).toBe('m1');
    expect(store.photoFor('nope')).toBeNull();
  });
});
