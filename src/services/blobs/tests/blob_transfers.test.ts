import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import type { Hono } from 'hono';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlobsApi } from '../../../api/blobs/blobs_api';
import { applyErrorHandler } from '../../../api/error_handler';
import { runMigrations } from '../../../db/migrate';
import { PathSegment, route } from '../../../schemas/route';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { peerId } from '../../replication/stamps';
import { BlobLocations } from '../blob_locations';
import { stagePath, stagedSize, stagingDir } from '../blob_store';
import { BackupLocations } from '../../backup/backup_locations';
import type { PeerTransport } from '../peer';
import { TransferService } from '../transfer_service';

// Two real replicas in one process: real temp directories, real files, and the
// blob endpoints answering each other through Hono's request(), which is the
// same seam the HTTP transport implements.

const LIB = 'library1';

interface Peer {
  id: string;
  db: Database;
  root: string;
  photoPaths: PhotoPathsRepository;
  photoMetadata: PhotoMetadataRepository;
  photoScan: PhotoScanRepository;
  libraries: LibrariesRepository;
  locations: BlobLocations;
  transfers: TransferService;
  routes: Hono;
  /** Every request this peer sent, for asserting what actually travelled. */
  sent: { path: string; method: string; range: string | null }[];
  /** Photographs handed to the pipeline as their originals landed (§7.8). */
  built: string[];
}

const net = new Map<string, Hono>();
const roots: string[] = [];

afterEach(() => {
  net.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makePeer(name: string): Peer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), `bb-blobs-${name}-`));
  roots.push(root);
  db.query("INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')").run(LIB, root);
  db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIB);

  const photoProcessing = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  const photoPaths = new PhotoPathsRepository(db, new StackMembership(db));
  const photoMetadata = new PhotoMetadataRepository(db, photoProcessing);
  const photoScan = new PhotoScanRepository(db, photoProcessing);
  const libraries = new LibrariesRepository(db);
  const locations = new BlobLocations(db);
  const sent: Peer['sent'] = [];
  const transport: PeerTransport = {
    canReach: (peer) => net.has(peer),
    request: (peer, reqPath, init) => {
      sent.push({
        path: reqPath,
        method: init?.method ?? 'GET',
        range: new Headers(init?.headers).get('range'),
      });
      const routes = net.get(peer);
      if (routes == null) throw new Error(`unknown peer: ${peer}`);
      return Promise.resolve(routes.request(reqPath, init));
    },
  };
  const built: string[] = [];
  const build = (ids: string[]): void => void built.push(...ids);
  const transfers = new TransferService(
    db,
    photoPaths,
    photoMetadata,
    libraries,
    locations,
    new BackupLocations(db),
    transport,
    build,
  );
  const api = new BlobsApi(photoPaths, photoMetadata, photoProcessing, libraries, locations, transfers, build);
  applyErrorHandler(api.routes);
  const id = peerId(db);
  net.set(id, api.routes);
  return { id, db, root, photoPaths, photoMetadata, photoScan, libraries, locations, transfers, routes: api.routes, sent, built };
}

function addPhoto(peer: Peer, id: string, relPath: string, bytes?: string): void {
  if (bytes != null) {
    const abs = path.join(peer.root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
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
    file_size: bytes == null ? 0 : Buffer.byteLength(bytes),
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

function addShoot(peer: Peer, id: string, folderPath: string): void {
  peer.db
    .query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)')
    .run(id, LIB, folderPath, folderPath);
}

/** A remote peer's location row as replication would have landed it. */
function knowsHolder(peer: Peer, photoId: string, holder: string): void {
  peer.db
    .query('INSERT OR IGNORE INTO blob_locations (library_id, photo_id, peer_id, stamp) VALUES (?, ?, ?, ?)')
    .run(LIB, photoId, holder, 'ffffffffffff0000' + holder);
}

function sha256(data: string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

function library(peer: Peer) {
  const lib = peer.libraries.getById(LIB);
  if (lib == null) throw new Error('library not found');
  return lib;
}

describe('push', () => {
  it('computes the content hash at first transfer, and the receiver verifies, materialises and records', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'Day1/one.arw');
    // Settled: this peer holds a placeholder it has already given up on building.
    b.db.query(`UPDATE renditions SET needs_build = 0 WHERE photo_id = ?`).run('photo1');

    expect(a.photoMetadata.contentHashOf('photo1')).toBeNull();
    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(1);
    await a.transfers.drain();

    const item = a.transfers.list(LIB)[0]!;
    expect(item.state).toBe('done');
    expect(item.bytes_done).toBe(7);
    expect(item.bytes_total).toBe(7);

    // §7.1: the sender computed and stored the hash off the stream it sent.
    expect(a.photoMetadata.contentHashOf('photo1')).toBe(sha256('RAW-one'));
    const logged = a.db
      .query("SELECT stamp FROM replication_log WHERE library_id = ? AND entity = 'photo.imported' AND row_id = 'photo1'")
      .get(LIB) as { stamp: string } | null;
    expect(logged).not.toBeNull();

    // The receiver holds the verified bytes at the row's path.
    expect(readFileSync(path.join(b.root, 'Day1/one.arw'), 'utf8')).toBe('RAW-one');
    // §7.2: its own location row, written after the rename; §7.8: the pipeline
    // is handed the arrival.
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(true);
    const owed = b.db
      .query(
        `SELECT variant, needs_build FROM renditions WHERE photo_id = ? ORDER BY variant`,
      )
      .all('photo1');
    expect(owed).toEqual([
      { variant: 'full-hdr', needs_build: 1 },
      { variant: 'grid', needs_build: 1 },
    ]);
    // And asked for, rather than left flagged for whatever might notice: the
    // watcher seeing the new file is off on any install with watching disabled
    // and late by a debounce everywhere else, so a placeholder would sit there.
    expect(b.built).toEqual(['photo1']);
    // The sender proved possession by reading every byte, so its own row stands too.
    expect(a.locations.heldBy(LIB, 'photo1', a.id)).toBe(true);
  });

  it('is a diff, so pressing it again is restart recovery and nothing re-sends', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');

    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(1);
    await a.transfers.drain();
    expect(a.transfers.list(LIB)[0]!.state).toBe('done');

    // The receiver's location row has not replicated back, so the diff still
    // names the photo - but the peer answers "held" and no bytes travel.
    a.sent.length = 0;
    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(1);
    await a.transfers.drain();
    expect(a.transfers.list(LIB)[0]!.state).toBe('done');
    expect(a.sent.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(b.locations.flags(LIB)).toEqual([]);

    // Once the row has replicated back, the diff is empty.
    knowsHolder(a, 'photo1', b.id);
    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(0);
  });

  it('scopes the diff to a selection or a shoot, and an empty shoot queues nothing', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
    addPhoto(a, 'photo2', 'Day2/two.arw', 'RAW-two');
    addShoot(a, 'day1', 'Day1');
    addShoot(a, 'day3', 'Day3');
    a.db.query('UPDATE photos SET shoot_id = ? WHERE id = ?').run('day1', 'photo1');

    expect(await a.transfers.pushDiff(LIB, b.id, { photo_ids: ['photo2'] })).toBe(1);
    expect(a.transfers.list(LIB).map((t) => t.photo_id)).toEqual(['photo2']);

    // Day1 holds photo1 alone, so one more is queued and photo2's entry stays.
    expect(await a.transfers.pushDiff(LIB, b.id, { shoot_id: 'day1' })).toBe(1);
    expect(a.transfers.list(LIB).map((t) => t.photo_id).sort()).toEqual(['photo1', 'photo2']);

    expect(await a.transfers.pushDiff(LIB, b.id, { shoot_id: 'day3' })).toBe(0);
  });

  it('refuses a request naming two scopes, rather than picking one of them', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');

    const res = await a.routes.request(route(PathSegment.push()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_id: LIB, peer_id: b.id, scope: { photo_ids: ['photo1'], shoot_id: 'day1' } }),
    });

    expect(res.status).toBe(400);
    expect(a.transfers.list(LIB)).toEqual([]);
  });

  it('skips and flags an occupied target, and the location row is only written after the rename', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    // The user's own file, unscanned, differing only in case: still theirs (§7.7).
    writeFileSync(path.join(b.root, 'ONE.ARW'), 'users own');

    await a.transfers.pushDiff(LIB, b.id, { library: true });
    await a.transfers.drain();

    const item = a.transfers.list(LIB)[0]!;
    expect(item.state).toBe('failed');
    expect(item.error).toContain('occupied');
    expect(readFileSync(path.join(b.root, 'ONE.ARW'), 'utf8')).toBe('users own');
    expect(existsSync(path.join(b.root, 'one.arw'))).toBe(false);
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(false);
    expect(b.locations.flags(LIB)).toEqual([
      { library_id: LIB, photo_id: 'photo1', target_path: 'one.arw', reason: 'target occupied by ONE.ARW' },
    ]);
    // The staged copy is kept, so the retry after the user resolves the
    // collision resumes without re-sending a byte.
    expect(stagedSize(stagePath(library(b), 'photo1'))).toBe(7);

    rmSync(path.join(b.root, 'ONE.ARW'));
    a.sent.length = 0;
    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(1);
    await a.transfers.drain();
    expect(a.transfers.list(LIB)[0]!.state).toBe('done');
    expect(a.sent.filter((r) => r.method === 'PUT')).toEqual([]);
    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('RAW-one');
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(true);
    expect(b.locations.flags(LIB)).toEqual([]);
  });

  it('a receiver whose recorded hash disagrees discards the download', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    b.db.query('UPDATE photos SET content_hash = ? WHERE id = ?').run(sha256('something else'), 'photo1');

    await a.transfers.pushDiff(LIB, b.id, { library: true });
    await a.transfers.drain();

    const item = a.transfers.list(LIB)[0]!;
    expect(item.state).toBe('failed');
    expect(item.error).toContain('discarded');
    expect(existsSync(path.join(b.root, 'one.arw'))).toBe(false);
    expect(stagedSize(stagePath(library(b), 'photo1'))).toBe(0);
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(false);
  });
});

describe('pull', () => {
  it('resumes from the staged byte offset', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'ABCDEFGHIJ');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', a.id);
    // Five bytes survived an interrupted run.
    mkdirSync(path.join(b.root, '.bowerbird-staging'), { recursive: true });
    writeFileSync(stagePath(library(b), 'photo1'), 'ABCDE');

    expect(await b.transfers.pullDiff(LIB, a.id, { library: true })).toBe(1);
    await b.transfers.drain();

    expect(b.transfers.list(LIB)[0]!.state).toBe('done');
    expect(b.sent.find((r) => r.path === route('photo1', PathSegment.original()))?.range).toBe('bytes=5-');
    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('ABCDEFGHIJ');
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(true);
    // The holder had never transferred it before, so serving this pull is what
    // made it compute and record the hash (§7.1).
    expect(a.photoMetadata.contentHashOf('photo1')).toBe(sha256('ABCDEFGHIJ'));
  });

  /**
   * Two peers holding the same original queue two pulls of it, differing only by
   * which peer they name. The first lands the file; the second would download the
   * whole thing again and then find its target occupied - by the copy the first one
   * just put there - so it flags a collision against itself and fails, on every
   * retry, for ever.
   */
  it('does not download again for a second holder once the original is here', async () => {
    const a = makePeer('a');
    const c = makePeer('c');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(c, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', a.id);
    knowsHolder(b, 'photo1', c.id);

    expect(await b.transfers.pullDiff(LIB, a.id, { library: true })).toBe(1);
    expect(await b.transfers.pullDiff(LIB, c.id, { library: true })).toBe(1);
    await b.transfers.drain();

    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('RAW-one');
    // Fetched once. The second entry finished without asking anybody for bytes.
    expect(b.sent.filter((r) => r.path === route('photo1', PathSegment.original()))).toHaveLength(1);
    expect(b.db.query('SELECT COUNT(*) AS n FROM materialisation_flags').get()).toEqual({ n: 0 });
  });

  it('discards a download that does not hash to the recorded value', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'ROTTED BYTES');
    addPhoto(b, 'photo1', 'one.arw');
    // The catalogue knows what the bytes should be; this holder's copy rotted.
    b.db.query('UPDATE photos SET content_hash = ? WHERE id = ?').run(sha256('RAW-one'), 'photo1');
    knowsHolder(b, 'photo1', a.id);

    await b.transfers.pullDiff(LIB, a.id, { library: true });
    await b.transfers.drain();

    const item = b.transfers.list(LIB)[0]!;
    expect(item.state).toBe('failed');
    expect(item.error).toContain('discarded');
    expect(existsSync(path.join(b.root, 'one.arw'))).toBe(false);
    expect(stagedSize(stagePath(library(b), 'photo1'))).toBe(0);
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(false);
  });

  it('fetch-on-open pulls from a recorded holder and keeps it; a local original needs nothing', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', a.id);

    const transfer = b.transfers.fetchOriginal('photo1');
    expect(transfer).not.toBeNull();
    expect(transfer!.direction).toBe('pull');
    await b.transfers.drain();
    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('RAW-one');

    expect(b.transfers.fetchOriginal('photo1')).toBeNull();
  });

  it('fetch-on-open skips a holder it cannot dial and takes the copy from one it can', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    // A device at the far end of a chain: its location rows replicated here, its
    // address never did, and it is recorded first.
    knowsHolder(b, 'photo1', 'faraway-peer');
    knowsHolder(b, 'photo1', a.id);

    const transfer = b.transfers.fetchOriginal('photo1');

    expect(transfer!.peer_id).toBe(a.id);
    await b.transfers.drain();
    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('RAW-one');
  });

  it('refuses a fetch whose only holders cannot be reached, rather than queuing one that cannot run', () => {
    const b = makePeer('b');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', 'faraway-peer');

    expect(() => b.transfers.fetchOriginal('photo1')).toThrow(/none of them can be reached/);
    expect(b.transfers.list(LIB)).toEqual([]);
  });

  it('hands a fetch to the next holder when the first one fails, and stops once they are all tried', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    const c = makePeer('c');
    // Holders come back in peer id order and an id is minted at random, so which
    // one is asked first is decided here rather than assumed: the first is the one
    // that answers without the bytes, which is the ordinary shape of a stale
    // location row (§7.2).
    const [empty, holder] = a.id < b.id ? [a, b] : [b, a];
    addPhoto(empty, 'photo1', 'one.arw');
    addPhoto(holder, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(c, 'photo1', 'one.arw');
    knowsHolder(c, 'photo1', empty.id);
    knowsHolder(c, 'photo1', holder.id);

    c.transfers.fetchOriginal('photo1');
    await c.transfers.drain();

    expect(readFileSync(path.join(c.root, 'one.arw'), 'utf8')).toBe('RAW-one');
    const byPeer = Object.fromEntries(c.transfers.list(LIB).map((item) => [item.peer_id, item.state]));
    expect(byPeer).toEqual({ [empty.id]: 'failed', [holder.id]: 'done' });
  });

  it('leaves a failed pull from a named peer where it is, rather than taking the photo from somebody else', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    const c = makePeer('c');
    addPhoto(a, 'photo1', 'one.arw');
    addPhoto(b, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(c, 'photo1', 'one.arw');
    knowsHolder(c, 'photo1', a.id);
    knowsHolder(c, 'photo1', b.id);

    // "Send me what a has", which is a request about a rather than about the
    // photograph: b holding a copy is no answer to it.
    await c.transfers.pullDiff(LIB, a.id, { library: true });
    await c.transfers.drain();

    expect(c.transfers.list(LIB).map((item) => [item.peer_id, item.state])).toEqual([[a.id, 'failed']]);
    expect(existsSync(path.join(c.root, 'one.arw'))).toBe(false);
  });

  it('cancel discards the staged bytes and keeps the item cancelled', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', a.id);
    mkdirSync(path.join(b.root, '.bowerbird-staging'), { recursive: true });
    writeFileSync(stagePath(library(b), 'photo1'), 'RAW');

    await b.transfers.pullDiff(LIB, a.id, { library: true });
    const item = b.transfers.list(LIB)[0]!;
    await b.transfers.cancel(item.id);
    expect(b.transfers.get(item.id).state).toBe('cancelled');
    expect(stagedSize(stagePath(library(b), 'photo1'))).toBe(0);
  });
});

describe('queue durability', () => {
  it('survives a restart, and an item caught mid-flight goes back to queued', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');

    await a.transfers.pushDiff(LIB, b.id, { library: true });
    const item = a.transfers.list(LIB)[0]!;
    a.db.query("UPDATE blob_transfers SET state = 'active' WHERE id = ?").run(item.id);

    const restarted = new TransferService(
      a.db,
      a.photoPaths,
      a.photoMetadata,
      a.libraries,
      a.locations,
      new BackupLocations(a.db),
      {
        canReach: (peer: string) => net.has(peer),
        request: (peer: string, reqPath: string, init?: RequestInit) =>
          Promise.resolve(net.get(peer)!.request(reqPath, init)),
      },
    );
    expect(restarted.get(item.id).state).toBe('queued');
    await restarted.drain();
    expect(restarted.get(item.id).state).toBe('done');
    expect(readFileSync(path.join(b.root, 'one.arw'), 'utf8')).toBe('RAW-one');
  });

  /**
   * Every path that clears a stage file is the receiving side of a pull, or a
   * refused commit. A push the sender abandons leaves the receiver holding bytes it
   * will never hear about again - inside the library root, where nothing else
   * looks, at the size of a RAW apiece.
   */
  it('sweeps staged bytes nothing is waiting on, and keeps the ones something is', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    addPhoto(a, 'photo2', 'two.arw', 'RAW-two');
    addPhoto(b, 'photo2', 'two.arw');
    // One abandoned by a sender that never came back, one belonging to a transfer
    // this device is still going to finish.
    mkdirSync(stagingDir({ root_path: b.root }), { recursive: true });
    writeFileSync(stagePath({ root_path: b.root }, 'photo1'), 'half a RAW');
    writeFileSync(stagePath({ root_path: b.root }, 'photo2'), 'half a RAW');
    b.db
      .query(
        `INSERT INTO blob_transfers (id, library_id, photo_id, peer_id, direction, state, queued_at)
           VALUES ('t2', ?, 'photo2', ?, 'pull', 'queued', '2026-01-01T00:00:00.000Z')`,
      )
      .run(LIB, a.id);

    expect(await b.transfers.sweepAbandonedStages()).toBe(1);

    expect(existsSync(stagePath({ root_path: b.root }, 'photo1'))).toBe(false);
    expect(existsSync(stagePath({ root_path: b.root }, 'photo2'))).toBe(true);
  });
});

describe('eviction', () => {
  async function transferred(): Promise<{ a: Peer; b: Peer }> {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    await a.transfers.pushDiff(LIB, b.id, { library: true });
    await a.transfers.drain();
    knowsHolder(a, 'photo1', b.id);
    return { a, b };
  }

  it('refuses without a live confirmation of possession, whatever the table says', async () => {
    const { a, b } = await transferred();
    // The replicated table still claims b holds it; the disk disagrees.
    rmSync(path.join(b.root, 'one.arw'));

    const result = await a.transfers.evict(['photo1'], b.id);
    expect(result.evicted).toEqual([]);
    expect(result.refused[0]?.reason).toContain('could not verify possession');
    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(true);
    expect(a.locations.heldBy(LIB, 'photo1', a.id)).toBe(true);
  });

  it('refuses a peer whose copy hashes to something else', async () => {
    const { a, b } = await transferred();
    writeFileSync(path.join(b.root, 'one.arw'), 'silently rotted');

    const result = await a.transfers.evict(['photo1'], b.id);
    expect(result.evicted).toEqual([]);
    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(true);
  });

  it('refuses a photo that was never transferred: there is no verified second copy', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo2', 'two.arw', 'RAW-two');

    const result = await a.transfers.evict(['photo2'], b.id);
    expect(result.refused[0]?.reason).toContain('never transferred');
    expect(existsSync(path.join(a.root, 'two.arw'))).toBe(true);
  });

  it('refuses to delete an original out of a read-only library', async () => {
    const { a, b } = await transferred();
    a.libraries.setReadOnly(LIB, true);

    const result = await a.transfers.evict(['photo1'], b.id);

    expect(result.evicted).toEqual([]);
    expect(result.refused[0]?.reason).toBe('library Trip is read-only');
    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(true);
  });

  it('deletes the local copy and tombstones the location row once a peer verifies possession', async () => {
    const { a, b } = await transferred();

    const result = await a.transfers.evict(['photo1'], b.id);
    expect(result).toEqual({ evicted: ['photo1'], refused: [] });
    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(false);
    expect(a.locations.heldBy(LIB, 'photo1', a.id)).toBe(false);
    const grave = a.db
      .query("SELECT deleted FROM replication_log WHERE entity = 'blob_location' AND row_id = ?")
      .get(`photo1/${a.id}`) as { deleted: number } | null;
    expect(grave?.deleted).toBe(1);
    const row = a.db.query('SELECT is_missing FROM photos WHERE id = ?').get('photo1') as { is_missing: number };
    expect(row.is_missing).toBe(1);
  });

  /**
   * The one that loses an original outright (§7.6).
   *
   * The possession check is a read: it takes nothing and says nothing about the
   * moment after it is answered. So two devices each removing their copy, each
   * keeping it "on the other", both hear yes - neither has deleted yet - and both
   * delete. The RAW is then on no device, every catalogue reads `is_missing`, and
   * nothing can ever fill the hole.
   *
   * Both refusing is the right answer: nothing is lost and the person is told,
   * where a copy deleted twice cannot be told to anybody.
   */
  /**
   * The row's path is only where the bytes are when the two agree.
   *
   * A merged move that has not run, or a transfer that refused to overwrite what it
   * found, leaves somebody else's file sitting at that path - and the peer is being
   * asked about *its* copy, so it says yes. What gets unlinked is the
   * photographer's own file, never imported, deleted to free space for a photograph
   * whose original is somewhere else entirely.
   */
  it('refuses to evict a photograph whose path may be holding somebody else\'s file', async () => {
    const { a, b } = await transferred();
    // As a refused materialisation leaves it: a flag, and a stranger at the path.
    a.db
      .query("INSERT INTO materialisation_flags (library_id, photo_id, target_path, reason) VALUES (?, ?, ?, 'occupied')")
      .run(LIB, 'photo1', 'one.arw');
    writeFileSync(path.join(a.root, 'one.arw'), 'SOMEBODY-ELSE');

    const result = await a.transfers.evict(['photo1'], b.id);

    expect(result.evicted).toEqual([]);
    expect(result.refused[0]?.reason).toContain('outstanding');
    expect(readFileSync(path.join(a.root, 'one.arw'), 'utf8')).toBe('SOMEBODY-ELSE');
  });

  it('answers a possession check with no, while it is removing that very copy', async () => {
    const { a, b } = await transferred();
    // Held at the moment A has decided to delete and has not yet done it, which is
    // the window both devices are inside when they lose the last two copies.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    net.set(b.id, {
      request: async (reqPath: string, init?: RequestInit) => {
        if (reqPath.endsWith(route(PathSegment.verify()))) await held;
        return b.routes.request(reqPath, init);
      },
    } as unknown as Hono);

    const evicting = a.transfers.evict(['photo1'], b.id);
    await Bun.sleep(1);
    // B asks A the same question in that window. A still has the file on disk.
    const asked = await a.routes.request(route('photo1', PathSegment.verify()));

    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(true);
    expect(await asked.json()).toEqual({ held: false });
    release();
    await evicting;
  });

  // §12.3: the bulk bar names positions in a filtered collection, not ids - a
  // selection of a hundred thousand is one small request rather than the client
  // reading every id back first.
  it('takes a selection the server resolves, as the other bulk routes do', async () => {
    const { a, b } = await transferred();
    const resolved = new BlobsApi(
      a.photoPaths,
      a.photoMetadata,
      new PhotoProcessingRepository(a.db, new RenditionsRepository(a.db)),
      a.libraries,
      a.locations,
      a.transfers,
      () => {},
      () => true,
      () => ['photo1'],
    );
    applyErrorHandler(resolved.routes);

    const res = await resolved.routes.request(route(PathSegment.evict()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peer_id: b.id,
        target: { selection: { scope: { kind: 'library', id: LIB }, filters: {}, ranges: [{ start: 0, end: 0 }], members: [] } },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ evicted: ['photo1'], refused: [] });
    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(false);
  });

  // A server with no resolver answering "nothing" would report an eviction that
  // never ran, which on this route reads as "those copies are gone".
  it('refuses a selection it cannot resolve rather than evicting nothing quietly', async () => {
    const { a, b } = await transferred();

    const res = await a.routes.request(route(PathSegment.evict()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        peer_id: b.id,
        target: { selection: { scope: { kind: 'library', id: LIB }, filters: {}, ranges: [{ start: 0, end: 0 }], members: [] } },
      }),
    });

    expect(res.status).toBe(400);
    expect(existsSync(path.join(a.root, 'one.arw'))).toBe(true);
  });
});

// §7.10: a device set to keep the catalogue only. The refusal that counts is
// this one - the sending peer's greyed-out button reads an answer minutes old.
describe('a device that does not keep RAW files', () => {
  function viewer(peer: Peer): Hono {
    const api = new BlobsApi(
      peer.photoPaths,
      peer.photoMetadata,
      new PhotoProcessingRepository(peer.db, new RenditionsRepository(peer.db)),
      peer.libraries,
      peer.locations,
      peer.transfers,
      () => {},
      () => false,
    );
    applyErrorHandler(api.routes);
    return api.routes;
  }

  it('refuses a push before a byte of it is staged', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    net.set(b.id, viewer(b));

    await a.transfers.pushDiff(LIB, b.id, { library: true });
    await a.transfers.drain();

    expect(existsSync(path.join(b.root, 'one.arw'))).toBe(false);
    expect(stagedSize(stagePath(library(b), 'photo1'))).toBe(0);
    expect(b.locations.heldBy(LIB, 'photo1', b.id)).toBe(false);
  });

  it('refuses to queue a bulk fetch of what a peer holds', async () => {
    const b = makePeer('b');
    addPhoto(b, 'photo1', 'one.arw');

    const res = await viewer(b).request(route(PathSegment.pull()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ library_id: LIB, peer_id: b.id, scope: { library: true } }),
    });

    expect(res.status).toBe(409);
  });

  it('drops what was already queued to arrive, rather than delivering it anyway', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', a.id);
    expect(await b.transfers.pullDiff(LIB, a.id, { library: true })).toBe(1);

    expect(await b.transfers.cancelIncoming(LIB)).toBe(1);

    expect(b.transfers.list(LIB).map((t) => t.state)).toEqual(['cancelled']);
    // The other direction is about somebody else's disk, so it is left alone.
    expect(await a.transfers.pushDiff(LIB, b.id, { library: true })).toBe(1);
    expect(await a.transfers.cancelIncoming(LIB)).toBe(0);
    expect(a.transfers.list(LIB).map((t) => t.state)).toEqual(['queued']);
  });

  // The whole point of the setting is a device that browses everything and edits
  // the occasional photograph, so asking for one by hand is not what it refuses.
  it('still fetches a single original on request', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'one.arw');
    knowsHolder(b, 'photo1', a.id);

    const res = await viewer(b).request(route('photo1', PathSegment.fetch()), { method: 'POST' });

    expect(res.status).toBe(200);
  });
});

describe('reconcile', () => {
  it('asserts the self-row where bytes exist, retracts it where they have gone, and keeps shoot folders', async () => {
    const a = makePeer('a');
    addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
    a.db
      .query("INSERT INTO shoots (id, library_id, folder_path, name) VALUES ('shoot1', ?, 'Day2', 'Day two')")
      .run(LIB);

    await a.locations.reconcile(library(a));
    expect(a.locations.heldBy(LIB, 'photo1', a.id)).toBe(true);
    // §7.4: the shoot folder exists whether or not any of its blobs do.
    expect(existsSync(path.join(a.root, 'Day2'))).toBe(true);

    rmSync(path.join(a.root, 'Day1/one.arw'));
    await a.locations.reconcile(library(a));
    expect(a.locations.heldBy(LIB, 'photo1', a.id)).toBe(false);
    const grave = a.db
      .query("SELECT deleted FROM replication_log WHERE entity = 'blob_location' AND row_id = ?")
      .get(`photo1/${a.id}`) as { deleted: number } | null;
    expect(grave?.deleted).toBe(1);
  });
});
