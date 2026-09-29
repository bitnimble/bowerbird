import { Database } from '../../../db/driver';
import type { Hono } from 'hono';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlobsApi } from '../../../api/blobs/blobs_api';
import { applyErrorHandler } from '../../../api/error_handler';
import { runMigrations } from '../../../db/migrate';
import { dataPathForLibraryId, getRenditionPath, originalPathOf } from '../../../utils/paths';
import { renditionVariant, type Rendition } from '../../processing/renditions/renditions';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import {
  PhotoProcessingRepository,
  type RenditionStamps,
} from '../../photos/renditions/photo_processing_repository';
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

export const BUILT_AT = '2026-02-01T00:00:00.000Z';
// Ordered as stamps order: fixed-width hex, so bytewise.
export const EDITED_BEFORE = '01a000000000000000000000peerpeer';
export const BUILT_FROM = '01a000000000000100000000peerpeer';
export const EDITED_AFTER = '01a000000000000200000000peerpeer';

export interface Peer {
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
  transport: PeerTransport;
  routes: Hono;
  /** Every fetched copy this peer told its clients had changed, as `stage of photo`. */
  announced: string[];
  /** What each fetch told its clients it was waiting on, as `rendition of photo: phase`. */
  phases: string[];
}

export const net = new Map<string, Hono>();
const roots: string[] = [];
const dataDirs: string[] = [];
let libraryIds = 0;

export function forgetPeers(): void {
  net.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function makePeer(name: string): Peer {
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
  db.query(
    "INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')",
  ).run(lib, root);
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
    buildForPeer: async (
      photoId: string,
      rendition: Rendition,
      hdr: boolean,
      via: readonly string[],
      force = false,
    ): Promise<void> => {
      if (!originalHere(photoId)) return fetch.relay(photoId, rendition, hdr, via, force);
      if (rendition === 'grid') return;
      const photo = photoPaths.getBasicById(photoId);
      const lib = photo == null ? null : libraries.getById(photo.library_id);
      if (lib == null) return;
      const target = getRenditionPath(lib, photoId, rendition, hdr);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        `${renditionVariant(rendition, hdr)} of ${photoId}${force ? ', forced' : ''}`,
      );
      const editedFrom = photoProcessing.renditionStamps(photoId, rendition)?.edited_from ?? null;
      photoProcessing.markCopyBuilt(
        photoId,
        BUILT_AT,
        editedFrom,
        renditionVariant(rendition, hdr),
      );
    },
    embeddedJpegForPeer: async (
      photoId: string,
      via: readonly string[],
    ): Promise<PeerJpeg | null> => {
      const lifted = camera.get(photoId);
      const stamps = (): RenditionStamps | null =>
        photoProcessing.renditionStamps(photoId, 'embedded');
      if (lifted != null)
        return {
          bytes: new TextEncoder().encode(lifted),
          builtFrom: stamps()?.edited_from ?? null,
        };
      await fetch.relay(photoId, 'embedded', false, via);
      const photo = photoPaths.getBasicById(photoId);
      const lib = photo == null ? null : libraries.getById(photo.library_id);
      const now = stamps();
      if (lib == null || !renditionCurrent(now?.built_from ?? null, now?.edited_from ?? null))
        return null;
      const cached = getRenditionPath(lib, photoId, 'embedded', false);
      return existsSync(cached)
        ? { bytes: readFileSync(cached), builtFrom: now?.built_from ?? null }
        : null;
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
    transport,
    announced,
    phases,
  };
}

export function addPhoto(peer: Peer, id: string, relPath: string, bytes?: string): void {
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

export function library(peer: Peer) {
  const lib = peer.libraries.getById(peer.lib);
  if (lib == null) throw new Error('library not found');
  return lib;
}

export function tilePath(peer: Peer, photoId: string): string {
  return getRenditionPath(library(peer), photoId, 'grid', false);
}

/** A rendition the pipeline built, as a holder would hold it. */
export function buildTile(
  peer: Peer,
  photoId: string,
  bytes: string,
  builtFrom: string | null = null,
): void {
  const abs = tilePath(peer, photoId);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  peer.photoProcessing.markTileBuilt(photoId, BUILT_AT, builtFrom, {
    from: 'render',
    matched: true,
  });
}

/** Both sides of a pairing, which is what makes a peer a fetch candidate. */
export function pair(a: Peer, b: Peer, photoId: string): void {
  registerPeer(a.db, a.lib, b.id, 'b');
  registerPeer(b.db, b.lib, a.id, 'a');
  b.db
    .query(
      'INSERT OR IGNORE INTO blob_locations (library_id, photo_id, peer_id, stamp) VALUES (?, ?, ?, ?)',
    )
    .run(b.lib, photoId, a.id, `ffffffffffff0000${a.id}`);
}

/** A holds the original and a built tile; B holds the catalogue row alone. */
export function holderAndReplica(): { a: Peer; b: Peer } {
  const a = makePeer('a');
  const b = makePeer('b');
  addPhoto(a, 'photo1', 'Day1/one.arw', 'RAW-one');
  addPhoto(b, 'photo1', 'Day1/one.arw');
  pair(a, b, 'photo1');
  return { a, b };
}
