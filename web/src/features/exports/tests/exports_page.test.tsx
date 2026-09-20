// What the page makes of a history: a run of one is a file, a run of several is a line that
// opens onto its files, and "Edits" is claimed only where the export actually carried some -
// and the same of a run still waiting to be written, above it.
import { afterEach, expect, test } from 'bun:test';
import { ExportOptionsSchema } from '../../../../../src/schemas/export';
import type { QueuedPhoto } from '../../../../../src/schemas/exports';
import { neutralEdits } from '../../../../../src/schemas/photo_edits';
import { type ExportRun } from '../../../../../src/schemas/exports';
import { exportsApi } from '../../../api/exports';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';
import type { ExportStore } from '../../export/export_store';
import { photoPath } from '../../photos/photos_store';

registerDom();
const { act, cleanup, render, screen, findByText } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { StoresProvider, useExportStore } = await import('../../../app/stores_context');
const { ExportJob } = await import('../../export/export_job');
const { ExportsPage } = await import('../exports_page');
const { ExportsPageStrings } = await import('../exports_page.strings');

restoreApiAfterTests();
afterEach(cleanup);

// The provider builds its own stores, so the queue is reached the way a component reaches it.
let exports: ExportStore | null = null;

function Reach(): null {
  exports = useExportStore();
  return null;
}

function queue(photoIds: string[], photos: QueuedPhoto[], running: boolean): void {
  const job = new ExportJob('run-q', photoIds, ExportOptionsSchema.parse({}), {
    save: () => Promise.resolve(''),
  });
  act(() => {
    job.photos = photos;
    job.running = running;
    exports!.queue = [...exports!.queue, job];
  });
}

function queued(id: string, over: Partial<QueuedPhoto> = {}): QueuedPhoto {
  return {
    photo_id: id,
    library_id: 'lib',
    library_name: 'Trips',
    shoot_id: null,
    shoot_name: null,
    source_path: `raw/${id}.arw`,
    edits: null,
    width: 6000,
    height: 4000,
    tile_built_at: null,
    ...over,
  };
}

function run(id: string, photos: Partial<ExportRun['photos'][number]>[]): ExportRun {
  return {
    id,
    exported_at: '2026-09-09T00:00:00.000Z',
    photos: photos.map((photo, index) => ({
      id: `${id}-${index}`,
      photo_id: `p${index}`,
      library_id: 'lib',
      library_name: 'Trips',
      shoot_id: null,
      shoot_name: null,
      source_path: `raw/p${index}.arw`,
      output_path: `/exports/p${index}.jpg`,
      edits: null,
      width: 6000,
      height: 4000,
      has_thumbnail: false,
      exported_at: '2026-09-09T00:00:00.000Z',
      ...photo,
    })),
  };
}

function open(runs: ExportRun[]): void {
  exportsApi.list = () => Promise.resolve(runs);
  render(
    <MemoryRouter>
      <StoresProvider>
        <Reach />
        <ExportsPage />
      </StoresProvider>
    </MemoryRouter>,
  );
}

test('a run of one is the file itself, and a run of several is a line that holds them', async () => {
  open([run('r2', [{}, {}, {}]), run('r1', [{ source_path: 'raw/alone.arw' }])]);

  await findByText(document.body, 'raw/alone.arw');
  expect(screen.getByText('Exported 3 photos.')).toBeTruthy();
  // Inside the summary rather than beside it, so the run is one row until it is opened.
  expect(screen.getByText('Exported 3 photos.').closest('details')?.textContent).toContain('/exports/p2.jpg');
  // One disclosure, not two: a single file is a row of its own rather than a run of one to
  // open, which every assertion above still holds for if it were wrapped.
  expect(document.querySelectorAll('details')).toHaveLength(1);
  expect(screen.getByText('raw/alone.arw').closest('details')).toBeNull();
});

// A closed run has to say what is in it without opening: a pile of the first few, capped so a
// run of four hundred is not four hundred requests for tiles nobody has asked to see.
test('a closed run piles up its first three tiles, and no more', async () => {
  open([run('r1', [{}, {}, {}, {}, {}].map((each) => ({ ...each, has_thumbnail: true })))]);

  await findByText(document.body, 'Exported 5 photos.');
  const stacked = document.querySelectorAll('summary img');
  expect(stacked).toHaveLength(3);
  // The run's own first file on top, which is the one its count reads against.
  expect(stacked[0]?.getAttribute('src')).toContain('r1-0');
});

// Filtered before it is capped, not after: a run whose first files were never rendered still
// shows three tiles where it has three to show.
test('the pile is of the first three files that have a tile, not the first three files', async () => {
  const tiles = [false, false, true, true, true, true].map((has_thumbnail) => ({ has_thumbnail }));
  open([run('r1', tiles)]);

  await findByText(document.body, 'Exported 6 photos.');
  const stacked = document.querySelectorAll('summary img');
  expect(stacked).toHaveLength(3);
  expect(stacked[0]?.getAttribute('src')).toContain('r1-2');
});

test('a run whose files have no tiles piles up nothing', async () => {
  open([run('r1', [{}, {}])]);

  await findByText(document.body, 'Exported 2 photos.');
  expect(document.querySelector('summary img')).toBeNull();
});

// The row outlives the photograph, and a link into a library that no longer holds it is
// worse than saying so.
test('an export of a photograph that has left the catalogue links nowhere', async () => {
  open([run('r1', [{ library_id: null, library_name: null, has_thumbnail: true }])]);

  await findByText(document.body, 'Photo missing from catalogue');
  expect(screen.queryByRole('link')).toBeNull();
  // What was exported is still on the row: that is what the history is for.
  expect(screen.getByText('/exports/p0.jpg')).toBeTruthy();
});

test('a thumbnail is the way to the photograph it is of, with a picture or without one', async () => {
  open([
    run('r2', [{ photo_id: 'drawn', source_path: 'raw/drawn.arw', has_thumbnail: true }]),
    run('r1', [{ photo_id: 'blank', source_path: 'raw/blank.arw', has_thumbnail: false }]),
  ]);

  await findByText(document.body, 'raw/drawn.arw');
  expect(screen.getByRole('link', { name: 'Go to raw/drawn.arw' }).getAttribute('href')).toBe(photoPath('drawn', null));
  expect(screen.getByRole('link', { name: 'Go to raw/blank.arw' }).getAttribute('href')).toBe(photoPath('blank', null));
});

test('an export whose settings moved nothing does not say it was edited', async () => {
  open([run('r1', [{ edits: neutralEdits() }])]);

  await findByText(document.body, 'raw/p0.arw');
  expect(screen.queryByText('Edits')).toBeNull();
});

// The other way to carry none, which is the one `includeEdits: false` writes.
test('an export that recorded no settings at all does not say it was edited', async () => {
  open([run('r1', [{ edits: null }])]);

  await findByText(document.body, 'raw/p0.arw');
  expect(screen.queryByText('Edits')).toBeNull();
});

test('a reader who has exported nothing is told so', async () => {
  open([]);

  await findByText(document.body, 'Nothing exported yet');
  // Every exported file's row names where it came from.
  expect(screen.queryByText(ExportsPageStrings.original())).toBeNull();
});

// "Nothing exported yet" is a claim about the reader's own history, and a page that could not
// read it does not know that - so a failed load says why and nothing else.
test('a history that could not be read does not read as an empty one', async () => {
  exportsApi.list = () => Promise.reject(new Error('no catalogue'));
  render(
    <MemoryRouter>
      <StoresProvider>
        <ExportsPage />
      </StoresProvider>
    </MemoryRouter>,
  );

  await findByText(document.body, /couldn't load your export history/);
  expect(screen.queryByText('Nothing exported yet')).toBeNull();
});

// A run still waiting says what it is about, not merely how many: the same row the history
// will hold for it, off the photograph as it stands.
test('a queued run of one photograph is that photograph, waiting', async () => {
  open([]);
  await findByText(document.body, 'Nothing exported yet');

  queue(['p0'], [queued('p0')], false);

  expect(screen.getByText('raw/p0.arw')).toBeTruthy();
  expect(screen.getByText('1 photo waiting')).toBeTruthy();
  // Nothing has been written yet, so the row claims no destination and draws no bar.
  expect(screen.queryByText('Written to')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
});

// The run in flight is drawn as far through as it is, and its bar is named: a page can hold
// several of these, and "progress bar, 50%" says nothing about which run it belongs to.
test('a run in flight counts down over a named bar, and opens onto its photographs', async () => {
  open([]);
  await findByText(document.body, 'Nothing exported yet');

  queue(['p0', 'p1'], [queued('p0'), queued('p1')], true);

  const bar = screen.getByRole('progressbar', { name: 'Exporting 1 of 2' });
  expect(bar?.getAttribute('aria-label')).toBe('Exporting 1 of 2');
  expect(bar?.getAttribute('max')).toBe('2');
  expect(bar?.getAttribute('value')).toBe('0');
  // One line until it is asked about, holding both files.
  expect(screen.getByText('2 photos').closest('details')?.textContent).toContain('raw/p1.arw');
});

// Two lists, not one: what is about to be written is a different claim from what was, and a
// row of each on the same page would read as the same kind of thing.
test('a queue and a history are headed against each other', async () => {
  open([run('r1', [{}])]);
  await findByText(document.body, 'raw/p0.arw');
  expect(screen.queryByText('Export history')).toBeNull();

  queue(['q0'], [queued('q0')], true);

  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByText('Export history')).toBeTruthy();
});

// The settings the file was written with, not the photograph's current ones - which is the
// whole reason they are stored per export.
test('the edits an export carried are listed under its own badge', async () => {
  open([run('r1', [{ edits: { ...neutralEdits(), contrast: 40, whites: 10, blacks: -10, cropRight: 0.5 } }])]);

  const badge = await findByText(document.body, 'Edits');
  badge.click();

  expect(await findByText(document.body, 'Contrast')).toBeTruthy();
  expect(screen.getByText('+40')).toBeTruthy();
  // Every row, rather than the viewer's first two: the popover is already the disclosure.
  expect(screen.getByText('50% × 100% (3:4)')).toBeTruthy();
});
