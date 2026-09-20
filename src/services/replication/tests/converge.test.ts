// The property the whole design is held to: however the work was interleaved and
// in whatever order the peers happened to meet, they end up holding the same
// library (docs/replication.md §12).
//
// This is deliberately the least specific test in the suite. The rule-by-rule
// tests say what each merge rule does; this one says that all of them together
// have the property those rules exist for, against interleavings nobody thought
// to write down. When it fails it names a seed, and the seed replays exactly.
import { describe, expect, it } from 'bun:test';
import { PhotoEditsRepository } from '../../photo_edits/photo_edits_repository';
import { PhotoMetadataRepository } from '../../photos/metadata/photo_metadata_repository';
import { PhotoStateRepository } from '../../photos/mutations/photo_state_repository';
import { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../photos/renditions/photo_processing_repository';
import { PhotoScanRepository } from '../../photos/scan/photo_scan_repository';
import { RenditionsRepository } from '../../processing/renditions/renditions_repository';
import { StackMembership } from '../../stacks/stack_membership';
import { FolderRulesRepository } from '../../shoots/folder_rules_repository';
import { ShootsRepository } from '../../shoots/shoots_repository';
import { StacksRepository } from '../../stacks/stacks_repository';
import { BlobLocations } from '../../blobs/blob_locations';
import { PushPageRequestSchema } from '../../../schemas/replication';
import { ReplicationService } from '../replication_service';
import { pull, pushTo, replicate, type ChangeSink } from '../session';
import { collectTombstones } from '../gc';
import { registerPeer } from '../pairing';
import { peerId } from '../stamps';
import { coverage, packVector } from '../vectors';
import { differences, invariants, LIB, makePeer, replicatedState, Rng, type Peer } from './peers';

const PHOTOS = ['p1', 'p2', 'p3', 'p4', 'p5'];
const SHOOTS = ['s1', 's2'];
// Where this process's seeds start, so a long run can be split across several of them
// (`scripts/converge.ts`, which is what `bun run converge` drives).
const FIRST_SEED = Number(process.env.BOWERBIRD_CONVERGE_FIRST_SEED ?? 1);
const SEEDS = Array.from({ length: Number(process.env.BOWERBIRD_CONVERGE_SEEDS ?? 40) }, (_, i) => FIRST_SEED + i);

function seed(peer: Peer): void {
  const photos = new PhotoScanRepository(peer.db, new PhotoProcessingRepository(peer.db, new RenditionsRepository(peer.db)));
  for (const id of PHOTOS) {
    photos.insertFromScan({
      id,
      library_id: LIB,
      shoot_id: null,
      file_hash: `hash-${id}`,
      file_path: `${id}.arw`,
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
  for (const id of SHOOTS) {
    peer.db
      .query('INSERT INTO shoots (id, library_id, folder_path, name, stamp) VALUES (?, ?, ?, ?, ?)')
      .run(id, LIB, id, id, `000000000000000000000000${'a'.repeat(8)}`);
  }
}

// Everything a photographer can do that replicates, as one-liners a random walk
// can pick from.
const ACTIONS: ((peer: Peer, rng: Rng) => void)[] = [
  (peer, rng) => new PhotoStateRepository(peer.db, new StackMembership(peer.db)).update(rng.pick(PHOTOS), { rating: rng.int(6) }),
  (peer, rng) =>
    new PhotoStateRepository(peer.db, new StackMembership(peer.db)).update(rng.pick(PHOTOS), {
      triage: rng.pick(['picked', 'rejected', 'untriaged']),
    }),
  (peer, rng) => new PhotoStateRepository(peer.db, new StackMembership(peer.db)).update(rng.pick(PHOTOS), { notes: `note ${rng.int(100)}` }),
  (peer, rng) => {
    const shootId = rng.pick([...SHOOTS, null]);
    if (shootId != null && peer.db.query('SELECT 1 FROM shoots WHERE id = ?').get(shootId) == null) return;
    new PhotoPathsRepository(peer.db, new StackMembership(peer.db)).setShoot(rng.pick(PHOTOS), shootId);
  },
  (peer, rng) => new PhotoPathsRepository(peer.db, new StackMembership(peer.db)).setFilePath(rng.pick(PHOTOS), `moved-${rng.int(50)}.arw`),
  (peer, rng) => {
    const id = rng.pick(PHOTOS);
    const paths = new PhotoPathsRepository(peer.db, new StackMembership(peer.db));
    const metadata = new PhotoMetadataRepository(
      peer.db,
      new PhotoProcessingRepository(peer.db, new RenditionsRepository(peer.db)),
    );
    if (metadata.isBinned(id)) paths.markRestored(id, `${id}.arw`);
    else paths.markDeleted(id, `${id}.arw`, `batch-${rng.int(10)}`);
  },
  (peer, rng) => {
    const stacks = new StacksRepository(peer.db);
    // From the seed rather than from `newId`, whose randomness is the app's and
    // not this test's: which of two stacks survives a merge is decided by id, so
    // a random one would make a failing seed replay differently every time.
    const id = rng.id();
    stacks.create(id, LIB, 'manual', '2026-01-01T00:00:00.000Z');
    stacks.addPhotos(id, [rng.pick(PHOTOS), rng.pick(PHOTOS)]);
  },
  (peer, rng) => {
    const stacks = new StacksRepository(peer.db);
    const existing = peer.db.query('SELECT id FROM stacks ORDER BY id').all() as { id: string }[];
    if (existing.length === 0) return;
    stacks.dissolve(rng.pick(existing).id, rng.next() < 0.5);
  },
  (peer, rng) => {
    peer.db
      .query(
        `INSERT INTO folder_rules (library_id, folder_path, rule, stamp) VALUES (?, ?, ?, ?)
         ON CONFLICT (library_id, folder_path) DO UPDATE SET rule = excluded.rule, stamp = excluded.stamp`,
      )
      .run(LIB, rng.pick(SHOOTS), rng.pick(['excluded', 'plain']), stampOf(peer));
  },
  (peer, rng) => {
    peer.db
      .query('UPDATE libraries SET name = ?, stamp = ? WHERE id = ?')
      .run(`Trip ${rng.int(100)}`, stampOf(peer), LIB);
  },
  // Only over rows this peer still has, which is what the service layer checks
  // before it ever reaches a repository.
  (peer, rng) => {
    const shootId = rng.pick(SHOOTS);
    const photoId = rng.pick([...PHOTOS, null]);
    if (peer.db.query('SELECT 1 FROM shoots WHERE id = ?').get(shootId) == null) return;
    if (photoId != null && peer.db.query('SELECT 1 FROM photos WHERE id = ?').get(photoId) == null) return;
    new ShootsRepository(peer.db).setBanner(shootId, photoId);
  },
  (peer, rng) => new FolderRulesRepository(peer.db).clear(LIB, rng.pick(SHOOTS)),
  // Putting things away and getting them back (DESIGN §12.4). Each carries a stamp of its own, so what
  // is worth catching is a hide landing against a write that shares no unit with it - a rating or a
  // verdict on the same photograph, a banner or an ordering on the same shoot.
  //
  // A folder renamed on disk, which the scan follows rather than repairs (§9.4.1): it rewrites
  // `folder_path` across the shoot and everything under it and re-derives `parent_id`, the widest write
  // a shoot takes. The one action here that moves a shoot into or out of another's subtree, so it is
  // also what holds hiding's derivation against a tree that moves under it.
  //
  // Targets are drawn from one small set shared by both shoots, so two peers renaming *different*
  // folders onto one name comes up - the collision `shoots`' unique index refuses, settled by giving the
  // folder to whichever rename was earlier and sending the later one back (§5.6). That resolution is
  // what makes it a convergence question at all: deferred on both sides it could never agree.
  (peer, rng) => new PhotoStateRepository(peer.db, new StackMembership(peer.db)).setHidden([rng.pick(PHOTOS)], rng.next() < 0.5),
  (peer, rng) => {
    const shootId = rng.pick(SHOOTS);
    if (peer.db.query('SELECT 1 FROM shoots WHERE id = ?').get(shootId) == null) return;
    new ShootsRepository(peer.db).setHidden(shootId, rng.next() < 0.5);
  },
  (peer, rng) => {
    const shootId = rng.pick(SHOOTS);
    const row = peer.db.query('SELECT folder_path FROM shoots WHERE id = ?').get(shootId) as
      | { folder_path: string }
      | null;
    if (row == null) return;
    // Under a sibling or back out at the root, from a set both shoots draw from - so the two contend
    // for one folder often enough for a seed to find it.
    const other = SHOOTS.find((id) => id !== shootId) ?? shootId;
    const leaf = `moved-${rng.int(4)}`;
    const to = rng.next() < 0.5 ? `${other}/${leaf}` : leaf;
    if (to === row.folder_path) return;
    // Not onto a folder this peer already has: the rename this stands for is one the scan followed on a
    // real disk, where two folders cannot share a path. The collision worth reaching is the one *across*
    // peers, where each rename was legal where it was made.
    if (peer.db.query('SELECT 1 FROM shoots WHERE library_id = ? AND folder_path = ?').get(LIB, to) != null) return;
    new ShootsRepository(peer.db).relocate(shootId, row.folder_path, to);
  },
  // Develop settings, in an editor session of their own (§5.3). Sessions are the
  // one unit a merge takes whole, and the one place it can decide it needs a
  // person - so the walk has to be able to make that happen, including against a
  // photograph another peer is deleting in the same window.
  (peer, rng) => {
    const id = rng.pick(PHOTOS);
    const edits = new PhotoEditsRepository(peer.db);
    if (peer.db.query('SELECT 1 FROM photos WHERE id = ?').get(id) == null) return;
    const state = edits.get(id);
    // A session per few edits rather than per edit, which is what an editor being
    // opened, worked in and closed looks like.
    edits.save(id, { ...state.doc, exposure: rng.int(20) / 10 - 1 }, state.rev, `session${rng.int(4)}`);
  },
  // A folder leaving the library: the one thing that removes a photograph's row
  // outright rather than binning it, and the one that cascades - taking its
  // memberships, its banner and its edits with it inside SQLite, where no code
  // sees it happen.
  (peer, rng) => new PhotoPathsRepository(peer.db, new StackMembership(peer.db)).deleteByIds([rng.pick(PHOTOS)]),
  (peer, rng) => new ShootsRepository(peer.db).delete(rng.pick(SHOOTS)),
];

function stampOf(peer: Peer): string {
  // Through the same clock every other write uses, so the ordering it produces is
  // the one the merge will resolve by.
  return require('../stamps').stamp(peer.db) as string;
}

/**
 * One push over the endpoints a peer across the wire would reach, rather than
 * over `pushTo`'s local shortcut.
 *
 * The awaits are what makes this worth writing: `receive` is where the exclusion
 * per page lives, so two of these under one `Promise.all` interleave exactly as
 * two HTTP sessions do, and a page of one applies between two pages of the other.
 */
async function pushInto(
  service: ReplicationService,
  from: Peer,
  into: Peer,
  limit: number,
  order: string[],
): Promise<void> {
  const sender = peerId(from.db);
  const sink: ChangeSink = {
    peer: peerId(into.db),
    held: coverage(into.db, into.libraryId),
    apply: async (page) => {
      order.push(from.name);
      // Through JSON and the schema, as the route has it: what a sender may put in
      // a page is narrower than what a local `Page` can hold, and that boundary is
      // half of what a push *is*. The page alone, because the id these peers share
      // is a readable stand-in rather than a minted one.
      const wire = PushPageRequestSchema.shape.page.parse(JSON.parse(JSON.stringify(page)));
      return (await service.receive({ library_id: LIB, peer_id: sender, page: wire })).deferred;
    },
    done: async (delivered) =>
      service.finishReceiving({ library_id: LIB, peer_id: sender, delivered: packVector(delivered) }),
  };
  await pushTo(from, sink, limit);
}

function converged(peers: readonly Peer[]): void {
  for (let i = 1; i < peers.length; i++) {
    expect(differences(peers[0]!, peers[i]!)).toEqual([]);
  }
  for (const peer of peers) expect([peer.name, ...invariants(peer.db)]).toEqual([peer.name]);
}

/**
 * Replicates every pair until nothing more moves - measured, not assumed.
 *
 * A fixed number of rounds is not the same thing. Applying a page can *make* a
 * row: two diverged editor sessions are parked as candidates by whichever peer
 * first holds both, and a session ending the last round leaves that row with
 * nowhere to go. Which is a true statement about the system - it needs one more
 * session - and a false one about the test, which is asking what they agree on
 * once they have all met.
 */
function quiesce(peers: readonly Peer[], rng: Rng, links: readonly Link[] = everyPair(peers)): void {
  for (let round = 0; round < QUIESCE_ROUNDS; round++) {
    const before = peers.map((peer) => replicatedState(peer.db));
    meet(links, rng);
    if (peers.every((peer, i) => replicatedState(peer.db) === before[i])) return;
  }
  throw new Error(`the peers were still moving after ${QUIESCE_ROUNDS} rounds`);
}

const QUIESCE_ROUNDS = 12;

/** Who is able to talk to whom, which is not every pair once a peer joined through another. */
type Link = readonly [Peer, Peer];

function everyPair(peers: readonly Peer[]): Link[] {
  const pairs: Link[] = [];
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) pairs.push([peers[i]!, peers[j]!]);
  }
  return pairs;
}

function meet(links: readonly Link[], rng: Rng): void {
  // Shuffled, because "whatever order the peers happened to meet in" is the
  // property, and a fixed order would only ever test one of them.
  const pairs = [...links];
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [pairs[i]!, pairs[j]!] = [pairs[j]!, pairs[i]!];
  }
  for (const [a, b] of pairs) replicate(a, b);
}

describe('convergence', () => {
  it('brings a fresh replica to exactly what the peer it cloned from holds', () => {
    const server = makePeer('server');
    seed(server);
    const laptop = makePeer('laptop');

    pull(laptop, server);

    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  it.each(SEEDS)(
    'converges three peers working apart, whatever order they meet in (seed %i)',
    (seedValue) => {
      const rng = new Rng(seedValue * 7919);
      const peers = ['server', 'laptop', 'desktop'].map(makePeer);
      seed(peers[0]!);
      quiesce(peers, rng);

      // Everyone works offline, on the same photographs, in an order nobody chose.
      for (let step = 0; step < 150; step++) {
        const peer = rng.pick(peers);
        // Each peer's own time moves at its own rate, so writes genuinely
        // interleave - sometimes in the same millisecond, sometimes not - and the
        // interleaving is a function of the seed rather than of how fast this
        // machine happened to run.
        peer.advance(rng.int(3));
        rng.pick(ACTIONS)(peer, rng);
        // Peers meet occasionally rather than only at the end, so half the writes
        // land on state that has already been merged once.
        if (rng.next() < 0.25) replicate(rng.pick(peers), rng.pick(peers));
      }

      quiesce(peers, rng);
      converged(peers);
    },
  );

  // A chain, which is the only shape a third device can join in: `addReplica`
  // refuses a library already on the device, so a phone that took the library from
  // the server cannot then be introduced to the laptop, and the two ends never
  // meet. Everything the laptop writes reaches the phone because the server
  // re-sends what it took - the log is keyed by the origin that wrote a row, not
  // by whoever handed it over - and every grave the laptop collects has to survive
  // that relay. Nothing else here covers it: `quiesce` otherwise meets every pair.
  it.each(SEEDS)('carries work along a chain whose ends never meet (seed %i)', (seedValue) => {
    const rng = new Rng(seedValue * 32_452_843);
    const laptop = makePeer('laptop');
    const server = makePeer('server');
    const phone = makePeer('phone');
    seed(laptop);
    pull(server, laptop);
    pull(phone, server);
    // Paired as the joins would leave them, because that is what each peer waits
    // for before it collects a grave (§8.3): the laptop is free to drop one as soon
    // as the server has it, long before the phone has heard anything.
    for (const [one, other] of [
      [laptop, server],
      [server, phone],
    ] as Link[]) {
      registerPeer(one.db, LIB, peerId(other.db), other.name);
      registerPeer(other.db, LIB, peerId(one.db), one.name);
    }
    const links: Link[] = [
      [laptop, server],
      [server, phone],
    ];

    // Only the ends write. The server holds the library too, but what is being
    // asked here is whether it relays, so it is left as nothing but a relay.
    for (let step = 0; step < 60; step++) {
      const peer = rng.pick([laptop, phone]);
      peer.advance(rng.int(3));
      rng.pick(ACTIONS)(peer, rng);
      if (rng.next() < 0.25) {
        meet([rng.pick(links)], rng);
        for (const held of [laptop, server, phone]) collectTombstones(held.db, LIB);
      }
    }

    quiesce([laptop, server, phone], rng, links);
    converged([laptop, server, phone]);
  });

  // The shape the server meets (§6.4): it dials nobody, so everything it takes
  // arrives as somebody else's push, and two pushes are serialised only per page.
  // Both senders therefore stream against a coverage vector read before either
  // applied anything, their pages land alternately, and each closes on a vector
  // the other has been moving underneath it. Nothing else in this file covers
  // that: `pull` and `replicate` take a session whole.
  it.each(SEEDS)('converges a server two peers push into at once (seed %i)', async (seedValue) => {
    const rng = new Rng(seedValue * 15_485_863);
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    const desktop = makePeer('desktop');
    seed(server);
    quiesce([server, laptop, desktop], rng);

    const service = new ReplicationService(server.db, new BlobLocations(server.db));
    for (const peer of [laptop, desktop]) {
      service.pair({ library_id: LIB, peer_id: peerId(peer.db), name: peer.name });
    }

    for (const peer of [laptop, desktop, server]) {
      for (let step = 0; step < 40; step++) {
        peer.advance(rng.int(3));
        rng.pick(ACTIONS)(peer, rng);
      }
    }

    // Small pages, so there are enough of them for the two sessions to interleave
    // rather than each finishing inside one round trip.
    const order: string[] = [];
    await Promise.all([pushInto(service, laptop, server, 3, order), pushInto(service, desktop, server, 3, order)]);

    // Asserted rather than assumed, because it is the whole premise: a change that
    // ran one session to its end before starting the other would leave everything
    // below passing while testing nothing this file does not already cover.
    const alternations = order.filter((name, i) => name !== order[i - 1]).length;
    expect([`pages: ${order.join(',')}`, alternations > 2]).toEqual([`pages: ${order.join(',')}`, true]);

    quiesce([server, laptop, desktop], rng);
    converged([server, laptop, desktop]);
  });

  // The shape the feature exists for: nobody meets anybody until the trip is
  // over, so every peer has a long run of work the others know nothing about.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('converges four peers that never met until the end (seed %i)', (seedValue) => {
    const rng = new Rng(seedValue * 104_729);
    const peers = ['server', 'laptop', 'desktop', 'phone'].map(makePeer);
    seed(peers[0]!);
    quiesce(peers, rng);

    for (const peer of peers) {
      for (let step = 0; step < 40; step++) {
        peer.advance(rng.int(3));
        rng.pick(ACTIONS)(peer, rng);
      }
    }

    quiesce(peers, rng);
    converged(peers);
  });

  // The rule the random walk exercises by accident, stated on its own so that a
  // change to it fails by name rather than as a seed nobody can read.
  it('keeps a photograph deleted even where somebody edited it afterwards, because its folder has left', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    const stacks = new StacksRepository(server.db);
    stacks.create('st1', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    stacks.addPhotos('st1', ['p1', 'p2']);
    replicate(server, laptop);

    // The server drops the folder; the laptop, still offline and knowing nothing
    // about that, goes on working and rates the photograph afterwards.
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    laptop.advance();
    new PhotoStateRepository(laptop.db, new StackMembership(laptop.db)).update('p1', { rating: 5 });
    replicate(server, laptop);

    // The rating is newer, and it still does not bring the row back: the only
    // thing that removes a photograph's row is its folder leaving the library, so
    // a rating made in ignorance of that is not a request to keep it. Letting the
    // folder back in imports its files as new photographs, which is the
    // resurrection a person would recognise.
    for (const peer of [server, laptop]) {
      expect(peer.db.query('SELECT 1 FROM photos WHERE id = ?').get('p1')).toBeNull();
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
    expect(laptop.db.query('SELECT COUNT(*) AS n FROM stack_members WHERE photo_id = ?').get('p1')).toEqual({ n: 0 });
  });


  it('makes one stack of two that overlap, keeping the union and the later stack', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    // Both stack the same burst while apart, and one of them sees a third frame.
    const early = new StacksRepository(server.db);
    early.create('stackaaaaaaaaaaaa', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    early.addPhotos('stackaaaaaaaaaaaa', ['p1', 'p2']);
    laptop.advance();
    const later = new StacksRepository(laptop.db);
    later.create('stackbbbbbbbbbbbb', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    later.addPhotos('stackbbbbbbbbbbbb', ['p1', 'p2', 'p3']);

    quiesce([server, laptop], new Rng(1));

    for (const peer of [server, laptop]) {
      // The one created last survives, and nothing is orphaned: p3 came from the
      // larger set and p1/p2 moved rather than being left behind.
      const members = peer.db
        .query('SELECT stack_id, photo_id FROM stack_members ORDER BY photo_id')
        .all() as { stack_id: string; photo_id: string }[];
      expect(members.map((row) => row.photo_id)).toEqual(['p1', 'p2', 'p3']);
      expect(new Set(members.map((row) => row.stack_id))).toEqual(new Set(['stackbbbbbbbbbbbb']));
      expect(peer.db.query('SELECT id FROM stacks ORDER BY id').all()).toEqual([{ id: 'stackbbbbbbbbbbbb' }]);
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  it('does not put a photograph back in a stack somebody took it out of', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    // The laptop stacks a smaller set; the server's is later, so the server's wins
    // the collapse - and the server has already had p2 taken out of its stack.
    const early = new StacksRepository(laptop.db);
    early.create('stackaaaaaaaaaaaa', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    early.addPhotos('stackaaaaaaaaaaaa', ['p1', 'p2']);
    server.advance();
    const later = new StacksRepository(server.db);
    later.create('stackbbbbbbbbbbbb', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    later.addPhotos('stackbbbbbbbbbbbb', ['p1', 'p2', 'p3']);
    server.advance();
    later.removePhotos('stackbbbbbbbbbbbb', ['p2'], true);

    quiesce([server, laptop], new Rng(2));

    for (const peer of [server, laptop]) {
      const members = peer.db
        .query("SELECT photo_id FROM stack_members WHERE stack_id = 'stackbbbbbbbbbbbb' ORDER BY photo_id")
        .all() as { photo_id: string }[];
      // p2 stays out. The collapse is machine work, minted just now, so left to
      // itself it would beat the removal every time rather than sometimes.
      expect(members.map((row) => row.photo_id)).toEqual(['p1', 'p3']);
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  /**
   * §3.1: a folder rename rewrites member *placement* units and only them; it
   * never touches bin units.
   *
   * `deleted_from_path` is a bin-unit column, so correcting it for a rename and
   * stamping the bin unit says the binning was decided now - and that beats a
   * restore made on another peer while this one was apart. The photograph goes
   * back in the bin everywhere, and the person who took it out is never told.
   */
  it('does not un-restore a photograph because a folder was renamed', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    const photos = new PhotoPathsRepository(server.db, new StackMembership(server.db));
    // Binned from a folder, which is what makes `deleted_from_path` interesting:
    // it is where a restore puts the photograph back.
    photos.markDeleted('p1', 'Day1/p1.arw');
    replicate(server, laptop);
    expect(laptop.db.query("SELECT is_deleted FROM photos WHERE id = 'p1'").get()).toMatchObject({ is_deleted: 1 });

    // The laptop takes it back out of the bin...
    laptop.advance();
    new PhotoPathsRepository(laptop.db, new StackMembership(laptop.db)).markRestored('p1', 'Day1/p1.arw');

    // ...and the server, which has not heard, renames the folder it was binned
    // from. A path correction, not a decision about binning - and it has to be
    // provably *later* than the restore, or a stamped bin unit could lose the
    // race by luck and the test would pass without exercising anything. Both
    // peers start at the same instant, so one `advance` each leaves them level
    // and only the peer id breaks the tie.
    server.advance(120_000);
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).rewritePathPrefix(LIB, 'Day1', 'Journey');

    quiesce([server, laptop], new Rng(23));

    for (const peer of [server, laptop]) {
      const row = peer.db.query("SELECT is_deleted, deleted_from_path FROM photos WHERE id = 'p1'").get() as {
        is_deleted: number;
        deleted_from_path: string | null;
      };
      expect(row.is_deleted).toBe(0);
      // Out of the bin, so it has no origin to go back to - and specifically not
      // a stale one, which is the state a placement-carried column would leave.
      expect(row.deleted_from_path).toBeNull();
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  /**
   * A rename must follow a binned-in-place row's file on every peer, including one
   * whose `deleted_from_path` disagrees.
   *
   * Only `file_path` replicates of that pair - the origin is a bin column and is
   * corrected without a bin stamp - so a peer that took the move but not the
   * correction holds the old origin against the new path. Classified by the pair's
   * equality, that peer reads the row as bin-resident and leaves its path alone;
   * the file at the new path then imports as a second, live photograph, and *that*
   * replicates back.
   */
  it('follows a rename for a binned-in-place row whose origin the peer never got', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    const photos = new PhotoPathsRepository(server.db, new StackMembership(server.db));
    // Binned where it stands, so file and origin are the same path.
    photos.setFilePath('p1', 'Day1/p1.arw');
    photos.markDeleted('p1', 'Day1/p1.arw');
    replicate(server, laptop);

    // The laptop is where the pair comes apart: a correction that does not travel.
    laptop.advance();
    new PhotoMetadataRepository(
      laptop.db,
      new PhotoProcessingRepository(laptop.db, new RenditionsRepository(laptop.db)),
    ).moveBinnedInPlace('p1', 'Day1/moved.arw');
    replicate(laptop, server);
    server.advance();

    // Now rename the folder on the server, whose origin for this row is stale.
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).rewritePathPrefix(LIB, 'Day1', 'Journey');

    const moved = server.db
      .query("SELECT json_extract(recipe, '$.path') AS path FROM photos WHERE id = 'p1'")
      .get() as { path: string };
    expect(moved.path).toBe('Journey/moved.arw');
  });

  // The other half of the same rule, with nobody restoring: a binned photograph
  // keeps the origin its binning gave it, whatever else moves. A path column
  // carried on the placement unit would have a peer that still thinks the row is
  // live null it, after which a restore puts the RAW in the library root.
  it('keeps a binned photograph its origin when another peer moves it', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    server.advance();
    new PhotoPathsRepository(server.db, new StackMembership(server.db)).markDeleted('p1', 'Day1/p1.arw');
    // The laptop has not heard, and does something ordinary and later to the path.
    laptop.advance(120_000);
    new PhotoPathsRepository(laptop.db, new StackMembership(laptop.db)).setFilePath('p1', 'Day2/p1.arw');

    quiesce([server, laptop], new Rng(31));

    for (const peer of [server, laptop]) {
      const row = peer.db.query("SELECT is_deleted, deleted_from_path FROM photos WHERE id = 'p1'").get() as {
        is_deleted: number;
        deleted_from_path: string | null;
      };
      expect(row.is_deleted).toBe(1);
      expect(row.deleted_from_path).toBe('Day1/p1.arw');
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  /**
   * `updated_at` is what says a rendition is out of date: `queueEditedSince`
   * rebuilds against it, and §7.9's fetch-through refuses to serve against it. So
   * a peer whose copy stops advancing keeps showing - and keeps handing other
   * peers - the picture from before the edit, and nothing ever comes to correct
   * it, because nothing is looking at anything that changed.
   *
   * It has to be a *replicated column*, not merely part of the row's identity:
   * identity seeds an insert, and every edit after the first for a given photo
   * takes the update path instead.
   */
  it('carries the time of an edit, not just the edit', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    const edits = new PhotoEditsRepository(server.db);
    edits.save('p1', { exposure: 0.5 } as never, 0, 'sessionone');
    replicate(server, laptop);
    // The first edit lands by insert, which does carry it.
    const afterFirst = laptop.db.query("SELECT updated_at FROM photo_edits WHERE photo_id = 'p1'").get() as {
      updated_at: string;
    };
    expect(afterFirst.updated_at).toBe(
      (server.db.query("SELECT updated_at FROM photo_edits WHERE photo_id = 'p1'").get() as {
        updated_at: string;
      }).updated_at,
    );

    // **Pushed back by hand, on both, because `updated_at` is the wall clock's and this
    // harness drives everything else off a clock of its own.** Two saves inside one real
    // millisecond record the same time, which on a fast machine is most of the time - and the
    // assertion below would then pass on the value the *insert* carried and say nothing about
    // the update path it is there to test. Both peers, so they still agree going in.
    const BEFORE = '2020-01-01T00:00:00.000Z';
    for (const peer of [server, laptop]) {
      peer.db.query("UPDATE photo_edits SET updated_at = ? WHERE photo_id = 'p1'").run(BEFORE);
    }

    server.advance(60_000);
    const held = edits.get('p1');
    edits.save('p1', { ...held.doc, exposure: 1.5 }, held.rev, 'sessionone');
    replicate(server, laptop);

    const mine = laptop.db.query("SELECT doc, updated_at FROM photo_edits WHERE photo_id = 'p1'").get() as {
      doc: string;
      updated_at: string;
    };
    const theirs = server.db.query("SELECT doc, updated_at FROM photo_edits WHERE photo_id = 'p1'").get() as {
      doc: string;
      updated_at: string;
    };
    // The document converged either way; that was never the question.
    expect(mine.doc).toBe(theirs.doc);
    expect(mine.updated_at).toBe(theirs.updated_at);
    expect(mine.updated_at).not.toBe(BEFORE);
  });

  /**
   * A collapse is machine work and is stamped where it ran (§5.2), which leaves
   * it above a deliberate unstack that has not arrived yet. `removedFromWinner`
   * is what covers that, by asking outright rather than by the ordering - so this
   * pins the *asking*, over the case the ordering cannot decide.
   */
  it('leaves a photograph out when the winner already buried it, however old the grave', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    // Two stacks over one photograph, which one peer cannot make on its own -
    // membership is single-stack here - so the overlap arrives by replication.
    const early = new StacksRepository(laptop.db);
    early.create('stackaaaaaaaaaaaa', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    early.addPhotos('stackaaaaaaaaaaaa', ['p1', 'p4']);
    server.advance();
    const later = new StacksRepository(server.db);
    later.create('stackbbbbbbbbbbbb', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    later.addPhotos('stackbbbbbbbbbbbb', ['p1', 'p2', 'p3', 'p4']);
    // Taken out of the winner long ago, and then a long time passes: the collapse
    // that follows is minted now, so it outranks this grave by an hour. Only the
    // guard keeps p4 out, and it is the guard this is about.
    later.removePhotos('stackbbbbbbbbbbbb', ['p4'], true);
    server.advance(60 * 60 * 1000);
    laptop.advance(60 * 60 * 1000);

    replicate(server, laptop);
    quiesce([server, laptop], new Rng(11));

    for (const peer of [server, laptop]) {
      const members = peer.db
        .query("SELECT photo_id FROM stack_members WHERE stack_id = 'stackbbbbbbbbbbbb' ORDER BY photo_id")
        .all() as { photo_id: string }[];
      expect(members.map((row) => row.photo_id)).toEqual(['p1', 'p2', 'p3']);
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  it('takes the shoots under a deleted one, including a child the sender never heard of', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    // The laptop makes a child of s1 while the server, knowing nothing about it,
    // deletes s1. The server's tombstone names one shoot; the laptop's foreign key
    // would take two, and only one of them would have been written down.
    laptop.advance();
    laptop.db
      .query("INSERT INTO shoots (id, library_id, parent_id, folder_path, name, stamp) VALUES (?, ?, 's1', ?, ?, ?)")
      .run('s1child', LIB, 's1/inner', 'Inner', stampOf(laptop));
    server.advance();
    new ShootsRepository(server.db).delete('s1');

    quiesce([server, laptop], new Rng(4));

    for (const peer of [server, laptop]) {
      expect(peer.db.query('SELECT id FROM shoots ORDER BY id').all()).toEqual([{ id: 's2' }]);
    }
    // Written down on the way out by the peer that had it, or its log advertises a
    // row nobody can be sent and whoever holds a copy is never corrected. The
    // server never heard of the child, so it has nothing to say about it.
    const grave = laptop.db
      .query("SELECT stamp FROM replication_log WHERE entity = 'shoot' AND row_id = 's1child' AND deleted = 1")
      .get();
    expect(grave).not.toBeNull();
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  it('dissolves a stack two peers emptied between them, which neither did alone', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    const stacks = new StacksRepository(server.db);
    stacks.create('stackaaaaaaaaaaaa', LIB, 'manual', '2026-01-01T00:00:00.000Z');
    stacks.addPhotos('stackaaaaaaaaaaaa', ['p1', 'p2', 'p3']);
    replicate(server, laptop);

    // Each takes a different one out, and each is left holding two - so neither
    // peer's own rule fires, and only the merge of the two ends the stack.
    server.advance();
    stacks.removePhotos('stackaaaaaaaaaaaa', ['p2'], true);
    laptop.advance();
    new StacksRepository(laptop.db).removePhotos('stackaaaaaaaaaaaa', ['p3'], true);

    quiesce([server, laptop], new Rng(3));

    for (const peer of [server, laptop]) {
      // One photograph is a photograph, however it came to be one.
      expect(peer.db.query('SELECT id FROM stacks').all()).toEqual([]);
      expect(peer.db.query('SELECT photo_id FROM stack_members').all()).toEqual([]);
      expect(peer.db.query('SELECT stack_id FROM photos WHERE id = ?').get('p1')).toEqual({ stack_id: null });
    }
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  it('keeps a deletion that nothing newer contradicts', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    replicate(server, laptop);

    new PhotoPathsRepository(server.db, new StackMembership(server.db)).deleteByIds(['p1']);
    replicate(server, laptop);

    expect(laptop.db.query('SELECT 1 FROM photos WHERE id = ?').get('p1')).toBeNull();
    expect(replicatedState(laptop.db)).toBe(replicatedState(server.db));
  });

  it('is unmoved by applying the same page twice', () => {
    const server = makePeer('server');
    const laptop = makePeer('laptop');
    seed(server);
    new PhotoStateRepository(server.db, new StackMembership(server.db)).update('p1', { rating: 4 });

    pull(laptop, server);
    const once = replicatedState(laptop.db);
    // A resumed session re-sends what it had already applied, so this is the
    // ordinary case rather than a strange one.
    laptop.db.query('DELETE FROM replication_vectors').run();
    pull(laptop, server);

    expect(replicatedState(laptop.db)).toBe(once);
  });
});
