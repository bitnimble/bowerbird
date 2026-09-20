import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prune } from './cargo';

const FRESH = '1111111111111111';
const STALE = '2222222222222222';
const GONE = '3333333333333333';

const A_MONTH_AGO = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;

let profile = '';

afterEach(() => rmSync(profile, { recursive: true, force: true }));

function file(path: string, bytes: number, seconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  if (seconds != null) utimesSync(path, seconds, seconds);
  return path;
}

function fingerprint(hash: string, seconds?: number, asked?: unknown): void {
  const dir = join(profile, '.fingerprint', `rawshim-${hash}`);
  mkdirSync(dir, { recursive: true });
  if (asked != null) writeFileSync(join(dir, 'lib-rawshim.json'), JSON.stringify(asked));
  file(join(dir, 'invoked.timestamp'), 0, seconds);
}

test('a fortnight-old generation goes, and every directory that carries its hash with it', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(FRESH);
  fingerprint(STALE, A_MONTH_AGO);
  fingerprint(GONE, A_MONTH_AGO);

  const kept = file(join(profile, 'deps', `librawshim-${FRESH}.rlib`), 1000);
  const superseded = file(join(profile, 'deps', `librawshim-${STALE}.rlib`), 1000, A_MONTH_AGO);
  const scriptOutput = file(join(profile, 'build', `rawshim-${STALE}`, 'out'), 1000, A_MONTH_AGO);
  const unhashed = file(join(profile, 'deps', 'librawshim.so'), 1000);

  const freed = prune(profile);

  expect(existsSync(kept)).toBe(true);
  expect(existsSync(join(profile, '.fingerprint', `rawshim-${FRESH}`))).toBe(true);
  expect(existsSync(superseded)).toBe(false);
  expect(existsSync(scriptOutput)).toBe(false);
  expect(existsSync(join(profile, '.fingerprint', `rawshim-${STALE}`))).toBe(false);
  // Rewritten in place rather than superseded: nothing hashed is ever a newer copy of it.
  expect(existsSync(unhashed)).toBe(true);
  expect(freed).toBeGreaterThanOrEqual(2000);
});

test("an uplift outlives the generation it points at, unless it is the last one's", () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(FRESH);
  fingerprint(STALE, A_MONTH_AGO);
  fingerprint(GONE, A_MONTH_AGO);

  const current = file(join(profile, 'examples', `renders-${FRESH}`), 1000);
  file(join(profile, 'examples', `renders-${STALE}`), 1000, A_MONTH_AGO);
  const uplifted = join(profile, 'examples', 'renders');
  linkSync(current, uplifted);

  file(join(profile, 'examples', `deleted-${GONE}`), 1000, A_MONTH_AGO);
  const deletedUplift = join(profile, 'examples', 'deleted');
  linkSync(join(profile, 'examples', `deleted-${GONE}`), deletedUplift);

  prune(profile);

  expect(existsSync(uplifted)).toBe(true);
  expect(existsSync(deletedUplift)).toBe(false);
});

test('a lockfile bump supersedes the generation before it without waiting a fortnight', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  const A_WEEK_AGO = (Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000;
  fingerprint(FRESH, undefined, { features: '["default"]', deps: [['rawler', 2]] });
  fingerprint(STALE, A_WEEK_AGO, { features: '["default"]', deps: [['rawler', 1]] });
  // A different thing to have asked for, so it stands on its own age rather than against the rest.
  fingerprint(GONE, A_WEEK_AGO, { features: '["default", "fixtures"]', deps: [['rawler', 1]] });

  const current = file(join(profile, 'deps', `librawshim-${FRESH}.rlib`), 1000);
  const superseded = file(join(profile, 'deps', `librawshim-${STALE}.rlib`), 1000, A_WEEK_AGO);
  const variant = file(join(profile, 'deps', `librawshim-${GONE}.rlib`), 1000, A_WEEK_AGO);

  prune(profile);

  expect(existsSync(current)).toBe(true);
  expect(existsSync(superseded)).toBe(false);
  expect(existsSync(variant)).toBe(true);
});

test("cargo's own account of the build outranks a fingerprint that condemns it", () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(FRESH);
  fingerprint(STALE, A_MONTH_AGO);

  const built = file(join(profile, 'deps', `librawshim-${STALE}.rlib`), 1000, A_MONTH_AGO);

  prune(profile, new Set([built]));

  expect(existsSync(built)).toBe(true);
});

test('an incremental directory stands against the newest of its crate', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(FRESH);

  const current = join(profile, 'incremental', 'rawshim-2rlxkkbnvv6f7');
  file(join(current, 'session'), 1000);
  // Written by the same command as the one above, being that crate's other unit.
  const harness = join(profile, 'incremental', 'rawshim-1i9c02880ai9q');
  file(join(harness, 'session'), 1000);
  const abandoned = join(profile, 'incremental', 'rawshim-0mwusn4xre12k');
  file(join(abandoned, 'session'), 1000, A_MONTH_AGO);
  utimesSync(abandoned, A_MONTH_AGO, A_MONTH_AGO);

  prune(profile);

  expect(existsSync(current)).toBe(true);
  expect(existsSync(harness)).toBe(true);
  expect(existsSync(abandoned)).toBe(false);
});

test('an unreadable fingerprint directory sweeps nothing rather than everything', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  const orphan = file(join(profile, 'deps', `librawshim-${FRESH}.rlib`), 1000);

  expect(prune(profile)).toBe(0);
  expect(existsSync(orphan)).toBe(true);
});
