import type { Triage } from '../../api/client';
import { readSetting, writeSetting } from '../../app/local_setting';
import type { Session } from './stack_triage';

// A triage session, kept across a reload (DESIGN §20.5).
//
// `sessionStorage` rather than `localStorage`: a tournament is something the
// photographer is in the middle of, not a preference. A session found in a tab
// opened last week would be a set of half-made judgements about photographs whose
// gallery has moved on.

const SESSION_PREFIX = 'bowerbird.triage.';
const MODE_KEY = 'bowerbird.triage.mode';

/** How far back a session can be undone. Bounds what a long session stores. */
const HISTORY_LIMIT = 50;

export type TriageMode = 'flip' | 'split';

/** One action, and everything needed to take it back (§20.3). */
export interface HistoryEntry {
  /** The session as it stood *before* this action. */
  session: Session;
  showing: 'a' | 'b';
  /** What the photographer chose. `stopped` is Keep the rest. */
  choice: 'a' | 'b' | 'both' | 'neither' | 'stopped';
  /** Photo ids this action wrote, in issue order. */
  changed: string[];
}

interface StoredSession {
  session: Session;
  history: HistoryEntry[];
  /** Each member's triage when the session opened: what every restore targets. */
  baseline: Record<string, Triage>;
  entryPhotoId: string | null;
  /** The photographs the stack lies between, for the jump out (§20.6). */
  bounds: { from: string | null; to: string | null };
  /** Photos whose write did not land, so the summary can still offer a retry. */
  failed: string[];
}

// `Set` has no JSON representation - `JSON.stringify(new Set())` is `{}` - so a
// session stored without this comes back with an empty `seen`, re-offers every
// pair already judged, and breaks the §20.1 guarantee in the one place nothing
// would notice.
interface Wire {
  alive: string[];
  seen: string[];
  stopped: boolean;
}

function toWire(session: Session): Wire {
  return { alive: [...session.alive], seen: [...session.seen], stopped: session.stopped };
}

function fromWire(wire: unknown): Session | null {
  if (wire == null || typeof wire !== 'object') return null;
  const { alive, seen, stopped } = wire as Partial<Wire>;
  if (!Array.isArray(alive) || !Array.isArray(seen)) return null;
  if (!alive.every((id) => typeof id === 'string') || !seen.every((key) => typeof key === 'string')) return null;
  return { alive, seen: new Set(seen), stopped: stopped === true };
}

function sessionKey(stackId: string): string {
  return `${SESSION_PREFIX}${stackId}`;
}

export function saveSession(stackId: string, stored: StoredSession): void {
  try {
    sessionStorage.setItem(
      sessionKey(stackId),
      JSON.stringify({
        session: toWire(stored.session),
        // Capped, because every entry snapshots a whole session including its
        // judged pairs, so an unbounded history is quadratic in the stack size.
        // The write is swallowed below, so an over-quota session would otherwise
        // simply stop surviving reloads with nothing said.
        history: stored.history.slice(-HISTORY_LIMIT).map((entry) => ({ ...entry, session: toWire(entry.session) })),
        baseline: stored.baseline,
        entryPhotoId: stored.entryPhotoId,
        bounds: stored.bounds,
        failed: stored.failed,
      }),
    );
  } catch {
    // Private browsing or a full quota. Losing the session costs a reload, which
    // is not worth failing a verdict over.
  }
}

// Hand-edited, or written by an older version: anything that does not parse into
// the shape below is discarded rather than allowed to break opening the session,
// following `view_state.ts`.
export function loadSession(stackId: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(stackId));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const session = fromWire(parsed.session);
    if (session == null) return null;

    const history: HistoryEntry[] = [];
    for (const entry of Array.isArray(parsed.history) ? parsed.history : []) {
      const record = entry as Record<string, unknown>;
      const before = fromWire(record.session);
      const changed = record.changed;
      if (before == null || !Array.isArray(changed)) continue;
      history.push({
        session: before,
        showing: record.showing === 'b' ? 'b' : 'a',
        choice: asChoice(record.choice),
        changed: changed.filter((id): id is string => typeof id === 'string'),
      });
    }

    const baseline: Record<string, Triage> = {};
    const stored = parsed.baseline;
    if (stored != null && typeof stored === 'object') {
      for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
        if (value === 'untriaged' || value === 'picked' || value === 'rejected') baseline[id] = value;
      }
    }

    return {
      session,
      history,
      baseline,
      entryPhotoId: typeof parsed.entryPhotoId === 'string' ? parsed.entryPhotoId : null,
      bounds: asBounds(parsed.bounds),
      failed: Array.isArray(parsed.failed) ? parsed.failed.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return null;
  }
}

function asBounds(value: unknown): StoredSession['bounds'] {
  const id = (held: unknown): string | null => (typeof held === 'string' ? held : null);
  if (value == null || typeof value !== 'object') return { from: null, to: null };
  const { from, to } = value as Record<string, unknown>;
  return { from: id(from), to: id(to) };
}

function asChoice(value: unknown): HistoryEntry['choice'] {
  return value === 'a' || value === 'b' || value === 'neither' || value === 'stopped' ? value : 'both';
}

// A preference about the machine rather than about the stack, so `localStorage`.
export function saveMode(mode: TriageMode): void {
  writeSetting(MODE_KEY, mode);
}

export function loadMode(): TriageMode {
  return readSetting(MODE_KEY) === 'split' ? 'split' : 'flip';
}
