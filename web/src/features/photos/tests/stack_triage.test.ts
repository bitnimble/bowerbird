import { describe, expect, test } from 'bun:test';
import {
  type Placed,
  type Round,
  type Session,
  type Verdict,
  SPLIT_GAP,
  applyVerdict,
  arrangement,
  keepers,
  losersOf,
  nextRound,
  openSession,
  pairHas,
  pairKey,
  remainingPairs,
  stop,
  upcomingRounds,
} from '../stack_triage';

// Runs `verdicts` in order, and reports every round that was actually put.
function play(ids: string[], verdicts: Verdict[]): { session: Session; rounds: Round[] } {
  let session = openSession(ids);
  const rounds: Round[] = [];
  for (const verdict of verdicts) {
    const round = nextRound(session);
    if (round == null) break;
    rounds.push(round);
    session = applyVerdict(session, round, verdict);
  }
  return { session, rounds };
}

// Every round to exhaustion, choosing each verdict from a supplied function.
function playOut(ids: string[], choose: (round: Round, n: number) => Verdict): { session: Session; rounds: Round[] } {
  let session = openSession(ids);
  const rounds: Round[] = [];
  for (;;) {
    const round = nextRound(session);
    if (round == null) break;
    rounds.push(round);
    session = applyVerdict(session, round, choose(round, rounds.length));
  }
  return { session, rounds };
}

// Deterministic, so a failure is reproducible; Math.random would make the
// counterexample vanish on the next run.
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 0x100000000;
    return state / 0x100000000;
  };
}

const ALL: Verdict[] = ['a', 'b', 'both', 'neither'];

describe('pairKey', () => {
  test('is order-independent', () => {
    expect(pairKey('q', 'p')).toBe(pairKey('p', 'q'));
  });

  test('names both of its photos, and no photo whose id is merely inside one of them', () => {
    const key = pairKey('photo-12', 'photo-13');
    expect(pairHas(key, 'photo-12')).toBe(true);
    expect(pairHas(key, 'photo-13')).toBe(true);
    // The failure the separator exists to stop is a *shorter* id inside a longer
    // one, which a substring test would report as a hit. A longer id is caught by
    // a substring test too, so asserting only that proves nothing.
    expect(pairHas(key, 'photo-1')).toBe(false);
    expect(pairHas(key, 'photo-123')).toBe(false);
  });
});

describe('losersOf', () => {
  test('is the verdict table', () => {
    const round = { a: 'p', b: 'q' };
    expect(losersOf(round, 'a')).toEqual(['q']);
    expect(losersOf(round, 'b')).toEqual(['p']);
    expect(losersOf(round, 'both')).toEqual([]);
    expect(losersOf(round, 'neither')).toEqual(['p', 'q']);
  });
});

describe('a decisive run', () => {
  test('is N-1 rounds and one survivor when the winner keeps winning', () => {
    const { session, rounds } = playOut(['p', 'q', 'r', 't'], () => 'a');
    expect(rounds).toHaveLength(3);
    expect(session.alive).toEqual(['p']);
    expect(keepers(session)).toEqual(['p']);
  });

  test('is N-1 rounds and one survivor when each challenger takes over', () => {
    const { session, rounds } = playOut(['p', 'q', 'r', 't'], () => 'b');
    expect(rounds).toHaveLength(3);
    expect(session.alive).toEqual(['t']);
  });

  test('holds the winner over: it goes to the front and meets the first photo it has not met', () => {
    const { session } = play(['p', 'q', 'r', 't'], ['a']);
    expect(session.alive).toEqual(['p', 'r', 't']);
    expect(nextRound(session)).toEqual({ a: 'p', b: 'r' });
  });

  test('stands a winner down once it has met everyone left', () => {
    const met: Session = {
      alive: ['p', 'r', 't'],
      seen: new Set([pairKey('p', 'q'), pairKey('p', 'r'), pairKey('p', 't')]),
      stopped: false,
    };
    const round = nextRound(met);
    expect(round).toEqual({ a: 'r', b: 't' });
    // Asked again it gives the same answer, so nothing depends on when it is asked.
    expect(nextRound(met)).toEqual(round);
  });
});

describe('an all-draw run', () => {
  test('over 4 photos is 6 rounds, every pair exactly once, and then ends', () => {
    const { session, rounds } = playOut(['p', 'q', 'r', 't'], () => 'both');
    expect(rounds).toHaveLength(6);
    expect(new Set(rounds.map((r) => pairKey(r.a, r.b))).size).toBe(6);
    expect(session.alive).toHaveLength(4);
    expect(keepers(session).sort()).toEqual(['p', 'q', 'r', 't']);
  });

  test('spreads the work rather than leaving one photo to carry it', () => {
    const { rounds } = playOut(['p', 'q', 'r', 't'], () => 'both');
    expect(rounds[0]).toEqual({ a: 'p', b: 'q' });
    // The drawn pair goes to the back, so the next round is the two who have not
    // been on screen at all, not one of the first two against someone new.
    expect(rounds[1]).toEqual({ a: 'r', b: 't' });
  });
});

describe('the guarantee', () => {
  test('the keep set is a clique of mutual draws, over many verdict sequences', () => {
    const random = lcg(20260731);
    for (let run = 0; run < 300; run++) {
      const size = 2 + Math.floor(random() * 6);
      const ids = Array.from({ length: size }, (_, i) => `p${i}`);
      const decisive = new Set<string>();

      const { session, rounds } = playOut(ids, (round) => {
        const verdict = ALL[Math.floor(random() * ALL.length)] ?? 'both';
        if (verdict === 'a' || verdict === 'b') decisive.add(pairKey(round.a, round.b));
        return verdict;
      });

      const keys = rounds.map((r) => pairKey(r.a, r.b));
      expect(new Set(keys).size).toBe(keys.length);

      const kept = keepers(session);
      for (const x of kept) {
        for (const y of kept) {
          if (x === y) continue;
          const key = pairKey(x, y);
          expect(session.seen.has(key)).toBe(true);
          expect(decisive.has(key)).toBe(false);
        }
      }
    }
  });

  test('two drawn photos and a winner over the rest still meet each other', () => {
    // §2.4's worked case: p and q draw, r then beats everything else, and the
    // session is not over - it owes r against p and r against q.
    let session = openSession(['p', 'q', 'r', 't']);
    const asked: string[] = [];
    for (const verdict of ['both', 'a', 'both', 'both'] as Verdict[]) {
      const round = nextRound(session);
      if (round == null) break;
      asked.push(pairKey(round.a, round.b));
      session = applyVerdict(session, round, verdict);
    }

    expect(asked).toEqual([pairKey('p', 'q'), pairKey('r', 't'), pairKey('r', 'p'), pairKey('q', 'r')]);
    expect(nextRound(session)).toBeNull();
    expect(keepers(session).sort()).toEqual(['p', 'q', 'r']);
  });
});

describe('keepers', () => {
  test('Neither on the last two ends the session with nothing kept', () => {
    const { session } = play(['p', 'q'], ['neither']);
    expect(nextRound(session)).toBeNull();
    expect(session.alive).toEqual([]);
    expect(keepers(session)).toEqual([]);
  });

  test('a lone survivor that was never on screen is not a keeper', () => {
    const { session } = play(['p', 'q', 'r'], ['neither']);
    expect(session.alive).toEqual(['r']);
    expect(nextRound(session)).toBeNull();
    expect(keepers(session)).toEqual([]);
  });

  test('Keep the rest keeps what was judged and claims nothing else', () => {
    const { session } = play(['p', 'q', 'r'], ['both']);
    const stopped = stop(session);
    expect(nextRound(stopped)).toBeNull();
    expect(stopped.alive).toEqual(['r', 'p', 'q']);
    expect(keepers(stopped).sort()).toEqual(['p', 'q']);
  });
});

describe('remainingPairs', () => {
  test('counts the round on screen as well as the ones after it', () => {
    expect(remainingPairs(openSession(['p', 'q', 'r']))).toBe(3);
    const { session } = play(['p', 'q', 'r'], ['both']);
    expect(remainingPairs(session)).toBe(2);
  });

  test('ignores judged pairs whose photos have left the pool', () => {
    // p beat q, so the p-q pair is in `seen` but q is gone: counting it would
    // understate what is left.
    const { session } = play(['p', 'q', 'r'], ['a']);
    expect(session.alive).toEqual(['p', 'r']);
    expect(remainingPairs(session)).toBe(1);
  });

  test('is zero once Keep the rest has been pressed', () => {
    expect(remainingPairs(stop(openSession(['p', 'q', 'r'])))).toBe(0);
  });
});

describe('upcomingRounds', () => {
  test('is the all-draw schedule and excludes the round on screen', () => {
    const session = openSession(['p', 'q', 'r', 't']);
    const onScreen = nextRound(session);
    const upcoming = upcomingRounds(session, Infinity);

    expect(upcoming).not.toContainEqual(onScreen);
    expect(upcoming).toHaveLength(remainingPairs(session) - 1);
    expect(upcoming[0]).toEqual({ a: 'r', b: 't' });
  });

  test('only shrinks, whichever verdict is cast', () => {
    for (const verdict of ALL) {
      let session = openSession(['p', 'q', 'r', 't', 'u']);
      const before = upcomingRounds(session, Infinity).length;
      const round = nextRound(session);
      if (round == null) throw new Error('expected a round');
      session = applyVerdict(session, round, verdict);
      expect(upcomingRounds(session, Infinity).length).toBeLessThan(before);
    }
  });

  test('is capped, and the cap is what the overflow count is measured against', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const session = openSession(ids);
    const shown = upcomingRounds(session, 20);
    expect(shown).toHaveLength(20);
    expect(remainingPairs(session) - 1 - shown.length).toBe(66 - 1 - 20);
  });

  test('is empty once the session is over', () => {
    expect(upcomingRounds(stop(openSession(['p', 'q'])))).toEqual([]);
    const { session } = play(['p', 'q'], ['a']);
    expect(upcomingRounds(session)).toEqual([]);
  });
});

describe('arrangement', () => {
  const W = 1600;
  const H = 900;
  const near = (value: number, expected: number): void => expect(Math.abs(value - expected)).toBeLessThan(0.01);

  // The gutter is spent along the layout axis only, so which constraint applies
  // depends on the arrangement that won.
  function fitsInside(placed: Placed, w: number, h: number): void {
    const used =
      placed.direction === 'row'
        ? { width: placed.a.width + placed.b.width + SPLIT_GAP, height: Math.max(placed.a.height, placed.b.height) }
        : { width: Math.max(placed.a.width, placed.b.width), height: placed.a.height + placed.b.height + SPLIT_GAP };
    expect(used.width).toBeLessThanOrEqual(w + 0.01);
    expect(used.height).toBeLessThanOrEqual(h + 0.01);
  }

  // Aspect ratios by number rather than by adjective: "a panorama beside a
  // portrait" chooses the *row* at 3:1 and only turns over past about 4.5:1, so
  // the name is not the test.
  const CASES: [name: string, aA: number, aB: number, direction: 'row' | 'column'][] = [
    ['two 3:2 landscapes', 1.5, 1.5, 'row'],
    ['two 2:3 portraits', 0.667, 0.667, 'row'],
    ['a 3:2 beside a 2:3', 1.5, 0.667, 'row'],
    ['a square beside a 16:9', 1, 1.778, 'row'],
    // The turnover is between 4.5:1 and 5:1, so both sides of it are pinned:
    // "a panorama chooses the column" is false at 3:1 and the adjective is not
    // the test.
    ['a 3:1 panorama beside a 2:3', 3, 0.667, 'row'],
    ['a 5:1 panorama beside a 2:3', 5, 0.667, 'column'],
    ['two 5:1 panoramas', 5, 5, 'column'],
  ];

  for (const [name, aA, aB, direction] of CASES) {
    test(`${name}: equal area, own aspect, as large as they fit, ${direction}`, () => {
      const placed = arrangement(aA, aB, W, H);

      near(placed.a.width * placed.a.height, placed.b.width * placed.b.height);
      near(placed.a.width / placed.a.height, aA);
      near(placed.b.width / placed.b.height, aB);
      expect(placed.direction).toBe(direction);
      fitsInside(placed, W, H);

      // And *maximal*, which is the whole contract: everything above is equally
      // true of an implementation returning half the size. One of the two axes has
      // to be spent to the last pixel, or the photos could have been bigger.
      const used =
        placed.direction === 'row'
          ? { width: placed.a.width + placed.b.width + SPLIT_GAP, height: Math.max(placed.a.height, placed.b.height) }
          : { width: Math.max(placed.a.width, placed.b.width), height: placed.a.height + placed.b.height + SPLIT_GAP };
      near(Math.max(used.width / W, used.height / H), 1);
    });
  }

  test('a tie chooses the row', () => {
    expect(arrangement(1, 1, 900, 900).direction).toBe('row');
  });

  test('a box narrower than the gutter still fits inside itself', () => {
    // The clamp is inside the expression, not on the result: `s²` squares away a
    // negative sign, so clamping afterwards would draw two photos in a container
    // of negative width. The row is what collapses here, so the column wins and
    // the photos stack - which still has to fit.
    const narrow = SPLIT_GAP - 4;
    const placed = arrangement(1.5, 1.5, narrow, 400);
    expect(placed.direction).toBe('column');
    expect(placed.a.width).toBeGreaterThanOrEqual(0);
    fitsInside(placed, narrow, 400);
  });

  test('a box shorter and narrower than the gutter draws nothing', () => {
    const placed = arrangement(1.5, 1.5, SPLIT_GAP - 4, SPLIT_GAP - 4);
    expect(placed.a.width).toBe(0);
    expect(placed.b.height).toBe(0);
  });

  test('a box of no size at all draws nothing rather than NaN', () => {
    const placed = arrangement(1.5, 0.667, 0, 0);
    expect(placed.a.width).toBe(0);
    expect(placed.b.height).toBe(0);
  });
});
