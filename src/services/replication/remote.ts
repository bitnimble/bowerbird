import type { Database } from '../../db/driver';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { latestMigrationMillis } from '../../db/migrate';
import { AppError, type ErrorCode } from '../../errors';
import { Logger } from '../../logger';
import { ErrorEnvelopeSchema } from '../../schemas/error';
import {
  AckRequestSchema,
  ChangesRequestSchema,
  HandshakeRequestSchema,
  HandshakeResponseSchema,
  PAGE_ROWS,
  PageSchema,
  PairRequestSchema,
  PairResponseSchema,
  PushDoneRequestSchema,
  PushPageRequestSchema,
  PushPageResponseSchema,
  REPLICATION_PROTOCOL,
  RemoteLibrariesSchema,
  UnpairRequestSchema,
  type BrowsedRemote,
  type HandshakeResponse,
  type PairResponse,
} from '../../schemas/replication';
import { assertNoDataDirectoryOverlap, isWritable } from '../libraries/libraries_service';
import { DEFAULT_BIN_NAME } from '../../schemas/libraries';
import { PathSegment, route } from '../../schemas/route';
import { libraryMutex } from '../sync/coordination/library_mutex';
import { deviceName, markReplicated, recordPeerAppetite, registerPeer, syncsOriginals } from './pairing';
import { peerId } from './stamps';
import {
  pullFrom,
  pushTo,
  type ChangeSink,
  type ChangeSource,
  type Guard,
  type PullResult,
  type Replica,
} from './session';
import { coverage, packVector, unpackVector } from './vectors';

// The initiating half of replication (docs/replication.md §6.4): what this
// process does against a peer that listens. The pages it fetches are remote
// input to this catalogue and eventually to this disk, so every response goes
// through the wire schemas before the merge engine sees it (§11.2).

const log = new Logger('replication');

const BROWSE_SKEW_NOTE_MS = 5 * 60 * 1000;

export interface ClonedLibrary {
  libraryId: string;
  /** The remote peer's id, as its pairing response named it. */
  peer: string;
}

/** What a peer is offering (§9.1). A read: nothing is registered on either side. */
export async function browseRemote(base: string): Promise<BrowsedRemote> {
  const offered = RemoteLibrariesSchema.parse(await get(base, route(PathSegment.libraries())));

  // §9: clocks that drift have usually been drifting since long before this, and
  // this is the cheapest moment to say so - a note, blocking nothing, well
  // before the session guard would start refusing. Carried back rather than only
  // logged, so the dialog can say it where somebody is reading.
  const skew = Math.abs(Date.now() - offered.clock_ms);
  if (skew > BROWSE_SKEW_NOTE_MS) {
    log.warn('the remote\'s clock disagrees with this machine; consider fixing NTP', {
      seconds: Math.round(skew / 1000),
    });
  }
  return { ...offered, clock_skew_ms: skew };
}

/**
 * Births the replica (§9.1): the remote's library id verbatim under a local root,
 * linked for replication, the remote recorded as a paired peer. The catalogue
 * then arrives by `pullFromRemote` as the ordinary delta stream against an empty
 * vector - there is no snapshot path to be a second, subtly different copy.
 *
 * The root has to be empty, or not exist yet. A clone lands a whole catalogue's
 * worth of paths under it and materialises files into them, and a folder that
 * already holds photographs would have the scan import them as this library's -
 * which then replicates to every peer as photographs that appeared on their disk.
 *
 * The local half is checked *before* the remote is asked to pair, so the usual
 * failure - a folder that is not empty - costs nothing on the other device. What
 * cannot be ordered away is a local failure after the remote has recorded us, so
 * that one is rolled back by unpairing rather than left as a peer that never
 * arrives (§8.3).
 *
 * Serialised per library, across the network call and not merely around the
 * write. Two adds of the same library would otherwise both pass the existence
 * check, both pair - the peer id is this whole device's, so the second is an
 * upsert of the first - and the loser's rollback would then unpair the winner,
 * leaving a replica whose every future session is refused. Nothing local can be
 * waiting on this lock, because until the transaction commits there is no
 * library here to be waiting on.
 */
export function addReplica(
  db: Database,
  base: string,
  libraryId: string,
  rootPath: string,
  syncOriginals = true,
): Promise<ClonedLibrary> {
  return libraryMutex.run(libraryId, async () => {
    if (db.query('SELECT 1 FROM libraries WHERE id = ?').get(libraryId) != null) {
      throw new AppError(
        'CONFLICT',
        'that library is already on this device. If its catalogue looks incomplete, it is still arriving - ' +
          'it carries on by itself, and Replicate now asks for the rest.',
      );
    }
    // The same refusal `LibrariesService.create` makes, and for a worse reason
    // here: nothing in the add path would notice, and the check that does runs at
    // module scope on the *next* start, where it throws before the server listens.
    // A library nobody can delete, on a server that will not boot to be asked.
    try {
      assertNoDataDirectoryOverlap(rootPath);
    } catch (error) {
      throw new AppError('VALIDATION_ERROR', (error as Error).message);
    }
    if (db.query('SELECT 1 FROM libraries WHERE root_path = ?').get(rootPath) != null) {
      throw new AppError('CONFLICT', `library root already registered: ${rootPath}`);
    }
    assertEmptyRoot(rootPath);
    mkdirSync(rootPath, { recursive: true });
    if (!isWritable(rootPath)) {
      throw new AppError('READ_ONLY', `${rootPath} is not writable, and a replica has to be written to`);
    }

    // Inside the rollback, not before it: `post` resolving means the remote has
    // already committed the pairing, so a reply this side cannot parse is one of
    // the failures the unpair exists for.
    let paired: PairResponse;
    try {
      paired = PairResponseSchema.parse(
        await post(
          base,
          route(PathSegment.pair()),
          PairRequestSchema.parse({ library_id: libraryId, peer_id: peerId(db), name: deviceName(db) }),
        ),
      );
      if (paired.library_id !== libraryId) {
        throw new AppError(
          'CONFLICT',
          `asked ${base} for library ${libraryId} and it paired ${paired.library_id}; nothing was added`,
        );
      }
      db.transaction(() => {
        // Re-read rather than trusting the check above: the pairing between them
        // is a network round trip, and the remote genesis-stamps a whole
        // catalogue inside it. Anything dropped into the folder in that window
        // would be imported as this library's own and replicated to every peer.
        assertEmptyRoot(rootPath);
        db.query('INSERT INTO libraries (id, root_path, name, bin_name) VALUES (?, ?, ?, ?)').run(
          libraryId,
          rootPath,
          paired.library_name,
          // Writable with no bin is the one shape the columns must never hold
          // (§4.1): binning would flag rows deleted and leave the files, and
          // replicate that to peers as though they had moved. The real name
          // arrives with the library unit on the first page and overwrites this.
          DEFAULT_BIN_NAME,
        );
        // Linked bare, without the genesis walk the server ran when it paired: a
        // clone is born holding nothing, and genesis-stamping its default-valued
        // library row would let those defaults beat the server's real settings.
        db.query('INSERT INTO replication_libraries (library_id, sync_originals) VALUES (?, ?)').run(
          libraryId,
          syncOriginals ? 1 : 0,
        );
        // With the address, because this is the side that dials: everything this
        // replica ever wants from the server - a session, a photograph's original, a
        // rendition it cannot build - goes back to where it paired.
        registerPeer(db, libraryId, paired.peer_id, paired.name, base);
      })();
    } catch (error) {
      await unpairFrom(base, libraryId, peerId(db));
      throw error;
    }
    return { libraryId, peer: paired.peer_id };
  });
}

/**
 * Tells a peer to forget this device (§8.4), so its vector stops bounding
 * tombstone collection on behalf of one that is not coming. Never throws: it is
 * only ever called while something else is already going wrong.
 */
async function unpairFrom(base: string, libraryId: string, self: string): Promise<void> {
  try {
    await post(base, route(PathSegment.unpair()), UnpairRequestSchema.parse({ library_id: libraryId, peer_id: self }));
  } catch (error) {
    // Retracted broadly rather than only where the pairing is known to have
    // landed, because the case worth covering is exactly the one this side
    // cannot tell apart: a reply that never arrived over a pairing that did. So
    // "there was nothing to forget" is an ordinary answer, not a problem.
    if (error instanceof AppError && error.code === 'NOT_FOUND') return;
    log.warn('could not undo a pairing whose local half failed', { library: libraryId, err: String(error) });
  }
}

function assertEmptyRoot(rootPath: string): void {
  if (!existsSync(rootPath)) return;
  if (!statSync(rootPath).isDirectory()) {
    throw new AppError('VALIDATION_ERROR', `not a folder: ${rootPath}`);
  }
  const holds = readdirSync(rootPath);
  if (holds.length > 0) {
    throw new AppError(
      'CONFLICT',
      `${rootPath} is not empty. A synced library needs a new or empty folder: anything already in this one ` +
        'would be imported as part of the library and appear on every other device.',
    );
  }
}

/**
 * The exchange both directions of a session open with (§6.2), which is also
 * where each side learns whether the other keeps RAW files (§7.10).
 */
async function handshake(replica: Replica, base: string): Promise<HandshakeResponse> {
  const shaken = HandshakeResponseSchema.parse(
    await post(
      base,
      route(PathSegment.handshake()),
      HandshakeRequestSchema.parse({
        protocol: REPLICATION_PROTOCOL,
        schema: latestMigrationMillis(),
        library_id: replica.libraryId,
        peer_id: peerId(replica.db),
        clock_ms: Date.now(),
        coverage: packVector(coverage(replica.db, replica.libraryId)),
        wants_originals: syncsOriginals(replica.db, replica.libraryId),
      }),
    ),
  );
  recordPeerAppetite(replica.db, replica.libraryId, shaken.peer_id, shaken.wants_originals);
  return shaken;
}

/** Handshakes (§6.2) and returns the remote as a source `pullFrom` can drain. */
export async function openRemote(into: Replica, base: string): Promise<ChangeSource> {
  const library = into.db.query('SELECT read_only FROM libraries WHERE id = ?').get(into.libraryId) as {
    read_only: number;
  } | null;
  if (library == null) throw new AppError('NOT_FOUND', `library not found: ${into.libraryId}`);
  if (library.read_only !== 0) throw new AppError('READ_ONLY', 'replication requires a writable library');

  const self = peerId(into.db);
  const shaken = await handshake(into, base);
  return {
    peer: shaken.peer_id,
    delivered: unpackVector(shaken.coverage),
    page: async (held, cursor, limit) =>
      PageSchema.parse(
        await post(
          base,
          route(PathSegment.changes()),
          ChangesRequestSchema.parse({ library_id: into.libraryId, peer_id: self, held: packVector(held), cursor, limit }),
        ),
      ),
  };
}

/**
 * Hands the remote everything this replica holds and it lacks (§6.4).
 *
 * The half a pull cannot do. Only one of two peers can usually dial the other -
 * a laptop reaches the server, and the server reaches a laptop behind whatever
 * network it is on today, which is to say never - so the peer that dials has to
 * be able to offer its own work as well as ask for theirs. Without this a trip's
 * ratings, edits and verdicts stay on the laptop for good.
 */
export async function pushToRemote(from: Replica, base: string, limit = PAGE_ROWS): Promise<PullResult> {
  const self = peerId(from.db);
  const shaken = await handshake(from, base);
  const sink: ChangeSink = {
    peer: shaken.peer_id,
    held: unpackVector(shaken.coverage),
    apply: async (page) => {
      const answer = PushPageResponseSchema.parse(
        await post(
          base,
          route(PathSegment.push()),
          PushPageRequestSchema.parse({ library_id: from.libraryId, peer_id: self, page }),
        ),
      );
      return answer.deferred;
    },
    done: async (delivered) => {
      await post(
        base,
        route(PathSegment.push(), PathSegment.done()),
        PushDoneRequestSchema.parse({ library_id: from.libraryId, peer_id: self, delivered: packVector(delivered) }),
      );
    },
  };
  return pushTo(from, sink, limit);
}

/** One direction of a session (§6.2); the other is the remote pulling back. */
export async function pullFromRemote(
  into: Replica,
  base: string,
  limit = PAGE_ROWS,
  guard?: Guard,
): Promise<PullResult> {
  const source = await openRemote(into, base);
  const result = await pullFrom(into, source, limit, guard);
  // The sender learns what this replica now holds, which is what its tombstone
  // GC is bounded by (§8.3): a sender nobody ever told would either reap graves
  // its pullers had not heard, or hold every grave forever.
  await post(
    base,
    route(PathSegment.ack()),
    AckRequestSchema.parse({
      library_id: into.libraryId,
      peer_id: peerId(into.db),
      coverage: packVector(coverage(into.db, into.libraryId)),
    }),
  );
  markReplicated(into.db, into.libraryId, source.peer);
  return result;
}

// The remote can only send codes this app defines; anything else arrives as an
// INTERNAL_ERROR rather than an invented status.
const REMOTE_CODES: readonly ErrorCode[] = [
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'CONFLICT',
  'READ_ONLY',
  'IO_ERROR',
  'SYNC_IN_PROGRESS',
  'CLOCK_SKEW',
  'INTERNAL_ERROR',
];

/**
 * How long one request may take before the session gives up on the peer.
 *
 * `fetch` has no timeout of its own, and the network this runs on is hotel wifi
 * and a laptop that closed its lid: a connection that stalls rather than fails
 * would otherwise hold the session open indefinitely, and everything the session
 * is holding with it. Generous, because a page is five hundred rows over a link
 * that may be slow as well as flaky - what it bounds is *stopped*, not slow.
 */
const REQUEST_TIMEOUT_MS = 120_000;

function post(base: string, path: string, body: unknown): Promise<unknown> {
  return send(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(base: string, path: string): Promise<unknown> {
  return send(base, path, { method: 'GET' });
}

async function send(base: string, path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${base}${route(PathSegment.api(), PathSegment.replication())}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 204) return null;
  const parsed: unknown = await response.json().catch(() => null);
  if (response.ok) return parsed;

  // Handed on under the remote's own code, so a caller treats "not paired" from
  // across the wire exactly as it would from its own service.
  const envelope = ErrorEnvelopeSchema.safeParse(parsed);
  const code = envelope.success ? envelope.data.error.code : undefined;
  const known = REMOTE_CODES.find((candidate) => candidate === code) ?? 'INTERNAL_ERROR';
  const message = envelope.success ? envelope.data.error.message : `replication request failed (${response.status})`;
  throw new AppError(known, message);
}
