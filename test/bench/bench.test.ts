// The stage budget is a test, and a stage over it is a failure rather than a note in a log.
//
// `scripts/bench.ts` is what runs, and it decides for itself whether the numbers it took can be
// judged: a different adapter or a busy machine reports and exits 0, so this can only fail where a
// millisecond is genuinely comparable with the one the budget recorded.
//
//   bun run test:bench
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

// A release build of the native crate, then six renders of three RAWs.
const TIMEOUT_MS = 30 * 60 * 1000;

test(
  'every stage of a render is inside its budget',
  () => {
    const run = spawnSync('bun', ['run', 'scripts/bench.ts'], { cwd: ROOT, encoding: 'utf8' });
    if (run.status !== 0) {
      throw new Error(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    }
  },
  TIMEOUT_MS,
);
