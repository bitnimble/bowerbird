// Two real servers over real HTTP, replicating two real catalogues: the one
// place the transport itself - pairing, handshake refusals, paged fetches, the
// validation boundary - is what is being tested. Everything about *merging* is
// pinned one layer down in `src/services/replication/tests`.
import { Database } from '../../../db/driver';
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { latestMigrationMillis } from '../../../db/migrate';
import { newId } from '../../../schemas/id';
import { REPLICATION_PROTOCOL, type Outdated } from '../../../schemas/replication';
import { PathSegment, route } from '../../../schemas/route';
import { BlobLocations } from '../../../services/blobs/blob_locations';
import { LibrariesRepository } from '../../../services/libraries/libraries_repository';
import { PhotoStateRepository } from '../../../services/photos/mutations/photo_state_repository';
import { StackMembership } from '../../../services/stacks/stack_membership';
import { DEFAULT_SKEW_MS } from '../../../services/replication/clock';
import { forgetLibrary } from '../../../services/replication/gc';
import {
  autoTransfersOriginals,
  pairedPeers,
  peerAddress,
  setAutoTransfersOriginals,
  setDeviceName,
  setSyncsOriginals,
  syncsOriginals,
} from '../../../services/replication/pairing';
import {
  addReplica,
  browseRemote,
  openRemote,
  pullFromRemote,
} from '../../../services/replication/remote';
import { ReplicationRunner } from '../../../services/replication/replication_runner';
import { ReplicationService } from '../../../services/replication/replication_service';
import { SyncLocksRepository } from '../../../services/sync/coordination/sync_locks_repository';
import { pullFrom, type ChangeSource } from '../../../services/replication/session';
import { stamp } from '../../../services/replication/stamps';
import { replicatedState } from '../../../services/replication/tests/peers';
import { applyErrorHandler } from '../../error_handler';
import { ReplicationApi } from '../replication_api';
import { LibraryActivity } from '../../../services/activity/library_activity';
import { libraryMutex } from '../../../services/sync/coordination/library_mutex';
import {
  LIB,
  SHOOT,
  catalogue,
  cleanUp,
  cloneRoot,
  pairedClone,
  peerIdOf,
  post,
  runnerFor,
  seedLibrary,
  serve,
} from './replication_api_test_helpers';

afterEach(cleanUp);

it('shows inbound catalogue work while it waits and clears it after success or refusal', async () => {
  const db = catalogue();
  seedLibrary(db, 1);
  const activity = new LibraryActivity();
  const service = new ReplicationService(db, new BlobLocations(db));
  const peer = newId();
  service.pair({ library_id: LIB, peer_id: peer, name: 'Remote' });
  const api = new ReplicationApi(service, runnerFor(db), undefined, activity);
  applyErrorHandler(api.routes);
  const release = Promise.withResolvers<void>();
  const held = libraryMutex.run(LIB, () => release.promise);
  const request = { library_id: LIB, peer_id: peer, page: { changes: [], cursor: '', done: true } };
  const sending = (): Promise<Response> =>
    Promise.resolve(
      api.routes.request(route(PathSegment.push()), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
  const incoming = sending();
  try {
    await Bun.sleep(0);
    expect(activity.current(LIB)).toEqual([{ kind: 'syncing', count: 1 }]);
  } finally {
    release.resolve();
    await held;
  }
  expect((await incoming).status).toBe(200);
  expect(activity.current(LIB)).toEqual([]);

  db.query('UPDATE libraries SET read_only = 1 WHERE id = ?').run(LIB);
  expect((await sending()).status).toBe(403);
  expect(activity.current(LIB)).toEqual([]);
  db.close();
});

describe('clone (§9)', () => {
  it('births a replica and fills it in one request, then replicates on the address it kept', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 3);
    const clone = serve(catalogue());

    const browsed = await post(clone.url, route(PathSegment.replicas(), PathSegment.browse()), {
      address: `${origin.url}/`,
    });
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
    expect(autoTransfersOriginals(clone.db, LIB)).toBe(true);
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));

    // The address pairing recorded is what a later session dials, so "sync now"
    // needs nothing but the library.
    new PhotoStateRepository(origin.db, new StackMembership(origin.db)).update('p2', { rating: 5 });
    const again = await post(
      clone.url,
      route(PathSegment.libraries(), LIB, PathSegment.replicate()),
      {},
    );
    expect(await again.json()).toMatchObject({ peers: 1 });
    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
  });

  // Listed rather than hidden, because a library missing with no reason given is
  // what has somebody checking their network for an hour (§9.1).
  it('offers a readonly library in the list and refuses to pair it', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    origin.db
      .query(
        "INSERT INTO libraries (id, root_path, name, read_only) VALUES ('rolib000', '/ro', 'RO', 1)",
      )
      .run();

    const offered = (await (
      await fetch(
        `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries())}`,
      )
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
      await fetch(
        `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries())}`,
      )
    ).json()) as {
      libraries: { id: string; replicating: boolean }[];
    };
    expect(offered.libraries.find((l) => l.id === LIB)).toMatchObject({ replicating: true });
  });
});

describe('sessions over HTTP (§6.2)', () => {
  it('replicates both directions, each side pulling from the other', async () => {
    const { origin, clone } = await pairedClone();
    await pullFromRemote(clone.replica, origin.url);

    new PhotoStateRepository(origin.db, new StackMembership(origin.db)).update('p1', { rating: 5 });
    new PhotoStateRepository(clone.db, new StackMembership(clone.db)).update('p2', {
      notes: 'keep this one',
    });

    await pullFromRemote(clone.replica, origin.url);
    await pullFromRemote(origin.replica, clone.url);

    expect(replicatedState(clone.db)).toBe(replicatedState(origin.db));
    expect(origin.db.query('SELECT notes FROM photos WHERE id = ?').get('p2')).toEqual({
      notes: 'keep this one',
    });
    expect(clone.db.query('SELECT rating FROM photos WHERE id = ?').get('p1')).toEqual({
      rating: 5,
    });

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
    const vector = clone.db.query('SELECT COUNT(*) AS n FROM replication_vectors').get() as {
      n: number;
    };
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
  // A schema gap closes one direction only: the newer catalogue merges what an older one sends, and
  // never the reverse (§8.5). A protocol gap closes both.
  it.each([
    [
      'a downlevel protocol pulling',
      { protocol: 0, schema: latestMigrationMillis() },
      'pull',
      'on this device',
    ],
    [
      'a downlevel protocol pushing',
      { protocol: 0, schema: latestMigrationMillis() },
      'push',
      'on this device',
    ],
    [
      'an uplevel protocol pulling',
      { protocol: REPLICATION_PROTOCOL + 1, schema: latestMigrationMillis() },
      'pull',
      'on the other device',
    ],
    [
      'an uplevel protocol pushing',
      { protocol: REPLICATION_PROTOCOL + 1, schema: latestMigrationMillis() },
      'push',
      'on the other device',
    ],
    [
      'a downlevel schema pulling',
      { protocol: REPLICATION_PROTOCOL, schema: latestMigrationMillis() - 1 },
      'pull',
      'on this device',
    ],
    [
      'an uplevel schema pushing',
      { protocol: REPLICATION_PROTOCOL, schema: latestMigrationMillis() + 1 },
      'push',
      'on the other device',
    ],
  ])('refuses %s, naming the device to update', async (_what, versions, direction, update) => {
    const { origin, clone } = await pairedClone();
    const response = await post(origin.url, route(PathSegment.handshake()), {
      ...versions,
      direction,
      library_id: LIB,
      peer_id: peerIdOf(clone.db),
      name: 'Laptop',
      clock_ms: Date.now(),
      coverage: {},
    });
    expect(response.status).toBe(426);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('OUTDATED');
    expect(body.error.message).toContain(`Update Bowerbird ${update}`);
  });

  it.each([
    ['a downlevel schema pushing', latestMigrationMillis() - 1, 'push'],
    ['an uplevel schema pulling', latestMigrationMillis() + 1, 'pull'],
  ])(
    'takes %s, the rows going from the older catalogue to the newer',
    async (_what, schema, direction) => {
      const { origin, clone } = await pairedClone();
      const response = await post(origin.url, route(PathSegment.handshake()), {
        protocol: REPLICATION_PROTOCOL,
        schema,
        direction,
        library_id: LIB,
        peer_id: peerIdOf(clone.db),
        name: 'Laptop',
        clock_ms: Date.now(),
        coverage: {},
      });
      expect(response.status).toBe(200);
    },
  );

  it('still sends this device’s work when the other runs a newer build and will not send back', async () => {
    const { origin, clone } = await pairedClone();
    await pullFromRemote(clone.replica, origin.url);
    // Stands in for an origin one migration ahead: its pull refused as a newer build refuses one,
    // everything else passed through to the real thing.
    const newer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = request.method === 'POST' ? await request.text() : undefined;
        if (
          url.pathname.endsWith('/handshake') &&
          (JSON.parse(body ?? '{}') as { direction?: string }).direction === 'pull'
        ) {
          return Response.json(
            {
              error: {
                code: 'OUTDATED',
                message: "This device's version of Bowerbird is older than the other device's.",
                details: [{ protocol: REPLICATION_PROTOCOL, schema: latestMigrationMillis() + 1 }],
              },
            },
            { status: 426 },
          );
        }
        const answer = await fetch(`${origin.url}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body,
        });
        if (!url.pathname.endsWith('/handshake')) return answer;
        return Response.json({
          ...((await answer.json()) as object),
          schema: latestMigrationMillis() + 1,
        });
      },
    });
    try {
      const address = `http://localhost:${newer.port}`;
      clone.db
        .query('UPDATE replication_peers SET address = ? WHERE library_id = ?')
        .run(address, LIB);
      new PhotoStateRepository(clone.db, new StackMembership(clone.db)).update('p2', { rating: 2 });

      await runnerFor(clone.db).replicate(LIB);

      expect(origin.db.query('SELECT rating FROM photos WHERE id = ?').get('p2')).toEqual({
        rating: 2,
      });
      const [peer] = pairedPeers(clone.db, LIB);
      expect(peer?.outdated).toBe('this_device');
      expect(peer?.last_error).toContain('older');
    } finally {
      newer.stop(true);
    }
  });

  it.each<[string, number, Outdated]>([
    ['older', latestMigrationMillis() - 1, 'peer'],
    ['newer', latestMigrationMillis() + 1, 'this_device'],
  ])(
    'remembers that the caller runs an %s build, so this side can say which device to update',
    async (_what, schema, outdated) => {
      const { origin, clone } = await pairedClone();
      await post(origin.url, route(PathSegment.handshake()), {
        protocol: REPLICATION_PROTOCOL,
        schema,
        direction: 'pull',
        library_id: LIB,
        peer_id: peerIdOf(clone.db),
        name: 'Laptop',
        clock_ms: Date.now(),
        coverage: {},
      });
      expect(pairedPeers(origin.db, LIB).map((peer) => peer.outdated)).toEqual([outdated]);

      // And forgets it once the caller arrives on this build.
      await pullFromRemote(clone.replica, origin.url);
      expect(pairedPeers(origin.db, LIB).map((peer) => peer.outdated)).toEqual([null]);
      expect(pairedPeers(clone.db, LIB).map((peer) => peer.outdated)).toEqual([null]);
    },
  );

  it('remembers the build a refusal names, so the device that dialled can say which one to update', async () => {
    const { origin, clone } = await pairedClone();
    const refusing = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            error: {
              code: 'OUTDATED',
              message: 'refused',
              details: [{ protocol: REPLICATION_PROTOCOL, schema: 1 }],
            },
          },
          { status: 426 },
        ),
    });
    try {
      const address = `http://localhost:${refusing.port}`;
      clone.db
        .query('UPDATE replication_peers SET address = ? WHERE library_id = ?')
        .run(address, LIB);
      await expect(pullFromRemote(clone.replica, address)).rejects.toThrow('refused');
      expect(pairedPeers(clone.db, LIB).map((peer) => [peer.peer_id, peer.outdated])).toEqual([
        [peerIdOf(origin.db), 'peer'],
      ]);
    } finally {
      refusing.stop(true);
    }
  });

  it('refuses a peer whose clock is out past the skew guard', async () => {
    const { origin, clone } = await pairedClone();
    const response = await post(origin.url, route(PathSegment.handshake()), {
      protocol: REPLICATION_PROTOCOL,
      schema: latestMigrationMillis(),
      direction: 'pull',
      library_id: LIB,
      peer_id: peerIdOf(clone.db),
      name: 'Laptop',
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
      direction: 'pull',
      library_id: LIB,
      peer_id: newId(),
      name: 'Stranger',
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

describe("this device's name", () => {
  it('is what a device pairing with it is told, once renamed', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const at = `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.device())}`;

    const renamed = await fetch(at, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Studio iMac ' }),
    });
    expect(await renamed.json()).toEqual({ name: 'Studio iMac' });
    expect(await (await fetch(at)).json()).toEqual({ name: 'Studio iMac' });
    expect((await browseRemote(origin.url)).name).toBe('Studio iMac');

    const blank = await fetch(at, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"name":" "}',
    });
    expect(blank.status).toBe(400);
  });

  it('reaches devices already paired at the next sync, in both directions', async () => {
    const { origin, clone } = await pairedClone();
    setDeviceName(origin.db, 'Studio iMac');
    setDeviceName(clone.db, 'Travel laptop');

    await pullFromRemote(clone.replica, origin.url);

    expect(pairedPeers(clone.db, LIB).map((peer) => peer.name)).toEqual(['Studio iMac']);
    expect(pairedPeers(origin.db, LIB).map((peer) => peer.name)).toEqual(['Travel laptop']);
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

  it('finds the scheme for an address typed without one, and hands back the one that answered', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);

    const offered = await browseRemote(` ${origin.url.replace('http://', '')}/ `);

    expect(offered.address).toBe(origin.url);
    expect(offered.libraries).toHaveLength(1);
  });

  const envelope = (code: string): string =>
    JSON.stringify({ error: { code, message: 'refused' } });
  it.each([
    ['invalid_address', 'not an address', 200, ''],
    ['invalid_address', 'ftp://desktop:5173', 200, ''],
    ['invalid_address', 'http://desktop:5173/?library=trip', 200, ''],
    ['not_answering', '', 500, ''],
    ['not_answering', '', 502, '<h1>Bad gateway</h1>'],
    ['not_bowerbird', '', 200, '<html></html>'],
    ['not_bowerbird', '', 404, '<h1>Not found</h1>'],
    ['different_version', '', 200, '{"libraries": 3}'],
    ['different_version', '', 404, envelope('NOT_FOUND')],
    ['refused', '', 401, envelope('UNAUTHORIZED')],
  ] as const)('names a %s failure for the dialog to explain', async (link, typed, status, body) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(body, { status }) });
    try {
      await expect(browseRemote(typed || `http://localhost:${server.port}`)).rejects.toMatchObject({
        details: [{ link }],
      });
    } finally {
      server.stop(true);
    }
  });

  it('names an address nothing answers at on either scheme as unreachable', async () => {
    const gone = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = gone.port;
    gone.stop(true);

    await expect(browseRemote(`localhost:${port}`)).rejects.toMatchObject({
      details: [{ link: 'unreachable' }],
    });
  });

  it.each([
    ['folder_not_empty', (root: string) => writeFileSync(path.join(root, 'holiday.arw'), '')],
    ['not_a_folder', (root: string) => writeFileSync(path.join(root, 'trip'), '')],
    ['folder_in_use', () => {}],
    ['already_added', () => {}],
  ] as const)('names a %s failure for the dialog to explain', async (link, arrange) => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const root = cloneRoot();
    arrange(root);
    const target = link === 'not_a_folder' ? path.join(root, 'trip') : root;
    if (link === 'folder_in_use') {
      clone.db
        .query("INSERT INTO libraries (id, root_path, name) VALUES ('otherlib', ?, 'Squatter')")
        .run(root);
    }
    if (link === 'already_added') await addReplica(clone.db, origin.url, LIB, cloneRoot(), true);

    await expect(addReplica(clone.db, origin.url, LIB, target, true)).rejects.toMatchObject({
      details: [{ link }],
    });
  });

  it('refuses a folder that already holds something, before the remote is told anything', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());

    const occupied = cloneRoot();
    writeFileSync(path.join(occupied, 'holiday.arw'), 'not ours');

    await expect(addReplica(clone.db, origin.url, LIB, occupied, true)).rejects.toThrow(
      'not empty',
    );
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
    clone.db
      .query("INSERT INTO libraries (id, root_path, name) VALUES ('otherlib', ?, 'Squatter')")
      .run(root);

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

    const browsed = await post(clone.url, route(PathSegment.replicas(), PathSegment.browse()), {
      address: origin.url,
    });
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
    expect(await refused.json()).toMatchObject({
      error: { details: [{ link: 'folder_not_empty' }] },
    });

    const added = await post(clone.url, route(PathSegment.replicas()), {
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: false,
      auto_transfer_originals: false,
      denoiser: 'pmrid',
    });
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ library_id: LIB });
    // The body's own field, rather than the default, decides what this keeps.
    expect(syncsOriginals(clone.db, LIB)).toBe(false);
    expect(autoTransfersOriginals(clone.db, LIB)).toBe(false);
    expect(clone.db.query('SELECT denoiser FROM libraries WHERE id = ?').get(LIB)).toEqual({
      denoiser: 'pmrid',
    });
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

    const row = clone.db
      .query('SELECT read_only, bin_name FROM libraries WHERE id = ?')
      .get(LIB) as {
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

    const summary = await runner.add({
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: true,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    });

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

    await expect(
      runner.add({
        address: origin.url,
        library_id: LIB,
        root_path: cloneRoot(),
        sync_originals: true,
        auto_transfer_originals: true,
        denoiser: 'galosh',
      }),
    ).rejects.toThrow('already running');

    expect(announced).toEqual([LIB]);
    expect(autoTransfersOriginals(clone.db, LIB)).toBe(true);
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

    const summary = await runner.add({
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: true,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    });

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
  it('lists and forgets peers; a forgotten peer that returns is refused', async () => {
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
    origin.db
      .query(
        "INSERT INTO libraries (id, root_path, name) VALUES ('solo', '/libraries/solo', 'Solo')",
      )
      .run();

    const all = (await (
      await fetch(
        `${origin.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.peers())}`,
      )
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
  it("keeps the clone's answer local and tells the origin at the handshake", async () => {
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

  it.each([true, false])(
    'exchanges originals once during setup with keep originals %s',
    async (keepOriginals) => {
      const origin = serve(catalogue());
      seedLibrary(origin.db, 1);
      const clone = serve(catalogue());
      const asked: string[] = [];

      await recordingRunner(clone.db, asked).add({
        address: origin.url,
        library_id: LIB,
        root_path: cloneRoot(),
        sync_originals: keepOriginals,
        auto_transfer_originals: true,
        denoiser: 'galosh',
      });

      expect(asked).toEqual([
        ...(keepOriginals ? [`pull ${LIB} ${peerIdOf(origin.db)}`] : []),
        `push ${LIB} ${peerIdOf(origin.db)}`,
      ]);
    },
  );

  it('fetches the originals of a replica that keeps them, from the device it joined', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const asked: string[] = [];

    await recordingRunner(clone.db, asked).add({
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: true,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    });

    expect(asked).toEqual([`pull ${LIB} ${peerIdOf(origin.db)}`]);
  });

  it('fetches nothing for a replica that keeps only the catalogue', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const asked: string[] = [];

    await recordingRunner(clone.db, asked).add({
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: false,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    });

    expect(asked).toEqual([]);
  });

  it('sends and fetches on every session once the library is set to', async () => {
    const origin = serve(catalogue());
    seedLibrary(origin.db, 1);
    const clone = serve(catalogue());
    const asked: string[] = [];
    const runner = recordingRunner(clone.db, asked);
    await runner.add({
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: true,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    });

    asked.length = 0;
    await runner.replicate(LIB);
    expect(asked).toEqual([]);

    setAutoTransfersOriginals(clone.db, LIB, true);
    await runner.replicate(LIB);
    expect(asked).toEqual([
      `pull ${LIB} ${peerIdOf(origin.db)}`,
      `push ${LIB} ${peerIdOf(origin.db)}`,
    ]);
  });

  // A page reads the transfer queue when it hears a session ended, and polls only while it finds one moving.
  it('turns automatic transfer on by itself, and refuses a request that changes nothing', async () => {
    const { clone } = await pairedClone(1);
    const patch = (body: unknown): Promise<Response> =>
      fetch(
        `${clone.url}${route(PathSegment.api(), PathSegment.replication(), PathSegment.libraries(), LIB, PathSegment.originals())}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
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
    await runner.add({
      address: origin.url,
      library_id: LIB,
      root_path: cloneRoot(),
      sync_originals: false,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    });
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
          .query(
            `UPDATE photos SET recipe = json_set(recipe, '$.path', ?), stamp_placement = ? WHERE id = ?`,
          )
          .run('../../etc/passwd', stamp(db), 'p1'),
      (db) =>
        count(
          db,
          `SELECT COUNT(*) AS n FROM photos WHERE json_extract(recipe, '$.path') LIKE '%..%'`,
        ),
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
      (db) =>
        count(
          db,
          `SELECT COUNT(*) AS n FROM photos WHERE json_extract(recipe, '$.path') LIKE '%..%'`,
        ),
    ],
    [
      'photo deleted_from_path',
      (db) =>
        db
          .query(
            'UPDATE photos SET is_deleted = 1, deleted_from_path = ?, stamp_bin = ? WHERE id = ?',
          )
          .run('/etc/passwd', stamp(db), 'p1'),
      (db) => count(db, "SELECT COUNT(*) AS n FROM photos WHERE deleted_from_path LIKE '/%'"),
    ],
    [
      'shoot folder_path',
      (db) =>
        db
          .query('UPDATE shoots SET folder_path = ?, stamp = ? WHERE id = ?')
          .run('a/../../b', stamp(db), SHOOT),
      (db) => count(db, "SELECT COUNT(*) AS n FROM shoots WHERE folder_path LIKE '%..%'"),
    ],
    [
      'folder_rule folder_path',
      (db) =>
        db
          .query(
            "INSERT INTO folder_rules (library_id, folder_path, rule, stamp) VALUES (?, ?, 'excluded', ?)",
          )
          .run(LIB, 'rules\\..\\up', stamp(db)),
      (db) => count(db, "SELECT COUNT(*) AS n FROM folder_rules WHERE folder_path LIKE '%..%'"),
    ],
    [
      'library bin_name',
      (db) =>
        db
          .query('UPDATE libraries SET bin_name = ?, stamp = ? WHERE id = ?')
          .run('../outside', stamp(db), LIB),
      (db) => count(db, "SELECT COUNT(*) AS n FROM libraries WHERE bin_name LIKE '%..%'"),
    ],
  ];

  function count(db: Database, sql: string): number {
    return (db.query(sql).get() as { n: number }).n;
  }

  it.each(POISONS)(
    'rejects traversal in %s before it can land',
    async (_column, poison, poisoned) => {
      const { origin, clone } = await pairedClone(2);
      poison(origin.db);

      await expect(pullFromRemote(clone.replica, origin.url)).rejects.toThrow();
      expect(poisoned(clone.db)).toBe(0);
      // The refused page claimed nothing, so fixing the row on the origin heals
      // the replica on the next ordinary session.
      const vector = clone.db.query('SELECT COUNT(*) AS n FROM replication_vectors').get() as {
        n: number;
      };
      expect(vector.n).toBe(0);
    },
  );
});
