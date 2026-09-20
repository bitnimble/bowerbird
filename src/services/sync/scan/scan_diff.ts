import type { FileMetadata } from '../../processing/analysis/metadata';

// Prior state (DB) and current state (disk) for one library.
//
// **One entry per input, not per photograph.** The catalogue's side of the diff is read as
// `photo_inputs` joined to the row it feeds, so a file two photographs are composed from arrives
// here twice, once for each - and the loop below, which already emits per entry, reports the
// change against both. That is the whole of the propagation from a file to what depends on it;
// what a *partly* changed composite should then do is the caller's to decide, and today cannot
// arise, every recipe naming one file.
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
  /**
   * The grid tile the scan built while it held this file open, waiting for a photo id to be
   * renamed to (§10.4).
   *
   * Carried from the read that made it rather than derived again later, which is what keeps it
   * unambiguous: this name belongs to this file, whatever the diff decides it is. A file that
   * turns out to be a move has its tile discarded, since the photo it pairs with already has
   * one.
   */
  stagedTile?: string;
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
  /** The tile the scan built for this file, for the row this becomes (`DiskFile.stagedTile`). */
  stagedTile?: string;
}

export interface ModifiedEntry {
  photoId: string;
  filePath: string;
  oldHash: string | null;
  newHash: string;
  metadata: FileMetadata;
  wasMissing: boolean;
  channel: Channel;
  /** The tile the scan built for the file's new contents (`DiskFile.stagedTile`). */
  stagedTile?: string;
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
        stagedTile: change.stagedTile,
      });
    } else if (db.is_missing) {
      // present at its path, unchanged (or re-hashed identical): reappearance.
      reappeared.push(db.id);
    }
  }

  const added: AddedEntry[] = changed
    .filter((f) => !dbByPath.has(f.filePath))
    .map((f) => ({
      filePath: f.filePath,
      fileHash: f.hash,
      metadata: f.metadata,
      channel,
      stagedTile: f.stagedTile,
    }));

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
