import { describe, expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { GRID_GAP } from '../grid_layout';
import { BAND_COLOURS } from '../../photos_store';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

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
    is_offloaded: false,
    is_deleted: false,
    is_hidden: false,
    tile_built_at: null,
    renditions_built_at: null,
    date_updated: null,
    viewer_rendition: null,
    stack_id: stackId,
    stack_size: stackSize,
    composite_kind: null,
    frame_count: 0,
    bracket_kind: null,
    is_edited: false,
    frames_edited: false,
    shown_rendition: 'embedded',
    has_embedded: true,
  };
}

function storesWith(total: number, options: { rowHeight: number; columns: number }) {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const viewer = new ViewerStore(listing, stacks);
  listing.source = { kind: 'library', libraryId: 'lib' };
  listing.total = total;
  listing.mode = 'list'; // one column, a fixed row height, so the arithmetic is legible
  listing.viewportWidth = options.columns * 200;
  listing.viewportHeight = options.rowHeight * 4;
  for (let i = 0; i < total; i++) listing.rows.set(i, photo(`p${i}`));
  return { listing, marks, stacks, viewer };
}

describe('a band is drawn at its own first row', () => {
  test('scrolling into a tall band does not slide its members down the page', () => {
    const { listing, stacks } = storesWith(40, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
    stacks.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]]);
    // Far enough in that the band's first rows are above the fold.
    listing.rail.top = 5 * listing.rowHeight;

    const band = listing.sections.find((section) => section.kind === 'band');
    expect(band).toBeDefined();
    // The band hangs under the row its tile sits in - display row 1 - wherever
    // the viewport happens to start. Anchoring it to the first *visible* row
    // slid every member down and painted them over the grid below.
    expect(band?.top).toBe(1 * listing.rowHeight);
  });
});

describe('a band never starves the grid of blocks', () => {
  test('a band taller than the viewport still asks for something to load', () => {
    const { listing, stacks } = storesWith(40, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 40 }, (_, i) => photo(`m${i}`));
    stacks.expansions = new Map([['s1', { stackId: 's1', position: 7, photos: members }]]);
    // Inside the band, where no row of the collection is on screen at all.
    listing.rail.top = 12 * listing.rowHeight;

    expect(listing.sections.every((section) => section.kind === 'band')).toBe(true);
    // Answering "nothing visible" here stopped every fetch and made Select
    // visible a silent no-op.
    expect(listing.visible.to).toBeGreaterThan(listing.visible.from);
    expect(listing.visible.from).toBe(7);
  });
});

describe('the keyboard cursor accounts for open bands', () => {
  test('scrolling to a photo below a band targets the row it is actually drawn on', () => {
    const { listing, marks, stacks } = storesWith(40, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 6 }, (_, i) => photo(`m${i}`));
    stacks.expansions = new Map([['s1', { stackId: 's1', position: 0, photos: members }]]);
    listing.rail.top = 0;
    marks.focusIndex = 20;

    // Photo 20 sits on collection row 20, but six band rows are inserted above
    // it, so it is drawn on display row 26. Targeting row 20 left the cursor a
    // whole band-height off screen.
    const drawnAt = 26 * listing.rowHeight;
    const target = marks.focusContentTop;
    expect(target).not.toBeNull();
    expect(target).toBeCloseTo(drawnAt + listing.rowHeight - GRID_GAP - listing.viewportHeight, 0);
  });
});

describe('the rendered window keeps its identity while it scrolls', () => {
  test('a scroll does not change the key the grid window is reconciled by', () => {
    const { listing } = storesWith(400, { rowHeight: 65, columns: 1 });
    listing.rail.top = 10 * listing.rowHeight;
    const before = listing.sections.filter((section) => section.kind === 'grid');

    listing.rail.top = 11 * listing.rowHeight;
    const after = listing.sections.filter((section) => section.kind === 'grid');

    // The window has genuinely moved...
    expect(after[0]!.from).not.toBe(before[0]!.from);
    // ...and React is told it is the same element, so the tiles inside it keep
    // their decoded images instead of being unmounted and re-fetched.
    expect(after.map((section) => section.key)).toEqual(before.map((section) => section.key));
  });

  test('a band leaving the top of the window does not re-key the grid below it', () => {
    const { listing, stacks } = storesWith(400, { rowHeight: 65, columns: 1 });
    const members = Array.from({ length: 4 }, (_, i) => photo(`m${i}`));
    stacks.expansions = new Map([['s1', { stackId: 's1', position: 10, photos: members }]]);
    // The band spans display rows 11-14; start with it in view, then scroll past it.
    listing.rail.top = 12 * listing.rowHeight;
    const before = listing.sections.filter((section) => section.kind === 'grid').at(-1)!.key;

    listing.rail.top = 30 * listing.rowHeight;
    const after = listing.sections.filter((section) => section.kind === 'grid').at(-1)!.key;

    expect(after).toBe(before);
  });
});

describe('open stacks are coloured so a tile can be matched to its band', () => {
  test('colours run down the collection and wrap, whatever order stacks were opened in', () => {
    const { listing, stacks } = storesWith(40, { rowHeight: 65, columns: 1 });
    const members = [photo('m0'), photo('m1')];
    stacks.expansions = new Map([
      ['s3', { stackId: 's3', position: 12, photos: members }],
      ['s1', { stackId: 's1', position: 3, photos: members }],
      ['s2', { stackId: 's2', position: 9, photos: members }],
    ]);

    expect(listing.bandColours.get('s1')).toBe(0);
    expect(listing.bandColours.get('s2')).toBe(1);
    expect(listing.bandColours.get('s3')).toBe(2);
  });

  test('one open stack is the first colour, so the ordinary case is never a colour to decode', () => {
    const { listing, stacks } = storesWith(40, { rowHeight: 65, columns: 1 });
    stacks.expansions = new Map([['s9', { stackId: 's9', position: 30, photos: [photo('m0')] }]]);

    expect(listing.bandColours.get('s9')).toBe(0);
  });

  test('more open stacks than colours wrap rather than run out', () => {
    const { listing, stacks } = storesWith(40, { rowHeight: 65, columns: 1 });
    stacks.expansions = new Map(
      Array.from({ length: BAND_COLOURS + 1 }, (_, i) => [
        `s${i}`,
        { stackId: `s${i}`, position: i, photos: [photo(`m${i}`)] },
      ]),
    );

    expect(listing.bandColours.get(`s${BAND_COLOURS}`)).toBe(0);
  });
});

describe('members of an open band are findable by id', () => {
  test('a photo held only in a band can still be located', () => {
    const { stacks, viewer } = storesWith(4, { rowHeight: 65, columns: 1 });
    const members = [photo('m0'), photo('m1')];
    stacks.expansions = new Map([['s1', { stackId: 's1', position: 1, photos: members }]]);
    // Rating and the triage verdicts start by locating the photo; a band member
    // is in no row, so without this they silently did nothing.
    expect(viewer.photoFor('m1')?.id).toBe('m1');
    expect(viewer.photoFor('nope')).toBeNull();
  });
});
