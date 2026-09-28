import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { peerId } from '../../replication/stamps';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { LibrariesRepository } from '../libraries_repository';

const LIBRARY = 'lib00001';
const BUILT_AT = '2026-09-01T00:00:00.000Z';

let db: Database;
let repository: LibrariesRepository;
let renditions: RenditionsRepository;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  repository = new LibrariesRepository(db);
  renditions = new RenditionsRepository(db);
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, '/photos', 'Photos')").run(LIBRARY);
});

afterEach(() => db.close());

function insertPhoto(id: string, missing = false, deleted = false, libraryId = LIBRARY): void {
  db.query(
    `INSERT INTO photos (id, library_id, recipe, width, height, date_added, is_missing, is_deleted)
       VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, ?, ?, ?)`,
  ).run(id, libraryId, `${id}.arw`, BUILT_AT, missing ? 1 : 0, deleted ? 1 : 0);
}

function recordHolder(id: string, peer: string, libraryId = LIBRARY): void {
  db.query('INSERT INTO blob_locations (library_id, photo_id, peer_id, stamp) VALUES (?, ?, ?, ?)').run(
    libraryId,
    id,
    peer,
    'held',
  );
}

function pair(peer: string, kind: 'active' | 'passive' = 'active'): void {
  db.query(
    'INSERT INTO replication_peers (library_id, peer_id, name, paired_at, kind) VALUES (?, ?, ?, ?, ?)',
  ).run(LIBRARY, peer, peer, BUILT_AT, kind);
}

function counts(): object {
  const library = repository.getById(LIBRARY)!;
  return {
    photos: library.photo_count,
    missing: library.missing_photo_count,
    unavailable: library.unavailable_photo_count,
    rendered: library.rendered_photo_count,
  };
}

describe('library photo counts', () => {
  it('reads fresh configuration without aggregate fields and leaves full counts live', () => {
    const configuration = repository.getConfiguration(LIBRARY);
    if (configuration == null) throw new Error('library configuration missing');
    expect(configuration).toMatchObject({ id: LIBRARY, root_path: '/photos', name: 'Photos', rendition_hdr: true, denoiser: 'galosh' });
    for (const field of ['photo_count', 'missing_photo_count', 'unavailable_photo_count', 'rendered_photo_count']) {
      expect(configuration).not.toHaveProperty(field);
    }
    expect(repository.listConfigurations()).toEqual([configuration]);
    expect(repository.getConfiguration('unknown')).toBeNull();

    insertPhoto('added', true);
    repository.setName(LIBRARY, 'Updated');
    expect(repository.getConfiguration(LIBRARY)?.name).toBe('Updated');
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
    renditions.markBuilt('added', 'full-hdr', BUILT_AT, null, { from: 'render', matched: false });
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 1 });
    expect(repository.list()[0]?.rendered_photo_count).toBe(1);
  });

  it('returns zero counts for an empty library through every read', () => {
    expect(counts()).toEqual({ photos: 0, missing: 0, unavailable: 0, rendered: 0 });
    expect(repository.list()).toEqual([repository.getById(LIBRARY)!]);
    expect(repository.getByRootPath('/photos')).toEqual(repository.getById(LIBRARY));
  });

  it('counts each live photo once across remote holders, backups and rendition variants', () => {
    db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIBRARY);
    pair('peer0001');
    pair('drive001', 'passive');
    pair('drive002', 'passive');
    insertPhoto('local');
    insertPhoto('remote', true);
    insertPhoto('gone', true);
    insertPhoto('self', true);
    insertPhoto('backup', true);
    insertPhoto('binned', true, true);
    recordHolder('local', 'peer0001');
    recordHolder('remote', 'peer0001');
    recordHolder('remote', 'peer0002');
    recordHolder('self', peerId(db));
    recordHolder('binned', 'peer0001');
    db.query(
      `INSERT INTO backup_locations (library_id, photo_id, peer_id, rel_path, content_hash, size, verified_at)
         VALUES (?, 'backup', ?, 'backup.arw', 'hash', 100, ?)`,
    ).run(LIBRARY, 'drive001', BUILT_AT);
    db.query(
      `INSERT INTO backup_locations (library_id, photo_id, peer_id, rel_path, content_hash, size, verified_at)
         VALUES (?, 'backup', ?, 'backup.arw', 'hash', 100, ?)`,
    ).run(LIBRARY, 'drive002', BUILT_AT);
    renditions.markBuilt('local', 'grid', BUILT_AT, null, { from: 'embedded', matched: false });
    renditions.markBuilt('local', 'full-hdr', BUILT_AT, null, { from: 'render', matched: true });
    renditions.markBuilt('gone', 'max', BUILT_AT, null, null);
    renditions.markBuilt('binned', 'full-hdr', BUILT_AT, null, null);

    expect(counts()).toEqual({ photos: 5, missing: 2, unavailable: 2, rendered: 2 });
  });

  it('classifies missing originals in an unsynced library as unavailable', () => {
    insertPhoto('gone', true);
    recordHolder('gone', 'peer0001');
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
  });

  it('ignores holders belonging to another library', () => {
    db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIBRARY);
    pair('peer0001');
    insertPhoto('gone', true);
    recordHolder('gone', 'peer0001', 'lib00002');
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
  });

  it('updates after import, transfers, rendition builds, requeues, binning and retractions', () => {
    db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIBRARY);
    pair('peer0001');
    insertPhoto('photo', true);
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });

    recordHolder('photo', 'peer0001');
    expect(counts()).toEqual({ photos: 1, missing: 1, unavailable: 0, rendered: 0 });

    db.query('UPDATE photos SET is_missing = 0 WHERE id = ?').run('photo');
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 0, rendered: 0 });

    renditions.markBuilt('photo', 'grid', BUILT_AT, null, { from: 'embedded', matched: false });
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 0, rendered: 0 });
    renditions.markBuilt('photo', 'full-hdr', BUILT_AT, null, { from: 'render', matched: false });
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 0, rendered: 1 });
    renditions.queue('photo', ['grid']);
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 0, rendered: 1 });

    db.query('UPDATE photos SET is_deleted = 1 WHERE id = ?').run('photo');
    expect(counts()).toEqual({ photos: 0, missing: 0, unavailable: 0, rendered: 0 });
    db.query('UPDATE photos SET is_deleted = 0, is_missing = 1 WHERE id = ?').run('photo');
    db.query('DELETE FROM blob_locations WHERE photo_id = ?').run('photo');
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 1 });
    db.query('UPDATE renditions SET built_at = NULL WHERE photo_id = ?').run('photo');
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
  });

  it('uses other known holders while paired, then marks them unavailable after the last pairing goes', () => {
    db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIBRARY);
    pair('peer0001');
    insertPhoto('remote', true);
    recordHolder('remote', 'peer0002');
    expect(counts()).toEqual({ photos: 1, missing: 1, unavailable: 0, rendered: 0 });
    db.query('DELETE FROM replication_peers WHERE library_id = ?').run(LIBRARY);
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
  });

  it('requires a known backup peer for a recorded backup copy', () => {
    insertPhoto('backup', true);
    db.query(
      `INSERT INTO backup_locations (library_id, photo_id, peer_id, rel_path, content_hash, size, verified_at)
         VALUES (?, 'backup', 'drive001', 'backup.arw', 'hash', 100, ?)`,
    ).run(LIBRARY, BUILT_AT);
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
    pair('drive001', 'passive');
    expect(counts()).toEqual({ photos: 1, missing: 1, unavailable: 0, rendered: 0 });
    db.query('DELETE FROM replication_peers WHERE library_id = ?').run(LIBRARY);
    expect(counts()).toEqual({ photos: 1, missing: 0, unavailable: 1, rendered: 0 });
  });

  it('includes composites in total and rendered counts without claiming an original', () => {
    insertPhoto('frame', true);
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
         VALUES ('composite', ?, json_object('kind', 'panorama', 'sources',
           json_array(json_object('photoId', 'frame'))), 200, 100, ?)`,
    ).run(LIBRARY, BUILT_AT);
    renditions.markBuilt('composite', 'full-hdr', BUILT_AT, null, { from: 'render', matched: false });
    expect(counts()).toEqual({ photos: 2, missing: 0, unavailable: 1, rendered: 1 });
  });
});
