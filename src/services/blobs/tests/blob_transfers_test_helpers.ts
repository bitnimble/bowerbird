import { Database } from '../../../db/driver';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlobsApi } from '../../../api/blobs/blobs_api';
import { applyErrorHandler } from '../../../api/error_handler';
import { runMigrations } from '../../../db/migrate';
import { LibrariesRepository } from '../../libraries/libraries_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { peerId } from '../../replication/stamps';
import { BlobLocations } from '../blob_locations';
import { BackupLocations } from '../../backup/backup_locations';
import type { PeerTransport } from '../peer';
import { TransferService } from '../transfer_service';
import { LibraryActivity } from '../../activity/library_activity';

// Two real replicas in one process: real temp directories, real files, and the
// blob endpoints answering each other through Hono's request(), which is the
// same seam the HTTP transport implements.

export const LIB = 'library1';

export interface Peer {
  id: string;
  db: Database;
  root: string;
  photoPaths: PhotoPathsRepository;
  photoMetadata: PhotoMetadataRepository;
  photoScan: PhotoScanRepository;
  libraries: LibrariesRepository;
  locations: BlobLocations;
  transfers: TransferService;
  activity: LibraryActivity;
  routes: Hono;
  /** Every request this peer sent, for asserting what actually travelled. */
  sent: { path: string; method: string; range: string | null }[];
  /** Photographs handed to the pipeline as their originals landed (§7.8). */
  built: string[];
}

export const net = new Map<string, Hono>();
const roots: string[] = [];

export function forgetPeers(): void {
  net.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function makePeer(name: string): Peer {
  const activity = new LibraryActivity();
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  const root = mkdtempSync(path.join(tmpdir(), `bb-blobs-${name}-`));
  roots.push(root);
  db.query(
    "INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, 'Trip', 'Bin')",
  ).run(LIB, root);
  db.query('INSERT INTO replication_libraries (library_id) VALUES (?)').run(LIB);

  const photoProcessing = new PhotoProcessingRepository(db, new RenditionsRepository(db));
  const photoPaths = new PhotoPathsRepository(db, new StackMembership(db));
  const photoMetadata = new PhotoMetadataRepository(db, photoProcessing);
  const photoScan = new PhotoScanRepository(db, photoProcessing);
  const libraries = new LibrariesRepository(db);
  const locations = new BlobLocations(db, activity);
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
    activity,
  );
  const api = new BlobsApi(
    photoPaths,
    photoMetadata,
    photoProcessing,
    libraries,
    locations,
    transfers,
    build,
    undefined,
    undefined,
    null,
    activity,
  );
  applyErrorHandler(api.routes);
  const id = peerId(db);
  net.set(id, api.routes);
  return {
    id,
    db,
    root,
    photoPaths,
    photoMetadata,
    photoScan,
    libraries,
    locations,
    transfers,
    activity,
    routes: api.routes,
    sent,
    built,
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
    capture_sequence: null,
  });
}

export function library(peer: Peer) {
  const lib = peer.libraries.getById(LIB);
  if (lib == null) throw new Error('library not found');
  return lib;
}
