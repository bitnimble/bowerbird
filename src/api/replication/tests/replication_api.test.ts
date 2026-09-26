// Two real servers over real HTTP, replicating two real catalogues: the one
// place the transport itself - pairing, handshake refusals, paged fetches, the
// validation boundary - is what is being tested. Everything about *merging* is
// pinned one layer down in `src/services/replication/tests`.
import { Database } from '../../../db/driver';
import { afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { latestMigrationMillis, runMigrations } from '../../../db/migrate';
import { newId } from '../../../schemas/id';
import { REPLICATION_PROTOCOL } from '../../../schemas/replication';
import { PathSegment, route } from '../../../schemas/route';
import { BlobLocations } from '../../../services/blobs/blob_locations';
import { LibrariesRepository } from '../../../services/libraries/libraries_repository';
import { PhotoStateRepository } from '../../../services/photos/mutations/photo_state_repository';
import { PhotoProcessingRepository } from '../../../services/photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../../services/photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../../services/processing/renditions/renditions_repository';
import { StackMembership } from '../../../services/stacks/stack_membership';
import { DEFAULT_SKEW_MS } from '../../../services/replication/clock';
import { forgetLibrary } from '../../../services/replication/gc';
import {
  autoTransfersOriginals,
  pairedPeers,
  peerAddress,
  setAutoTransfersOriginals,
  setSyncsOriginals,
  syncsOriginals,
} from '../../../services/replication/pairing';
import { addReplica, browseRemote, openRemote, pullFromRemote, pushToRemote } from '../../../services/replication/remote';
import { ReplicationRunner } from '../../../services/replication/replication_runner';
import { ReplicationService } from '../../../services/replication/replication_service';
import { SyncLocksRepository } from '../../../services/sync/coordination/sync_locks_repository';
import { pullFrom, type ChangeSource, type Replica } from '../../../services/replication/session';
import { stamp } from '../../../services/replication/stamps';
import { replicatedState } from '../../../services/replication/tests/peers';
import { applyErrorHandler } from '../../error_handler';
import { ReplicationApi } from '../replication_api';

const LIB = 'photolib';
const SHOOT = 'shoot001';

interface Server {
  db: Database;
  url: string;
  replica: Replica;
  stop: () => void;
}

const running: Server[] = [];
afterEach(() => {
  while (running.length > 0) running.pop()!.stop();
});

function catalogue(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

function serve(db: Database, now: () => number = Date.now): Server {
  const app = new Hono();
  const runner = new ReplicationRunner(
    db,
    new SyncLocksRepository(db),
    new LibrariesRepository(db),
    new BlobLocations(db),
    () => {},
    () => {},
    () => {},
    () => Promise.resolve(0),
  );
  app.route(
    route(PathSegment.api(), PathSegment.replication()),
    new ReplicationApi(new ReplicationService(db, new BlobLocations(db), now, () => {}), runner).routes,
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

function seedLibrary(db: Database, photos: number): void {
  db.query("INSERT INTO libraries (id, root_path, name) VALUES (?, ?, 'Trip')").run(LIB, `/photos/${newId()}`);
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

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${route(PathSegment.api(), PathSegment.replication())}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The whole §9 dance: an origin server with a seeded library, and a fresh replica paired to it. */
async function pairedClone(photos = 3, syncOriginals = true): Promise<{ origin: Server; clone: Server }> {
  const origin = serve(catalogue());
  seedLibrary(origin.db, photos);
  const clone = serve(catalogue());
  await addReplica(clone.db, origin.url, LIB, cloneRoot(), syncOriginals);
  return { origin, clone };
}

// A real, empty, writable directory: `addReplica` refuses anything else, since
// whatever is already there would be imported as the library's own (§9.1).
function cloneRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bowerbird-clone-'));
  roots.push(root);
  return root;
}

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function peerIdOf(db: Database): string {
  const identity = db.query('SELECT peer_id FROM replication_identity').get() as { peer_id: string };
  return identity.peer_id;
}

describe('clone (§9)', () => {
  it('brings a fresh replica to exactly what the origin holds, ids verbatim, over the ordinary stream', async () => {
    const { origin, clone } = await pairedClone();

    const pulled = await pullFromRemote(clone.replica, origin.url);
    expect(pulled.applied).toBeGreaterThan(0);
    expect(pulled.deferred).toBe(0);

    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
    const ids = clone.db.query('SELECT id FROM photos ORDER BY id').all() as { id: string }[];
    expect(ids.map((row) => row.id)).toEqual(['p1', 'p2', 'p3']);

    // Nothing left to say: a second session finds the vector already covers it.
    const again = await pullFromRemote(clone.replica, origin.url);
    expect(again.applied).toBe(0);
  });

  it('births a replica and fills it in one request, then replicates on the address it kept', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 3);
    const clone = serve(catalogue());

    const browsed = await post(clone.url, route(PathSegment.replicas(), PathSegment.browse()), { address: `${origin.url}/` });
    expect(browsed.status).toBe(200);
    expect(await browsed.json()).toMatchObject({
      libraries: [{ id: LIB, name: 'Trip', photo_count: 3, read_only: false }],
    });

    const created = await post(clone.url, route(PathSegment.replicas()), {
      address: `${origin.url}/`,
      library_id: LIB,
      root_path: cloneRoot(),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ library_id: LIB, peer_id: peerIdOf(origin.db) });
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));

    // The address pairing recorded is what a later session dials, so "sync now"
    // needs nothing but the library.
    new PhotoStateRepository(origin.db, new StackMembership(origin.db)).update('p2', { rating: 5 });
    const again = await post(clone.url, route(PathSegment.libraries(), LIB, PathSegment.replicate()), {});
    expect(await again.json()).toMatchObject({ peers: 1 });
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
  });

  // Listed rather than hidden, because a library missing with no reason given is
  // what has somebody checking their network for an hour (§9.1).
  it('offers a readonly library in the list and refuses to pair it', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    origin.db
      .query("INSERT INTO libraries (id, root_path, name, read_only) VALUES ('rolib000', '/ro', 'RO', 1)")
      .run();

    const offered = (await (
      await fetch(`${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries())}`)
    ).json()) as {
      libraries: { id: string; read_only: boolean; replicating: boolean }[];
    };
    expect(offered.libraries.find((l) => l.id === 'rolib000')).toMatchObject({ read_only: true });
    // Not yet paired with anyone, so nothing claims to be replicating.
    expect(offered.libraries.every((l) => !l.replicating)).toBe(true);

    const response = await post(origin.url, route(PathSegment.pair()), {
      library_id: 'rolib000',
      peer_id: 'peerbbbbbbbbbbbb',
      name: 'Macbook',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'READ_ONLY' } });
  });

  it('says which of its libraries it already replicates, so the list can say so', async () => {
    const { origin } = await pairedClone(1);

    const offered = (await (
      await fetch(`${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries())}`)
    ).json()) as {
      libraries: { id: string; replicating: boolean }[];
    };
    expect(offered.libraries.find((l) => l.id === LIB)).toMatchObject({ replicating: true });
  });
});

describe('sessions over HTTP (§6.2)', () => {
  // The trip, and the whole point of the feature: only the laptop can dial, so if
  // dialling did not also *offer*, a fortnight of work would stay on the laptop.
  it('carries the dialling peer\'s own work to a peer that can never dial back', async () => {
    const { origin, clone } = await pairedClone();
    await pullFromRemote(clone.replica, origin.url);

    // The origin knows no address for the clone - a laptop is behind whatever
    // network it is on - so it can never start a session of its own.
    expect(
      origin.db.query('SELECT address FROM replication_peers WHERE peer_id = ?').get(peerIdOf(clone.db)),
    ).toEqual({ address: null });

    new PhotoStateRepository(clone.db, new StackMembership(clone.db)).update('p2', { rating: 4, notes: 'shot on the trip' });
    const given = await pushToRemote(clone.replica, origin.url);

    expect(given.applied).toBeGreaterThan(0);
    expect(origin.db.query('SELECT rating, notes FROM photos WHERE id = ?').get('p2')).toEqual({
      rating: 4,
      notes: 'shot on the trip',
    });
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));

    // And the origin has taken coverage of it, so it does not ask again.
    const again = await pushToRemote(clone.replica, origin.url);
    expect(again.applied).toBe(0);
  });

  it('replicates both directions, each side pulling from the other', async () => {
    const { origin, clone } = await pairedClone();
    await pullFromRemote(clone.replica, origin.url);

    new PhotoStateRepository(origin.db, new StackMembership(origin.db)).update('p1', { rating: 5 });
    new PhotoStateRepository(clone.db, new StackMembership(clone.db)).update('p2', { notes: 'keep this one' });

    await pullFromRemote(clone.replica, origin.url);
    await pullFromRemote(origin.replica, clone.url);

    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
    expect(origin.db.query('SELECT notes FROM photos WHERE id = ?').get('p2')).toEqual({
      notes: 'keep this one',
    });
    expect(clone.db.query('SELECT rating FROM photos WHERE id = ?').get('p1')).toEqual({ rating: 5 });

    // The ack told the origin what the clone now holds (§8.3), so its tombstone
    // GC is bounded by a real vector rather than an absent one.
    const acked = origin.db
      .query('SELECT COUNT(*) AS n FROM replication_peer_vectors WHERE peer_id = ?')
      .get(peerIdOf(clone.db)) as { n: number };
    expect(acked.n).toBeGreaterThan(0);
  });

  it('loses nothing to an interrupted session: the vector stays put and a rerun finishes the job', async () => {
    const { origin, clone } = await pairedClone(12);

    const source = await openRemote(clone.replica, origin.url);
    let pages = 0;
    const cut: ChangeSource = {
      peer: source.peer,
      delivered: source.delivered,
      page: (held, cursor, limit) => {
        if (pages++ === 2) throw new Error('network gone');
        return source.page(held, cursor, limit);
      },
    };
    await expect(pullFrom(clone.replica, cut, 8)).rejects.toThrow('network gone');

    const applied = clone.db.query('SELECT COUNT(*) AS n FROM photos').get() as { n: number };
    expect(applied.n).toBeGreaterThan(0);
    const vector = clone.db.query('SELECT COUNT(*) AS n FROM replication_vectors').get() as { n: number };
    expect(vector.n).toBe(0);

    await pullFromRemote(clone.replica, origin.url);
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
  });
});

describe('refused handshakes (§6.2, §2.2)', () => {
  // One case per half of the guard, and each half wrong on its own: both wrong at
  // once cannot tell an `||` from either of its sides, and both wrong *upward*
  // cannot tell `!==` from `>`. The schema half is the one that matters most - a
  // peer on another migration merges rows against columns it does not have.
  it.each([
    ['a downlevel protocol', { protocol: 0, schema: latestMigrationMillis() }, 'on this device'],
    ['an uplevel protocol', { protocol: REPLICATION_PROTOCOL + 1, schema: latestMigrationMillis() }, 'on the other device'],
    ['a downlevel schema', { protocol: REPLICATION_PROTOCOL, schema: latestMigrationMillis() - 1 }, 'on this device'],
    ['an uplevel schema', { protocol: REPLICATION_PROTOCOL, schema: latestMigrationMillis() + 1 }, 'on the other device'],
  ])('refuses %s, naming the device to update', async (_what, versions, update) => {
    const { origin, clone } = await pairedClone();
    const response = await post(origin.url, route(PathSegment.handshake()), {
      ...versions,
      library_id: LIB,
      peer_id: peerIdOf(clone.db),
      clock_ms: Date.now(),
      coverage: {},
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toContain(`Update Bowerbird ${update}`);
  });

  it('refuses a peer whose clock is out past the skew guard', async () => {
    const { origin, clone } = await pairedClone();
    const response = await post(origin.url, route(PathSegment.handshake()), {
      protocol: REPLICATION_PROTOCOL,
      schema: latestMigrationMillis(),
      library_id: LIB,
      peer_id: peerIdOf(clone.db),
      clock_ms: Date.now() + 2 * DEFAULT_SKEW_MS,
      coverage: {},
    });
    expect(await response.json()).toMatchObject({ error: { code: 'CLOCK_SKEW' } });
  });

  it('refuses a peer it was never paired with, and a library the peer is not paired to', async () => {
    const { origin, clone } = await pairedClone();
    const stranger = await post(origin.url, route(PathSegment.handshake()), {
      protocol: REPLICATION_PROTOCOL,
      schema: latestMigrationMillis(),
      library_id: LIB,
      peer_id: newId(),
      clock_ms: Date.now(),
      coverage: {},
    });
    expect(stranger.status).toBe(404);

    const crossLibrary = await post(origin.url, route(PathSegment.changes()), {
      library_id: 'otherlib',
      peer_id: peerIdOf(clone.db),
      held: {},
      cursor: '',
      limit: 10,
    });
    expect(crossLibrary.status).toBe(404);
  });
});

// §9.1: browse asks what a peer has and registers nothing; adding is the whole
// pairing, and the local half is checked before the remote is asked for anything.
describe('browse, then add (§9.1)', () => {
  it('lists what a peer offers without either side recording anything', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 2);

    const offered = await browseRemote(origin.url);

    expect(offered.libraries).toMatchObject([{ id: LIB, name: 'Trip', photo_count: 2 }]);
    expect(offered.name).toBeString();
    // Asking is free: no peer recorded, and the library is not linked for
    // replication until somebody actually adds it.
    expect(pairedPeers(origin.db, LIB)).toHaveLength(0);
    expect(origin.db.query('SELECT 1 FROM replication_libraries').get()).toBeNull();
  });

  it('refuses a folder that already holds something, before the remote is told anything', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    const occupied = cloneRoot();
    writeFileSync(path.join(occupied, 'holiday.arw'), 'not ours');

    await expect(addReplica(clone.db, origin.url, LIB, occupied, true)).rejects.toThrow('not empty');
    // The usual failure costs the other device nothing, which is why the local
    // half is checked first.
    expect(pairedPeers(origin.db, LIB)).toHaveLength(0);
    expect(clone.db.query('SELECT 1 FROM libraries').get()).toBeNull();
  });

  it('makes the folder when it does not exist yet', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    const root = path.join(cloneRoot(), 'trip');
    await addReplica(clone.db, origin.url, LIB, root, true);

    expect(existsSync(root)).toBe(true);
  });

  it('records the address it was added at, which is what later sessions dial', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    await addReplica(clone.db, origin.url, LIB, cloneRoot(), true);

    expect(peerAddress(clone.db, LIB, peerIdOf(origin.db))).toBe(origin.url);
  });

  // The one ordering that cannot be arranged away: the remote has recorded us and
  // then the local half fails, which would leave a peer that never arrives (§8.3).
  //
  // Failing on the *root path* rather than the id is what makes this exercise the
  // rollback at all: an id already here is refused before the remote is asked, so
  // a test built on one would assert an empty peer list that was never filled.
  it('unpairs again when the local half fails after the remote agreed', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    // Empty on disk, so the folder check passes - but spoken for in the
    // catalogue, and `libraries.root_path` is UNIQUE, so the insert inside the
    // transaction is what fails.
    const root = cloneRoot();
    clone.db.query("INSERT INTO libraries (id, root_path, name) VALUES ('otherlib', ?, 'Squatter')").run(root);

    await expect(addReplica(clone.db, origin.url, LIB, root, true)).rejects.toThrow();

    // It got as far as pairing, and then took it back.
    expect(pairedPeers(origin.db, LIB)).toHaveLength(0);
    expect(clone.db.query('SELECT 1 FROM libraries WHERE id = ?').get(LIB)).toBeNull();
  });

  // The two routes the web client calls, which the calls above reach past: they
  // go straight to `browseRemote`/`addReplica`, so nothing else covers the
  // request shapes or the refusals coming back through HTTP.
  it('browses and adds over the routes the client uses', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 2);
    const clone = serve(catalogue());

    const browsed = await post(clone.url, route(PathSegment.replicas(), PathSegment.browse()), { address: origin.url });
    expect(browsed.status).toBe(200);
    expect(await browsed.json()).toMatchObject({ libraries: [{ id: LIB, photo_count: 2 }] });

    const occupied = cloneRoot();
    writeFileSync(path.join(occupied, 'holiday.arw'), 'not ours');
    const refused = await post(clone.url, route(PathSegment.replicas()), {
      address: origin.url,
      library_id: LIB,
      root_path: occupied,
    });
    expect(refused.status).toBe(409);

    const added = await post(clone.url, route(PathSegment.replicas()), {
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: false,
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ library_id: LIB });
    // The body's own field, rather than the default, decides what this keeps.
    expect(syncsOriginals(clone.db, LIB)).toBe(false);
  });

  // A replica is created under the remote's library id, verbatim, so deleting one
  // and adding it again lands on the same id. The vectors carry no foreign key -
  // a tombstone has to outlive the row it describes - so without a deliberate
  // sweep the second add is told it already holds everything, and the reader gets
  // a library that reports success, shows no error, and is empty.
  it('re-adds a deleted library rather than cloning nothing into it', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 3);
    const clone = serve(catalogue());
    await addReplica(clone.db, origin.url, LIB, cloneRoot(), true);
    const first = await pullFromRemote(clone.replica, origin.url);
    expect(first.applied).toBeGreaterThan(0);

    // What Settings → Remove does, including replication's own clean-up.
    clone.db.query('DELETE FROM libraries WHERE id = ?').run(LIB);
    forgetLibrary(clone.db, LIB);

    await addReplica(clone.db, origin.url, LIB, cloneRoot(), true);
    const again = await pullFromRemote(clone.replica, origin.url);

    expect(again.applied).toBe(first.applied);
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
  });

  // The same leak, one table over and quieter: photo ids are the remote's
  // verbatim too, so a surviving self-row has the re-added library claiming to
  // hold originals that went with the folder. Nothing re-asserts it and the
  // "originals this peer lacks" diff is empty, so the grid shows a full library
  // over an empty root and no fetch is ever queued.
  it('forgets what it claimed to hold, so a re-add knows it holds nothing', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 2);
    const clone = serve(catalogue());
    await addReplica(clone.db, origin.url, LIB, cloneRoot(), true);
    await pullFromRemote(clone.replica, origin.url);
    // What fetching an original leaves behind: this device's own claim on it.
    new BlobLocations(clone.db).record(LIB, 'p1');
    expect(new BlobLocations(clone.db).heldBy(LIB, 'p1', peerIdOf(clone.db))).toBe(true);

    clone.db.query('DELETE FROM libraries WHERE id = ?').run(LIB);
    forgetLibrary(clone.db, LIB);

    expect(new BlobLocations(clone.db).heldBy(LIB, 'p1', peerIdOf(clone.db))).toBe(false);
  });

  // §4.1: writable with no bin is the one shape the columns must never hold. A
  // library in it flags a binned photograph deleted and leaves the file where it
  // is, then replicates that to every peer as though it had moved.
  it('gives the replica a bin, rather than the shape a library may not have', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    await addReplica(clone.db, origin.url, LIB, cloneRoot(), true);

    const row = clone.db.query('SELECT read_only, bin_name FROM libraries WHERE id = ?').get(LIB) as {
      read_only: number;
      bin_name: string | null;
    };
    expect(row.read_only).toBe(0);
    expect(row.bin_name).not.toBeNull();
  });

  /**
   * Everything that hangs off a library appearing - the watcher above all, whose
   * update path returns early for one it was never told about, so a replica that
   * misses this can never acquire a watcher at all.
   *
   * Announced through the real listener, which is what makes this worth a test:
   * `ScanService.onLibraryCreated` starts the first scan, and a scan takes the
   * per-library lease *before its first await*. Told inside the add, it therefore
   * hands back with the lease held and the clone that follows cannot take it - so
   * every add answers 409 and no catalogue ever arrives.
   */
  it('announces the replica without the first scan blocking its own clone', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 2);
    const clone = serve(catalogue());

    const announced: string[] = [];
    const runner = new ReplicationRunner(
      clone.db,
      new SyncLocksRepository(clone.db),
      new LibrariesRepository(clone.db),
      new BlobLocations(clone.db),
      (library) => {
        announced.push(library.id);
        // What a scan does, and it does it synchronously.
        new SyncLocksRepository(clone.db).acquire(library.id, newId());
      },
      () => {},
      () => {},
      () => Promise.resolve(0),
    );

    const summary = await runner.add(origin.url, LIB, cloneRoot(), true);

    expect(announced).toEqual([LIB]);
    // The clone ran, rather than dying on a lease its own announcement took.
    expect(summary.applied).toBeGreaterThan(0);
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
  });

  // A clone that failed part-way still committed the library, and one that is
  // never announced is never watched - and cannot come to be watched, short of a
  // restart. So the announcement is owed whether the clone worked or not.
  it('announces the replica even when the clone that follows fails', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    const announced: string[] = [];
    // Something else holds the library's lease by the time the clone wants it,
    // which the pairing before it neither needs nor notices. Refused here rather
    // than acquired for real, because the lease has a foreign key and the library
    // does not exist until the add creates it.
    const locks = new SyncLocksRepository(clone.db);
    locks.acquire = () => false;
    const runner = new ReplicationRunner(
      clone.db,
      locks,
      new LibrariesRepository(clone.db),
      new BlobLocations(clone.db),
      (library) => announced.push(library.id),
      () => {},
      () => {},
      () => Promise.resolve(0),
    );

    await expect(runner.add(origin.url, LIB, cloneRoot(), true)).rejects.toThrow('already running');

    expect(announced).toEqual([LIB]);
  });

  // A listener is somebody else's code, and it runs over a replica that is
  // already committed and paired. Letting it fail the add reports a failure for
  // something that worked, and the retry then refuses: it is already here.
  it('survives a listener that throws', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const runner = new ReplicationRunner(
      clone.db,
      new SyncLocksRepository(clone.db),
      new LibrariesRepository(clone.db),
      new BlobLocations(clone.db),
      () => {
        throw new Error('a watcher that could not subscribe');
      },
      () => {},
      () => {},
      () => Promise.resolve(0),
    );

    const summary = await runner.add(origin.url, LIB, cloneRoot(), true);

    expect(summary.library_id).toBe(LIB);
  });

  // The peer id is the whole device's, so a second add of the same library pairs
  // as the *same* peer - and its rollback would then retract the first one's,
  // leaving a replica whose every later session is refused.
  it('does not let a duplicate add unpair the one that succeeded', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    const both = await Promise.allSettled([
      addReplica(clone.db, origin.url, LIB, cloneRoot(), true),
      addReplica(clone.db, origin.url, LIB, cloneRoot(), true),
    ]);

    // Exactly one wins; the other is refused for the library already being here.
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // And the winner is still paired, which is the whole point.
    expect(pairedPeers(origin.db, LIB)).toHaveLength(1);
    const session = await pullFromRemote(clone.replica, origin.url);
    expect(session.applied).toBeGreaterThan(0);
  });
});

describe('pairing (§6.5)', () => {
  it('lists, renames and forgets peers; a forgotten peer that returns is refused', async () => {
    const { origin, clone } = await pairedClone(1);
    await pullFromRemote(clone.replica, origin.url);
    const clonePeer = peerIdOf(clone.db);

    const listed = (await (
      await fetch(
        `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), LIB, PathSegment.peers())}`,
      )
    ).json()) as {
      peers: { peer_id: string; name: string; last_replicated_at: string | null }[];
      sync_originals: boolean;
    };
    expect(listed.peers).toHaveLength(1);
    expect(listed.peers[0]!.peer_id).toBe(clonePeer);
    expect(listed.peers[0]!.last_replicated_at).not.toBeNull();
    expect(listed.sync_originals).toBe(true);

    const renamed = await fetch(
      `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), LIB, PathSegment.peers(), clonePeer)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Macbook' }),
      },
    );
    expect(renamed.status).toBe(204);
    const renamedList = (await (
      await fetch(
        `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), LIB, PathSegment.peers())}`,
      )
    ).json()) as { peers: { name: string }[] };
    expect(renamedList.peers[0]!.name).toBe('Macbook');

    const forgotten = await fetch(
      `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), LIB, PathSegment.peers(), clonePeer)}`,
      {
        method: 'DELETE',
      },
    );
    expect(forgotten.status).toBe(204);
    // Off the GC floor (§8.3) as well as out of the list.
    const floor = origin.db
      .query('SELECT COUNT(*) AS n FROM replication_peer_vectors WHERE peer_id = ?')
      .get(clonePeer) as { n: number };
    expect(floor.n).toBe(0);

    await expect(pullFromRemote(clone.replica, origin.url)).rejects.toThrow('not paired');
  });

  // What a page opens with. The gate on every strip, badge and panel is whether a
  // library has a peer at all, and asking that per library is a request each to
  // be told no.
  it('answers for the whole install at once, leaving out libraries that replicate with nobody', async () => {
    const { origin, clone } = await pairedClone(1);
    origin.db.query("INSERT INTO libraries (id, root_path, name) VALUES ('solo', '/photos/solo', 'Solo')").run();

    const all = (await (
      await fetch(`${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.peers())}`)
    ).json()) as {
      libraries: { library_id: string; peers: { peer_id: string }[]; sync_originals: boolean }[];
    };

    expect(all.libraries.map((library) => library.library_id)).toEqual([LIB]);
    expect(all.libraries[0]!.peers.map((peer) => peer.peer_id)).toEqual([peerIdOf(clone.db)]);
    expect(all.libraries[0]!.sync_originals).toBe(true);
  });
});

// §7.10: a replica born wanting the catalogue but not the RAW files. The choice
// is the clone's alone - nothing about it replicates - but the origin has to
// learn it, or it goes on offering to send bytes that would be refused.
describe('sync RAWs to this device (§7.10)', () => {
  it('keeps the clone\'s answer local and tells the origin at the handshake', async () => {
    const { origin, clone } = await pairedClone(1, false);

    expect(syncsOriginals(clone.db, LIB)).toBe(false);
    // The origin's own library is untouched by what the clone chose for itself.
    expect(syncsOriginals(origin.db, LIB)).toBe(true);

    await pullFromRemote(clone.replica, origin.url);

    const asOriginSeesIt = pairedPeers(origin.db, LIB)[0]!;
    expect(asOriginSeesIt.peer_id).toBe(peerIdOf(clone.db));
    expect(asOriginSeesIt.wants_originals).toBe(false);
    // And the clone's view of the origin, which is what greys its own buttons.
    expect(pairedPeers(clone.db, LIB)[0]!.wants_originals).toBe(true);
  });

  it('follows the setting when it changes, without re-pairing', async () => {
    const { origin, clone } = await pairedClone(1);
    await pullFromRemote(clone.replica, origin.url);
    expect(pairedPeers(origin.db, LIB)[0]!.wants_originals).toBe(true);

    setSyncsOriginals(clone.db, LIB, false);
    await pullFromRemote(clone.replica, origin.url);

    expect(pairedPeers(origin.db, LIB)[0]!.wants_originals).toBe(false);
  });
});

describe('originals moved by a session', () => {
  function recordingRunner(db: Database, asked: string[]): ReplicationRunner {
    return new ReplicationRunner(
      db,
      new SyncLocksRepository(db),
      new LibrariesRepository(db),
      new BlobLocations(db),
      () => {},
      () => {},
      () => {},
      (libraryId, peer, direction) => {
        asked.push(`${direction} ${libraryId} ${peer}`);
        return Promise.resolve(0);
      },
    );
  }

  it('fetches the originals of a replica that keeps them, from the device it joined', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const asked: string[] = [];

    await recordingRunner(clone.db, asked).add(origin.url, LIB, cloneRoot(), true);

    expect(asked).toEqual([`pull ${LIB} ${peerIdOf(origin.db)}`]);
  });

  it('fetches nothing for a replica that keeps only the catalogue', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const asked: string[] = [];

    await recordingRunner(clone.db, asked).add(origin.url, LIB, cloneRoot(), false);

    expect(asked).toEqual([]);
  });

  it('sends and fetches on every session once the library is set to', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const asked: string[] = [];
    const runner = recordingRunner(clone.db, asked);
    await runner.add(origin.url, LIB, cloneRoot(), true);

    asked.length = 0;
    await runner.replicate(LIB);
    expect(asked).toEqual([]);

    setAutoTransfersOriginals(clone.db, LIB, true);
    await runner.replicate(LIB);
    expect(asked).toEqual([`pull ${LIB} ${peerIdOf(origin.db)}`, `push ${LIB} ${peerIdOf(origin.db)}`]);
  });

  // A page reads the transfer queue when it hears a session ended, and polls only while it finds one moving.
  it('turns automatic transfer on by itself, and refuses a request that changes nothing', async () => {
    const { clone } = await pairedClone(1);
    const patch = (body: unknown): Promise<Response> =>
      fetch(
        `${clone.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), LIB, PathSegment.originals())}`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      );

    expect((await patch({})).ok).toBe(false);
    expect(autoTransfersOriginals(clone.db, LIB)).toBe(false);

    expect(await (await patch({ auto_transfer_originals: true })).json()).toEqual({ cancelled: 0 });
    expect(autoTransfersOriginals(clone.db, LIB)).toBe(true);
    expect(syncsOriginals(clone.db, LIB)).toBe(true);
  });

  it('announces the session only once its originals are queued', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const happened: string[] = [];
    const runner = new ReplicationRunner(
      clone.db,
      new SyncLocksRepository(clone.db),
      new LibrariesRepository(clone.db),
      new BlobLocations(clone.db),
      () => {},
      () => {},
      () => happened.push('announced'),
      (_libraryId, _peer, direction) => {
        happened.push(direction);
        return Promise.resolve(0);
      },
    );
    await runner.add(origin.url, LIB, cloneRoot(), false);
    setAutoTransfersOriginals(clone.db, LIB, true);

    happened.length = 0;
    await runner.replicate(LIB);

    expect(happened).toEqual(['push', 'announced']);
  });
});

describe('apply is a trust boundary (§11.2)', () => {
  const POISONS: [string, (db: Database) => void, (db: Database) => number][] = [
    [
      // The path a photograph is, which now travels inside its recipe - and is checked there
      // (`RecipeCellSchema`), the join onto the library root being just as real for it.
      'a photograph recipe path',
      (db) =>
        db
          .query(`UPDATE photos SET recipe = json_set(recipe, '$.path', ?), stamp_placement = ? WHERE id = ?`)
          .run('../../etc/passwd', stamp(db), 'p1'),
      (db) => count(db, `SELECT COUNT(*) AS n FROM photos WHERE json_extract(recipe, '$.path') LIKE '%..%'`),
    ],
    [
      // A path smuggled on a kind the guard relays unread. Nothing composes this kind, but the
      // readers that ask a recipe for `$.path` do not all ask what kind it is first, so a
      // payload that never calls itself a file must still be held to the path rules.
      'a path on a recipe kind this build does not know',
      (db) =>
        db
          .query(`UPDATE photos SET recipe = ?, stamp_placement = ? WHERE id = ?`)
          .run('{"kind":"kaleidoscope","path":"../../etc/passwd"}', stamp(db), 'p1'),
      (db) => count(db, `SELECT COUNT(*) AS n FROM photos WHERE json_extract(recipe, '$.path') LIKE '%..%'`),
    ],
    [
      'photo deleted_from_path',
      (db) =>
        db
          .query('UPDATE photos SET is_deleted = 1, deleted_from_path = ?, stamp_bin = ? WHERE id = ?')
          .run('/etc/passwd', stamp(db), 'p1'),
      (db) => count(db, "SELECT COUNT(*) AS n FROM photos WHERE deleted_from_path LIKE '/%'"),
    ],
    [
      'shoot folder_path',
      (db) =>
        db.query('UPDATE shoots SET folder_path = ?, stamp = ? WHERE id = ?').run('a/../../b', stamp(db), SHOOT),
      (db) => count(db, "SELECT COUNT(*) AS n FROM shoots WHERE folder_path LIKE '%..%'"),
    ],
    [
      'folder_rule folder_path',
      (db) =>
        db
          .query("INSERT INTO folder_rules (library_id, folder_path, rule, stamp) VALUES (?, ?, 'excluded', ?)")
          .run(LIB, 'rules\\..\\up', stamp(db)),
      (db) => count(db, "SELECT COUNT(*) AS n FROM folder_rules WHERE folder_path LIKE '%..%'"),
    ],
    [
      'library bin_name',
      (db) =>
        db.query('UPDATE libraries SET bin_name = ?, stamp = ? WHERE id = ?').run('../outside', stamp(db), LIB),
      (db) => count(db, "SELECT COUNT(*) AS n FROM libraries WHERE bin_name LIKE '%..%'"),
    ],
  ];

  function count(db: Database, sql: string): number {
    return (db.query(sql).get() as { n: number }).n;
  }

  it.each(POISONS)('rejects traversal in %s before it can land', async (_column, poison, poisoned) => {
    const { origin, clone } = await pairedClone(2);
    poison(origin.db);

    await expect(pullFromRemote(clone.replica, origin.url)).rejects.toThrow();
    expect(poisoned(clone.db)).toBe(0);
    // The refused page claimed nothing, so fixing the row on the origin heals
    // the replica on the next ordinary session.
    const vector = clone.db.query('SELECT COUNT(*) AS n FROM replication_vectors').get() as { n: number };
    expect(vector.n).toBe(0);
  });
});
