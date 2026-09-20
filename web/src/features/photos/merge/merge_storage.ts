// A merge session, kept across a reload - `triage_storage.ts`'s pattern, with one deliberate
// difference: that module swallows a quota failure because losing a triage session costs a
// reload, where losing picks the reader has made across a dozen tiles is real work, so
// `saveMergeSession` reports failure rather than hiding it.

import { TakesSchema, type Takes } from '../../../../../src/schemas/assembly';
import type { Rect } from './merge_rect';

const SESSION_PREFIX = 'bowerbird.merge.';

export interface StoredMergeSession {
  /** Per tile, the source index - the seeded tiles' included, after the recipe's own. */
  picks: number[];
  base: number;
  /** The seeded tiles, in the order they were seeded: the analysis answers none of them. */
  seeds: Rect[];
  /**
   * What each seed asks its pick for, one entry a seed. Absent from a session saved before a tile
   * could ask for anything but its subject.
   */
  takes?: Takes[];
  /** `AssemblyRecipe.feather`, absent from a session saved before it could be set. */
  feather?: number;
}

function sessionKey(key: string): string {
  return `${SESSION_PREFIX}${key}`;
}

/** @returns whether the write landed, so a presenter can tell the reader when it did not. */
export function saveMergeSession(key: string, session: StoredMergeSession): boolean {
  try {
    sessionStorage.setItem(sessionKey(key), JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearMergeSession(key: string): void {
  try {
    sessionStorage.removeItem(sessionKey(key));
  } catch {
    // Storage the tab will not give us is not worth failing a navigation over.
  }
}

// Hand-edited, or written by an older version: anything that does not parse into the shape below
// is discarded rather than allowed to break opening the page, following `triage_storage.ts`.
export function loadMergeSession(key: string): StoredMergeSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(key));
    if (raw == null) return null;
    const { picks, base, seeds = [], takes, feather } = JSON.parse(raw) as Record<string, unknown>;
    const isNumberArray = (value: unknown): value is number[] =>
      Array.isArray(value) && value.every((v) => typeof v === 'number');
    const isRect = (value: unknown): value is Rect =>
      typeof value === 'object' &&
      value != null &&
      (['x0', 'y0', 'x1', 'y1'] as const).every((k) => typeof (value as Record<string, unknown>)[k] === 'number');
    if (!isNumberArray(picks) || typeof base !== 'number') return null;
    if (!Array.isArray(seeds) || !seeds.every(isRect)) return null;
    const session: StoredMergeSession = { picks, base, seeds };
    if (takes != null) {
      const parsed = TakesSchema.array().length(seeds.length).safeParse(takes);
      if (!parsed.success) return null;
      session.takes = parsed.data;
    }
    if (typeof feather === 'number') session.feather = feather;
    return session;
  } catch {
    return null;
  }
}
