import type { Database } from '../../db/driver';
import { AppError } from '../../errors';

// A hybrid logical clock, and the stamp it mints: the total order every merge in
// replication resolves by (docs/replication.md §2.2).
//
// The encoding is the contract, not an implementation detail - byte order *is*
// chronological order, so "which write wins" is one string comparison, identical
// on every peer and inside SQLite's own ORDER BY. Two peers disagreeing on these
// widths would disagree on every comparison, so they are part of the protocol
// version.
const MS_DIGITS = 12; // 48 bits of milliseconds, which runs out in the year 10889
const COUNTER_DIGITS = 4;
const COUNTER_LIMIT = 16 ** COUNTER_DIGITS;

/**
 * How far a clock may lead this machine's before its stamps are refused.
 *
 * An hour rather than the few minutes that would catch a bad clock soonest,
 * because refusing to mint means refusing to *write*, and the two failures this
 * sits between are not the same size. A clock a few minutes ahead is what a
 * suspended laptop or an NTP step leaves behind, and the hybrid logical clock is
 * built to absorb exactly that: it keeps minting on the counter until the wall
 * catches up, and nothing is wrong with the stamps. A clock a decade ahead cannot
 * be waited out and poisons every peer it reaches. So the threshold is set where
 * waiting stops being a remedy, not where drift stops being tidy.
 */
export const DEFAULT_SKEW_MS = 60 * 60 * 1000;

export const STAMP_LENGTH = MS_DIGITS + COUNTER_DIGITS + 16;

export function encodeStamp(ms: number, counter: number, peerId: string): string {
  return (
    ms.toString(16).padStart(MS_DIGITS, '0') + counter.toString(16).padStart(COUNTER_DIGITS, '0') + peerId
  );
}

export function stampMs(stamp: string): number {
  return parseInt(stamp.slice(0, MS_DIGITS), 16);
}

// Deliberately not `parseInt`, which reads the longest prefix it understands and
// so turns "12zz" into 18 rather than into a refusal. A stamp whose counter
// parsed to NaN would take the clock with it - `Math.max(n, NaN)` is NaN, every
// stamp after it renders as "NaN", and the catalogue's ordering is gone with
// nothing raised.
const STAMP_SHAPE = new RegExp(`^[0-9a-f]{${MS_DIGITS + COUNTER_DIGITS}}[0-9a-z]+$`);

function decode(stamp: string): { ms: number; counter: number } | null {
  if (stamp.length !== STAMP_LENGTH || !STAMP_SHAPE.test(stamp)) return null;
  return {
    ms: parseInt(stamp.slice(0, MS_DIGITS), 16),
    counter: parseInt(stamp.slice(MS_DIGITS, MS_DIGITS + COUNTER_DIGITS), 16),
  };
}

/**
 * The stamp immediately below this one from the same origin, or null if it is that
 * origin's first.
 *
 * A vector says "everything this origin wrote up to *and including* here is
 * applied", so covering everything strictly below a stamp means naming the one
 * before it. Every stamp an origin mints is unique and ordered by the counter
 * inside its millisecond, so subtracting one from the two joined fields is exactly
 * that predecessor - and comparing the results as strings still orders them,
 * because both are fixed-width hex.
 */
export function stampBefore(stamp: string): string | null {
  const parts = decode(stamp);
  if (parts == null) return null;
  if (parts.counter > 0) return encodeStamp(parts.ms, parts.counter - 1, stampPeer(stamp));
  if (parts.ms === 0) return null;
  return encodeStamp(parts.ms - 1, COUNTER_LIMIT - 1, stampPeer(stamp));
}

/** Which peer minted it, which is also the origin a version vector is keyed by. */
export function stampPeer(stamp: string): string {
  return stamp.slice(MS_DIGITS + COUNTER_DIGITS);
}


export class Clock {
  private ms = 0;
  private counter = 0;

  constructor(
    readonly peerId: string,
    private readonly skewMs: number = DEFAULT_SKEW_MS,
    private readonly wall: () => number = Date.now,
  ) {}

  /**
   * Picks the clock up where the catalogue left it.
   *
   * The log's newest stamp rather than a saved counter: it is written in the same
   * transaction as the work it describes, so it cannot be ahead of what was
   * committed, and a restore that rewinds the catalogue rewinds this with it.
   */
  static fromDatabase(db: Database, peerId: string, skewMs: number = DEFAULT_SKEW_MS): Clock {
    const clock = new Clock(peerId, skewMs);
    const row = db.query('SELECT MAX(stamp) AS newest FROM replication_log').get() as { newest: string | null };
    if (row?.newest != null) clock.resume(row.newest);
    return clock;
  }

  /**
   * The next stamp, strictly above every stamp this clock has minted or seen.
   *
   * **Refuses rather than mints when the clock leads the wall clock by more than
   * the threshold.** A machine that booted believing it is 2035 would otherwise
   * write stamps that beat every honest peer for a decade, and monotonicity makes
   * that permanent: nothing can bring the clock back down afterwards, so fixing
   * the system time does not fix the catalogue. Refusing at the *first write*
   * keeps the damage to nothing at all.
   */
  mint(): string {
    const wall = this.wall();
    if (this.ms > wall + this.skewMs) {
      throw new AppError(
        'CLOCK_SKEW',
        `this catalogue's clock is ${Math.round((this.ms - wall) / 1000)}s ahead of the system clock; check the system time`,
      );
    }
    if (wall > this.ms) {
      this.ms = wall;
      this.counter = 0;
    } else if (++this.counter >= COUNTER_LIMIT) {
      // Carried into the millisecond rather than widened, so the encoding's
      // widths stay fixed and the ordering stays byte-comparable.
      this.ms += 1;
      this.counter = 0;
    }
    return encodeStamp(this.ms, this.counter, this.peerId);
  }

  /**
   * Takes a stamp from elsewhere into account, so nothing minted here can sort
   * below something already seen.
   *
   * @returns whether the stamp was one this clock would accept: well formed, and
   * close enough to this machine's own time.
   */
  observe(stamp: string): boolean {
    const seen = this.acceptable(stamp);
    if (seen == null) return false;
    this.take(seen);
    return true;
  }

  /**
   * The same test without taking it into account.
   *
   * For a stamp that arrives somewhere other than a replication page - a peer
   * reporting which develop settings it rendered, say. That answer still has to be
   * bounded, since a value dated centuries ahead is one no edit ever sorts above,
   * but it is not a write anybody made and letting it move this clock would hand a
   * peer the local time over an image request.
   */
  accepts(stamp: string): boolean {
    return this.acceptable(stamp) != null;
  }

  /** Decoded if this clock would take it, so the two answers cannot drift apart. */
  private acceptable(stamp: string): { ms: number; counter: number } | null {
    const seen = decode(stamp);
    if (seen == null || seen.ms > this.wall() + this.skewMs) return null;
    return seen;
  }

  private resume(stamp: string): void {
    const seen = decode(stamp);
    if (seen != null) this.take(seen);
  }

  private take(seen: { ms: number; counter: number }): void {
    if (seen.ms < this.ms) return;
    if (seen.ms > this.ms) {
      this.ms = seen.ms;
      this.counter = seen.counter;
      return;
    }
    this.counter = Math.max(this.counter, seen.counter);
  }
}
