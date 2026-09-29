// The installer for this machine, or the APK, from a checkout with nothing built in it.
//
//   bun run build:app [--target <triple>] [anything the Tauri CLI's build takes]
//
// Every step is a no-op when nothing it reads has changed, so running this again is the rebuild.
// A desktop target other than this machine is Docker's (`bun run release:check`), which cross-builds
// through `bundle-app.ts` and `mac-build.ts` directly.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { hostTriple } from './host-triple.ts';

const ROOT = join(import.meta.dir, '..');
const ANDROID = 'aarch64-linux-android';

function run(
  command: string,
  args: string[],
  cwd = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const done = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

function initSubmodules(): void {
  const status = spawnSync('git', ['submodule', 'status'], { cwd: ROOT, encoding: 'utf8' });
  if (status.status !== 0)
    throw new Error(`git submodule status exited ${status.status}:\n${status.stderr}`);
  const missing = status.stdout
    .split('\n')
    .filter((line) => line.startsWith('-'))
    .map((line) => line.trim().split(/\s+/)[1]!);
  // Named, not all: `update` moves an initialised submodule to the recorded commit, off whatever
  // is being worked on in the fork.
  if (missing.length > 0)
    run('git', ['submodule', 'update', '--init', '--recursive', '--', ...missing]);
}

const passed = process.argv.slice(2);
const at = passed.indexOf('--target');
const target = at === -1 ? hostTriple() : passed[at + 1];
if (target == null) throw new Error('--target names no triple');
const android = target === ANDROID;
if (!android && target !== hostTriple()) {
  throw new Error(
    `${target} is not this machine: build it on one, or cross-build it with \`bun run release:check\``,
  );
}

initSubmodules();
run('bun', ['install', '--frozen-lockfile']);
run('bun', ['install', '--frozen-lockfile'], join(ROOT, 'web'));
run('bun', ['run', 'get:shell']);
run('bun', ['run', 'build:wasm']);

if (android) {
  // `android-build.ts` names the target the Tauri CLI's own way.
  run('bun', [
    'run',
    'scripts/android-build.ts',
    ...passed.filter((_, index) => index !== at && index !== at + 1),
  ]);
} else {
  run('bun', ['run', 'get:codecs']);
  // Here, not in rawshim's release profile: `test:bench` builds that profile too, and a profiler
  // wants the symbols.
  run('bun', ['run', 'build:native:release', '--target', target], ROOT, {
    ...process.env,
    CARGO_PROFILE_RELEASE_STRIP: 'symbols',
  });
  run('bun', ['run', 'build:sidecar', '--target', target]);
  run('bun', ['run', 'scripts/bundle-app.ts', ...passed]);
}
