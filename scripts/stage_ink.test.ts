import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

test("the TV's window and activity are the page's ink", () => {
  const ink = /ink: '(#[0-9a-f]{6})'/.exec(read('web/src/ui/tokens.stylex.ts'))?.[1];
  expect(ink).toBeDefined();
  const bytes = /const INK: \[u8; 3\] = \[0x(..), 0x(..), 0x(..)\]/
    .exec(read('native/rawshim/src/gpu/surface_stage.rs'))
    ?.slice(1)
    .join('');
  expect(`#${bytes}`).toBe(ink!);
  expect(read('scripts/android-build.ts')).toContain(`Color.parseColor("${ink}")`);
});
