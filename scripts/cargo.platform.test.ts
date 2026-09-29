import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prune } from './cargo';
import { A_MONTH_AGO, FRESH, GONE, STALE, file, fingerprint } from './cargo_test_helpers';

let profile = '';

afterEach(() => rmSync(profile, { recursive: true, force: true }));

test("an uplift outlives the generation it points at, unless it is the last one's", () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(profile, FRESH);
  fingerprint(profile, STALE, A_MONTH_AGO);
  fingerprint(profile, GONE, A_MONTH_AGO);

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

test('an incremental directory stands against the newest of its crate', () => {
  profile = mkdtempSync(join(tmpdir(), 'sweep-'));
  fingerprint(profile, FRESH);

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
