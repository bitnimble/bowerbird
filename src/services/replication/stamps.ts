import type { Database } from '../../db/driver';
import { Clock } from './clock';

// One hybrid logical clock per catalogue, reachable from the connection alone.
//
// A registry rather than a constructor argument because the stamp is needed at
// around forty write sites across seven repositories, most of which are reached
// by photo id and know nothing else: threading a clock through all of them - and
// through every test that builds one - would be a wide change to buy what a
// connection can already answer. The state itself lives in `Clock`.
const clocks = new WeakMap<Database, Clock>();

function clockFor(db: Database): Clock {
  const known = clocks.get(db);
  if (known != null) return known;
  const row = db.query('SELECT peer_id FROM replication_identity WHERE singleton = 1').get() as
    | { peer_id: string }
    | undefined;
  if (row == null) throw new Error('this catalogue has no replication identity; migrations have not run');
  const clock = Clock.fromDatabase(db, row.peer_id);
  clocks.set(db, clock);
  return clock;
}

/**
 * The stamp a write should carry, strictly above every stamp this catalogue has
 * minted or seen.
 *
 * **One stamp per action, not per row.** A binning of four hundred photographs is
 * one thing the photographer did, and stamping each row separately would let a
 * merge take half of it.
 */
export function stamp(db: Database): string {
  return clockFor(db).mint();
}

/**
 * Gives this connection a clock of the caller's own.
 *
 * For tests that need to say "and *then* the laptop rated it": two peers writing
 * inside one millisecond are ordered by their counters and peer ids, which is
 * deterministic but is not program order, so a randomised run driven by the
 * system clock cannot be replayed from its seed.
 */
export function useClock(db: Database, clock: Clock): void {
  clocks.set(db, clock);
}

/** Takes a stamp from another peer into account, so nothing minted here sorts below it. */
export function observeStamp(db: Database, remote: string): boolean {
  return clockFor(db).observe(remote);
}

/** Whether a stamp is one this machine's clock would accept, without taking it. */
export function stampWithinSkew(db: Database, remote: string): boolean {
  return clockFor(db).accepts(remote);
}

export function peerId(db: Database): string {
  return clockFor(db).peerId;
}

/**
 * The later of two stamps, either of which may be absent.
 *
 * Compared as strings, which is what the encoding is for. What asks: a row composed out of others
 * is as new as the newest document behind it, its own or a frame's, so that is what its copies are
 * stamped against and what they are held stale against.
 */
export function newest(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}
