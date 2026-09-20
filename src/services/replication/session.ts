import type { Database } from '../../db/driver';
import { AppError } from '../../errors';
import { applyChanges, dissolveEmptiedStacks, observePage, rebuildCandidates } from './apply';
import { stampBefore, stampPeer } from './clock';
import { repair } from './repair';
import { peerId } from './stamps';
import { PAGE_ROWS, type Page } from '../../schemas/replication';
import { page } from './stream';
import { advance, coverage, recordPeer, type Vector } from './vectors';

// One replication session, as the two halves it is made of (docs/replication.md §6.2).
//
// The transport is deliberately absent: a session is a sender that can answer
// "what am I missing" and a receiver that applies the answer, and whether those
// two are in one process or on opposite sides of the world is the transport's
// business. That is also what makes the whole engine testable in milliseconds
// against two in-memory catalogues.

export interface Replica {
  db: Database;
  libraryId: string;
}

/** A sender a receiver can drain, wherever it lives: `remote.ts` puts one behind HTTP. */
export interface ChangeSource {
  /** The sending peer's id. */
  readonly peer: string;
  /**
   * The sender's coverage as of the handshake: what it is about to prove it
   * delivered. Read before a single page is sent, so anything the sender writes
   * during the session gets a higher stamp and is honestly left for next time.
   */
  readonly delivered: Vector;
  page(held: Vector, cursor: string, limit: number): Promise<Page>;
}

export interface PullResult {
  applied: number;
  pages: number;
  /** Changes whose parent this peer no longer has, left for a later session. */
  deferred: number;
  /**
   * Photographs whose develop settings or recipe arrived, which may owe a tile and a rendition.
   *
   * The pictures on this device are built from the edits, so an edit that lands
   * without them is a peer showing the frame as it was before somebody changed it
   * - and showing it indefinitely, since nothing else asks. The same debt an
   * arriving original leaves (§7.8), from the other direction.
   */
  edited: string[];
}

/**
 * Takes everything `from` holds and `into` lacks.
 *
 * **The vector moves once, at the end, and never past what the sender itself
 * held.** Advancing per page to the newest stamp in it would claim coverage of
 * every origin up to that stamp, including origins the sender was behind on -
 * after which the receiver would never ask anyone for that work again. Resuming
 * is therefore the cursor's job, not the vector's: an interrupted session leaves
 * the vector where it was and re-streams what it had already applied, which
 * costs bandwidth and changes nothing, because applying a page twice is the same
 * as applying it once.
 */
export function pull(into: Replica, from: Replica, limit = PAGE_ROWS): PullResult {
  const delivered = coverage(from.db, from.libraryId);
  const intake = open(into);

  let cursor = '';
  for (;;) {
    const next = page(from.db, from.libraryId, intake.held, cursor, limit);
    observePage(into.db, next.changes);
    accept(into, intake, next);
    cursor = next.cursor;
    if (next.done) break;
  }
  return close(into, intake, peerId(from.db), delivered);
}

/**
 * The same, from a sender that is not in this process.
 *
 * The one rule the local path does not need: a received page is bounded by this
 * machine's clock (docs/replication.md §2.2). A peer can pass an honest
 * handshake and still ship future-dated stamps in payloads, and a stamp past
 * the skew bound would win every conflict for as long as it is ahead.
 */
export async function pullFrom(
  into: Replica,
  source: ChangeSource,
  limit = PAGE_ROWS,
  guard: Guard = unsynchronised,
): Promise<PullResult> {
  const delivered = new Map(source.delivered);
  const intake = open(into);

  let cursor = '';
  for (;;) {
    const next = await source.page(intake.held, cursor, limit);
    if (!observePage(into.db, next.changes)) {
      throw new AppError('VALIDATION_ERROR', 'page carries malformed or future-dated stamps');
    }
    await guard(() => accept(into, intake, next));
    cursor = next.cursor;
    if (next.done) break;
  }
  return guard(() => close(into, intake, source.peer, delivered));
}

/**
 * Runs one page's apply where nothing else may be writing this library.
 *
 * Taken per page rather than around the session, because a session is network:
 * held across a peer that has stopped answering rather than failing, it would
 * freeze every binning, rename, scan and incoming push on that library for as
 * long as the connection takes to give up on itself.
 */
export type Guard = <T>(fn: () => T) => Promise<T>;

/**
 * The guard for a pull with nothing to be serialised against.
 *
 * Named rather than written inline as a default, so that omitting the argument
 * reads as this choice rather than as an argument somebody forgot: what it means is
 * "no scan, bin, rename or inbound push can run against this library while the
 * page applies", which is true of a pull between two replicas in one process and
 * is not true of anything the server does.
 */
export const unsynchronised: Guard = (fn) => Promise.resolve(fn());

/** A session in both directions, which is what "replicate with that peer" means. */
export function replicate(a: Replica, b: Replica, limit = PAGE_ROWS): void {
  pull(a, b, limit);
  pull(b, a, limit);
}

/**
 * A receiver a sender can hand pages to, which is a pull turned around.
 *
 * Needed because only one of two peers can usually dial the other: a laptop
 * reaches the server, and the server reaches a laptop that is behind whatever
 * network it is on today, which is to say never (§6.4). Without this, everything
 * the laptop did on the trip stays on the laptop - it can take the server's work
 * and has no way to offer its own.
 */
export interface ChangeSink {
  /** The receiving peer's id. */
  readonly peer: string;
  /** What the receiver already holds, so the sender streams only what it lacks. */
  readonly held: Vector;
  /** @returns the stamps the receiver could not apply, which this session may not claim. */
  apply(page: Page): Promise<string[]>;
  /** The receiver takes coverage of everything delivered, minus what it deferred. */
  done(delivered: Vector): Promise<void>;
}

/**
 * Gives `sink` everything this replica holds and it lacks.
 *
 * The mirror image of `pullFrom`, and the same rule about the vector: what the
 * receiver may claim is what the *sender* held when the session opened, minus any
 * origin it had to defer, and it claims it once at the end rather than per page.
 */
export async function pushTo(from: Replica, sink: ChangeSink, limit = PAGE_ROWS): Promise<PullResult> {
  const delivered = coverage(from.db, from.libraryId);
  const deferred: string[] = [];
  let applied = 0;
  let pages = 0;

  let cursor = '';
  for (;;) {
    const next = page(from.db, from.libraryId, sink.held, cursor, limit);
    if (next.changes.length > 0) {
      deferred.push(...(await sink.apply(next)));
      applied += next.changes.length;
    }
    pages += 1;
    cursor = next.cursor;
    if (next.done) break;
  }

  holdBack(delivered, deferred);
  await sink.done(delivered);
  // What the receiver now holds bounds this peer's own tombstone collection (§8.3).
  recordPeer(from.db, from.libraryId, sink.peer, delivered);
  // Nothing arrives on the sending side, so nothing here owes a picture: the peer
  // that took these applies them, and answers for them in its own close.
  return { applied, pages, deferred: deferred.length, edited: [] };
}

/**
 * Caps what a session may claim at the deferred changes it could not take.
 *
 * An origin something was deferred from is not one this session may claim up to
 * its own newest: the vector says "everything this origin wrote up to here is
 * applied", and for that origin it is not. But dropping the origin *entirely*
 * claims nothing at all from it, and the cost of that is not a page - the sender's
 * next scan restarts at the bottom of its log and re-streams every change that
 * origin ever made, on every session, with full payloads. A shoot renamed after
 * its photographs were placed defers all of them (§5.1), so a first clone of an
 * ordinary library paid for itself twice; a deferral that can never clear paid
 * forever, and pinned the sender's tombstone collection while it did (§8.3).
 *
 * Held to just below the lowest stamp deferred from each origin instead. What is
 * re-sent is then what actually sits above the gap, which is the "little too much"
 * this was always willing to pay.
 */
function holdBack(delivered: Vector, deferred: readonly string[]): void {
  for (const stamp of deferred) {
    const origin = stampPeer(stamp);
    const claimed = delivered.get(origin);
    if (claimed == null || claimed < stamp) continue;
    const cap = stampBefore(stamp);
    if (cap == null) delivered.delete(origin);
    else delivered.set(origin, cap);
  }
}

interface Intake {
  held: Vector;
  applied: number;
  pages: number;
  deferred: string[];
  edited: Set<string>;
}

function open(into: Replica): Intake {
  return { held: coverage(into.db, into.libraryId), applied: 0, pages: 0, deferred: [], edited: new Set() };
}

function accept(into: Replica, intake: Intake, next: Page): void {
  if (next.changes.length > 0) {
    into.db.transaction(() => {
      const applied = applyChanges(into.db, into.libraryId, next.changes);
      intake.deferred.push(...applied.deferred);
      // Deletions included: the row id is the photograph either way, and what is
      // owed is decided by asking, not by this list - which is a shortlist of
      // candidates, not a claim about any of them. What is *not* on it is anything
      // this page could not take.
      for (const photoId of rebuildCandidates(applied.taken)) intake.edited.add(photoId);
      repair(into.db, into.libraryId);
    })();
    intake.applied += next.changes.length;
  }
  intake.pages += 1;
}

function close(into: Replica, intake: Intake, peer: string, delivered: Vector): PullResult {
  holdBack(delivered, intake.deferred);

  into.db.transaction(() => {
    // Everything the sender had is here now, so a stack a removal emptied is one
    // this peer can honestly say has ended (§5.2).
    dissolveEmptiedStacks(into.db, into.libraryId);
    repair(into.db, into.libraryId);
    advance(into.db, into.libraryId, delivered);
    recordPeer(into.db, into.libraryId, peer, delivered);
  })();
  return {
    applied: intake.applied,
    pages: intake.pages,
    deferred: intake.deferred.length,
    edited: [...intake.edited],
  };
}
