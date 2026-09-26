// Build what a tag would release, locally, in Docker: the container image, the APK, or both.
//
//   bun run scripts/release-check.ts [docker] [android]
//
// Built from HEAD in a detached worktree rather than from this checkout, because a tag releases
// the commit: an uncommitted edit would otherwise decide whether the check passes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const TARGETS = ['docker', 'android'] as const;
type Target = (typeof TARGETS)[number];

const repoRoot = resolve(import.meta.dir, '..');

function main(): void {
  const targets = parseTargets(process.argv.slice(2));
  const tree = join(mkdtempSync(join(tmpdir(), 'bb-release-check-')), 'tree');
  try {
    checkout(tree);
    for (const target of targets) build(target, tree);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot, stdio: 'inherit' });
    rmSync(resolve(tree, '..'), { recursive: true, force: true });
  }
}

function parseTargets(args: string[]): Target[] {
  if (args.length === 0) return [...TARGETS];
  for (const arg of args) {
    if (!(TARGETS as readonly string[]).includes(arg)) {
      console.error(`[release-check] ${arg} is not one of: ${TARGETS.join(', ')}`);
      process.exit(2);
    }
  }
  return args as Target[];
}

function checkout(tree: string): void {
  run('git', ['worktree', 'add', '--detach', tree, 'HEAD'], repoRoot);
  // The submodule from this checkout's own objects, so a fork commit that is not pushed yet
  // still builds.
  const submodule = 'native/vendor/dnglab';
  run('git', ['submodule', 'init', submodule], tree);
  run('git', ['config', `submodule.${submodule}.url`, join(repoRoot, submodule)], tree);
  run('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', submodule], tree);
}

function build(target: Target, tree: string): void {
  switch (target) {
    case 'docker':
      run('docker', ['build', '-t', 'bowerbird:release-check', '.'], tree);
      return;
    case 'android':
      run(
        'docker',
        ['build', '--target', 'android-apk', '--output', join(repoRoot, 'dist', 'android-aarch64'), '.'],
        tree,
      );
      return;
  }
}

function run(command: string, args: string[], cwd: string): void {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (done.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${done.status}`);
  }
}

main();
