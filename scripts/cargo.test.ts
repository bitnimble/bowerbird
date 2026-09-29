import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prune } from './cargo';
import { A_MONTH_AGO, FRESH, GONE, STALE, file, fingerprint } from './cargo_test_helpers';

let profile = '';

afterEach(() => rmSync(profile, { recursive: true, force: true }));

test('a fortnight-old generation goes, and every directory that carries its hash with it', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(profile, FRESH);
  fingerprint(profile, STALE, A_MONTH_AGO);
  fingerprint(profile, GONE, A_MONTH_AGO);

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

test('a lockfile bump supersedes the generation before it without waiting a fortnight', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  const A_WEEK_AGO = (Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000;
  fingerprint(profile, FRESH, undefined, { features: '["default"]', deps: [['rawler', 2]] });
  fingerprint(profile, STALE, A_WEEK_AGO, { features: '["default"]', deps: [['rawler', 1]] });
  // A different thing to have asked for, so it stands on its own age rather than against the rest.
  fingerprint(profile, GONE, A_WEEK_AGO, {
    features: '["default", "fixtures"]',
    deps: [['rawler', 1]],
  });

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
  fingerprint(profile, FRESH);
  fingerprint(profile, STALE, A_MONTH_AGO);

  const built = file(join(profile, 'deps', `librawshim-${STALE}.rlib`), 1000, A_MONTH_AGO);

  prune(profile, new Set([built]));

  expect(existsSync(built)).toBe(true);
});

test('an unreadable fingerprint directory sweeps nothing rather than everything', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  const orphan = file(join(profile, 'deps', `librawshim-${FRESH}.rlib`), 1000);

  expect(prune(profile)).toBe(0);
  expect(existsSync(orphan)).toBe(true);
});
