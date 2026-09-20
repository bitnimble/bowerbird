// A panorama is a photograph composed out of others, so it draws from its own copies at its own
// size. What is worth pinning is the one place it is not quite an ordinary photograph: only
// `full` is ever built for one, so a reader who asked for the camera's JPEG must still be shown
// the picture that exists rather than a 404 for one that cannot.
import { expect, test } from 'bun:test';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { renditionsApi } from '../../../../api/renditions';
import { SelectionRanges } from '../../selection';
import { ListingStore } from '../listing_store';
import { MarksStore } from '../marks_store';
import { StacksStore } from '../stacks_store';
import { ViewerStore } from '../../viewer/viewer_store';

const BUILT = '2026-09-08T01:02:03.000Z';

function row(overrides: Partial<PhotoSummary> = {}): PhotoSummary {
  return {
    id: 'photo001',
    library_id: 'lib00001',
    shoot_id: null,
    file_path: 'DSC0001.arw',
    width: 6000,
    height: 4000,
    ordering_date: '2026-01-01T00:00:00.000Z',
    triage: 'untriaged',
    rating: 0,
    is_missing: false,
    is_deleted: false,
    date_updated: null,
    tile_built_at: BUILT,
    renditions_built_at: BUILT,
    viewer_rendition: null,
    is_edited: false,
    stack_id: null,
    stack_size: 1,
    shown_rendition: 'full',
    has_embedded: true,
    ...overrides,
  } as PhotoSummary;
}

function stores() {
  const stacks = new StacksStore();
  const listing = new ListingStore(stacks);
  return { listing, marks: new MarksStore(listing, stacks), viewer: new ViewerStore(listing, stacks) };
}

test('a panorama is shown from its own copies, like any photograph', () => {
  const { listing, viewer } = stores();
  listing.rows.set(0, row({ composite_kind: 'panorama', frame_count: 3, file_path: null }));

  expect(viewer.sourceOf('photo001', 'full')).toBe(renditionsApi.url('photo001', 'full', Date.parse(BUILT)));
});

// Including the camera's own view of it: there is no RAW to lift a JPEG out of, so that view
// is a canvas composited from the frames' JPEGs, fetched by the same route as the rest and
// versioned like them - a photograph's is bytes inside a file it already has, where this one is
// built, and a URL that did not move when it landed is a picture nothing asks for again.
test('a panorama asked for as the camera’s JPEG is served a composited one, versioned as built', () => {
  const { listing, viewer } = stores();
  listing.rows.set(0, row({ composite_kind: 'panorama', frame_count: 3, file_path: null }));

  expect(viewer.sourceOf('photo001', 'embedded')).toBe(renditionsApi.url('photo001', 'embedded', Date.parse(BUILT)));
});

test('an ordinary photograph is shown at the rendition asked for', () => {
  const { listing, viewer } = stores();
  listing.rows.set(0, row());

  expect(viewer.sourceOf('photo001', 'embedded')).not.toBe(renditionsApi.url('photo001', 'full', Date.parse(BUILT)));
});

// A panorama's frames are named by its recipe rather than by a stack, so the bulk bar's stack
// actions - Unstack above all, which over a finished panorama reads as a way to take it apart
// and is in fact the way to destroy it - are not offered on one.
test('a panorama offers no Unstack, having no stack to unmake', () => {
  const { listing, marks } = stores();
  listing.rows.set(0, row({ composite_kind: 'panorama', frame_count: 4, file_path: null }));
  marks.selection = SelectionRanges.of(0, 0);

  expect(marks.hasSelectedStack).toBe(false);
});

test('a stacked photograph still offers it', () => {
  const { listing, marks } = stores();
  listing.rows.set(0, row({ stack_id: 'stack001', stack_size: 3 }));
  marks.selection = SelectionRanges.of(0, 0);

  expect(marks.hasSelectedStack).toBe(true);
});
