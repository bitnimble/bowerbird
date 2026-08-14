// A comment that names a file which no longer exists is a comment that was true when it was
// written, and is now a wrong turn for whoever follows it. This branch deleted a lot - a wasm
// editor, a worker, a daemon, a blocking FFI entry point, a dylib-bundling step - and the
// references to them were found one at a time, by reading, several rounds apart.
//
// Reading is what this replaces. A path in backticks is the one part of a comment that can be
// checked mechanically, and in practice it is the anchor: a stale explanation almost always
// names the thing it is stale about.
//
// Code only, deliberately. `DESIGN.md` and `docs/` keep superseded sections on purpose, under
// banners saying so, and naming what was deleted is the point of those. A comment beside code
// has no such excuse.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

const SOURCE = [
  'src',
  'web/src',
  'web/e2e',
  'e2e-tauri',
  'scripts',
  'native/rawshim/src',
  'native/rawshim/examples',
  'src-tauri/src',
];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.rs', '.wgsl']);
const SKIP = new Set(['node_modules', 'target', 'dist', '.git']);

// What a named file can be. Anything else in backticks is a symbol, a command or prose.
const NAMED = new Set([
  '.ts', '.tsx', '.rs', '.wgsl', '.md', '.json', '.toml', '.html', '.css', '.sh', '.yml',
]);

function walk(dir: string, out: string[] = []): string[] {
  // Dirents rather than a stat each: a tauri android build leaves symlinks into an
  // NDK that need not be there, and stat follows them and throws.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Every file in the repo, by name alone, because a comment rarely spells the whole path. */
const everyFile = new Set<string>();
const everyPath = new Set<string>();
for (const dir of ['src', 'web', 'e2e-tauri', 'scripts', 'native', 'src-tauri', 'docs', 'test']) {
  for (const path of walk(join(ROOT, dir))) {
    everyPath.add(relative(ROOT, path));
    everyFile.add(path.slice(path.lastIndexOf('/') + 1));
  }
}
for (const top of readdirSync(ROOT)) {
  if (!SKIP.has(top) && statSync(join(ROOT, top)).isFile()) {
    everyPath.add(top);
    everyFile.add(top);
  }
}

// Files the app writes rather than files the repo holds, which a comment may name for the
// same reasons and which no checkout will ever contain.
const AT_RUNTIME = new Set(['config.json']);

function named(token: string): boolean {
  // Not a path of ours: somebody else's tree, a URL, a glob, a sentence.
  if (token.startsWith('/') || token.startsWith('~') || token.includes('://')) return false;
  if (/[\s*?<>|]/.test(token)) return false;
  if (token.startsWith('node_modules/') || AT_RUNTIME.has(token)) return false;
  return NAMED.has(extname(token));
}

function exists(token: string): boolean {
  const path = token.replace(/^\.\//, '');
  if (everyPath.has(path)) return true;
  // A comment usually says `rawshim_edit.ts`, or a partial path from wherever the reader is
  // assumed to be standing. Either resolves by name; the point is that the file is still
  // there under that name, not that the comment spelled its whole path.
  return everyFile.has(path.slice(path.lastIndexOf('/') + 1));
}

describe('a comment naming a file', () => {
  test('names one that exists', () => {
    const dangling: string[] = [];
    for (const dir of SOURCE) {
      for (const path of walk(join(ROOT, dir))) {
        if (!SOURCE_EXTENSIONS.has(extname(path))) continue;
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/`([^`\n]+)`/g)) {
          const token = match[1] ?? '';
          if (!named(token) || exists(token)) continue;
          dangling.push(`${relative(ROOT, path)} names ${token}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });
});

// The same rule one level down. A Rust comment that says `wasm::Editor::grade_from` is what
// this owes its answer to is describing a module that was deleted, and the reader cannot
// tell that from the comment - it reads exactly like a live cross-reference.
//
// The last segment rather than the whole path, because a comment abbreviates the route and
// not the name. Anything genuinely there is written down somewhere: its own definition, a
// call, or a `use`.
const RUST_PATH = /^[a-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/;

describe('a Rust comment naming a path', () => {
  test('names one that is written down somewhere', () => {
    const rust = walk(join(ROOT, 'native', 'rawshim'))
      .concat(walk(join(ROOT, 'src-tauri', 'src')))
      .filter((path) => extname(path) === '.rs');
    const source = new Map(rust.map((path) => [path, readFileSync(path, 'utf8')]));
    // Comments stripped, so a name that appears only in prose does not vouch for itself,
    // which is the whole failure being looked for. From wherever `//` starts rather than
    // only from the start of a line: a trailing comment is still a comment, and one on the
    // same line as code was the way a dead name went on proving it was alive.
    const code = [...source.values()]
      .map((text) => text.replaceAll(/\/\/.*$/gm, '').replaceAll(/^\s*\*.*$/gm, ''))
      .join('\n');

    const dangling: string[] = [];
    for (const [path, text] of source) {
      for (const match of text.matchAll(/`([^`\n]+)`/g)) {
        const token = match[1] ?? '';
        if (!RUST_PATH.test(token)) continue;
        const leaf = token.slice(token.lastIndexOf(':') + 1);
        if (code.includes(leaf)) continue;
        dangling.push(`${relative(ROOT, path)} names ${token}`);
      }
    }
    expect(dangling).toEqual([]);
  });
});
