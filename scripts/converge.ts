// The convergence suite over a long run of seeds, a few hundred at a time.
//
// Split across processes because libSQL never frees a prepared statement: there is no `finalize` on
// its binding and `close()` does not release them either, so a process pays about 5KB for every
// distinct statement it has ever prepared, for as long as it lives. A peer is a fresh in-memory
// catalogue preparing its own hundred-odd, and a seed builds several peers - measured at 5.5GB by
// seed 250, which is why one process cannot reach 3000.
//
// Seeds are independent and each is a function of its own number, so a chunk boundary changes
// nothing about what is tested; a failure still names a seed that replays alone.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SPEC = join('src', 'services', 'replication', 'tests', 'converge.test.ts');
const CHUNK = 250;

const total = Number(process.argv[2] ?? process.env.BOWERBIRD_CONVERGE_SEEDS ?? 3000);
if (!Number.isInteger(total) || total < 1) throw new Error(`seeds must be a positive integer, not ${process.argv[2]}`);

for (let first = 1; first <= total; first += CHUNK) {
  const count = Math.min(CHUNK, total - first + 1);
  console.log(`seeds ${first}-${first + count - 1} of ${total}`);
  const result = spawnSync('bun', ['test', SPEC], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      LOG_LEVEL: 'warn',
      DATA_DIR: `${process.env.TMPDIR ?? '/tmp'}/bowerbird-test-data`,
      BOWERBIRD_CONVERGE_FIRST_SEED: String(first),
      BOWERBIRD_CONVERGE_SEEDS: String(count),
    },
  });
  if (result.status !== 0) {
    console.error(`seeds ${first}-${first + count - 1} failed`);
    process.exit(result.status ?? 1);
  }
}
console.log(`${total} seeds converged`);
