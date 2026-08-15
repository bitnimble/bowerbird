// `JSCallback { threadsafe: true }` is how bun:ffi lets native code call back from a thread
// this runtime does not own, and in Bun 1.3.14 it segfaults: measured at five crashes in forty
// runs of the specimens that crossed that boundary, against none of the ones that did not,
// always on the main thread and mid-run, and always reported against whichever test happened
// to be executing rather than the one that armed it.
//
// Nothing here reads as wrong, which is why it stood for as long as it did. The boundary that
// armed one is gone - the editor's open is the tab's own now - and nothing may arm another.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const SOURCE = ['src', 'web/src', 'e2e-tauri', 'scripts', 'test'];
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

describe('a callback into this runtime', () => {
  test('is never handed to a thread the runtime does not own', () => {
    const armed: string[] = [];
    for (const dir of SOURCE) {
      for (const path of walk(join(ROOT, dir))) {
        readFileSync(path, 'utf8')
          .split('\n')
          .forEach((line, index) => {
            // A comment may name the hazard - this file's own does - without being it.
            if (/^\s*(\/\/|\*)/.test(line)) return;
            if (/threadsafe\s*:\s*true/.test(line)) armed.push(`${relative(ROOT, path)}:${index + 1}`);
          });
      }
    }

    expect(armed, 'park the result and poll for it rather than calling back').toEqual([]);
  });
});
