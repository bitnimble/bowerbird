import type { Database } from '../../db/driver';
import { Logger } from '../../logger';
import { EditSessionIdSchema } from '../../schemas/photo_edits';
import type { LiveChange } from '../../schemas/replication';

const log = new Logger('replication');

// Edit sessions, and the one conflict a user is ever asked about
// (docs/replication.md §5.3).
//
// Opening the editor begins a session, and every save until it closes carries the
// session's id. The `photo_edits` row holds the current session and the **full
// chain** of `(session_id, stamp)` hops behind it, appended on each session open.
// The whole chain, not one hop, because the log streams latest state only:
// intermediate sessions are routinely never seen by other peers, and a one-hop
// parent would call every linear two-session gap between replications a conflict.
//
// The merge is then one question, asked in both directions: does either row
// descend from the other? If so the descendant wins silently; if neither does,
// two people edited the same photograph while apart, and both candidates are
// parked for one of them to choose.

export type SessionHop = [sessionId: string, stamp: string];

// ponytail: fixed cap; prune at the GC watermark (§8.3) once acknowledgement GC
// lands. Overflow costs a peer stale past 200 session opens a surfaced conflict,
// never a silent clobber.
export const MAX_CHAIN_HOPS = 200;

export function parseChain(raw: unknown): SessionHop[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const hops = parsed.filter(
      (hop): hop is SessionHop =>
        Array.isArray(hop) && hop.length === 2 && typeof hop[0] === 'string' && typeof hop[1] === 'string',
    );
    // The cap holds here rather than only where a chain is built, because this is
    // the one funnel both a local row and an arriving one come through (§11.2: a
    // buggy peer is in the threat model). Without it a peer's overlong chain is
    // taken whole, stored, and relayed onward to everyone else - a column that
    // only ever grows, on every peer, for good. Newest kept, as `lineage` keeps
    // them: those are the hops a recent divergence is decided against.
    return hops.slice(Math.max(0, hops.length - MAX_CHAIN_HOPS));
  } catch {
    return [];
  }
}

export interface SessionRow {
  session: string;
  stamp: string;
  chain: SessionHop[];
}

/**
 * Whether `a` was built on `b`'s exact state, or on a later save of `b`'s
 * session.
 *
 * The `>=` is load-bearing: a session parented on `(s1, t3)` against an `s1`
 * that has since saved to t5 must NOT descend, or the t3→t5 saves are silently
 * clobbered.
 */
export function descends(a: SessionRow, b: { session: string; stamp: string }): boolean {
  if (a.session === b.session) return a.stamp >= b.stamp;
  return a.chain.some(([session, stamp]) => session === b.session && stamp >= b.stamp);
}

/**
 * Parks both candidates of a divergence, leaving the row itself to ordinary LWW -
 * the newest session as the provisional document is exactly what the stamp
 * comparison already does.
 *
 * Runs on every peer that ever holds both candidates, and mints identical rows on
 * each: one of the two rows carries the *other* peer's stamp, and a row so
 * stamped can never be streamed to a peer whose coverage already claims that
 * origin, so the rows cannot travel to where they are needed most - they have to
 * be rebuilt there, from the same bytes.
 */
export function parkDivergentEdits(db: Database, change: LiveChange): void {
  const arriving = change.stamps.photo_edits;
  const row = change.row;
  if (arriving == null) return;
  const session = row.session_id;
  const doc = row.doc;
  if (typeof session !== 'string' || typeof doc !== 'string') return;

  const local = db
    .query(
      `SELECT e.doc, e.cursor, e.session_id, e.chain, e.stamp, h.deltas
         FROM photo_edits e LEFT JOIN photo_edit_history h ON h.photo_id = e.photo_id
        WHERE e.photo_id = ?`,
    )
    .get(change.rowId) as {
    doc: string;
    cursor: number;
    session_id: string | null;
    chain: string | null;
    stamp: string | null;
    deltas: string | null;
  } | null;
  // A side without a session predates sessions; plain LWW is all it can ask for.
  if (local == null || local.session_id == null || local.stamp == null) return;

  const incoming: SessionRow = { session, stamp: arriving, chain: parseChain(row.chain) };
  const held: SessionRow = { session: local.session_id, stamp: local.stamp, chain: parseChain(local.chain) };
  if (descends(incoming, held) || descends(held, incoming)) return;
  // A conflict's row id is `photo_id/session_id`, so a session id with a `/` in it
  // mints a log row that will not come apart. The stream and the apply both step
  // over such a row rather than dying on it, which is what keeps the library
  // replicating - but a row nobody can ever read is still a conflict nobody can
  // ever resolve, and this is the one place that mints them. The only check there
  // is: a `photo_edits` row's own id is the photograph alone, so nothing on the way
  // in has any reason to look at the session it names. Both sides, because either
  // can be the one carrying it. The edit still merges by stamp; what is refused is
  // the card describing the divergence.
  for (const candidate of [held.session, incoming.session]) {
    if (EditSessionIdSchema.safeParse(candidate).success) continue;
    log.warn('refusing to park a divergence under a session id that cannot be streamed', { photo: change.rowId });
    return;
  }

  park(db, change.rowId, held.session, local.doc, local.deltas, local.cursor, local.chain ?? '[]', local.stamp);
  park(
    db,
    change.rowId,
    session,
    doc,
    typeof change.sidecar?.deltas === 'string' ? change.sidecar.deltas : null,
    typeof row.cursor === 'number' ? row.cursor : 0,
    typeof row.chain === 'string' ? row.chain : '[]',
    arriving,
  );
}

function park(
  db: Database,
  photoId: string,
  sessionId: string,
  doc: string,
  history: string | null,
  cursor: number,
  chain: string,
  stamp: string,
): void {
  db.query(
    `INSERT INTO edit_conflicts (photo_id, session_id, doc, history, cursor, chain, stamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (photo_id, session_id) DO UPDATE SET
       doc = excluded.doc, history = excluded.history, cursor = excluded.cursor,
       chain = excluded.chain, stamp = excluded.stamp
     WHERE excluded.stamp > edit_conflicts.stamp`,
  ).run(photoId, sessionId, doc, history, cursor, chain, stamp);
}
