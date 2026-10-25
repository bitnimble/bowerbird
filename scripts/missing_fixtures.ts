import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { REFERENCE_FRAME } from '../src/services/processing/renditions/reference_frame';

const ROOT = resolve(import.meta.dir, '..');

/** Fixtures `bun run get:fixtures` would fetch that this checkout holds only as LFS pointers, or not at all. */
export function missingFixtures(): string[] {
  const listed = spawnSync('git', ['lfs', 'ls-files'], { cwd: ROOT, encoding: 'utf8' });
  // `<oid> - <path>` is a pointer in the working tree, `<oid> * <path>` the file itself.
  const pointers = (listed.stdout ?? '')
    .split('\n')
    .map((line) => /^\S+ - (.+)$/.exec(line)?.[1])
    .filter((path) => path != null);
  const frame = statSync(REFERENCE_FRAME.path, { throwIfNoEntry: false });
  return frame?.size === REFERENCE_FRAME.byteLength
    ? pointers
    : [...pointers, relative(ROOT, REFERENCE_FRAME.path)];
}

export function warnOfMissingFixtures(): void {
  const missing = missingFixtures();
  if (missing.length === 0) return;
  process.stderr.write(
    `${missing.length} fixtures are LFS pointers or missing (${missing[0]}${missing.length > 1 ? ', …' : ''}), so the tests reading them fail. Run \`bun run get:fixtures\`.\n`,
  );
}
