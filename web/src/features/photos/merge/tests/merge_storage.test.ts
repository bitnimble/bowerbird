import { beforeEach, expect, test } from 'bun:test';
import { MemoryStorage } from '../../../../test_storage';
import { clearMergeSession, loadMergeSession, saveMergeSession, type StoredMergeSession } from '../merge_storage';

const key = 'job1';

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});

function session(): StoredMergeSession {
  return { picks: [0, 1, 0], base: 0, seeds: [{ x0: 1, y0: 2, x1: 3, y1: 4 }] };
}

test('round-trips', () => {
  expect(saveMergeSession(key, session())).toBe(true);
  expect(loadMergeSession(key)).toEqual(session());
});

test('round-trips a feather, and reads one that is not a number as none', () => {
  saveMergeSession(key, { ...session(), feather: 0.02 });
  expect(loadMergeSession(key)?.feather).toBe(0.02);
  sessionStorage.setItem(`bowerbird.merge.${key}`, JSON.stringify({ ...session(), feather: 'wide' }));
  expect(loadMergeSession(key)).toEqual(session());
});

test('a session with no seeds reads as none seeded', () => {
  sessionStorage.setItem(`bowerbird.merge.${key}`, JSON.stringify({ picks: [0, 1], base: 0 }));
  expect(loadMergeSession(key)).toEqual({ picks: [0, 1], base: 0, seeds: [] });
});

test('a seed that is not a rectangle discards the session', () => {
  sessionStorage.setItem(`bowerbird.merge.${key}`, JSON.stringify({ picks: [0], base: 0, seeds: [{ x0: 1 }] }));
  expect(loadMergeSession(key)).toBeNull();
});

test('a different key is not found', () => {
  saveMergeSession(key, session());
  expect(loadMergeSession('other-key')).toBeNull();
});

test('clearing removes it', () => {
  saveMergeSession(key, session());
  clearMergeSession(key);
  expect(loadMergeSession(key)).toBeNull();
});

test('malformed storage is discarded rather than thrown', () => {
  sessionStorage.setItem(`bowerbird.merge.${key}`, '{not json');
  expect(loadMergeSession(key)).toBeNull();
});

test('a session written by an older version is discarded rather than half-read', () => {
  sessionStorage.setItem(`bowerbird.merge.${key}`, JSON.stringify({ picks: [0, 1] }));
  expect(loadMergeSession(key)).toBeNull();
});

test('a quota failure is surfaced rather than swallowed', () => {
  sessionStorage.setItem = () => {
    throw new DOMException('quota', 'QuotaExceededError');
  };
  expect(saveMergeSession(key, session())).toBe(false);
});
