// cargo, then a sweep of the artefacts it superseded.
//
//   bun run scripts/cargo.ts test --profile quick --tests --manifest-path native/rawshim/Cargo.toml
//
// Cargo names every artefact with a hash of the inputs that produced it and never removes the one
// it just replaced, so `target/` grows by an rlib and a linked binary per rebuild, forever. It
// reached 2.5GB here across a day, of which a gigabyte was generations nothing could reach.
// `cargo clean` is the only built-in answer and it takes the live set with it.
//
// **Which artefacts are live is cargo's to say, not ours.** Two guesses were tried first and both
// churn: keeping the newest hash of each name deletes one of the two rlibs a single `cargo test`
// legitimately produces - the crate is built once as a dependency and once as a test harness - and
// mtime cannot tell a cached artefact from an abandoned one, because cargo does not touch a fresh
// unit's fingerprint. Asking cargo is the only answer that converges, and a second run of the same
// command sweeps nothing.
//
// Only hashes of a name this build produced are candidates. An example the command never built
// keeps every copy it has, so running the test suite does not throw away the example binaries.
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Cargo's own suffix: a dash and sixteen hex digits, before any extension. */
const HASHED = /^(.*)-[0-9a-f]{16}(\..*)?$/;

const ROOT = resolve(import.meta.dir, '..');

function main(): void {
  const args = process.argv.slice(2);
  // Inherited rather than captured, so a test run prints as it goes rather than in one block at
  // the end. The artefact list is asked for separately below.
  const cargo = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' });

  const freed = sweep(live(args));
  if (freed > 0) {
    console.log(`swept ${(freed / 1e6).toFixed(0)}MB of superseded build artefacts`);
  }

  // A signalled cargo has no exit code, and reporting 0 for one would call a killed build a pass.
  process.exit(cargo.status ?? 1);
}

/**
 * Every file the build just used, cargo's word for it.
 *
 * A second invocation rather than JSON from the first: everything is fresh by now, so this costs
 * a tenth of a second and reports the whole set, fresh units included.
 *
 * Asked in a form that only builds, since the work has already been done: `--no-run` for a test,
 * and `build` in place of `run` - which would otherwise decode a folder of RAWs a second time.
 */
function live(args: string[]): Set<string> {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  const [subcommand = 'build', ...rest] = head;
  // A `run`'s trailing arguments are the program's, and `build` would take them for its own.
  const tail = end === -1 || subcommand === 'run' ? [] : args.slice(end);
  const probe = [
    subcommand === 'run' ? 'build' : subcommand,
    ...rest,
    ...(subcommand === 'test' || subcommand === 'bench' ? ['--no-run'] : []),
    '--message-format=json',
    ...tail,
  ];

  const asked = spawnSync('cargo', probe, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'ignore'],
  });

  const found = new Set<string>();
  for (const line of (asked.stdout ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let message: { reason?: string; filenames?: string[]; executable?: string | null };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== 'compiler-artifact') continue;
    for (const file of [...(message.filenames ?? []), message.executable]) {
      if (file == null) continue;
      found.add(file);
      // The dependency file cargo writes beside an artefact shares its name and its fate.
      found.add(`${file}.d`);
      found.add(`${file.replace(/\.[^./]*$/, '')}.d`);
    }
  }
  return found;
}

/** Everything beside a live artefact that is another hash of the same name. */
function sweep(live: Set<string>): number {
  const names = new Map<string, string>();
  for (const file of live) {
    const parts = HASHED.exec(basename(file));
    if (parts) names.set(join(dirname(file), `${parts[1]}${parts[2] ?? ''}`), dirname(file));
  }

  let freed = 0;
  for (const [name, dir] of names) {
    for (const entry of entries(dir)) {
      const parts = HASHED.exec(entry);
      if (!parts || join(dir, `${parts[1]}${parts[2] ?? ''}`) !== name) continue;
      const path = join(dir, entry);
      if (live.has(path)) continue;
      freed += size(path);
      rmSync(path, { recursive: true, force: true });
    }
  }
  return freed;
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

main();
