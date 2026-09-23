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
import { dataPathForLibraryId, getRenditionPath } from '../../../utils/paths';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
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
  photoProcessing: PhotoProcessingRepository;
  libraries: LibrariesRepository;
  locations: BlobLocations;
  fetch: RenditionFetchService;
  routes: Hono;
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
  const api = new BlobsApi(photoPaths, photoMetadata, photoProcessing, libraries, locations, transfers);
  applyErrorHandler(api.routes);
  const id = peerId(db);
  net.set(id, api.routes);
  return {
    id,
    lib,
    db,
    root,
    photoScan,
    photoProcessing,
    libraries,
    locations,
    routes: api.routes,
    fetch: new RenditionFetchService(db, photoPaths, photoProcessing, libraries, locations, transport),
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
  it('refuses a rendition reported as built from a stamp the clock will not take', async () => {
    const { a, b } = holderAndReplica();
    const centuriesAhead = `ffffffffffff0000${'peerpeerpeerpeer'}`;
    buildTile(a, 'photo1', 'TILE-BYTES', centuriesAhead);
    edited(b, 'photo1', EDITED_AFTER);

    await expect(b.fetch.ensureCurrent('photo1', 'grid')).rejects.toThrow(/no peer holds a current/);
    expect(b.photoProcessing.renditionStamps('photo1', 'grid')?.built_from).toBeNull();
  });

  it('refuses a copy the holder has itself edited past', async () => {
    const { a, b } = holderAndReplica();
    buildTile(a, 'photo1', 'TILE-BYTES', EDITED_BEFORE);
    edited(a, 'photo1', EDITED_AFTER);

    await expect(b.fetch.ensureCurrent('photo1', 'grid')).rejects.toThrow(/no peer holds a current/);
    expect(existsSync(tilePath(b, 'photo1'))).toBe(false);
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
