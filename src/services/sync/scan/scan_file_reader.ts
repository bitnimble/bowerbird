import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Logger } from '../../../logger';
import { computeFileHash } from '../../../utils/hash';
import type { ScannedFile } from '../../../utils/scan';
import type { ScanDbPhoto } from '../../photos/scan/photo_scan_repository';
import type { FileMetadata, TileStage } from '../../processing/analysis/metadata';
import type { DiskFile } from './scan_diff';
import { eachInOrder, inodeOrder } from './scan_order';

const log = new Logger('scan');

// How many photos a first scan holds before writing them down. Small enough that
// a kill costs seconds of work rather than hours, large enough that the commit
// itself is nowhere near the cost of the decodes that filled it.
const INSERT_BATCH = 1000;

// And how long it holds them, however few there are. The scan builds each photo's
// grid tile while it has the RAW open, so a thousand files is minutes of work: a
// library whose whole import is smaller than one batch would otherwise show
// nothing at all until the run ended.
const INSERT_BATCH_MS = 2_000;

/** One file the walk found, with the stat the diff and the read order are both taken from. */
interface Scanned {
  relPath: string;
  absPath: string;
  stats: Stats;
}

export type MetadataExtractor = (absPath: string, stage?: TileStage) => Promise<FileMetadata>;

export class ScanCancelled extends Error {}

export class ScanFileReader {
  constructor(
    private readonly extract: MetadataExtractor,
    private readonly scanConcurrency: () => number,
  ) {}


  // Stats each file and opens/hashes ONLY the ones that are new or whose mtime+size
  // changed vs the stored record (§9.1). Unchanged files are never opened, so a
  // no-op scan does zero decoding. Shared by the full and scoped paths.
  //
  // `onBatch`, when given, takes the files as they are hashed, a batch at a time,
  // and is what makes a first scan resumable: a half-built `present` is normally
  // unusable, because absence from it is how a removal is detected, and applying
  // it would mark every file the scan had not reached as missing. With no rows
  // for it to be an absence from that cannot happen, and nothing else can either
  // - a move pairs a removal with an addition, and there are no removals - so
  // each batch says only "these files are new", which is true whether or not the
  // scan saw the rest. Those files are then handed over rather than accumulated,
  // so `changed` (and the diff built from it) stays empty.
  async scanFiles(
    files: readonly ScannedFile[],
    dbPhotos: readonly ScanDbPhoto[],
    signal: AbortSignal,
    onProgress: (scanned: number, toScan: number) => void,
    onBatch: ((batch: readonly DiskFile[]) => void) | null,
    keepLease: () => void,
    stageFor: () => TileStage | undefined = () => undefined,
  ): Promise<{ present: Set<string>; changed: DiskFile[]; failed: Set<string> }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

    // Stat everything, collapsing hardlink pairs (same dev+ino) to a single path.
    // A concurrent non-atomic move (moveIntoDir does link() then unlink()) briefly
    // exposes both the old and new path pointing at one inode; without this, the
    // new path would be scanned as a brand-new file and insertFromScan'd as a
    // permanent duplicate row. Prefer whichever path matches an existing record.
    const byInode = new Map<string, Scanned>();
    const width = this.scanConcurrency();
    const stopped = (): boolean => signal.aborted;
    await eachInOrder(
      files,
      width,
      (file) => stat(file.absPath),
      (file, outcome) => {
        // This pass reports nothing, so it is the one blocking stretch of a scan
        // with no other refresh point in it (§9.7).
        keepLease();
        // Gone before it was looked at: treat as not present (a race, or a deletion
        // the watcher reported).
        if (!('value' in outcome)) return;
        const stats = outcome.value;
        // A scoped run is handed paths and not entries, and a folder is free to be
        // named like a photograph; the walk's own files are always files.
        if (!stats.isFile()) return;
        const key = `${stats.dev}:${stats.ino}`;
        const existing = byInode.get(key);
        if (existing == null || (!dbByPath.has(existing.relPath) && dbByPath.has(file.relPath))) {
          byInode.set(key, { relPath: file.relPath, absPath: file.absPath, stats });
        }
      },
      stopped,
    );

    const present = new Set<string>();
    const changed: DiskFile[] = [];
    const failed = new Set<string>();
    const batch: DiskFile[] = [];
    let committedAt = Date.now();
    const keep = (file: DiskFile): void => {
      if (onBatch == null) {
        changed.push(file);
        return;
      }
      batch.push(file);
      if (batch.length < INSERT_BATCH && Date.now() - committedAt < INSERT_BATCH_MS) return;
      onBatch(batch.splice(0));
      committedAt = Date.now();
    };

    // The pass below is the whole cost of a scan (the stat pass above opens
    // nothing), so it is the one worth reporting against. `present` is added to
    // once per file, so its size is how many have been dealt with.
    //
    // A file whose stat still matches its row is never opened, and asking for it is
    // what would open it - so the test is made here, before the read is started, and
    // an unchanged file's "read" is the null that stands for one that never happened.
    const unchanged = (file: Scanned): boolean => {
      const record = dbByPath.get(file.relPath);
      return record != null && record.date_updated === file.stats.mtime.toISOString() && record.file_size === file.stats.size;
    };
    // The denominator before the first read rather than with the first result: reads are
    // started ahead of the results being used, so a strip that waited for one would show
    // nothing to scan for as long as the first file takes - which on the library this is
    // for is the better part of a second.
    onProgress(0, byInode.size);
    await eachInOrder(
      inodeOrder([...byInode.values()]),
      width,
      // The staged tile's name travels back with the metadata rather than being worked out
      // again downstream: it is a name minted for this read, and nothing else can derive it.
      async (file) => {
        if (unchanged(file)) return null;
        const stage = stageFor();
        return { metadata: await this.extract(file.absPath, stage), stagedTile: stage?.outputPath };
      },
      (file, outcome) => {
        // After the file is counted in, not before it: reads run ahead of their results
        // being used, so a figure written before the count would say a file was
        // outstanding while the read of the one after it was already in flight.
        present.add(file.relPath);
        onProgress(present.size, byInode.size);
        if (!('value' in outcome)) {
          // Unreadable/corrupt file: record it as failed so buildDiff leaves any
          // existing record untouched (not marked missing, and not falsely reappeared).
          failed.add(file.relPath);
          log.warn('unreadable file, left as it is', { file: file.absPath, err: outcome.error });
          return;
        }
        const read = outcome.value;
        if (read == null) return;
        keep({
          filePath: file.relPath,
          hash: computeFileHash(file.absPath, read.metadata),
          metadata: read.metadata,
          stagedTile: read.stagedTile,
        });
      },
      // Between files, not inside one: this is the pass that opens and hashes, so a
      // stop lands within one file's read rather than at the end of the scan.
      stopped,
    );

    // The tail of a batched scan, stopped or finished: it is as applicable as
    // every batch before it.
    if (batch.length > 0) onBatch?.(batch.splice(0));
    // Nothing was written down as it went, so a stop leaves the run with nothing
    // it can apply.
    if (signal.aborted && onBatch == null) throw new ScanCancelled();
    return { present, changed, failed };
  }
}
