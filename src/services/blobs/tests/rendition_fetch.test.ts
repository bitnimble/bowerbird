import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import type { Hono } from 'hono';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlobsApi } from '../../../api/blobs/blobs_api';
import { applyErrorHandler } from '../../../api/error_handler';
import { runMigrations } from '../../../db/migrate';
import { PathSegment, route } from '../../../schemas/route';
import { dataPathForLibraryId, getRenditionPath, originalPathOf } from '../../../utils/paths';
import { renditionVariant, storedAsHdr, type Rendition } from '../../processing/renditions/renditions';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { type BasicPhoto, PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoProcessingRepository, type RenditionStamps } from '../../photos/renditions/photo_processing_repository';
import type { PeerJpeg } from '../../photos/renditions/photo_rendition_service';
import { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { registerPeer } from '../../replication/pairing';
import { peerId } from '../../replication/stamps';
import { BlobLocations } from '../blob_locations';
import { RenditionFetchService, renditionCurrent } from '../rendition_fetch_service';
import { BackupLocations } from '../../backup/backup_locations';
import type { PeerTransport } from '../peer';
import { TransferService } from '../transfer_service';

// A device holding the catalogue but not the originals, serving pictures from a
// peer's built renditions (§7.9). Two replicas in one process, answering each
// other over the blob endpoints.

const BUILT_AT = '2026-02-01T00:00:00.000Z';
// Ordered as stamps order: fixed-width hex, so bytewise.
const EDITED_BEFORE = '01a000000000000000000000peerpeer';
const BUILT_FROM = '01a000000000000100000000peerpeer';
const EDITED_AFTER = '01a000000000000200000000peerpeer';

interface Peer {
  id: string;
  lib: string;
  db: Database;
  root: string;
  photoScan: PhotoScanRepository;
  photoPaths: PhotoPathsRepository;
  photoProcessing: PhotoProcessingRepository;
  libraries: LibrariesRepository;
  locations: BlobLocations;
  /** The camera JPEG inside each original this peer holds. */
  camera: Map<string, string>;
  fetch: RenditionFetchService;
  routes: Hono;
  /** Every fetched copy this peer told its clients had changed, as `stage of photo`. */
  announced: string[];
  /** What each fetch told its clients it was waiting on, as `rendition of photo: phase`. */
  phases: string[];
}

const net = new Map<string, Hono>();
const roots: string[] = [];
const dataDirs: string[] = [];
let libraryIds = 0;

afterEach(() => {
  net.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makePeer(name: string): Peer {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), `bb-rf-${name}-`));
  roots.push(root);
  // A library id per replica, where a real pair shares one: the data directory
  // holding the renditions is keyed by it and outlives the test, so a shared id
  // would have replicas - and cases - reading each other's cached tiles.
  const lib = `library-${name}-${++libraryIds}`;
  dataDirs.push(dataPathForLibraryId(lib));
  db.query("INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')").run(lib, root);
  db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(lib);

  const libraries = new LibrariesRepository(db);
  const renditions = new RenditionsRepository(db);
  const photoProcessing = new PhotoProcessingRepository(db, renditions);
  const photoPaths = new PhotoPathsRepository(db, new StackMembership(db));
  const photoScan = new PhotoScanRepository(db, photoProcessing);
  const photoMetadata = new PhotoMetadataRepository(db, photoProcessing);
  const locations = new BlobLocations(db);
  const transport: PeerTransport = {
    canReach: (peer) => net.has(peer),
    request: (peer, reqPath, init) => {
      const routes = net.get(peer);
      if (routes == null) throw new Error(`unknown peer: ${peer}`);
      return Promise.resolve(routes.request(reqPath, init));
    },
  };
  const transfers = new TransferService(
    db,
    photoPaths,
    photoMetadata,
    libraries,
    locations,
    new BackupLocations(db),
    transport,
  );
  const announced: string[] = [];
  const phases: string[] = [];
  const fetch = new RenditionFetchService(
    db,
    photoPaths,
    photoProcessing,
    libraries,
    locations,
    transport,
    (photoId, written) => announced.push(`${written.stage} of ${photoId}`),
    (photoId, rendition, phase) => phases.push(`${rendition} of ${photoId}: ${phase ?? 'settled'}`),
  );
  const camera = new Map<string, string>();
  const originalHere = (photoId: string): boolean => {
    const photo = photoPaths.getBasicById(photoId);
    const lib = photo == null ? null : libraries.getById(photo.library_id);
    const original = photo == null || lib == null ? null : originalPathOf(lib, photo);
    return original != null && existsSync(original);
  };
  // `PhotoRenditionService`'s contract with a peer, minus the pixels: rendered from an original on
  // this disk at the range asked and stamped with the edits it rendered - never a tile, which is
  // the queue's - and otherwise passed on.
  const renderer = {
    buildForPeer: async (photoId: string, rendition: Rendition, hdr: boolean, via: readonly string[], force = false): Promise<void> => {
      if (!originalHere(photoId)) return fetch.relay(photoId, rendition, hdr, via, force);
      if (rendition === 'grid') return;
      const photo = photoPaths.getBasicById(photoId);
      const lib = photo == null ? null : libraries.getById(photo.library_id);
      if (lib == null) return;
      const target = getRenditionPath(lib, photoId, rendition, hdr);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${renditionVariant(rendition, hdr)} of ${photoId}${force ? ', forced' : ''}`);
      const editedFrom = photoProcessing.renditionStamps(photoId, rendition)?.edited_from ?? null;
      photoProcessing.markCopyBuilt(photoId, BUILT_AT, editedFrom, renditionVariant(rendition, hdr));
    },
    embeddedJpegForPeer: async (photoId: string, via: readonly string[]): Promise<PeerJpeg | null> => {
      const lifted = camera.get(photoId);
      const stamps = (): RenditionStamps | null => photoProcessing.renditionStamps(photoId, 'embedded');
      if (lifted != null) return { bytes: new TextEncoder().encode(lifted), builtFrom: stamps()?.edited_from ?? null };
      await fetch.relay(photoId, 'embedded', false, via);
      const photo = photoPaths.getBasicById(photoId);
      const lib = photo == null ? null : libraries.getById(photo.library_id);
      const now = stamps();
      if (lib == null || !renditionCurrent(now?.built_from ?? null, now?.edited_from ?? null)) return null;
      const cached = getRenditionPath(lib, photoId, 'embedded', false);
      return existsSync(cached) ? { bytes: readFileSync(cached), builtFrom: now?.built_from ?? null } : null;
    },
  };
  const api = new BlobsApi(
    photoPaths,
    photoMetadata,
    photoProcessing,
    libraries,
    locations,
    transfers,
    undefined,
    undefined,
    undefined,
    renderer,
  );
  applyErrorHandler(api.routes);
  const id = peerId(db);
  net.set(id, api.routes);
  return {
    id,
    lib,
    db,
    root,
    photoScan,
    photoPaths,
    photoProcessing,
    libraries,
    locations,
    camera,
    routes: api.routes,
    fetch,
    announced,
    phases,
  };
}

function addPhoto(peer: Peer, id: string, relPath: string, bytes?: string): void {
  if (bytes != null) {
    const abs = path.join(peer.root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  peer.photoScan.insertFromScan({
    id,
    library_id: peer.lib,
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
    capture_sequence: null,
  });
}

function library(peer: Peer) {
  const lib = peer.libraries.getById(peer.lib);
  if (lib == null) throw new Error('library not found');
  return lib;
}

function tilePath(peer: Peer, photoId: string): string {
  return getRenditionPath(library(peer), photoId, 'grid', false);
}

/** A rendition the pipeline built, as a holder would hold it. */
function buildTile(peer: Peer, photoId: string, bytes: string, builtFrom: string | null = null): void {
  const abs = tilePath(peer, photoId);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  peer.photoProcessing.markTileBuilt(photoId, BUILT_AT, builtFrom, { from: 'render', matched: true });
}

// A stamp rather than a time, because that is what staleness is decided on: the
// edit and the build happen on different machines, so a wall clock decides it
// against somebody else's clock.
function edited(peer: Peer, photoId: string, at: string): void {
  peer.db
    .query("INSERT INTO photo_edits (photo_id, doc, cursor, rev, updated_at, stamp) VALUES (?, '{}', 0, 1, ?, ?)")
    .run(photoId, BUILT_AT, at);
}

/** Both sides of a pairing, which is what makes a peer a fetch candidate. */
function pair(a: Peer, b: Peer, photoId: string): void {
  registerPeer(a.db, a.lib, b.id, 'b');
  registerPeer(b.db, b.lib, a.id, 'a');
  b.db
    .query('INSERT OR IGNORE INTO blob_locations (library_id, photo_id, peer_id, stamp) VALUES (?, ?, ?, ?)')
    .run(b.lib, photoId, a.id, `ffffffffffff0000${a.id}`);
}

/** A holds the original and a built tile; B holds the catalogue row alone. */
function holderAndReplica(): { a: Peer; b: Peer } {
  const a = makePeer('a');
  const b = makePeer('b');
  addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
  addPhoto(b, 'photo1', 'Day1/one.arw');
  pair(a, b, 'photo1');
  return { a, b };
}

describe('renditionCurrent', () => {
  it('is current until the develop settings move past what it was built from', () => {
    expect(renditionCurrent(null, null)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, null)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, BUILT_FROM)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, EDITED_BEFORE)).toBe(true);
    expect(renditionCurrent(BUILT_FROM, EDITED_AFTER)).toBe(false);
    expect(renditionCurrent(null, EDITED_AFTER)).toBe(false);
  });

  /**
   * The reason this is stamps and not times.
   *
   * A build happens on whichever peer holds the original and an edit on whichever
   * peer made it, and a catalogue-only peer never builds at all - so the two values
   * come from different machines' clocks as a matter of course. A clock a minute
   * slow hides the edit for good: nothing re-queues it, the holder serves the old
   * picture to every peer as current, and the reader watches their own edit fail to
   * appear. A minute is well inside what the HLC deliberately absorbs.
   */
  it('is decided on values that do not come from a wall clock', () => {
    const editedOnASlowPeer = EDITED_AFTER;
    const builtHereALittleLater = BUILT_FROM;

    expect(editedOnASlowPeer > builtHereALittleLater).toBe(true);
    expect(renditionCurrent(builtHereALittleLater, editedOnASlowPeer)).toBe(false);
  });
});

describe('fetching a rendition through a peer', () => {
  it('caches a holder-built tile where the local pipeline would have written it', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
    // Recorded against the settings the *sender* rendered, so an edit replicated
    // later still reads as newer than the copy it invalidates.
    expect(b.photoProcessing.renditionStamps('photo1', 'grid')?.built_from).toBe(BUILT_FROM);

    // A second ask is answered from the cache, with the holder gone.
    net.delete(a.id);
    await b.fetch.ensureCurrent('photo1', 'grid');
    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
  });

  it('says it is fetching a copy the holder has, and rendering one it has to build', async () => {
    const { a, b } = holderAndReplica();
    await b.fetch.ensureCurrent('photo1', 'full');
    await b.fetch.ensureCurrent('photo1', 'full', true);
    a.camera.set('photo1', 'JPEG-one');
    await b.fetch.ensureCurrent('photo1', 'embedded');

    expect(b.phases).toEqual([
      'full of photo1: rendering',
      'full of photo1: settled',
      'full of photo1: rendering',
      'full of photo1: settled',
      'embedded of photo1: fetching',
      'embedded of photo1: settled',
    ]);
  });

  it('says it is fetching when the holder already built the rendition', async () => {
    const { a, b } = holderAndReplica();
    const hdr = storedAsHdr('full', library(b).rendition_hdr);
    const built = getRenditionPath(library(a), 'photo1', 'full', hdr);
    mkdirSync(path.dirname(built), { recursive: true });
    writeFileSync(built, 'FULL-BYTES');
    a.photoProcessing.markCopyBuilt('photo1', BUILT_AT, BUILT_FROM, renditionVariant('full', hdr));

    await b.fetch.ensureCurrent('photo1', 'full');

    expect(b.phases).toEqual(['full of photo1: fetching', 'full of photo1: settled']);
  });

  it('keeps a grid scroll quiet', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);
    await b.fetch.ensureCurrent('photo1', 'grid');
    expect(b.phases).toEqual([]);
  });

  // The one thing a caller needs that the bytes cannot tell it: which develop
  // settings they are of, so it can hold them against an edit this holder has not
  // been told about yet.
  it('reports which settings it rendered', async () => {
    const { a } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

    const res = await a.routes.request(route('photo1', PathSegment.rendition(), 'grid'));

    expect(res.headers.get('x-rendition-built-from')).toBe(BUILT_FROM);
  });

  it('leaves a photo alone when the original is here to build from', async () => {
    const a = makePeer('a');
    const b = makePeer('b');
    addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
    addPhoto(b, 'photo1', 'Day1/one.arw', 'RAW-one');
    pair(a, b, 'photo1');
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(existsSync(tilePath(b, 'photo1'))).toBe(false);
  });

  /**
   * A reported build stamp is bounded, not merely well formed.
   *
   * It lands in the column that decides staleness from then on, so a peer answering
   * with a stamp dated centuries ahead - which is a valid stamp - would leave this
   * device holding a rendition no edit could ever sort above, and re-advertising
   * that stamp to the next peer. Contagious, permanent, and silent.
   */
  it('never records a build stamp the clock will not take', async () => {
    const { a, b } = holderAndReplica();
    const centuriesAhead = `ffffffffffff0000${'peerpeerpeerpeer'}`;
    buildTile(a, 'photo1', 'TILE-BYTES', centuriesAhead);
    edited(b, 'photo1', EDITED_AFTER);

    await b.fetch.ensureCurrent('photo1', 'grid');
    expect(b.photoProcessing.renditionStamps('photo1', 'grid')?.built_from).toBeNull();
  });

  // Every edit made here while the two devices cannot sync is one the holder never hears of.
  it('shows the holder’s copy from before an edit made here rather than a hole, still owed', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);
    edited(b, 'photo1', EDITED_AFTER);

    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
    const stamps = b.photoProcessing.renditionStamps('photo1', 'grid');
    expect(renditionCurrent(stamps?.built_from ?? null, stamps?.edited_from ?? null)).toBe(false);
  });

  it('refuses a copy the holder has itself edited past', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', EDITED_BEFORE);
    edited(a, 'photo1', EDITED_AFTER);

    await expect(b.fetch.ensureCurrent('photo1', 'grid')).rejects.toThrow(/no peer holds a current/);
    expect(existsSync(tilePath(b, 'photo1'))).toBe(false);
  });

  it('has the holder render a copy it lacks, at the range this device shows', async () => {
    const { b } = holderAndReplica();
    b.db.query('UPDATE libraries SET rendition_hdr = 1 WHERE id = ?').run(b.lib);

    await b.fetch.ensureCurrent('photo1', 'max');

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'max', true), 'utf8')).toBe('max-hdr of photo1');
  });

  it('has the holder lift the camera JPEG out of its original', async () => {
    const { a, b } = holderAndReplica();
    a.camera.set('photo1', 'CAMERA-JPEG');

    await b.fetch.ensureCurrent('photo1', 'embedded');

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'embedded', false), 'utf8')).toBe('CAMERA-JPEG');
  });

  describe('through a device that holds no original either', () => {
    // A holds the original, B syncs with A, and C syncs with B alone and has never heard of A.
    function chain(): { a: Peer; b: Peer; c: Peer } {
      const { a, b } = holderAndReplica();
      const c = makePeer('c');
      addPhoto(c, 'photo1', 'Day1/one.arw');
      pair(b, c, 'photo1');
      return { a, b, c };
    }

    it('passes the request on to the holder, and keeps the copy on the way back', async () => {
      const { b, c } = chain();
      c.db.query('UPDATE libraries SET rendition_hdr = 1 WHERE id = ?').run(c.lib);

      await c.fetch.ensureCurrent('photo1', 'max');

      expect(readFileSync(getRenditionPath(library(c), 'photo1', 'max', true), 'utf8')).toBe('max-hdr of photo1');
      expect(readFileSync(getRenditionPath(library(b), 'photo1', 'max', true), 'utf8')).toBe('max-hdr of photo1');
    });

    it('passes a forced render on, past the copy it holds itself', async () => {
      const { b, c } = chain();
      await c.fetch.ensureCurrent('photo1', 'max');

      await c.fetch.ensureCurrent('photo1', 'max', true);

      expect(readFileSync(getRenditionPath(library(c), 'photo1', 'max', true), 'utf8')).toBe('max-hdr of photo1, forced');
      expect(readFileSync(getRenditionPath(library(b), 'photo1', 'max', true), 'utf8')).toBe('max-hdr of photo1, forced');
    });

    it("passes on the camera's JPEG", async () => {
      const { a, c } = chain();
      a.camera.set('photo1', 'CAMERA-JPEG');

      await c.fetch.ensureCurrent('photo1', 'embedded');

      expect(readFileSync(getRenditionPath(library(c), 'photo1', 'embedded', false), 'utf8')).toBe('CAMERA-JPEG');
    });

    it('passes on a tile the holder built', async () => {
      const { a, c } = chain();
      buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

      await c.fetch.ensureCurrent('photo1', 'grid');

      expect(readFileSync(tilePath(c, 'photo1'), 'utf8')).toBe('TILE-BYTES');
    });

    it('lands two requests passed on at once for the same copy, whole', async () => {
      const { a, b } = holderAndReplica();
      buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);

      await Promise.all([b.fetch.relay('photo1', 'grid', false, []), b.fetch.relay('photo1', 'grid', false, [])]);

      expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
      expect(readdirSync(path.dirname(tilePath(b, 'photo1')))).toEqual(['photo1.avif']);
    });

    // Each can reach the other and neither has the original: every request that goes round comes
    // back to a device already on its path, which refuses to ask again rather than waiting on itself.
    it('gives up rather than going round two devices that each ask the other', async () => {
      const b = makePeer('b');
      const c = makePeer('c');
      addPhoto(b, 'photo1', 'Day1/one.arw');
      addPhoto(c, 'photo1', 'Day1/one.arw');
      pair(b, c, 'photo1');

      await expect(c.fetch.ensureCurrent('photo1', 'full')).rejects.toThrow(/no peer holds a current/);
    });
  });

  it('takes pictures from a peer on a library that keeps no originals', async () => {
    const { b } = holderAndReplica();
    b.db.query('UPDATE replication_libraries SET sync_originals = 0 WHERE library_id = ?').run(b.lib);

    await b.fetch.ensureCurrent('photo1', 'full');

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'full', true), 'utf8')).toBe('full-hdr of photo1');
  });

  it('takes a photo from a peer on a library that keeps no originals, until its original is fetched here', () => {
    const { b } = holderAndReplica();
    const photo = (): BasicPhoto => {
      const row = b.photoPaths.getBasicById('photo1');
      if (row == null) throw new Error('photo not found');
      return row;
    };
    expect(b.fetch.takesFromPeer(library(b), photo())).toBe(false);

    b.db.query('UPDATE replication_libraries SET sync_originals = 0 WHERE library_id = ?').run(b.lib);
    expect(b.fetch.takesFromPeer(library(b), photo())).toBe(true);

    mkdirSync(path.join(b.root, 'Day1'), { recursive: true });
    writeFileSync(path.join(b.root, 'Day1/one.arw'), 'RAW-one');
    expect(b.fetch.takesFromPeer(library(b), photo())).toBe(false);
  });

  it('has the holder render again when forced, and tells clients the copy they hold has changed', async () => {
    const { b } = holderAndReplica();
    await b.fetch.ensureCurrent('photo1', 'full');
    expect(b.announced).toEqual([]);

    await b.fetch.ensureCurrent('photo1', 'full', true);

    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'full', true), 'utf8')).toBe('full-hdr of photo1, forced');
    expect(b.announced).toEqual(['renditions of photo1']);
  });

  it('says a forced render did not happen when no peer can answer, keeping the copy it had', async () => {
    const { a, b } = holderAndReplica();
    await b.fetch.ensureCurrent('photo1', 'full');
    net.delete(a.id);

    await expect(b.fetch.ensureCurrent('photo1', 'full', true)).rejects.toThrow(/no peer holds a current/);
    expect(readFileSync(getRenditionPath(library(b), 'photo1', 'full', true), 'utf8')).toBe('full-hdr of photo1');
  });

  it('keeps a stale cached copy rather than a hole when no peer can answer', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', BUILT_FROM);
    await b.fetch.ensureCurrent('photo1', 'grid');

    // An edit lands here that the holder has not replicated, so nothing it holds
    // is current any more.
    edited(b, 'photo1', EDITED_AFTER);
    await b.fetch.ensureCurrent('photo1', 'grid');

    expect(readFileSync(tilePath(b, 'photo1'), 'utf8')).toBe('TILE-BYTES');
  });
});
