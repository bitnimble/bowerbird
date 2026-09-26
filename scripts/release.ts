// Writes the next version into `VERSION`, commits it, and tags the commit `v<version>`.
//
//   bun run release            the patch after the current version
//   bun run release 1.2.0      that version
//   bun run release 3f9c2ab    0.0.0-3f9c2ab
//
// Pushing the tag (`git push --follow-tags`) is what starts the release workflow.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../src/version.ts';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const HASH = /^[0-9a-f]{7,40}$/;
const ROOT = join(import.meta.dir, '..');

function git(...args: string[]): string {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) fail(`git ${args.join(' ')} failed:\n${run.stderr}`);
  return run.stdout.trim();
}

function fail(message: string): never {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function nextVersion(requested: string | undefined): string {
  if (requested != null) {
    if (HASH.test(requested)) {
      // Semver forbids a leading zero on an all-digit prerelease, and Tauri refuses the whole version.
      if (/^0\d*$/.test(requested)) fail(`${requested} is all digits with a leading 0: pass a longer hash`);
      return `0.0.0-${requested}`;
    }
    const version = requested.replace(/^v/, '');
    if (!SEMVER.test(version)) fail(`${requested} is neither a semver version (1.2.3, 1.2.3-rc1) nor a commit hash`);
    return version;
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(VERSION);
  if (parts == null) fail(`VERSION is ${VERSION}, which has no patch to increment: name the version`);
  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
}

const dirty = git('status', '--porcelain');
if (dirty !== '') fail(`the working tree has uncommitted or untracked files:\n${dirty}`);

const version = nextVersion(process.argv[2]);
const tag = `v${version}`;
if (git('tag', '--list', tag) !== '') fail(`${tag} already exists`);

writeFileSync(join(ROOT, 'VERSION'), `${version}\n`);
git('commit', '--quiet', '-m', `chore(release): ${version}`, '--', 'VERSION');
// Annotated, because `git push --follow-tags` pushes only annotated tags.
git('tag', '--annotate', tag, '-m', tag);

console.log(`[release] ${VERSION} -> ${version}, committed and tagged ${tag}`);
console.log('[release] git push --follow-tags   to build it');
