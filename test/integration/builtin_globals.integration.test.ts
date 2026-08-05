// A test that swaps out a runtime builtin has to put the original back, not `delete` the
// property. Bun builds globals like `Worker` lazily behind a slot; deleting the property drops
// the slot, and the next thing inside the runtime that reaches for it dereferences null -
// `panic: Segmentation fault at address 0x10`, mid-run, taking the whole `bun test src` with it.
//
// It reads like ordinary cleanup, which is why it survived: the crash lands about one run in
// eight, always in a different place, and never in the test that caused it.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SOURCE = ['src', 'web/src', 'web/e2e', 'e2e-tauri', 'scripts', 'test'];
const SKIP = new Set(['node_modules', 'target', 'dist', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (extname(path) === '.ts' || extname(path) === '.tsx') out.push(path);
  }
  return out;
}

describe('a stubbed-out global', () => {
  test('is restored, not deleted', () => {
    const deletions: string[] = [];
    for (const dir of SOURCE) {
      for (const path of walk(join(ROOT, dir))) {
        readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
          // A comment may name the hazard - this file's own does - without being it.
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/\bdelete\s+\(?\s*globalThis\b/.test(line)) {
            deletions.push(`${relative(ROOT, path)}:${index + 1}`);
          }
        });
      }
    }

    expect(deletions, 'save the original in `beforeEach` and assign it back instead').toEqual([]);
  });
});
