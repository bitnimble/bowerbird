// The hybrid logical clock, whose stamps are the total order every replication
// merge resolves by (docs/replication.md §2.2). What these pin is that byte
// order is chronological order, that nothing minted here sorts below anything
// already seen, and that a machine whose clock is broken is refused before its
// first stamp exists rather than poisoning every peer permanently.
import { describe, expect, it } from 'bun:test';
import { Database } from '../../../db/driver';
import { runMigrations } from '../../../db/migrate';
import { AppError } from '../../../errors';
import { Clock, DEFAULT_SKEW_MS, STAMP_LENGTH, encodeStamp, stampBefore, stampMs, stampPeer } from '../clock';

const PEER = 'aaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbb';
const COUNTER_LIMIT = 16 ** 4;

function frozenAt(ms: number): Clock {
  return new Clock(PEER, DEFAULT_SKEW_MS, () => ms);
}

describe('the stamp encoding', () => {
  // The pairs straddle every width change a naive unpadded encoding sorts
  // wrongly across: a counter growing a digit, a millisecond growing a digit,
  // and a millisecond boundary crossed while the counter was high.
  it('sorts as strings exactly as (ms, counter) sorts as numbers', () => {
    const ascending: [number, number][] = [
      [9, 1],
      [9, 15],
      [9, 16],
      [9, COUNTER_LIMIT - 1],
      [10, 0],
      [15, COUNTER_LIMIT - 1],
      [16, 0],
      [999, COUNTER_LIMIT - 1],
      [1000, 0],
      [Date.now(), 3],
      [16 ** 12 - 1, COUNTER_LIMIT - 1],
    ];
    const stamps = ascending.map(([ms, counter]) => encodeStamp(ms, counter, PEER));

    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i - 1]! < stamps[i]!).toBe(true);
    }
    for (const stamp of stamps) expect(stamp).toHaveLength(STAMP_LENGTH);
  });

  it('breaks a tie between two peers by who minted it, identically everywhere', () => {
    const a = encodeStamp(7, 7, PEER);
    const b = encodeStamp(7, 7, OTHER);

    expect(a < b).toBe(true);
    expect(stampMs(a)).toBe(stampMs(b));
  });
});

// What a session covers an origin to when it had to leave one of that origin's
// changes behind: everything strictly below it, which is the stamp before it.
describe('the stamp before one', () => {
  it('steps back through the counter, and over a millisecond when it runs out', () => {
    expect(stampBefore(encodeStamp(9, 5, PEER))).toBe(encodeStamp(9, 4, PEER));
    expect(stampBefore(encodeStamp(9, 0, PEER))).toBe(encodeStamp(8, COUNTER_LIMIT - 1, PEER));
  });

  it('keeps the origin, so the vector it caps is still keyed by the same peer', () => {
    expect(stampPeer(stampBefore(encodeStamp(9, 5, OTHER))!)).toBe(OTHER);
  });

  // Every stamp between the two would otherwise be claimed as covered.
  it('is below the stamp it came from, and above the one before that', () => {
    const stamp = encodeStamp(Date.now(), 0, PEER);
    const before = stampBefore(stamp)!;

    expect(before < stamp).toBe(true);
    expect(before > stampBefore(before)!).toBe(true);
  });

  it('answers nothing where there is nothing below it', () => {
    expect(stampBefore(encodeStamp(0, 0, PEER))).toBeNull();
    expect(stampBefore('not a stamp')).toBeNull();
  });
});

describe('minting', () => {
  it('strictly increases through thousands of mints inside one frozen millisecond', () => {
    const clock = frozenAt(1_000);
    let previous = clock.mint();
    for (let i = 0; i < 10_000; i++) {
      const next = clock.mint();
      expect(next > previous).toBe(true);
      previous = next;
    }
    expect(stampMs(previous)).toBe(1_000);
  });

  it('follows the wall forward, and its own past when the wall slips back a little', () => {
    let now = 5_000;
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => now);
    clock.mint();
    now = 6_000;
    const second = clock.mint();
    expect(stampMs(second)).toBe(6_000);

    now = 5_500;
    const third = clock.mint();
    expect(third > second).toBe(true);
    expect(stampMs(third)).toBe(6_000);
  });

  it('carries counter overflow into the millisecond instead of wrapping or widening', () => {
    const clock = frozenAt(1_000);
    let previous = clock.mint();
    for (let i = 0; i < COUNTER_LIMIT; i++) {
      const next = clock.mint();
      expect(next > previous).toBe(true);
      expect(next).toHaveLength(STAMP_LENGTH);
      previous = next;
    }
    expect(stampMs(previous)).toBe(1_001);
  });

  it('refuses once its clock leads the wall by more than the skew threshold', () => {
    let now = 10_000_000;
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => now);
    const lastHonest = clock.mint();

    now = 10_000_000 - DEFAULT_SKEW_MS - 1;
    let refused: unknown;
    try {
      clock.mint();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe('CLOCK_SKEW');

    // Exactly the threshold is still honest drift.
    now = 10_000_000 - DEFAULT_SKEW_MS;
    expect(clock.mint() > lastHonest).toBe(true);
  });

  it('resumes when the wall catches back up, still above everything minted before', () => {
    let now = 10_000_000;
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => now);
    const beforeTheJump = clock.mint();

    now = 1_000;
    expect(() => clock.mint()).toThrow(AppError);

    now = 10_000_001;
    expect(clock.mint() > beforeTheJump).toBe(true);
  });
});

describe('observing a remote stamp', () => {
  it('never mints below a stamp it accepted from ahead of its own wall', () => {
    const clock = frozenAt(1_000);
    const remote = encodeStamp(60_000, 12, OTHER);

    expect(clock.observe(remote)).toBe(true);
    expect(clock.mint() > remote).toBe(true);
  });

  it('never mints below a stamp that shares its millisecond and beats its counter', () => {
    const clock = frozenAt(60_000);
    clock.mint();
    const remote = encodeStamp(60_000, 500, OTHER);

    expect(clock.observe(remote)).toBe(true);
    expect(clock.mint() > remote).toBe(true);
  });

  it('is unmoved by a stamp older than what it has already minted', () => {
    const clock = frozenAt(60_000);
    const minted = clock.mint();

    expect(clock.observe(encodeStamp(1_000, COUNTER_LIMIT - 1, OTHER))).toBe(true);
    const next = clock.mint();
    expect(next > minted).toBe(true);
    expect(stampMs(next)).toBe(60_000);
  });

  it('rejects a stamp from beyond the skew threshold, and does not merge toward it', () => {
    const clock = frozenAt(1_000);
    const future = encodeStamp(1_000 + DEFAULT_SKEW_MS + 1, 0, OTHER);

    expect(clock.observe(future)).toBe(false);
    const minted = clock.mint();
    expect(minted < future).toBe(true);
    expect(stampMs(minted)).toBe(1_000);
  });

  it('accepts a stamp leading by exactly the threshold', () => {
    const clock = frozenAt(1_000);
    const edge = encodeStamp(1_000 + DEFAULT_SKEW_MS, 0, OTHER);

    expect(clock.observe(edge)).toBe(true);
    expect(clock.mint() > edge).toBe(true);
  });
});

describe('observing something that is not a stamp', () => {
  // `parseInt` reads the longest prefix it understands, so a counter of "12zz"
  // becomes 18 rather than a refusal, and one of "zzzz" becomes NaN - which
  // `Math.max` then spreads to the clock itself, after which every stamp renders
  // as "NaN" and the catalogue's whole ordering is gone with nothing raised.
  it.each([
    ['a counter that is not hex', `${'0'.repeat(12)}zzzz${PEER}`],
    ['a counter that is only partly hex', `${'0'.repeat(12)}12zz${PEER}`],
    ['milliseconds that are not hex', `${'z'.repeat(12)}0000${PEER}`],
    ['nothing like a stamp at all', 'not-a-stamp'],
    ['a stamp of the wrong width', `${'0'.repeat(12)}0000aaaaaaaa`],
  ])('refuses %s, and goes on minting stamps that sort', (_name, malformed) => {
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => 1_000_000);

    expect(clock.observe(malformed)).toBe(false);

    const first = clock.mint();
    const second = clock.mint();
    expect(first).toHaveLength(STAMP_LENGTH);
    expect(second > first).toBe(true);
  });
});

describe('resuming from the catalogue', () => {
  function insertLog(db: Database, rowId: string, stamp: string): void {
    db.query(
      "INSERT INTO replication_log (library_id, entity, row_id, stamp, deleted) VALUES ('lib', 'photo.triage', ?, ?, 0)",
    ).run(rowId, stamp);
  }

  it('resumes above the newest stamp in the replication log', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const newest = encodeStamp(Date.now() + 60_000, 7, OTHER);
    // Newest first, so resuming from the last row inserted would not pass.
    insertLog(db, 'p1', newest);
    insertLog(db, 'p2', encodeStamp(Date.now() - 60_000, 3, OTHER));

    expect(Clock.fromDatabase(db, PEER).mint() > newest).toBe(true);
  });

  it('mints from the wall clock when the log is empty', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const before = Date.now();
    const minted = Clock.fromDatabase(db, PEER).mint();
    expect(stampMs(minted)).toBeGreaterThanOrEqual(before);
    expect(stampMs(minted)).toBeLessThanOrEqual(Date.now());
  });

  it('refuses the first mint of a catalogue whose log believes the future', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertLog(db, 'p1', encodeStamp(Date.now() + DEFAULT_SKEW_MS + 60_000, 0, OTHER));

    const clock = Clock.fromDatabase(db, PEER);
    let refused: unknown;
    try {
      clock.mint();
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).code).toBe('CLOCK_SKEW');
  });
});

/**
 * What a version vector rests on, and the reason a repair cannot be stamped from
 * its inputs however much §5.4 reads like it should.
 *
 * "Everything this origin wrote below this stamp is applied here" is only true
 * because nothing this peer mints ever sorts below something it has already
 * minted. A write placed in the past under this peer's own origin is one a
 * receiver can advance its vector straight past, having never been sent it - and
 * never be sent it again. Measured rather than argued: a repair stamped from its
 * inputs diverged 2 seeds in 1500, a stack alive on one peer and buried on
 * another with the grave below the receiver's coverage.
 */
describe('what this peer mints never goes backwards', () => {
  it('rises even while the wall clock stands still', () => {
    let wall = 1000;
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => wall);

    const stamps = [clock.mint(), clock.mint(), clock.mint()];

    expect(stamps).toEqual([...stamps].sort());
    expect(new Set(stamps).size).toBe(3);
  });

  it('rises even when the wall clock jumps backwards', () => {
    let wall = 5000;
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => wall);
    const before = clock.mint();

    wall = 1000;
    const after = clock.mint();

    expect(after > before).toBe(true);
  });

  it('rises past a stamp taken in from elsewhere, rather than beside it', () => {
    let wall = 1000;
    const clock = new Clock(PEER, DEFAULT_SKEW_MS, () => wall);
    const remote = encodeStamp(4000, 7, 'bbbbbbbbbbbbbbbb');

    clock.observe(remote);
    const minted = clock.mint();

    expect(minted > remote).toBe(true);
    expect(stampMs(minted)).toBe(4000);
    expect(stampPeer(minted)).toBe(PEER);
    expect(minted.length).toBe(STAMP_LENGTH);
  });
});
