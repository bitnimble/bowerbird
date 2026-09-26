// Build what a tag would release, locally, in Docker: the container image and the apps.
//
//   bun run scripts/release-check.ts [docker] [android] [macos] [windows]
//
// With no names it builds every one it can: `macos` needs `BOWERBIRD_MACOS_SDK` naming a macOS SDK
// packaged for osxcross (`MacOSX<version>.sdk.tar.xz`, made from Xcode by osxcross's
// `gen_sdk_package.sh`), and is left out without one. The apps land in `dist/`, as the release
// workflow lays them out.
//
// Built from HEAD in a detached worktree rather than from this checkout, because a tag releases
// the commit: an uncommitted edit would otherwise decide whether the check passes.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const TARGETS = ['docker', 'android', 'macos', 'windows'] as const;
type Target = (typeof TARGETS)[number];

const repoRoot = resolve(import.meta.dir, '..');
const dist = join(repoRoot, 'dist');
const macosSdk = process.env.BOWERBIRD_MACOS_SDK?.trim() || undefined;

function main(): void {
  const targets = parseTargets(process.argv.slice(2));
  const work = mkdtempSync(join(tmpdir(), 'bb-release-check-'));
  const tree = join(work, 'tree');
  const failed: Target[] = [];
  try {
    checkout(tree);
    for (const target of targets) {
      try {
        build(target, tree, work);
      } catch (error) {
        console.error(`[release-check] ${target}: ${(error as Error).message}`);
        failed.push(target);
      }
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot, stdio: 'inherit' });
    rmSync(work, { recursive: true, force: true });
  }
  if (failed.length > 0) {
    console.error(`[release-check] failed: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.error(`[release-check] built: ${targets.join(', ')}`);
}

function parseTargets(args: string[]): Target[] {
  if (args.length === 0) {
    if (macosSdk != null) return [...TARGETS];
    console.error('[release-check] no BOWERBIRD_MACOS_SDK, so macos is left out');
    return TARGETS.filter((target) => target !== 'macos');
  }
  const targets: Target[] = [];
  for (const arg of args) {
    if (!isTarget(arg)) {
      console.error(`[release-check] ${arg} is not one of: ${TARGETS.join(', ')}`);
      process.exit(2);
    }
    targets.push(arg);
  }
  if (targets.includes('macos') && macosSdk == null) {
    console.error('[release-check] macos needs BOWERBIRD_MACOS_SDK naming a MacOSX<version>.sdk.tar.xz packaged for osxcross');
    process.exit(2);
  }
  return targets;
}

function isTarget(arg: string): arg is Target {
  return TARGETS.some((target) => target === arg);
}

function checkout(tree: string): void {
  run('git', ['worktree', 'add', '--detach', tree, 'HEAD'], repoRoot);
  // The submodule from this checkout's own objects, so a fork commit that is not pushed yet
  // still builds. `-c`, not `git config`: a worktree shares the checkout's config, and the
  // written URL would outlive the check.
  const submodule = 'native/vendor/dnglab';
  run('git', ['submodule', 'init', submodule], tree);
  run(
    'git',
    [
      '-c',
      `submodule.${submodule}.url=${join(repoRoot, submodule)}`,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      submodule,
    ],
    tree,
  );
}

function build(target: Target, tree: string, work: string): void {
  switch (target) {
    case 'docker':
      run('docker', ['build', '-t', 'bowerbird:release-check', '.'], tree);
      return;
    case 'android':
    case 'windows':
      run('docker', ['build', '--target', `${target}-dist`, '--output', dist, '.'], tree);
      return;
    case 'macos': {
      if (macosSdk == null) throw new Error('macos needs BOWERBIRD_MACOS_SDK');
      const context = sdkContext(work, macosSdk);
      run('docker', ['build', '--target', 'macos-dist', '--build-context', `macos-sdk=${context}`, '--output', dist, '.'], tree);
      return;
    }
  }
}

/** A directory holding the SDK and nothing else, since a build context is sent whole. */
function sdkContext(work: string, named: string): string {
  const sdk = resolve(named);
  if (!existsSync(sdk)) throw new Error(`BOWERBIRD_MACOS_SDK names ${sdk}, which is not there`);
  const context = mkdtempSync(join(work, 'macos-sdk-'));
  copyFileSync(sdk, join(context, basename(sdk)));
  return context;
}

function run(command: string, args: string[], cwd: string): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}

main();
