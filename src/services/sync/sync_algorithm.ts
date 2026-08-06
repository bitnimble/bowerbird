import type { ScannedDir } from '../../utils/scan';
import type { ShootIdentity } from '../shoots/shoots_repository';
import type { FileMetadata } from '../processing/metadata';

// Prior state (DB) and current state (disk) for one library.
export interface DbPhoto {
  id: string;
  file_path: string;
  file_hash: string | null;
  is_missing: boolean;
}

export interface DiskFile {
  filePath: string;
  hash: string;
  metadata: FileMetadata;
}

// Which walk an entry came from, and so which set of rows it is about: the live
// tree against the live rows, the bin against the binned ones (§9.1.1). Carried on
// the entries rather than inferred from the path, because an in-place binned row
// is `is_deleted = 1` with its file *outside* the bin, which position cannot
// tell from a hand-restore.
export type Channel = 'live' | 'bin';

export interface RemovedEntry {
  photoId: string;
  filePath: string;
  fileHash: string | null;
  wasMissing: boolean;
  channel: Channel;
}

export interface AddedEntry {
  filePath: string;
  fileHash: string;
  metadata: FileMetadata;
  channel: Channel;
}

export interface ModifiedEntry {
  photoId: string;
  filePath: string;
  oldHash: string | null;
  newHash: string;
  metadata: FileMetadata;
  wasMissing: boolean;
  channel: Channel;
}

/**
 * A move whose halves landed in different channels: the file entered or left the
 * bin by hand. `within` is a move inside the bin, which is structurally the same
 * question and equally not evidence about a live shoot folder (§9.1.1).
 */
export interface Crossing {
  photoId: string;
  oldFilePath: string;
  newFilePath: string;
  direction: 'in' | 'out' | 'within';
}

export interface LibraryDiff {
  removed: RemovedEntry[];
  added: AddedEntry[];
  modified: ModifiedEntry[];
  reappeared: string[]; // photo ids
}

export interface MoveEntry {
  photoId: string;
  oldFilePath: string;
  newFilePath: string;
  fileHash: string;
}

export interface MoveResult {
  moves: MoveEntry[]; // live-to-live only, so shoot relocation can read them
  crossings: Crossing[]; // §9.1.1
  added: AddedEntry[]; // leftover additions (new photos)
  removed: RemovedEntry[]; // leftover removals (mark is_missing)
  modified: ModifiedEntry[]; // applied in place
}

// Phase 1 diff (DESIGN §9.1). `presentPaths` is every supported file this
// channel's walk found (cheap: readdir + stat) - the library minus the bin for
// the live channel, the bin alone for the bin one - and `dbPhotos` narrows with
// it. Pairing those two inputs is the invariant §9.1.1 has to keep: a path claimed
// by a binned row is not the live channel's business. `changed` is only the files that are new or whose
// stat changed, i.e. the ones actually opened + re-hashed; unchanged files are
// omitted from `changed` and only appear in `presentPaths`, so they are never
// opened. Already-missing records still on disk reappear in `removed` so a
// delayed move can match them; they are not re-counted (§9.4 step 5).
export function buildDiff(
  dbPhotos: readonly DbPhoto[],
  presentPaths: ReadonlySet<string>,
  changed: readonly DiskFile[],
  failedPaths: ReadonlySet<string> = new Set(),
  channel: Channel = 'live',
): LibraryDiff {
  const changedByPath = new Map(changed.map((f) => [f.filePath, f]));
  const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

  const removed: RemovedEntry[] = [];
  const modified: ModifiedEntry[] = [];
  const reappeared: string[] = [];

  for (const db of dbPhotos) {
    if (!presentPaths.has(db.file_path)) {
      removed.push({ photoId: db.id, filePath: db.file_path, fileHash: db.file_hash, wasMissing: db.is_missing, channel });
      continue;
    }
    // Present but unreadable (stat ok, extract threw): we never confirmed its
    // content, so leave the record untouched -- do NOT treat it as a reappearance.
    if (failedPaths.has(db.file_path)) continue;

    const change = changedByPath.get(db.file_path);
    if (change && change.hash !== db.file_hash) {
      modified.push({
        photoId: db.id,
        filePath: db.file_path,
        oldHash: db.file_hash,
        newHash: change.hash,
        metadata: change.metadata,
        wasMissing: db.is_missing,
        channel,
      });
    } else if (db.is_missing) {
      // present at its path, unchanged (or re-hashed identical): reappearance.
      reappeared.push(db.id);
    }
  }

  const added: AddedEntry[] = changed
    .filter((f) => !dbByPath.has(f.filePath))
    .map((f) => ({ filePath: f.filePath, fileHash: f.hash, metadata: f.metadata, channel }));

  return { removed, added, modified, reappeared };
}

function groupByHash<T extends { fileHash: string | null }>(entries: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const entry of entries) {
    if (entry.fileHash == null) continue;
    const list = map.get(entry.fileHash);
    if (list) list.push(entry);
    else map.set(entry.fileHash, [entry]);
  }
  return map;
}

const CROSSING: Record<string, Crossing['direction']> = { 'live>bin': 'in', 'bin>live': 'out', 'bin>bin': 'within' };

// Phase 2 move detection (DESIGN §9.3). `isInAlbum` biases which duplicates are
// kept as moves (preserving album membership) when removals outnumber additions.
//
// Called **once** over both channels' diffs concatenated, because a file that
// entered or left the bin by hand is a removal in one and an addition in the
// other, and neither half can be paired by a run that can only see one of them.
// A pair whose halves disagree on channel becomes a `Crossing` rather than a
// `MoveEntry`: `detectShootRelocations` reads `moves`, and a binned file's
// movement is not evidence about a live shoot folder.
export function detectMoves(diff: LibraryDiff, isInAlbum: (photoId: string) => boolean): MoveResult {
  const addedByHash = groupByHash(diff.added);
  const removedByHash = groupByHash(diff.removed);

  // A modified file's old hash reappearing as an addition is the relocated
  // original (§9.3): reserve ONE such addition per modified file (it becomes a new
  // photo, not a move source), but leave any other same-hash additions available
  // to pair as moves with their own removed counterparts. Scoped to the
  // modification's own channel, or a bin-side modification consumes a live
  // addition (§9.1.1).
  for (const m of diff.modified) {
    if (m.oldHash == null) continue;
    const list = addedByHash.get(m.oldHash);
    const at = list?.findIndex((a) => a.channel === m.channel) ?? -1;
    if (at >= 0) list!.splice(at, 1);
  }

  const moves: MoveEntry[] = [];
  const crossings: Crossing[] = [];
  const usedAdded = new Set<AddedEntry>();
  const usedRemoved = new Set<RemovedEntry>();

  for (const [hash, removedList] of removedByHash) {
    const addedList = addedByHash.get(hash);
    if (!addedList || addedList.length === 0) continue;

    // Channel first, then album membership. Today's sort was album membership
    // alone, which let a binned album member outrank a live non-album removal and
    // take its addition - the swallow §9.1.1 promises could not happen, on the most
    // ordinary input.
    const pair = (r: RemovedEntry, a: AddedEntry): void => {
      usedRemoved.add(r);
      usedAdded.add(a);
      const direction = CROSSING[`${r.channel}>${a.channel}`];
      if (direction == null) moves.push({ photoId: r.photoId, oldFilePath: r.filePath, newFilePath: a.filePath, fileHash: hash });
      else crossings.push({ photoId: r.photoId, oldFilePath: r.filePath, newFilePath: a.filePath, direction });
    };

    // Album members first, so the excess (kept as removals) are non-album photos.
    const free = (list: readonly RemovedEntry[]): RemovedEntry[] =>
      list.filter((r) => !usedRemoved.has(r)).sort((a, b) => Number(isInAlbum(b.photoId)) - Number(isInAlbum(a.photoId)));

    for (const channel of ['live', 'bin'] as const) {
      const removals = free(removedList.filter((r) => r.channel === channel));
      const additions = addedList.filter((a) => a.channel === channel && !usedAdded.has(a));
      for (let i = 0; i < Math.min(removals.length, additions.length); i++) pair(removals[i]!, additions[i]!);
    }
    // Whatever is left can only pair across the channels, which is what a hand
    // binning or a hand restore looks like.
    const removals = free(removedList);
    const additions = addedList.filter((a) => !usedAdded.has(a));
    for (let i = 0; i < Math.min(removals.length, additions.length); i++) pair(removals[i]!, additions[i]!);
  }

  return {
    moves,
    crossings,
    added: diff.added.filter((a) => !usedAdded.has(a)),
    removed: diff.removed.filter((r) => !usedRemoved.has(r)),
    modified: diff.modified,
  };
}

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
