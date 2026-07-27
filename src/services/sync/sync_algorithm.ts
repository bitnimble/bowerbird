import { shootContains } from '../../utils/shoots';
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

export interface RemovedEntry {
  photoId: string;
  filePath: string;
  fileHash: string | null;
  wasMissing: boolean;
}

export interface AddedEntry {
  filePath: string;
  fileHash: string;
  metadata: FileMetadata;
}

export interface ModifiedEntry {
  photoId: string;
  filePath: string;
  oldHash: string | null;
  newHash: string;
  metadata: FileMetadata;
  wasMissing: boolean;
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
  moves: MoveEntry[];
  added: AddedEntry[]; // leftover additions (new photos)
  removed: RemovedEntry[]; // leftover removals (mark is_missing)
  modified: ModifiedEntry[]; // applied in place
}

// Phase 1 diff (DESIGN §9.1). `presentPaths` is every supported file on disk
// (cheap: readdir + stat). `changed` is only the files that are new or whose
// stat changed, i.e. the ones actually opened + re-hashed; unchanged files are
// omitted from `changed` and only appear in `presentPaths`, so they are never
// opened. Already-missing records still on disk reappear in `removed` so a
// delayed move can match them; they are not re-counted (§9.4 step 5).
export function buildDiff(
  dbPhotos: readonly DbPhoto[],
  presentPaths: ReadonlySet<string>,
  changed: readonly DiskFile[],
  failedPaths: ReadonlySet<string> = new Set(),
): LibraryDiff {
  const changedByPath = new Map(changed.map((f) => [f.filePath, f]));
  const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

  const removed: RemovedEntry[] = [];
  const modified: ModifiedEntry[] = [];
  const reappeared: string[] = [];

  for (const db of dbPhotos) {
    if (!presentPaths.has(db.file_path)) {
      removed.push({ photoId: db.id, filePath: db.file_path, fileHash: db.file_hash, wasMissing: db.is_missing });
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
      });
    } else if (db.is_missing) {
      // present at its path, unchanged (or re-hashed identical): reappearance.
      reappeared.push(db.id);
    }
  }

  const added: AddedEntry[] = changed
    .filter((f) => !dbByPath.has(f.filePath))
    .map((f) => ({ filePath: f.filePath, fileHash: f.hash, metadata: f.metadata }));

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

// Phase 2 move detection (DESIGN §9.3). `isInAlbum` biases which duplicates are
// kept as moves (preserving album membership) when removals outnumber additions.
export function detectMoves(diff: LibraryDiff, isInAlbum: (photoId: string) => boolean): MoveResult {
  const addedByHash = groupByHash(diff.added);
  const removedByHash = groupByHash(diff.removed);

  // A modified file's old hash reappearing as an addition is the relocated
  // original (§9.3): reserve ONE such addition per modified file (it becomes a new
  // photo, not a move source), but leave any other same-hash additions available
  // to pair as moves with their own removed counterparts.
  for (const m of diff.modified) {
    if (m.oldHash == null) continue;
    addedByHash.get(m.oldHash)?.shift();
  }

  const moves: MoveEntry[] = [];
  const usedAdded = new Set<AddedEntry>();
  const usedRemoved = new Set<RemovedEntry>();

  for (const [hash, removedList] of removedByHash) {
    const addedList = addedByHash.get(hash);
    if (!addedList || addedList.length === 0) continue;

    // Album members first, so the excess (kept as removals) are non-album photos.
    const orderedRemoved = [...removedList].sort(
      (a, b) => Number(isInAlbum(b.photoId)) - Number(isInAlbum(a.photoId)),
    );
    const pairs = Math.min(orderedRemoved.length, addedList.length);
    for (let i = 0; i < pairs; i++) {
      const r = orderedRemoved[i]!;
      const a = addedList[i]!;
      moves.push({ photoId: r.photoId, oldFilePath: r.filePath, newFilePath: a.filePath, fileHash: hash });
      usedRemoved.add(r);
      usedAdded.add(a);
    }
  }

  return {
    moves,
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

// A shoot folder renamed outside the app (DESIGN §9.5). Nothing on disk says a
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

  for (const shoot of shoots) {
    if (folderStillOnDisk(shoot.folder_path)) continue; // it did not go anywhere
    const under = dbPhotos.filter((p) => shootContains(shoot.folder_path, p.file_path));
    if (under.length === 0) continue; // nothing to reason from

    let target: string | null = null;
    const wholeFolderMoved = under.every((photo) => {
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
