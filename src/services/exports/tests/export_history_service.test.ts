// What the Exports page lists. The claim worth pinning is that a row is a copy rather than a
// view: exporting, editing the photograph and exporting again has to keep the first export's
// settings, and a photograph leaving the catalogue must not take its history with it.
import { Database } from '../../../db/driver';
import { beforeEach, expect, test } from 'bun:test';
import { runMigrations } from '../../../db/migrate';
import { ExportOptionsSchema } from '../../../schemas/export';
import { neutralEdits } from '../../../schemas/photo_edits';
import { fileRecipe } from '../../../schemas/recipes';
import { PhotoEditsRepository } from '../../photo_edits/photo_edits_repository';
import type { PhotoRenditionService } from '../../photos/renditions/photo_rendition_service';
import { SettingsRepository } from '../../settings/settings_repository';
import { ExportHistoryService } from '../export_history_service';

let db: Database;
let history: ExportHistoryService;
let settings: SettingsRepository;
/** What the render handed back for the row's tile, or null where it made none. */
let tile: (photoId: string) => Uint8Array | null;

// Only `locate` is reached, and only for the path the row copies - where the photograph
// lives is read back out of the catalogue by the listing itself.
const photos = {
  locate: (photoId: string) => ({
    photo: { id: photoId, library_id: 'lib', recipe: fileRecipe(`raw/${photoId}.arw`), shoot_id: null },
    library: { id: 'lib', name: 'Trips' },
  }),
} as unknown as PhotoRenditionService;

// The catalogue side of a row, which the listing reads back: recording an export of a
// photograph this catalogue does not hold is refused, so every test has one.
function addPhoto(photoId: string): void {
  db.query(
    `INSERT OR IGNORE INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, 'lib', json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(photoId, `raw/${photoId}.arw`);
}

// The two calls one exported file makes: the render writes the row with the tile it produced
// alongside the export, and the client says where it put the file afterwards.
function record(photoId: string, run: string, includeEdits = true): void {
  addPhoto(photoId);
  began(photoId, run, includeEdits);
  history.landed({ run_id: run, photo_id: photoId, output_path: `/exports/${photoId}.jpg` });
}

function began(photoId: string, run: string, includeEdits = true): void {
  history.began(
    run,
    photoId,
    ExportOptionsSchema.parse({ format: 'jpeg', longEdge: 3000, includeEdits }),
    tile(photoId),
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES ('lib', '/photos', 'Trips')`).run();
  addPhoto('p1');
  tile = (photoId) => new Uint8Array([1, 2, photoId.length]);
  settings = new SettingsRepository(db);
  history = new ExportHistoryService(db, photos, new PhotoEditsRepository(db), settings);
});

function keepAtMost(files: number): void {
  settings.update({ export_history_limit: files });
}

test('a run of several photographs is one entry holding each of them', async () => {
  record('p1', 'run1');
  record('p2', 'run1');
  record('p3', 'run2');

  const runs = history.list();
  expect(runs.map((run) => run.photos.length)).toEqual([1, 2]);
  expect(runs[0]?.id).toBe('run2');
  expect(runs[1]?.photos.map((photo) => photo.photo_id)).toEqual(['p1', 'p2']);
  expect(runs[0]?.photos[0]).toMatchObject({
    photo_id: 'p3',
    library_name: 'Trips',
    source_path: 'raw/p3.arw',
    output_path: '/exports/p3.jpg',
    width: 100,
    height: 100,
  });
});

test('each export keeps the settings it was written with', async () => {
  const edits = new PhotoEditsRepository(db);
  const saved = edits.save('p1', { ...neutralEdits(), exposure: 1 }, 0, 'session-a');
  record('p1', 'run1');

  edits.save('p1', { ...neutralEdits(), exposure: 2 }, saved.rev, 'session-b');
  record('p1', 'run2');

  const [second, first] = history.list();
  expect(second?.photos[0]?.edits?.exposure).toBe(2);
  expect(first?.photos[0]?.edits?.exposure).toBe(1);
});

// An export without the develop settings is a picture of what the camera recorded, and the
// page must not offer the photograph's edits as though the file carried them.
test('an export that left the edits out records none', async () => {
  new PhotoEditsRepository(db).save('p1', { ...neutralEdits(), exposure: 1 }, 0, 'session-a');
  record('p1', 'run1', false);

  expect(history.list()[0]?.photos[0]?.edits).toBeNull();
});

// The file on disk outlives the catalogue row, which is exactly when knowing where it went
// matters most - so the history holds no foreign key back to the photograph.
test('a photograph leaving the catalogue leaves its exports behind', async () => {
  record('p1', 'run1');
  db.query(`DELETE FROM photos WHERE id = 'p1'`).run();

  const listed = history.list()[0]?.photos[0];
  // What the export was is still here; where the photograph is has no answer any more, and
  // saying so is better than a link into nothing.
  expect(listed?.source_path).toBe('raw/p1.arw');
  expect(listed?.output_path).toBe('/exports/p1.jpg');
  expect(listed?.library_id).toBeNull();
  expect(listed?.library_name).toBeNull();
  expect(listed?.width).toBeNull();
  expect(listed?.height).toBeNull();
});

// The queue lists what is waiting the way the history lists what was written, so a run's rows
// come from the same joins - and in the order the run will write them, whatever order SQLite
// matched them in.
test('a queued run reads as the rows it is about to become', async () => {
  addPhoto('p2');
  db.query(`INSERT INTO shoots (id, library_id, name, folder_path) VALUES ('sh', 'lib', 'Day 2', 'Trip/Day 2')`).run();
  db.query(`UPDATE photos SET shoot_id = 'sh' WHERE id = 'p2'`).run();
  // When a copy was written is the `renditions` table's, keyed by the variant it is of.
  db.query(
    `INSERT INTO renditions (photo_id, variant, needs_build, built_at)
       VALUES ('p2', 'grid', 0, '2026-01-02T00:00:00.000Z')
     ON CONFLICT (photo_id, variant) DO UPDATE SET needs_build = 0, built_at = excluded.built_at`,
  ).run();

  const queued = history.queued(['p2', 'p1'], true);

  expect(queued.map((photo) => photo.photo_id)).toEqual(['p2', 'p1']);
  expect(queued[0]).toMatchObject({
    library_id: 'lib',
    library_name: 'Trips',
    shoot_id: 'sh',
    shoot_name: 'Trip/Day 2',
    source_path: 'raw/p2.arw',
    tile_built_at: '2026-01-02T00:00:00.000Z',
    width: 100,
    height: 100,
  });
});

// A photograph binned between the run being queued and the page being read has no row to show,
// and the rest of the run still has.
test('a queued photograph that has left the catalogue is left out', async () => {
  expect(history.queued(['p1', 'gone'], true).map((photo) => photo.photo_id)).toEqual(['p1']);
});

// What a pending row lists is what the file will carry, which is nothing where the run was
// asked to leave the develop settings out.
test('a queued run without the edits lists none', async () => {
  new PhotoEditsRepository(db).save('p1', { ...neutralEdits(), exposure: 1 }, 0, 'session-a');

  expect(history.queued(['p1'], true)[0]?.edits?.exposure).toBe(1);
  expect(history.queued(['p1'], false)[0]?.edits).toBeNull();
});

test('forgetting one file drops its row and nothing else', async () => {
  record('p1', 'run1');
  record('p2', 'run1');

  const [first] = history.list()[0]!.photos;
  history.forget(first!.id);

  expect(history.list()[0]?.photos.map((photo) => photo.photo_id)).toEqual(['p2']);
});

// What the reader is looking at when a selection is one row: forgetting it forgets the files
// it stands for, and nothing outside it.
test('forgetting a run drops every file in it and leaves the others', async () => {
  record('p1', 'run1');
  record('p2', 'run1');
  record('p3', 'run2');

  history.forgetRun('run1');

  expect(history.list().map((run) => run.id)).toEqual(['run2']);
});

// A run is its rows and nothing else, so forgetting the last of them takes the run with it
// rather than leaving a heading over nothing.
test('forgetting the only file of a run leaves no run', async () => {
  record('p1', 'run1');
  history.forget(history.list()[0]!.photos[0]!.id);

  expect(history.list()).toEqual([]);
});

// A corrupt document, or one a newer build wrote in a shape this one cannot read, costs that
// row its list of edits. The page it is on still has to arrive.
test('a stored document that will not parse reads as no edits rather than throwing', async () => {
  record('p1', 'run1');
  db.query(`UPDATE exports SET edits = 'not json at all'`).run();
  expect(history.list()[0]?.photos[0]?.edits).toBeNull();

  db.query(`UPDATE exports SET edits = '{"exposure":"quite a lot"}'`).run();
  expect(history.list()[0]?.photos[0]?.edits).toBeNull();
});

// The run's own moment, which is what the page prints beside "Exported N photos".
test('a run is stamped by the newest file in it', async () => {
  record('p1', 'run1');
  record('p2', 'run1');
  db.query(`UPDATE exports SET exported_at = '2026-01-01T00:00:00.000Z' WHERE photo_id = 'p1'`).run();
  db.query(`UPDATE exports SET exported_at = '2026-02-01T00:00:00.000Z' WHERE photo_id = 'p2'`).run();

  expect(history.list()[0]?.exported_at).toBe('2026-02-01T00:00:00.000Z');
});

// The limit is where the history stops, and the oldest run is what pays for the newest.
test('reaching the limit drops the oldest run', async () => {
  keepAtMost(2);
  record('p1', 'run1');
  record('p2', 'run2');
  record('p3', 'run3');

  expect(history.list().map((run) => run.id)).toEqual(['run3', 'run2']);
});

// Counted in files it would fall inside whichever run straddles it, and the page would then
// say "Exported 2 photos" over a run that wrote three - so whole runs leave, and the limit is
// a floor rather than a ceiling.
test('a run leaves whole, so the limit is a floor', async () => {
  keepAtMost(3);
  record('p1', 'run1');
  record('p2', 'run2');
  record('p3', 'run2');
  record('p4', 'run2');

  // run1 went even though three files would have fitted, because the alternative was two
  // thirds of run2.
  expect(history.list().map((run) => run.id)).toEqual(['run2']);
  expect(history.list()[0]?.photos).toHaveLength(3);
});

// The limit is a setting, so it moves under a history that is already past it - and one
// record then has to take away everything that no longer fits rather than one run of it.
test('a limit lowered under an existing history culls until it fits', async () => {
  record('p1', 'run1');
  record('p2', 'run2');
  record('p3', 'run3');
  record('p4', 'run4');

  keepAtMost(2);
  record('p5', 'run5');

  expect(history.list().map((run) => run.id)).toEqual(['run5', 'run4']);
});

// A single export of a thousand photographs is still the thing that just happened; a cull
// that took it would leave the reader with a history of nothing.
test('the newest run is kept however far past the limit it is', async () => {
  keepAtMost(1);
  record('p1', 'run1');
  record('p2', 'run2');
  record('p3', 'run2');

  expect(history.list().map((run) => run.id)).toEqual(['run2']);
  expect(history.list()[0]?.photos).toHaveLength(2);
});

// The picture is a column, so the row leaving takes it with it - there is no file to sweep.
test('a culled run takes its thumbnails with it', async () => {
  keepAtMost(1);
  record('p1', 'run1');
  const first = history.list()[0]!.photos[0]!.id;
  expect(history.thumbnailFor(first)).not.toBeNull();

  record('p2', 'run2');

  expect(history.thumbnailFor(first)).toBeNull();
  expect(db.query('SELECT COUNT(*) AS n FROM exports').get()).toEqual({ n: 1 });
});

// Where the photograph lives, read off it rather than stored: the row says which library and
// shoot hold it now, so the links go somewhere that exists.
test('a row says which library and shoot hold the photograph', async () => {
  db.query(
    `INSERT INTO shoots (id, library_id, folder_path, name, ordering)
       VALUES ('s1', 'lib', 'Japan/Day 2', 'Day 2', 'taken_asc')`,
  ).run();
  db.query(`UPDATE photos SET shoot_id = 's1' WHERE id = 'p1'`).run();

  record('p1', 'run1');
  record('p2', 'run1');

  const [inside, outside] = history.list()[0]!.photos;
  expect(inside).toMatchObject({ library_id: 'lib', library_name: 'Trips', shoot_id: 's1', shoot_name: 'Japan/Day 2' });
  expect(outside).toMatchObject({ library_name: 'Trips', shoot_id: null, shoot_name: null });
});

// The whole reason it is a lookup: a photograph filed into a shoot after the fact reads under
// the shoot holding it, not under the nothing it was exported from.
test('moving the photograph afterwards moves what its exports say', async () => {
  record('p1', 'run1');
  expect(history.list()[0]?.photos[0]?.shoot_name).toBeNull();

  db.query(
    `INSERT INTO shoots (id, library_id, folder_path, name, ordering)
       VALUES ('s1', 'lib', 'Japan/Day 2', 'Day 2', 'taken_asc')`,
  ).run();
  db.query(`UPDATE photos SET shoot_id = 's1' WHERE id = 'p1'`).run();

  expect(history.list()[0]?.photos[0]?.shoot_name).toBe('Japan/Day 2');
});

// The tile arrives with the row, being what the export's own render produced beside the file.
test('the tile the render made is what the row keeps', async () => {
  record('p1', 'run1');

  const listed = history.list()[0]!.photos[0]!;
  expect(listed.has_thumbnail).toBe(true);
  expect(history.thumbnailFor(listed.id)).toEqual(new Uint8Array([1, 2, 2]));
});

// A render that produced no tile - an older shell asking for none, a target that failed to
// encode - costs the row its picture and not the row.
test('a row whose render made no tile is still a row', async () => {
  tile = () => null;

  record('p1', 'run1');

  const listed = history.list()[0]!.photos[0]!;
  expect(listed.source_path).toBe('raw/p1.arw');
  expect(listed.has_thumbnail).toBe(false);
  expect(history.thumbnailFor(listed.id)).toBeNull();
});

// A row is a history entry once the file is somewhere, not when the render finished: until
// then nothing can say where it went, and a run stopped in between must not leave a line
// claiming an export that never landed.
test('a render nobody reported a destination for is not listed', async () => {
  addPhoto('p1');
  began('p1', 'run1');

  expect(history.list()).toEqual([]);

  history.landed({ run_id: 'run1', photo_id: 'p1', output_path: '/exports/p1.jpg' });
  expect(history.list()[0]?.photos[0]?.output_path).toBe('/exports/p1.jpg');
});

// And it does not sit there forever: the sweep is inside the cull, so it costs no timer.
test('a render that never landed is swept', async () => {
  addPhoto('p1');
  began('p1', 'run1');
  db.query(`UPDATE exports SET exported_at = '2020-01-01T00:00:00.000Z' WHERE output_path IS NULL`).run();

  record('p2', 'run2');

  expect(db.query('SELECT COUNT(*) AS n FROM exports').get()).toEqual({ n: 1 });
});
