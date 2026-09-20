import { expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { GRID_GAP } from '../../grid/grid_layout';
import { ListingStore } from '../../grid/listing_store';
import { StacksStore } from '../../grid/stacks_store';
import { STRIP_MAX_THICKNESS, STRIP_MIN_THICKNESS, STRIP_SPINE, StripViewStore } from '../strip_view_store';
import { ViewerStore } from '../viewer_store';

// The viewer's filmstrip as arithmetic: one row of the collection, the members an
// open stack inserts into it, and which cells that leaves on screen. The rail
// underneath is `rail_scroll.test.ts`; this is the strip using it at a column
// count of one.

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
    is_hidden: false,
    tile_built_at: null,
    renditions_built_at: null,
    date_updated: null,
    viewer_rendition: null,
    stack_id: stackId,
    stack_size: stackSize,
    composite_kind: null,
    frame_count: 0,
    is_edited: false,
    frames_edited: false,
    shown_rendition: 'embedded',
    has_embedded: true,
  };
}

function stripOver(total: number): { stacks: StacksStore; strip: StripViewStore } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const viewer = new ViewerStore(listing, stacks);
  listing.source = { kind: 'library', libraryId: 'lib' };
  listing.total = total;
  for (let i = 0; i < total; i++) listing.rows.set(i, photo(`p${i}`, i === 4 ? 'stack' : null, i === 4 ? 3 : 1));
  const strip = new StripViewStore(listing, stacks, viewer);
  // A round cell: 100px tall leaves a 3:2 picture inside the tile's own pad, and
  // every position below is a multiple of the pitch that comes out of it.
  strip.viewportWidth = 1000;
  strip.viewportHeight = 100;
  return { stacks, strip };
}

test('the strip is one cell per photograph, and its content is as long as that makes it', () => {
  const { strip } = stripOver(50);
  expect(strip.cellCount).toBe(50);
  expect(strip.contentLength).toBeCloseTo(50 * strip.pitch - 2, 5);
  // A cell is as wide as the strip is tall, at the tile's own 3:2.
  expect(strip.pitch).toBeGreaterThan(strip.viewportHeight);
});

test('a window of it is on screen, not the whole collection', () => {
  const { strip } = stripOver(10_000);
  const span = strip.visibleSpan;
  expect(span.from).toBe(0);
  // A thousand-pixel strip holds a handful of cells; the overscan adds two either
  // side, and nothing near ten thousand is mounted.
  expect(span.to).toBeLessThan(20);
  expect(strip.visible.to).toBeLessThan(20);
});

test('scrolling the rail moves which cells are drawn, and the far end is reachable', () => {
  const { strip } = stripOver(10_000);
  strip.rail.rawAnchor = 0;
  strip.rail.top = 100 * strip.pitch;
  expect(strip.visibleSpan.from).toBeGreaterThan(95);
  expect(strip.visibleSpan.from).toBeLessThan(105);

  // The rail is shorter than the collection at this length, so the anchor is what
  // reaches the end of it.
  expect(strip.rail.limit).toBeGreaterThan(0);
  expect(strip.offsetOf(9_999)).toBeCloseTo(9_999 * strip.pitch, 5);
});

test('an open stack inserts its members into the run, after the tile they belong to', () => {
  const { stacks, strip } = stripOver(50);
  const members = [photo('m0', 'stack'), photo('m1', 'stack'), photo('m2', 'stack')];
  stacks.expansions.set('stack', { stackId: 'stack', position: 4, photos: members });

  expect(strip.cellCount).toBe(53);
  // The photographs before it are where they were; everything after has moved on
  // by the three cells the band took.
  expect(strip.displayCellOf(4)).toBe(4);
  expect(strip.displayCellOf(5)).toBe(8);
  // A member is placed inside the band rather than at the stack's own cell.
  expect(strip.cellOf('m0')).toBe(5);
  expect(strip.cellOf('m2')).toBe(7);
  expect(strip.cellOf('p5')).toBe(8);
});

// The one cell of the strip that is not a photograph. A stack's tile shows the
// frame its band opens with, so open it keeps a spine's width and hands the rest
// back to the photographs after it.
test('an open stack keeps a spine of the strip, and everything after it moves back', () => {
  const { stacks, strip } = stripOver(50);
  const members = [photo('m0', 'stack'), photo('m1', 'stack'), photo('m2', 'stack')];
  stacks.expansions.set('stack', { stackId: 'stack', position: 4, photos: members });
  const saved = strip.pitch - (STRIP_SPINE + GRID_GAP);

  expect(strip.spines).toEqual([4]);
  expect(strip.contentLength).toBeCloseTo(53 * strip.pitch - GRID_GAP - saved, 5);
  // Up to the spine nothing has moved; from the first member on, everything is
  // back by what the spine gave up.
  expect(strip.offsetOfCell(4)).toBeCloseTo(4 * strip.pitch, 5);
  expect(strip.offsetOfCell(5)).toBeCloseTo(4 * strip.pitch + STRIP_SPINE + GRID_GAP, 5);
  expect(strip.offsetOf(5)).toBeCloseTo(8 * strip.pitch - saved, 5);

  const band = strip.sections.find((section) => section.kind === 'band');
  expect(band?.top).toBeCloseTo(strip.offsetOfCell(5), 5);
});

test('the sections name the run either side of an open band, and the band itself', () => {
  const { stacks, strip } = stripOver(50);
  stacks.expansions.set('stack', {
    stackId: 'stack',
    position: 4,
    photos: [photo('m0', 'stack'), photo('m1', 'stack')],
  });

  const kinds = strip.sections.map((section) => section.kind);
  expect(kinds).toEqual(['grid', 'band', 'grid']);
  const [before, band, after] = strip.sections;
  expect(before).toMatchObject({ kind: 'grid', from: 0, to: 5 });
  expect(band).toMatchObject({ kind: 'band', stackId: 'stack' });
  expect(after).toMatchObject({ kind: 'grid', from: 5 });
});

// The strip takes the edge that leaves the photograph biggest, so it runs down the
// side as readily as along the foot - and a cell is sized from whichever of the
// strip's own measurements is across its cells, not from a fixed one.
test('down the side, the cell is sized from the width and the content runs vertically', () => {
  const { strip } = stripOver(50);
  const along = strip.pitch;
  strip.axis = 'y';
  strip.viewportWidth = 100;
  strip.viewportHeight = 1000;

  expect(strip.viewportLength).toBe(1000);
  expect(strip.across).toBe(100);
  // A 100px-wide cell is shorter than a 100px-tall one is wide: the same 3:2 the
  // other way up.
  expect(strip.pitch).toBeLessThan(along);
  expect(strip.contentLength).toBeCloseTo(50 * strip.pitch - 2, 5);
  expect(strip.visibleSpan.to).toBeLessThan(50);
});

// The zoom, asserted where it can be: a Base UI slider cannot be driven headlessly
// (CLAUDE.md), so what is pinned is what moving it does to the strip.
test('a thicker strip has bigger cells, and so shows less of the collection at once', () => {
  const { strip } = stripOver(500);
  strip.viewportHeight = STRIP_MIN_THICKNESS;
  const thin = strip.visibleSpan.to - strip.visibleSpan.from;

  strip.viewportHeight = STRIP_MAX_THICKNESS;
  expect(strip.pitch).toBeGreaterThan(STRIP_MAX_THICKNESS);
  expect(strip.visibleSpan.to - strip.visibleSpan.from).toBeLessThan(thin);
});

test('a photograph the client is not holding cannot be placed, and says so', () => {
  const { strip } = stripOver(50);
  expect(strip.cellOf('p3')).toBe(3);
  expect(strip.cellOf('nowhere')).toBeNull();
});
