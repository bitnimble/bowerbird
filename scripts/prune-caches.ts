// Deletes every Actions cache no run will restore again: on `main`, all but the newest of each
// family; anywhere else, all of them, since a run restores only its own ref's and `main`'s and the
// release workflow saves from `main` alone.
//
//   GH_TOKEN=... bun run scripts/prune-caches.ts <owner/repo>
import { spawnSync } from 'node:child_process';

export type Cache = { id: number; key: string; ref: string; created_at: string };

const MAIN = 'refs/heads/main';

/** A key less the hashes that end it: every entry one save replaces the last of. */
export function family(key: string): string {
  return key.replace(/(-[0-9a-f]{8,})+$/, '');
}

export function stale(caches: Cache[]): Cache[] {
  const newest = new Map<string, Cache>();
  for (const cache of caches) {
    if (cache.ref !== MAIN) continue;
    const kept = newest.get(family(cache.key));
    if (kept == null || cache.created_at > kept.created_at) newest.set(family(cache.key), cache);
  }
  const keep = new Set(newest.values());
  return caches.filter((cache) => !keep.has(cache));
}

function gh(args: string[]): string {
  const done = spawnSync('gh', args, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`gh ${args.join(' ')} exited ${done.status}:\n${done.stderr}`);
  return done.stdout;
}

if (import.meta.main) {
  const repo = process.argv[2];
  if (repo == null) throw new Error('name the repository: owner/repo');
  const pages = gh(['api', '--paginate', '--jq', '.actions_caches[]', `repos/${repo}/actions/caches?per_page=100`]);
  const caches: Cache[] = pages
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
  for (const cache of stale(caches)) {
    gh(['api', '-X', 'DELETE', `repos/${repo}/actions/caches/${cache.id}`]);
    console.log(`deleted ${cache.key} (${cache.ref})`);
  }
}
