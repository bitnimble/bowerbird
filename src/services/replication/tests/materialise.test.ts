import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../db/migrate';
import { BlobLocations } from '../../blobs/blob_locations';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { Clock, DEFAULT_SKEW_MS } from '../clock';
import { pull, type Replica } from '../session';
import { drainMaterialisations, pendingMaterialisations, recipePathToTouch, unsettled } from '../materialise';
import { linkLibrary } from '../pairing';
import { useClock } from '../stamps';

// A merged move is a move on disk too, on the peer that holds the original
// (docs/replication.md §7.4).

const LIB = 'library1';

interface Peer {
  db: Database;
  root: string;
  photoScan: PhotoScanRepository;
  photoPaths: PhotoPathsRepository;
  libraries: LibrariesRepository;
  replica: Replica;
  /** Makes this peer's next write provably later than the other's. */
  advance: (byMs?: number) => void;
}

// Far from any real timestamp, so every run starts from the same instant.
const EPOCH = 1_700_000_000_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePeer(name: string): Peer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), `bb-mat-${name}-`));
  roots.push(root);
  db.query("INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')").run(LIB, root);
  linkLibrary(db, LIB);
  // A clock the test drives: two peers writing inside one millisecond are ordered
  // by their peer ids, which are random, so "the move is newer" would be a coin
  // flip against the system clock.
  let now = EPOCH;
  const identity = db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string };
  useClock(db, new Clock(identity.peer_id, DEFAULT_SKEW_MS, () => now));
  return {
    db,
    root,
    photoScan: new PhotoScanRepository(db, new PhotoProcessingRepository(db, new RenditionsRepository(db))),
    photoPaths: new PhotoPathsRepository(db, new StackMembership(db)),
    libraries: new LibrariesRepository(db),
    replica: { db, libraryId: LIB },
    advance: (byMs = 5) => (now += byMs),
  };
}

function addPhoto(peer: Peer, id: string, relPath: string, onDisk: boolean): void {
  if (onDisk) {
    const abs = path.join(peer.root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, `RAW-${id}`);
  }
  peer.photoScan.insertFromScan({
    id,
    library_id: LIB,
    shoot_id: null,
    file_hash: 'stat-hash',
    file_path: relPath,
    width: 100,
    height: 80,
    orientation: 0,
    date_taken: null,
    date_taken_offset: null,
    date_added: '2026-01-01T00:00:00.000Z',
    date_updated: null,
    file_size: 7,
    latitude: null,
    longitude: null,
    iso: null,
    shutter_speed: null,
    aperture: null,
    focal_length: null,
    camera_make: null,
    camera_model: null,
    lens_model: null,
  });
}

function drain(peer: Peer): Promise<number> {
  const library = peer.libraries.getById(LIB);
  if (library == null) throw new Error('library not found');
  return drainMaterialisations(peer.db, library, new BlobLocations(peer.db));
}

describe('a merged move', () => {
  it('moves the file this peer holds to where the merged row says it is', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', false);
    addPhoto(b, 'photo1', 'Day1/one.arw', true);
    a.advance();
    a.photoPaths.setFilePath('photo1', 'Day2/one.arw');

    pull(b.replica, a.replica);

    // Queued by the apply, not done inside it: the move is disk work and the
    // apply is a transaction.
    expect(pendingMaterialisations(b.db, LIB)).toBe(1);
    expect(await drain(b)).toBe(1);

    expect(existsSync(path.join(b.root, 'Day2/one.arw'))).toBe(true);
    expect(existsSync(path.join(b.root, 'Day1/one.arw'))).toBe(false);
    expect(pendingMaterialisations(b.db, LIB)).toBe(0);
  });

  it('is nothing to do on a peer that does not hold the original', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', false);
    addPhoto(b, 'photo1', 'Day1/one.arw', false);
    a.advance();
    a.photoPaths.setFilePath('photo1', 'Day2/one.arw');

    pull(b.replica, a.replica);

    expect(await drain(b)).toBe(0);
    expect(pendingMaterialisations(b.db, LIB)).toBe(0);
  });

  it('never overwrites what is already there, and flags the collision instead', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', false);
    addPhoto(b, 'photo1', 'Day1/one.arw', true);
    // Something else already occupies the destination - another card's DSC_0001
    // after a counter reset (§7.7).
    writeFileSync(path.join(b.root, 'taken.arw'), 'SOMEBODY-ELSE');
    a.advance();
    a.photoPaths.setFilePath('photo1', 'taken.arw');

    pull(b.replica, a.replica);
    expect(await drain(b)).toBe(0);

    expect(Bun.file(path.join(b.root, 'taken.arw')).text()).resolves.toBe('SOMEBODY-ELSE');
    expect(existsSync(path.join(b.root, 'Day1/one.arw'))).toBe(true);
    expect(new BlobLocations(b.db).flags(LIB)).toHaveLength(1);
    // And still owed. Forgotten, the next scan reads the row's occupied path as a
    // modification of this photograph and its real file as an unclaimed import -
    // the photograph's history lost, and both readings replicated.
    expect(pendingMaterialisations(b.db, LIB)).toBe(1);
    // Both paths are unsettled, and the occupied one is the point: the scan would
    // otherwise hash the stranger's file, find it different from what the row
    // records, and write that frame's dimensions, dates and camera onto this
    // photograph - minting an `imported` stamp that carries it to every peer.
    expect(unsettled(b.db, LIB).sort((x, y) => x.wasAt.localeCompare(y.wasAt))).toEqual([
      { photoId: 'photo1', wasAt: 'Day1/one.arw' },
      { photoId: 'photo1', wasAt: 'taken.arw' },
    ]);
  });

  it('stays queued when the move cannot be made, and the scan is told to leave it alone', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', false);
    addPhoto(b, 'photo1', 'Day1/one.arw', true);
    a.advance();
    a.photoPaths.setFilePath('photo1', 'Day2/one.arw');
    pull(b.replica, a.replica);

    // A file where the destination folder has to be, so making it fails: the
    // real cases are a file the editor holds open and a disk that is full.
    writeFileSync(path.join(b.root, 'Day2'), 'not a folder');

    expect(await drain(b)).toBe(0);
    // Still owed, so the next drain tries again...
    expect(pendingMaterialisations(b.db, LIB)).toBe(1);
    // ...and until it lands, the scan must read neither half: the row says Day2
    // and the file is at Day1, which taken as evidence is the photographer having
    // moved it back, and this peer would stamp that and replicate it.
    expect(unsettled(b.db, LIB)).toEqual([{ photoId: 'photo1', wasAt: 'Day1/one.arw' }]);
  });

  it('leaves everything queued when the library root is not mounted', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', false);
    addPhoto(b, 'photo1', 'Day1/one.arw', true);
    a.advance();
    a.photoPaths.setFilePath('photo1', 'Day2/one.arw');
    pull(b.replica, a.replica);

    rmSync(b.root, { recursive: true, force: true });

    // Every file would read as gone, and every entry would be dropped as
    // nothing-to-do - after which the drive comes back holding the old paths.
    expect(await drain(b)).toBe(0);
    expect(pendingMaterialisations(b.db, LIB)).toBe(1);
  });

  /**
   * The path is checked where it is *read*, not only where it arrived (§11.2).
   *
   * Two ways a recipe reaches this peer holding a path no payload rule was applied to: a kind
   * this build does not know is relayed unread and may carry one, and `JSON.parse` keeps the last
   * of a duplicated key where SQLite's `json_extract` returns the first - so a payload can
   * validate as `ok.arw` and be read as a traversal. Whatever is about to be joined onto the
   * library root is what gets checked, which is the only place the two cannot differ.
   */
  it.each([
    ['a kind this build cannot read', '{"kind":"kaleidoscope","path":"../../escape.arw"}'],
    ['a duplicated key the validator and SQLite read differently', '{"kind":"file","path":"../../escape.arw","path":"ok.arw"}'],
  ])('refuses to touch a path smuggled through %s', (_name, recipe) => {
    const a = makePeer('a');
    addPhoto(a, 'photo1', 'Day1/one.arw', true);
    a.db.query('UPDATE photos SET recipe = ? WHERE id = ?').run(recipe, 'photo1');

    // Both would otherwise be joined onto the root and handed to a link-then-unlink of the
    // source, which is a file taken from outside the library.
    expect(recipePathToTouch(a.db, 'photo1')).toBeNull();
  });

  it('is idempotent: draining twice, or against a tree already put right, does nothing', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', false);
    addPhoto(b, 'photo1', 'Day1/one.arw', true);
    a.advance();
    a.photoPaths.setFilePath('photo1', 'Day2/one.arw');

    pull(b.replica, a.replica);
    expect(await drain(b)).toBe(1);
    expect(await drain(b)).toBe(0);
    expect(existsSync(path.join(b.root, 'Day2/one.arw'))).toBe(true);
  });
});
