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
