// The stack triage tournament, and the split layout (DESIGN §20).
//
// A session is one immutable value. Every action returns a new one, which is what
// lets undo restore a snapshot rather than invert an operation, and what stops
// the pool, the judged pairs and the stopped flag from ever disagreeing.

/** Which photo the photographer preferred, or that neither answer applies. */
export type Verdict = 'a' | 'b' | 'both' | 'neither';

/** A pair put to the photographer. `a` and `b` are slots, not rankings. */
export interface Round {
  a: string;
  b: string;
}

export interface Session {
  /** The photos still in contention, in queue order. */
  alive: readonly string[];
  /** Every pair already judged, by `pairKey`. */
  seen: ReadonlySet<string>;
  /** Keep the rest was pressed: no further round is offered. */
  stopped: boolean;
}

export interface Shape {
  width: number;
  height: number;
}

export interface Placed {
  direction: 'row' | 'column';
  a: Shape;
  b: Shape;
}

/** How many upcoming rounds the queue projects before it stops counting them out. */
export const UPCOMING_SHOWN = 20;

/** The gutter between the two photos in split mode, in px. */
export const SPLIT_GAP = 16;

// A separator no UUID contains, so a key can be taken apart again - which
// `pairHas` and the closing-write rule both need. Splitting rather than a
// substring test also keeps one id matching another's prefix from ever reading as
// a hit.
const SEPARATOR = '|';

/** Order-independent: the same two photos always produce the same key. */
export function pairKey(x: string, y: string): string {
  return x < y ? `${x}${SEPARATOR}${y}` : `${y}${SEPARATOR}${x}`;
}

export function pairHas(key: string, id: string): boolean {
  return key.split(SEPARATOR).includes(id);
}

export function openSession(ids: readonly string[]): Session {
  return { alive: [...ids], seen: new Set(), stopped: false };
}

/**
 * The pair to put next, or null when the session is over.
 *
 * The scan is in index order over the pool - (0,1), (0,2), … then (1,2) - and not
 * nearest-neighbour, which would produce a different session. A decisive verdict
 * moves the winner to the front (`applyVerdict`), so (0,k) is that winner against
 * the first photo it has not met; when it has met them all, every (0,k) is judged
 * and the scan walks on to a pair that cannot contain it. The hold-over and the
 * fall-through are both this one loop.
 */
export function nextRound(session: Session): Round | null {
  if (session.stopped) return null;
  const { alive, seen } = session;
  for (let i = 0; i < alive.length; i++) {
    const a = alive[i];
    if (a == null) continue;
    for (let j = i + 1; j < alive.length; j++) {
      const b = alive[j];
      if (b == null) continue;
      if (!seen.has(pairKey(a, b))) return { a, b };
    }
  }
  return null;
}

/**
 * The photos a verdict eliminates.
 *
 * Exported so the verdict table lives in one place: the presenter needs these ids
 * to write `rejected`, and deriving them there would be a second copy of it.
 */
export function losersOf(round: Round, verdict: Verdict): string[] {
  switch (verdict) {
    case 'a':
      return [round.b];
    case 'b':
      return [round.a];
    case 'both':
      return [];
    case 'neither':
      return [round.a, round.b];
  }
}

export function applyVerdict(session: Session, round: Round, verdict: Verdict): Session {
  const seen = new Set(session.seen);
  seen.add(pairKey(round.a, round.b));

  const gone = new Set(losersOf(round, verdict));
  const rest = session.alive.filter((id) => !gone.has(id));

  return { alive: reorder(rest, round, verdict), seen, stopped: session.stopped };
}

// The winner to the front is what holds it over into the next round; a drawn pair
// to the back is what stops those two photos carrying the whole session between
// them.
function reorder(rest: readonly string[], round: Round, verdict: Verdict): string[] {
  if (verdict === 'neither') return [...rest];
  if (verdict === 'both') {
    const others = rest.filter((id) => id !== round.a && id !== round.b);
    return [...others, round.a, round.b];
  }
  const winner = verdict === 'a' ? round.a : round.b;
  return [winner, ...rest.filter((id) => id !== winner)];
}

export function stop(session: Session): Session {
  return { ...session, stopped: true };
}

/**
 * The survivors that have actually been on screen.
 *
 * What the closing `picked` write covers. A survivor in no judged pair has never
 * been compared with anything - which Keep the rest can leave, and `Neither` can
 * leave by emptying the pool around it - and claiming it as a considered keeper
 * would be the same unearned claim the win rule refuses to make.
 */
export function keepers(session: Session): string[] {
  const judged = new Set<string>();
  for (const key of session.seen) {
    for (const id of key.split(SEPARATOR)) judged.add(id);
  }
  return session.alive.filter((id) => judged.has(id));
}

/**
 * Rounds still to come, the one on screen included.
 *
 * `C(n,2)` less the judged pairs *whose photos are both still in the pool*, which
 * is one pass over `seen`. Not `C(n,2) - seen.size`, which understates it once an
 * elimination has left pairs in `seen` naming photos that are gone; and not a scan
 * of every pair of the pool, which is half a million iterations on a thousand-member
 * manual stack.
 */
export function remainingPairs(session: Session): number {
  if (session.stopped) return 0;
  const pool = new Set(session.alive);
  let judgedInPool = 0;
  for (const key of session.seen) {
    const [x, y] = key.split(SEPARATOR);
    if (x != null && y != null && pool.has(x) && pool.has(y)) judgedInPool++;
  }
  const n = session.alive.length;
  return (n * (n - 1)) / 2 - judgedInPool;
}

/**
 * The rounds after the current one, as they would be asked if every one drew.
 *
 * A projection has to assume verdicts it does not have, and all-draw is the one
 * that makes the list only ever shrink: it is every pair still unseen among the
 * pool, so a draw drops the round just judged and a decisive verdict drops every
 * round its loser appeared in. Assuming the winner keeps winning would make the
 * list *grow* whenever it lost, which reads as a plan that cannot be trusted.
 *
 * Running the real functions forward on a copy, rather than reimplementing the
 * schedule, is what keeps the projection honest when the schedule changes.
 */
export function upcomingRounds(session: Session, limit = UPCOMING_SHOWN): Round[] {
  const onScreen = nextRound(session);
  if (onScreen == null) return [];

  const rounds: Round[] = [];
  let ahead = applyVerdict(session, onScreen, 'both');
  while (rounds.length < limit) {
    const round = nextRound(ahead);
    if (round == null) break;
    rounds.push(round);
    ahead = applyVerdict(ahead, round, 'both');
  }
  return rounds;
}

// A photo of aspect `a` drawn at area `s²`: `√(s²·a)` by `√(s²/a)`, which has that
// area exactly and that aspect exactly.
function sizeAt(s: number, a: number): Shape {
  const root = Math.sqrt(a);
  return { width: s * root, height: s / root };
}

/**
 * Where the two photos go, at equal displayed area, in the arrangement that makes
 * that area largest.
 *
 * Equal area rather than a common height: a common height hands the two photos
 * areas in the ratio `aA/aB` exactly, which is 2.25x on a 3:2 beside a 2:3, and
 * size is persuasive in a tool whose whole job is a fair comparison.
 *
 * Every constraint below is a linear upper bound on `s`, so the smaller bound is
 * the maximum rather than merely a size that fits. The gutter is spent only along
 * the axis the photos are laid out on, and is clamped *before* the division: `s²`
 * squares away a negative sign, so a box narrower than the gutter would otherwise
 * render two small photos inside a container of negative width.
 */
export function arrangement(aA: number, aB: number, w: number, h: number): Placed {
  const rootA = Math.sqrt(aA);
  const rootB = Math.sqrt(aB);

  const row = Math.min(Math.max(0, w - SPLIT_GAP) / (rootA + rootB), h * Math.min(rootA, rootB));
  const column = Math.min(Math.max(0, h - SPLIT_GAP) / (1 / rootA + 1 / rootB), w / Math.max(rootA, rootB));

  // A tie goes to the row - two squares in a square box produce one exactly, and
  // side by side is the better comparison gesture.
  const s = Math.max(row, column);
  return { direction: row >= column ? 'row' : 'column', a: sizeAt(s, aA), b: sizeAt(s, aB) };
}
