import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prune } from './cargo';
import { A_MONTH_AGO, FRESH, GONE, STALE, file, fingerprint } from './cargo_test_helpers';

let profile = '';

afterEach(() => rmSync(profile, { recursive: true, force: true }));

test('cargo fmt checks and formats only the selected crate', () => {
  profile = mkdtempSync(join(tmpdir(), 'fmt-'));
  const manifest = join(profile, 'Cargo.toml');
  const source = join(profile, 'src', 'lib.rs');
  const original = 'pub fn answer()->u32{42}\n';
  mkdirSync(join(profile, 'src'));
  writeFileSync(
    manifest,
    '[package]\nname = "format_probe"\nversion = "0.1.0"\nedition = "2024"\n',
  );
  writeFileSync(source, original);

  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ['run', join(import.meta.dir, 'cargo.ts'), 'fmt', '--manifest-path', manifest, ...args],
      { encoding: 'utf8' },
    );

  expect(run('--check').status).toBe(1);
  expect(readFileSync(source, 'utf8')).toBe(original);
  expect(run().status).toBe(0);
  expect(readFileSync(source, 'utf8')).toBe('pub fn answer() -> u32 {\n    42\n}\n');
  expect(run('--check').status).toBe(0);
});

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
