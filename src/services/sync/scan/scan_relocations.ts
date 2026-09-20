import type { ScannedDir } from '../../../utils/scan';
import type { ShootIdentity } from '../../shoots/shoots_repository';
import type { MoveEntry } from './scan_diff';

export interface ShootRelocation {
  shootId: string;
  oldFolderPath: string;
  newFolderPath: string;
}

// A shoot folder renamed outside the app, answered by the folder itself rather
// than by what is filed in it (DESIGN §9.4.1). A rename preserves the inode, so a
// shoot whose recorded identity turns up at another path *is* that folder: no
// time window, no all-or-nothing test over its photos, and it works for a folder
// holding none, whose move leaves no other trace at all.
//
// `birthtime` is corroboration, not half of the key. It rules out a recycled
// inode number silently adopting an unrelated folder, and only when both sides
// report one: some filesystems return 0, and treating that as a mismatch would
// disable the check exactly where it is the only evidence there is.
export function detectRelocationsByIdentity(
  shoots: readonly ShootIdentity[],
  dirs: readonly ScannedDir[],
  folderStillOnDisk: (folderPath: string) => boolean,
): ShootRelocation[] {
  // Keyed on device *and* inode: inode numbers repeat across filesystems, so a
  // library with a card reader or a share mounted inside it would otherwise
  // match a shoot against a folder on the other volume and rewrite every one of
  // its photos' paths.
  const byIdentity = new Map<string, ScannedDir[]>();
  for (const dir of dirs) {
    const key = `${dir.dev}:${dir.ino}`;
    const list = byIdentity.get(key);
    if (list) list.push(dir);
    else byIdentity.set(key, [dir]);
  }

  const occupied = new Set(shoots.map((s) => s.folder_path));
  const relocations: ShootRelocation[] = [];
  const claimed = new Set<string>();

  for (const shoot of shoots) {
    // Nothing recorded to match: never scanned, or recorded before the device
    // was part of the key, in which case guessing would be exactly the mistake
    // the device is there to prevent.
    if (shoot.folder_ino == null || shoot.folder_dev == null) continue;
    if (folderStillOnDisk(shoot.folder_path)) continue; // it did not go anywhere

    const candidates = (byIdentity.get(`${shoot.folder_dev}:${shoot.folder_ino}`) ?? []).filter(
      (dir) =>
        dir.relPath !== shoot.folder_path &&
        !occupied.has(dir.relPath) && // a folder another shoot already holds
        !claimed.has(dir.relPath) &&
        birthtimesAgree(shoot.folder_birthtime, dir.birthtimeMs),
    );
    // Exactly one, or it is not an identification. Two folders sharing an inode
    // are hardlinked directories or a filesystem recycling numbers within one
    // scan, and either way the folder's identity is genuinely ambiguous.
    const target = candidates.length === 1 ? candidates[0] : undefined;
    if (target == null) continue;

    claimed.add(target.relPath);
    relocations.push({ shootId: shoot.id, oldFolderPath: shoot.folder_path, newFolderPath: target.relPath });
  }

  return relocations;
}

/**
 * Which walked directory carries the bin's recorded identity (DESIGN §9.1.1).
 *
 * `ambiguous` names every candidate rather than one, because each of them *is*
 * the bin as far as the inode goes: one left in the live walk is a second copy
 * of the whole bin imported as live photographs. That is what a **bind mount**
 * of the bin elsewhere under the root looks like, and a **hardlinked
 * directory**, and a filesystem recycling a number within one scan - all three
 * arrive here as nothing but two `ScannedDir`s sharing a `dev:ino`, which is why
 * this half is separated out and can be reasoned about without them.
 *
 * A nested candidate is ambiguous too: `getBinPath` joins a single name, so a
 * bin one folder deep is not expressible, a constraint inherited from
 * `BinNameSchema` rather than a rule of its own.
 */
export type BinCandidates =
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'one'; target: ScannedDir };

export function findBinByIdentity(
  dirs: readonly ScannedDir[],
  identity: { dev: number | null; ino: number | null } | null,
): BinCandidates {
  // Nothing recorded to match, or a filesystem that reports no inode at all -
  // where guessing would be exactly the mistake the device half is there to
  // prevent.
  if (identity?.ino == null || identity.dev == null || identity.ino === 0) return { kind: 'none' };

  const candidates = dirs.filter((dir) => dir.dev === identity.dev && dir.ino === identity.ino);
  if (candidates.length === 0) return { kind: 'none' };
  const target = candidates.length === 1 ? candidates[0]! : null;
  if (target == null || target.relPath.includes('/')) {
    return { kind: 'ambiguous', candidates: candidates.map((c) => c.relPath) };
  }
  return { kind: 'one', target };
}

function birthtimesAgree(recorded: number | null, found: number): boolean {
  if (recorded == null || recorded === 0 || found === 0) return true;
  return recorded === found;
}

// A shoot folder renamed outside the app (DESIGN §9.4.1). Nothing on disk says a
// folder was renamed rather than deleted and another created, and the watcher is
// no help: the kernel pairs the two halves of a rename with a cookie, but no
// portable JS watcher exposes it. The photos are the evidence instead. If every
// file that was under A/ is now under B/, each keeping its position within the
// folder, then A became B and nothing else explains it.
//
// Deliberately all-or-nothing. A partial match means files were also added,
// removed or reshuffled, so the folder's identity is genuinely ambiguous; the
// shoot is left pointing at a folder that is gone, for the user to resolve,
// rather than guessed at, a wrong guess silently adopts someone else's folder.
//
// `folderStillOnDisk` is what separates a folder that moved from photos that
// were merely reorganised inside one that did not. Sorting a shoot's frames into
// a new `Selects/` subfolder moves every one of them, keeping each one's
// filename, which is indistinguishable from a rename by the paths alone. The old
// folder still being there says the shoot did not go anywhere.
export function detectShootRelocations(
  shoots: readonly { id: string; folder_path: string }[],
  moves: readonly MoveEntry[],
  dbPhotos: readonly { file_path: string }[],
  folderStillOnDisk: (folderPath: string) => boolean,
): ShootRelocation[] {
  const movedTo = new Map<string, string>();
  for (const m of moves) movedTo.set(m.oldFilePath, m.newFilePath);

  const relocations: ShootRelocation[] = [];
  const claimed = new Set<string>();

  // Which shoots are even in question, before touching the photos. Mirroring
  // makes shoots as numerous as folders, and scanning every row per shoot to find
  // out is the difference between a few milliseconds and minutes when a volume
  // goes away and every folder is missing at once.
  const missing = shoots.filter((shoot) => !folderStillOnDisk(shoot.folder_path));
  if (missing.length === 0) return relocations;

  // One pass to bucket the photos under the shoots that need them, rather than a
  // pass over every photo per shoot. A photo goes into *every* missing ancestor's
  // bucket, not just the nearest, because a shoot is answered by everything
  // beneath it - a parent whose own frames all live in a child folder still has
  // to be able to see that they moved together.
  const under = new Map<string, { file_path: string }[]>(missing.map((shoot) => [shoot.folder_path, []]));
  for (const photo of dbPhotos) {
    let prefix = '';
    for (const segment of photo.file_path.split('/').slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      under.get(prefix)?.push(photo);
    }
  }

  for (const shoot of missing) {
    const beneath = under.get(shoot.folder_path) ?? [];
    if (beneath.length === 0) continue; // nothing to reason from

    let target: string | null = null;
    const wholeFolderMoved = beneath.every((photo) => {
      const to = movedTo.get(photo.file_path);
      if (to == null) return false; // this one stayed put: not a whole-folder move
      const tail = photo.file_path.slice(shoot.folder_path.length); // leading '/' included
      if (!to.endsWith(tail)) return false; // moved, but to a different position in the tree
      const folder = to.slice(0, to.length - tail.length);
      target ??= folder;
      return folder === target;
    });
    if (!wholeFolderMoved || target == null || target === shoot.folder_path) continue;

    // Two shoots cannot occupy one folder, and a target another shoot already
    // owns means this is something other than a plain rename.
    const targetPath: string = target;
    if (claimed.has(targetPath) || shoots.some((s) => s.id !== shoot.id && s.folder_path === targetPath)) continue;
    claimed.add(targetPath);
    relocations.push({ shootId: shoot.id, oldFolderPath: shoot.folder_path, newFolderPath: targetPath });
  }

  return relocations;
}
