// cargo, then a sweep of the artefacts it superseded.
//
//   bun run scripts/cargo.ts test --profile quick --tests --manifest-path native/rawshim/Cargo.toml
//
// Cargo names every artefact with a hash of the inputs that produced it and never removes the one
// it just replaced, so `target/` grows by an rlib and a linked binary per rebuild, forever. It
// reached 2.5GB here across a day, of which a gigabyte was generations nothing could reach.
// `cargo clean` is the only built-in answer and it takes the live set with it.
//
// **Which artefacts are live is cargo's to say, not ours**, and the guesses that are not cargo's
// both churn: keeping the newest hash of each *name* takes one of the two rlibs a single
// `cargo test` legitimately produces - the crate is built once as a dependency and once as a test
// harness - along with whichever of `--features fixtures` and a bare run went second, and an
// artefact's own mtime cannot tell a cached generation from an abandoned one, because cargo does
// not relink a fresh unit.
//
// What cargo does say is in `<profile>/.fingerprint/<name>-<hash>/`, which it keeps for every unit
// whether or not the command in hand wanted it, and which is read here two ways:
//
// - `invoked.timestamp` is rewritten for every unit an invocation used, cached ones included, so
//   its mtime is when a hash was last *wanted* rather than when it was last compiled. Unwanted for
//   a fortnight is unwanted.
// - The unit's JSON, minus the dependency hashes, is what cargo was *asked* for: rustc, features,
//   profile, target. That is the configuration the name-based guess gets wrong - a lib and its test
//   harness disagree on it, as do the two feature sets, so all of them stand. Two generations that
//   agree on it are one unit built twice either side of a lockfile bump, cargo will only ever reach
//   for the newer, and the fortnight does not have to elapse before the older can go.
//
// `deps/`, `examples/` and `build/` all name their entries with the same hash the fingerprint
// directory carries, so one condemned hash takes its whole generation across all three. Cargo's own
// artefact list is still asked for, to find the target directories the build wrote into and to hold
// anything this invocation produced back from a fingerprint that would condemn it.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Cargo's own suffix: a dash and sixteen hex digits, before any extension. */
const HASHED = /^(.*)-([0-9a-f]{16})(\..*)?$/;

const KEEP_UNUSED = 14 * 24 * 60 * 60 * 1000;

// Not zero: a branch taken and given back inside a working day has both generations wanted again,
// and a sweep between the two would make the second switch a full rebuild.
const SUPERSEDED_AFTER = 24 * 60 * 60 * 1000;

const ROOT = resolve(import.meta.dir, '..');

function main(): void {
  const args = process.argv.slice(2);
  // Inherited rather than captured, so a test run prints as it goes rather than in one block at
  // the end. The artefact list is asked for separately below.
  const cargo = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' });

  const built = live(args);
  let freed = 0;
  for (const profile of profiles(built)) {
    freed += prune(profile, built);
  }
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

/**
 * Every profile directory of every target directory the build wrote into - `release/` and
 * `wasm32-unknown-unknown/debug/` included, which no single command builds all of.
 *
 * `CACHEDIR.TAG` is the marker cargo puts at the root of a target directory, so walking up from an
 * artefact until one appears finds the root without asking where it was configured to be.
 */
function profiles(live: Set<string>): string[] {
  const roots = new Set<string>();
  for (const file of live) {
    for (let dir = dirname(file), up = 0; up < 4; dir = dirname(dir), up++) {
      if (entries(dir).includes('CACHEDIR.TAG')) {
        roots.add(dir);
        break;
      }
    }
  }

  const found: string[] = [];
  for (const root of roots) {
    for (const entry of entries(root)) {
      const dir = join(root, entry);
      if (entries(dir).includes('.fingerprint')) {
        found.push(dir);
        continue;
      }
      for (const nested of entries(dir)) {
        if (entries(join(dir, nested)).includes('.fingerprint')) found.push(join(dir, nested));
      }
    }
  }
  return found;
}

/** Every generation in a profile directory that cargo has stopped reaching for. */
export function prune(profile: string, live: Set<string> = new Set()): number {
  const cutoff = Date.now() - KEEP_UNUSED;
  const fingerprints = join(profile, '.fingerprint');

  // Without it there is no account of what cargo wanted, and an empty account reads as "nothing".
  const fingerprinted = entries(fingerprints);
  if (fingerprinted.length === 0) return 0;

  const used = new Map<string, number>();
  const configurations = new Map<string, string[]>();
  for (const entry of fingerprinted) {
    const carried = generation(entry);
    if (!carried) continue;
    const dir = join(fingerprints, entry);
    used.set(carried.hash, mtime(join(dir, 'invoked.timestamp')) || mtime(dir));
    // Keyed by the package too: with the dependency hashes gone, every build script's fingerprint
    // in the tree reduces to the same handful of zeroes.
    const asked = configuration(dir);
    if (asked == null) continue;
    const key = `${carried.uplift}\n${asked}`;
    configurations.set(key, [...(configurations.get(key) ?? []), carried.hash]);
  }

  const wanted = new Set<string>();
  for (const [hash, when] of used) {
    if (when >= cutoff) wanted.add(hash);
  }
  for (const hashes of configurations.values()) {
    const newest = Math.max(...hashes.map((hash) => used.get(hash) ?? 0));
    for (const hash of hashes) {
      if ((used.get(hash) ?? 0) < newest - SUPERSEDED_AFTER) wanted.delete(hash);
    }
  }
  let freed = 0;
  for (const name of ['.fingerprint', 'deps', 'examples', 'build']) {
    freed += condemn(join(profile, name), wanted, live);
  }

  return freed + sessions(join(profile, 'incremental'), cutoff);
}

/**
 * The same rule again over `incremental/`, which rustc names with a hash of its own and leaves no
 * fingerprint beside, so all there is to go on is what the directories themselves say: the newest
 * of a crate name is the one being written into, and an older one is reachable only by undoing
 * whatever moved the hash.
 *
 * Without a fingerprint there is no configuration either, so a crate's units stand against each
 * other rather than each against its own kind - a lib and its test harness more than a day apart
 * cost the older one a single non-incremental compile, which is the whole price of being wrong here.
 */
function sessions(incremental: string, cutoff: number): number {
  const rebuilt = entries(incremental).map((entry) => ({
    entry,
    crate: entry.replace(/-[0-9a-z]+$/, ''),
    when: mtime(join(incremental, entry)),
  }));

  const newest = new Map<string, number>();
  for (const { crate, when } of rebuilt) {
    newest.set(crate, Math.max(newest.get(crate) ?? 0, when));
  }

  let freed = 0;
  for (const { entry, crate, when } of rebuilt) {
    if (when >= cutoff && when >= (newest.get(crate) ?? 0) - SUPERSEDED_AFTER) continue;
    freed += remove(join(incremental, entry));
  }
  return freed;
}

/**
 * What cargo was asked for, as opposed to what it happened to have to hand: the fingerprint with
 * the dependency hashes taken out, those being what moves when a lockfile does. Two generations
 * that agree on it are one unit built twice, and cargo will only ever reach for the newer.
 */
function configuration(dir: string): string | null {
  const described: string[] = [];
  for (const entry of entries(dir).sort()) {
    if (!entry.endsWith('.json')) continue;
    let asked: Record<string, unknown>;
    try {
      asked = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
    } catch {
      return null;
    }
    delete asked.deps;
    // Names its own fingerprint directory, so it carries the hash being compared across.
    delete asked.local;
    described.push(`${entry}:${JSON.stringify(asked)}`);
  }
  return described.length > 0 ? described.join('\n') : null;
}

function condemn(dir: string, wanted: Set<string>, live: Set<string>): number {
  let freed = 0;
  const surviving = new Set<string>();
  const orphaned = new Set<string>();
  for (const entry of entries(dir)) {
    const carried = generation(entry);
    if (!carried) continue;
    // Cargo has just named it as one of this build's outputs, whatever its fingerprint says.
    if (wanted.has(carried.hash) || live.has(join(dir, entry))) {
      surviving.add(carried.uplift);
      continue;
    }
    orphaned.add(carried.uplift);
    freed += remove(join(dir, entry));
  }

  // Cargo hardlinks the generation in use to its bare name, and the link outlives it. Only a name
  // whose hashes have just gone is a candidate: `deps/librawshim.so` carries no hash at all and is
  // rewritten in place, so nothing there ever supersedes it.
  for (const name of orphaned) {
    if (!surviving.has(name)) freed += remove(join(dir, name));
  }
  return freed;
}

/** The generation a file name carries, and the bare name cargo uplifts that generation to. */
function generation(name: string): { hash: string; uplift: string } | null {
  const parts = HASHED.exec(name);
  if (parts == null) return null;
  const [, stem = '', hash = '', extension = ''] = parts;
  return { hash, uplift: `${stem}${extension}` };
}

function remove(path: string): number {
  const freed = weight(path);
  rmSync(path, { recursive: true, force: true });
  return freed;
}

function weight(path: string): number {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  return entries(path).reduce((total, entry) => total + weight(join(path, entry)), 0);
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
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

if (import.meta.main) main();
