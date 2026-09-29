import { Database } from '../../../db/driver';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../../db/migrate';
import { newId } from '../../../schemas/id';
import { PathSegment, route } from '../../../schemas/route';
import { BlobLocations } from '../../../services/blobs/blob_locations';
import { LibrariesRepository } from '../../../services/libraries/libraries_repository';
import { PhotoStateRepository } from '../../../services/photos/mutations/photo_state_repository';
import { PhotoProcessingRepository } from '../../../services/photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../../services/photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../../services/processing/renditions/renditions_repository';
import { StackMembership } from '../../../services/stacks/stack_membership';
import { addReplica } from '../../../services/replication/remote';
import { ReplicationRunner } from '../../../services/replication/replication_runner';
import { ReplicationService } from '../../../services/replication/replication_service';
import { SyncLocksRepository } from '../../../services/sync/coordination/sync_locks_repository';
import type { Replica } from '../../../services/replication/session';
import { applyErrorHandler } from '../../error_handler';
import { ReplicationApi } from '../replication_api';

export const LIB = 'photolib';
export const SHOOT = 'shoot001';

export interface Server {
  db: Database;
  url: string;
  replica: Replica;
  stop: () => void;
}

const running: Server[] = [];
const roots: string[] = [];

/** For `afterEach`: stops every server and removes every clone root the test made. */
export function cleanUp(): void {
  while (running.length > 0) running.pop()!.stop();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
}

export function catalogue(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runnerFor(db: Database): ReplicationRunner {
  return new ReplicationRunner(
    db,
    new SyncLocksRepository(db),
    new LibrariesRepository(db),
    new BlobLocations(db),
    () => {},
    () => {},
    () => {},
    () => Promise.resolve(0),
  );
}

export function serve(db: Database, now: () => number = Date.now): Server {
  const app = new Hono();
  app.route(
    route(PathSegment.api(), PathSegment.replication()),
    new ReplicationApi(new ReplicationService(db, new BlobLocations(db), now, () => {}), runnerFor(db)).routes,
  );
  applyErrorHandler(app);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const built: Server = {
    db,
    url: `http://localhost:${server.port}`,
    replica: { db, libraryId: LIB },
    stop: () => server.stop(true),
  };
  running.push(built);
  return built;
}

export function seedLibrary(db: Database, photos: number): void {
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, ?, 'Trip')").run(LIB, `/libraries/${newId()}`);
  db.query('INSERT INTO shoots (id, library_id, folder_path, name) VALUES (?, ?, ?, ?)').run(
    SHOOT,
    LIB,
    'trip',
    'Trip',
  );
  const scan = new PhotoScanRepository(db, new PhotoProcessingRepository(db, new RenditionsRepository(db)));
  const state = new PhotoStateRepository(db, new StackMembership(db));
  for (let i = 1; i <= photos; i++) {
    scan.insertFromScan({
      id: `p${i}`,
      library_id: LIB,
      shoot_id: null,
      file_hash: `hash-p${i}`,
      file_path: `p${i}.arw`,
      file_size: 100,
      width: 60,
      height: 40,
      orientation: 0,
      date_taken: '2026-01-01T00:00:00.000Z',
      date_taken_offset: null,
      date_added: '2026-01-01T00:00:00.000Z',
      date_updated: null,
      latitude: null,
      longitude: null,
      iso: null,
      shutter_speed: null,
      aperture: null,
      focal_length: null,
      camera_make: null,
      camera_model: null,
      lens_model: null,
      binned: null,
    } as never);
  }
  state.update('p1', { rating: 4 });
}

export async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${route(PathSegment.api(), PathSegment.replication())}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The whole §9 dance: an origin server with a seeded library, and a fresh replica paired to it. */
export async function pairedClone(photos = 3, syncOriginals = true): Promise<{ origin: Server; clone: Server }> {
  const origin = serve(catalogue());
  seedLibrary(origin.db, photos);
  const clone = serve(catalogue());
  await addReplica(clone.db, origin.url, LIB, cloneRoot(), syncOriginals);
  return { origin, clone };
}

// A real, empty, writable directory: `addReplica` refuses anything else, since
// whatever is already there would be imported as the library's own (§9.1).
export function cloneRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bowerbird-clone-'));
  roots.push(root);
  return root;
}

export function peerIdOf(db: Database): string {
  const identity = db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string };
  return identity.peer_id;
}
