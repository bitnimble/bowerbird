import { beforeEach, describe, expect, test } from 'bun:test';
import { applyVerdict, nextRound, openSession, pairKey } from '../stack_triage';
import { type HistoryEntry, clearSession, loadMode, loadSession, saveMode, saveSession } from '../triage_storage';

// A session is stored as JSON, and the one thing JSON cannot carry is the Set the
// whole tournament rests on: `JSON.stringify(new Set())` is `{}`. Lost, a
// rehydrated session re-offers every pair it has already judged, which is the one
// failure nothing on screen would show.

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
}

const STACK = 'stack-1';

function storedSession(): { session: ReturnType<typeof openSession>; history: HistoryEntry[] } {
  let session = openSession(['p', 'q', 'r']);
  const history: HistoryEntry[] = [];
  for (const choice of ['both', 'a'] as const) {
    const round = nextRound(session);
    if (round == null) break;
    history.push({ session, showing: 'a', choice, changed: choice === 'a' ? [round.b] : [] });
    session = applyVerdict(session, round, choice);
  }
  return { session, history };
}

describe('the stored session', () => {
  beforeEach(() => {
    globalThis.sessionStorage = new MemoryStorage();
    globalThis.localStorage = new MemoryStorage();
  });

  test('carries the judged pairs back, so nothing already judged is re-offered', () => {
    const { session, history } = storedSession();
    saveSession(STACK, { session, history, baseline: { p: 'untriaged', q: 'picked', r: 'untriaged' }, entryPhotoId: 'p', failed: [] });

    const loaded = loadSession(STACK);
    expect(loaded).not.toBeNull();
    expect(loaded?.session.seen.size).toBe(session.seen.size);
    expect(loaded?.session.seen.has(pairKey('q', 'p'))).toBe(true);
    // The point of the round trip: the restored session asks the same next
    // question, rather than starting the tournament over.
    expect(nextRound(loaded!.session)).toEqual(nextRound(session));
  });

  test('carries the pool, the history, the baseline and the way back', () => {
    const { session, history } = storedSession();
    saveSession(STACK, { session, history, baseline: { p: 'untriaged', q: 'picked', r: 'rejected' }, entryPhotoId: 'p', failed: ['q'] });

    const loaded = loadSession(STACK);
    expect(loaded?.session.alive).toEqual([...session.alive]);
    expect(loaded?.session.stopped).toBe(session.stopped);
    expect(loaded?.entryPhotoId).toBe('p');
    expect(loaded?.failed).toEqual(['q']);
    expect(loaded?.baseline).toEqual({ p: 'untriaged', q: 'picked', r: 'rejected' });
    expect(loaded?.history).toHaveLength(history.length);
    // Every entry's own snapshot survives, or a rewind would restore a pool that
    // never existed.
    expect(loaded?.history[0]?.session.seen.size).toBe(0);
    expect(loaded?.history[1]?.choice).toBe('a');
    expect(loaded?.history[1]?.changed).toEqual(history[1]!.changed);
  });

  test('is discarded rather than half-read when the stored shape is wrong', () => {
    sessionStorage.setItem(`bowerbird.triage.${STACK}`, '{"session":{"alive":"not-an-array"}}');
    expect(loadSession(STACK)).toBeNull();

    sessionStorage.setItem(`bowerbird.triage.${STACK}`, 'not json at all');
    expect(loadSession(STACK)).toBeNull();

    // The shape a `Set` serialises to on its own, which is what this module exists
    // to avoid writing.
    sessionStorage.setItem(`bowerbird.triage.${STACK}`, '{"session":{"alive":["p"],"seen":{},"stopped":false}}');
    expect(loadSession(STACK)).toBeNull();
  });

  test('is gone once cleared, and absent for a stack that never had one', () => {
    const { session, history } = storedSession();
    saveSession(STACK, { session, history, baseline: {}, entryPhotoId: null, failed: [] });
    clearSession(STACK);
    expect(loadSession(STACK)).toBeNull();
    expect(loadSession('never-triaged')).toBeNull();
  });
});

describe('the stored mode', () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage();
  });

  test('defaults to flip, and only ever comes back as one of the two', () => {
    expect(loadMode()).toBe('flip');
    saveMode('split');
    expect(loadMode()).toBe('split');
    localStorage.setItem('bowerbird.triage.mode', 'something else');
    expect(loadMode()).toBe('flip');
  });
});
