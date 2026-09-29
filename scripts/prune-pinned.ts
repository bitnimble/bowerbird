// Deletes every tree of a linked pinned name that its link does not point into. For a cache one
// checkout owns, a CI runner's or a Docker stage's: elsewhere it deletes other worktrees' trees.
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pinnedLink, pinnedRoot } from './pinned';

if (existsSync(pinnedRoot())) {
  for (const name of readdirSync(pinnedRoot(), { withFileTypes: true })) {
    const link = pinnedLink(name.name);
    if (!name.isDirectory() || !existsSync(link)) continue;
    const linked = realpathSync.native(link);
    const trees = resolve(pinnedRoot(), name.name);
    const entries = readdirSync(trees);
    for (const entry of entries) {
      // a lock, or the tree a `makeOnce` holding one is still making
      if (entry.endsWith('.lock') || entries.includes(`${entry}.lock`)) continue;
      const tree = resolve(trees, entry);
      const resolved = existsSync(tree) ? realpathSync.native(tree) : null;
      if (resolved != null && (linked === resolved || linked.startsWith(resolved + sep))) continue;
      rmSync(tree, { recursive: true, force: true });
      console.log(`pruned ${tree}`);
    }
  }
}
