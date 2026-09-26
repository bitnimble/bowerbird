import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoListingRepository } from '../../photos/listing/photo_listing_repository';
import { LabelsRepository } from '../labels_repository';
import { LabelsService } from '../labels_service';

const LIB = 'library1';
const OTHER = 'library2';

let db: Database;
let service: LabelsService;

function addPhoto(id: string, libraryId = LIB): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`,
  ).run(id, libraryId, `${id}.arw`);
}

function names(libraryId = LIB): string[] {
  return service
    .list()
    .filter((label) => label.library_id === libraryId)
    .map((label) => label.name);
}

function idOf(name: string): string {
  return service.list().find((label) => label.name === name)!.id;
}

function log(): { entity: string; row_id: string; deleted: number }[] {
  return db
    .query('SELECT entity, row_id, deleted FROM replication_log WHERE entity IN (?, ?) ORDER BY entity, row_id')
    .all('label', 'photo_label') as { entity: string; row_id: string; deleted: number }[];
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Library')`).run(LIB);
  db.query(`INSERT INTO libraries (id, root_path, name) VALUES (?, '/other', 'Other')`).run(OTHER);
  addPhoto('photo001');
  addPhoto('photo002');
  addPhoto('photo003', OTHER);
  service = new LabelsService(new LabelsRepository(db), new LibrariesRepository(db));
});

describe('LabelsService', () => {
  it('appends a created label to its own library only', () => {
    service.create({ library_id: LIB, name: 'Keeper', colour: '#ff0000' });
    service.create({ library_id: LIB, name: 'Print', colour: '#00ff00' });
    service.create({ library_id: OTHER, name: 'Keeper', colour: '#0000ff' });
    expect(names()).toEqual(['Keeper', 'Print']);
    expect(names(OTHER)).toEqual(['Keeper']);
  });

  it('refuses a name the library already has, whatever its case', () => {
    service.create({ library_id: LIB, name: 'Keeper', colour: '#ff0000' });
    expect(() => service.create({ library_id: LIB, name: 'keeper', colour: '#ff0000' })).toThrow(/already exists/);
    expect(() =>
      service.save({
        library_id: LIB,
        labels: [
          { name: 'Print', colour: '#000000' },
          { name: 'PRINT', colour: '#000000' },
        ],
        removed: [],
      }),
    ).toThrow(/already exists/);
  });

  it('saves the dialog in its order, keeping labels it never mentioned after them', () => {
    for (const name of ['A', 'B', 'C', 'D']) service.create({ library_id: LIB, name, colour: '#111111' });
    service.save({
      library_id: LIB,
      labels: [
        { id: idOf('C'), name: 'Sea', colour: '#222222' },
        { name: 'New', colour: '#333333' },
        { id: idOf('A'), name: 'A', colour: '#111111' },
      ],
      removed: [idOf('B')],
    });
    expect(names()).toEqual(['Sea', 'New', 'A', 'D']);
    expect(service.list().find((label) => label.name === 'Sea')?.colour).toBe('#222222');
  });

  it('keeps a rename made elsewhere while the dialog was open, when the dialog only reordered', () => {
    for (const name of ['A', 'B']) service.create({ library_id: LIB, name, colour: '#111111' });
    const [a, b] = [idOf('A'), idOf('B')];
    db.query("UPDATE labels SET name = 'Renamed elsewhere' WHERE id = ?").run(a);
    service.save({ library_id: LIB, labels: [{ id: b }, { id: a }], removed: [] });
    expect(names()).toEqual(['B', 'Renamed elsewhere']);
  });

  it('saves around two labels replication left sharing a name, but refuses giving that name again', () => {
    const repo = new LabelsRepository(db);
    repo.create(LIB, { id: 'label001', name: 'Keeper', colour: '#111111' });
    repo.create(LIB, { id: 'label002', name: 'Keeper', colour: '#222222' });
    repo.create(LIB, { id: 'label003', name: 'Print', colour: '#333333' });
    service.save({ library_id: LIB, labels: [{ id: 'label003' }], removed: [] });
    expect(names()).toEqual(['Print', 'Keeper', 'Keeper']);
    expect(() =>
      service.save({ library_id: LIB, labels: [{ id: 'label003', name: 'keeper' }], removed: [] }),
    ).toThrow(/already exists/);
  });

  it('labels only the photos in the label’s library, and counts them', () => {
    service.create({ library_id: LIB, name: 'Keeper', colour: '#ff0000' });
    const keeper = idOf('Keeper');
    service.addPhotos(keeper, ['photo001', 'photo003']);
    service.addPhotos(keeper, ['photo001']);
    expect(service.list()[0]?.photo_count).toBe(1);

    service.removePhotos(keeper, ['photo001']);
    expect(service.list()[0]?.photo_count).toBe(0);
  });

  it('filters a listing to photos carrying every checked label', () => {
    service.create({ library_id: LIB, name: 'A', colour: '#111111' });
    service.create({ library_id: LIB, name: 'B', colour: '#111111' });
    service.addPhotos(idOf('A'), ['photo001', 'photo002']);
    service.addPhotos(idOf('B'), ['photo002']);
    const listing = new PhotoListingRepository(db);
    const listed = (labels: string[]): string[] =>
      listing.listByLibrary(LIB, 'taken_asc', 0, 100, { includeDeleted: false, labels }).photos.map((p) => p.id);
    expect(listed([idOf('A')])).toEqual(['photo001', 'photo002']);
    expect(listed([idOf('A'), idOf('B')])).toEqual(['photo002']);
    expect(listing.getById('photo002')?.label_ids).toEqual([idOf('A'), idOf('B')]);
  });

  it('leaves a grave for every label and labelling that goes, where the library replicates', () => {
    db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIB);
    service.create({ library_id: LIB, name: 'A', colour: '#111111' });
    service.create({ library_id: LIB, name: 'B', colour: '#111111' });
    const [a, b] = [idOf('A'), idOf('B')];
    service.addPhotos(a, ['photo001']);
    service.addPhotos(b, ['photo002']);
    service.removePhotos(b, ['photo002']);
    service.save({ library_id: LIB, labels: [], removed: [a] });

    expect(log()).toEqual(
      [
        { entity: 'label', row_id: a, deleted: 1 },
        { entity: 'label', row_id: b, deleted: 0 },
        { entity: 'photo_label', row_id: `${a}/photo001`, deleted: 1 },
        { entity: 'photo_label', row_id: `${b}/photo002`, deleted: 1 },
      ].sort((x, y) => (x.entity + x.row_id).localeCompare(y.entity + y.row_id)),
    );
  });
});
