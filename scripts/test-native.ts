// The Rust suite, but only ever a named part of it.
//
// Running everything is the reflex this refuses: it takes long enough that it stops being read,
// and it answers a question nobody asked - what a change moved is knowable, so name it.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ICD } from './get-swiftshader';

/** Cargo's target selectors that name *one* target. The plural forms select all of them. */
const ONE_TARGET = new Set(['--test', '--lib', '--bin', '--example', '--doc', '--bench']);

/** Selectors that take the target's name as the next argument. */
const TAKES_NAME = new Set(['--test', '--bin', '--example', '--bench']);

const OPTION_VALUES = new Set([
  '--features',
  '--profile',
  '--manifest-path',
  '--package',
  '-p',
  '--target',
  '--target-dir',
  '--jobs',
  '-j',
  '--color',
  '--message-format',
]);

const USAGE = `test:native runs a named part of the Rust suite, never all of it.

  bun run test:native <name>          tests whose path contains <name>, e.g. galosh, demosaic::pad
  bun run test:native --test <file>   one file in native/rawshim/tests, e.g. --test gpu_fixture
  bun run test:native --lib           every in-crate test

Tests that decode a real RAW are behind a feature and are not compiled without it:

  bun run test:native --features fixtures fixture_tests

On a machine with no GPU, --swiftshader runs on the CPU driver \`bun run get:swiftshader\` fetches.
`;

const SWIFTSHADER = '--swiftshader';

function main(): void {
  const args = process.argv.slice(2);
  // `bun run test:native -- --lib` and `bun run test:native --lib` should mean the same thing.
  if (args[0] === '--') args.shift();

  const env = { ...process.env };
  const flagged = args.indexOf(SWIFTSHADER);
  if (flagged >= 0) {
    args.splice(flagged, 1);
    if (!existsSync(ICD)) {
      process.stderr.write(`${SWIFTSHADER} wants ${ICD}, which \`bun run get:swiftshader\` fetches.\n`);
      process.exit(2);
    }
    env.VK_DRIVER_FILES = ICD;
  }

  const scope = scoped(args);
  if (scope == null) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const cargo = [
    'test',
    '--profile',
    'quick',
    // Without a named target, cargo would also build the binaries and run the doctests.
    ...(scope === 'name' ? targetsFor(args) : []),
    '--manifest-path',
    'native/rawshim/Cargo.toml',
    ...args,
  ];
  const run = spawnSync('bun', ['run', resolve(import.meta.dir, 'cargo.ts'), ...cargo], {
    cwd: resolve(import.meta.dir, '..'),
    stdio: 'inherit',
    env,
  });
  process.exit(run.status ?? 1);
}

const CRATE = resolve(import.meta.dir, '../native/rawshim');

/**
 * The `--lib` / `--test <file>` selectors a name filter needs, and no others.
 *
 * **A crate is one compilation unit, so the lib is rebuilt either way; what this saves is the
 * linking.** `--tests` selects every integration target, and each is its own binary linked against
 * that lib - so a filter naming one test in one file paid for eight links, which on this crate is
 * most of the wall clock of a run. Narrowing to the targets that could contain the name leaves one.
 *
 * Matched against the identifiers a cargo filter can actually match: a test's path is
 * `module::module::fn` for the lib and `fn` for an integration file, so the filter's own
 * `::`-separated parts each have to appear in some `fn` or `mod` name of the file.
 *
 * **Falls back to everything rather than guessing.** A filter that matches no identifier anywhere -
 * a name this misreads, a macro-generated test - selects the whole set exactly as before, so the
 * worst this can do is fail to save time. It can never silently skip the test being asked for.
 */
function targetsFor(args: string[]): string[] {
  const filters = names(args);
  if (filters.length === 0) return ['--tests'];

  const holds = (source: string, filter: string): boolean => {
    const names = [...source.matchAll(/\b(?:fn|mod)\s+([a-z0-9_]+)/g)].map((m) => m[1]!);
    return filter
      .split('::')
      .filter((part) => part.length > 0)
      .every((part) => names.some((name) => name.includes(part)));
  };
  const matches = (source: string): boolean => filters.some((filter) => holds(source, filter));

  const selectors: string[] = [];
  if (matches(read(resolve(CRATE, 'src'), true))) selectors.push('--lib');
  for (const file of readdirSync(resolve(CRATE, 'tests'), { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.rs')) continue;
    if (matches(readFileSync(resolve(CRATE, 'tests', file.name), 'utf8'))) {
      selectors.push('--test', file.name.slice(0, -'.rs'.length));
    }
  }
  return selectors.length > 0 ? selectors : ['--tests'];
}

/**
 * The name filters in an argument list, which is not simply every word that is not a flag.
 *
 * An option's *value* is a bare word too - `--features fixtures` looks exactly like a filter called
 * `fixtures`, and taking it for one ORs a word that substring-matches half the crate into the
 * selection. It can only ever select too much, never too little, but selecting too much is the
 * whole thing this function exists not to do.
 */
function names(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Everything past it is the harness's, which cannot name a target.
    if (arg === '--') break;
    const flag = arg.split('=')[0]!;
    if ((TAKES_NAME.has(flag) || OPTION_VALUES.has(flag)) && !arg.includes('=')) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

/** Every `.rs` under a directory, concatenated - the identifiers are all this reads. */
function read(from: string, recurse: boolean): string {
  let all = '';
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const path = resolve(from, entry.name);
    if (entry.isDirectory() && recurse) all += read(path, true);
    else if (entry.isFile() && entry.name.endsWith('.rs')) all += readFileSync(path, 'utf8');
  }
  return all;
}

/** How the caller narrowed the run, or null if they did not. */
function scoped(args: string[]): 'name' | 'target' | null {
  let scope: 'name' | 'target' | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Everything past it belongs to the test harness, which cannot select a target.
    if (arg === '--') break;

    const flag = arg.split('=')[0]!;
    if (ONE_TARGET.has(flag)) {
      if (TAKES_NAME.has(flag) && !arg.includes('=')) i++;
      scope = 'target';
      continue;
    }
    if (OPTION_VALUES.has(flag) && !arg.includes('=')) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    scope ??= 'name';
  }
  return scope;
}

main();
