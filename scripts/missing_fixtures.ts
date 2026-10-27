import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { REFERENCE_FRAME } from '../src/services/processing/renditions/reference_frame';

const ROOT = resolve(import.meta.dir, '..');

/** Fixtures `bun run get:fixtures` would fetch that this checkout holds only as LFS pointers, or not at all. */
export function missingFixtures(): string[] {
  const listed = spawnSync('git', ['lfs', 'ls-files'], { cwd: ROOT, encoding: 'utf8' });
  // `-` also marks a real file that differs from the index, such as a regenerated fixture not yet
  // committed, so the file itself says whether it is a pointer.
  const pointers = (listed.stdout ?? '')
    .split('\n')
    .map((line) => /^\S+ - (.+)$/.exec(line)?.[1])
    .filter((path): path is string => path != null && isPointer(resolve(ROOT, path)));
  const frame = statSync(REFERENCE_FRAME.path, { throwIfNoEntry: false });
  return frame?.size === REFERENCE_FRAME.byteLength
    ? pointers
    : [...pointers, relative(ROOT, REFERENCE_FRAME.path)];
}

function isPointer(path: string): boolean {
  if (statSync(path, { throwIfNoEntry: false }) == null) return true;
  const head = Buffer.alloc(LFS_POINTER.length);
  const file = openSync(path, 'r');
  try {
    readSync(file, head, 0, head.length, 0);
  } finally {
    closeSync(file);
  }
  return head.toString() === LFS_POINTER;
}

const LFS_POINTER = 'version https://git-lfs.github.com/spec/';

export function warnOfMissingFixtures(): void {
  const missing = missingFixtures();
  if (missing.length === 0) return;
  process.stderr.write(
    `${missing.length} fixtures are LFS pointers or missing (${missing[0]}${missing.length > 1 ? ', …' : ''}), so the tests reading them fail. Run \`bun run get:fixtures\`.\n`,
  );
}
