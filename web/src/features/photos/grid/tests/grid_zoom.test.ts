// The grid's zoom is a position on a track whose column count is even in the logarithm.
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { PhotosPresenter } from '../../photos_presenter';
import { ViewerStore } from '../../viewer/viewer_store';
import { ZOOM_SETTLE_MS } from '../listing_presenter';
import { ZOOM_STEPS, columnsAtZoom, gridColumns, tileWidthForColumns } from '../grid_layout';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';

const WIDTHS = [390, 860, 1920, 3840, 5120];

function store(width: number): ListingStore {
  const built = new ListingStore(new StacksStore());
  built.viewportWidth = width;
  built.tileSize = 240;
  return built;
}

const absent = new Proxy({}, { get: () => () => undefined }) as never;

function build(width: number): { listing: ListingStore; presenter: PhotosPresenter } {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  const marks = new MarksStore(listing, stacks);
  const viewer = new ViewerStore(listing, stacks);
  const presenter = new PhotosPresenter(listing, marks, stacks, viewer, absent, absent, absent, absent, {} as never, absent);
  runInAction(() => {
    listing.viewportWidth = width;
    listing.tileSize = 240;
  });
  return { listing, presenter };
}

const columnsAt = (s: ListingStore, zoom: number): number =>
  gridColumns(s.viewportWidth, tileWidthForColumns(s.viewportWidth, columnsAtZoom(zoom, s.maxColumns)));

test('the ends of the track are as many as the window holds and one photograph across', () => {
  for (const width of WIDTHS) {
    const s = store(width);
    expect(columnsAt(s, 0), `${width}px`).toBe(s.maxColumns);
    expect(columnsAt(s, ZOOM_STEPS), `${width}px`).toBe(1);
  }
});

test('moving up the track never adds a column', () => {
  for (const width of WIDTHS) {
    const s = store(width);
    for (let zoom = 1; zoom <= ZOOM_STEPS; zoom++) {
      expect(columnsAt(s, zoom), `${width}px at ${zoom}`).toBeLessThanOrEqual(columnsAt(s, zoom - 1));
    }
  }
});

test('the middle of the track is a handful of columns, not most of the window', () => {
  expect(columnsAt(store(1920), ZOOM_STEPS / 2)).toBe(6);
  expect(columnsAt(store(3840), ZOOM_STEPS / 2)).toBe(8);
});

test('the zoom reads back as a position drawing the grid it set', () => {
  for (const width of WIDTHS) {
    const s = store(width);
    for (let zoom = 0; zoom <= ZOOM_STEPS; zoom++) {
      s.tileSize = tileWidthForColumns(width, columnsAtZoom(zoom, s.maxColumns));
      expect(columnsAt(s, s.zoom), `${width}px at ${zoom}`).toBe(gridColumns(width, s.tileSize));
    }
  }
});

test('a drag moves the thumb at once and lays the grid out once it rests', async () => {
  const { listing, presenter } = build(1920);
  const before = listing.tileSize;

  presenter.dragZoom(ZOOM_STEPS);
  expect(listing.zoomDraft).toBe(ZOOM_STEPS);
  expect(listing.tileSize).toBe(before);

  await Bun.sleep(ZOOM_SETTLE_MS + 50);
  expect(listing.columns).toBe(1);
  expect(listing.zoomDraft).toBe(ZOOM_STEPS);
});

test('a step that draws the same columns keeps the masonry measurements', () => {
  const { listing, presenter } = build(1920);
  presenter.setZoom(46);
  runInAction(() => listing.blockHeights.set(0, 900));

  presenter.setZoom(48);
  expect(listing.columns).toBe(6);
  expect(listing.blockHeights.get(0)).toBe(900);

  presenter.setZoom(ZOOM_STEPS);
  expect(listing.blockHeights.size).toBe(0);
});

test('letting go lays the grid out at once and hands the thumb back to it', () => {
  const { listing, presenter } = build(1920);

  presenter.dragZoom(0);
  presenter.setZoom(0);
  expect(listing.columns).toBe(listing.maxColumns);
  expect(listing.zoomDraft).toBeNull();
  expect(listing.zoom).toBe(0);
});
