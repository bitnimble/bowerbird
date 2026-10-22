import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Logger } from '../../../logger';
import { computeFileHash } from '../../../utils/hash';
import { isRendered, type ScannedFile } from '../../../utils/scan';
import type { MediaEntry, MediaListing } from '../../libraries/media_listing';
import type { ScanDbPhoto } from '../../photos/scan/photo_scan_repository';
import type { FileMetadata } from '../../processing/analysis/metadata';
import type { DiskFile } from './scan_diff';
import { eachInOrder } from './scan_order';

const log = new Logger('scan');

const INSERT_BATCH = 1000;

/** One file the walk found, with the stat the diff is taken from. */
interface Scanned {
  relPath: string;
  absPath: string;
  stats: Stats;
}

export class ScanCancelled extends Error {}

export interface BatchedInserts {
  insert(batch: readonly DiskFile[]): void;
  /** Whether a file new to the catalogue at `relPath` is a live photo, which a batch may insert. */
  accepts(relPath: string): boolean;
}

export class ScanFileReader {
  constructor(
    private readonly scanConcurrency: () => number,
    private readonly media: MediaListing | null = null,
  ) {}

  // Stats each file and opens none (§9.1). A file that is new, or whose mtime+size
  // changed vs the stored record, is hashed off that stat and its row made
  // provisional, so the tile pass reads its header.
  //
  // `batched`, when given, takes new files a batch at a time, and is what makes an
  // import resumable: a half-built `present` is normally unusable, because absence
  // from it is how a removal is detected, and applying it would mark every file the
  // scan had not reached as missing. When the stat pass finds every row's file, no
  // removal can come of this run, and so no move either - a move pairs a removal
  // with an addition - so a new file says only "this file is new", which is true
  // whether or not the scan saw the rest. Those files are handed over rather than
  // accumulated in `changed`.
  async scanFiles(
    files: readonly ScannedFile[],
    dbPhotos: readonly ScanDbPhoto[],
    root: string,
    signal: AbortSignal,
    onProgress: (scanned: number, toScan: number) => void,
    batched: BatchedInserts | null,
  ): Promise<{ present: Set<string>; changed: DiskFile[] }> {
    const dbByPath = new Map(dbPhotos.map((p) => [p.file_path, p]));

    // Stat everything, collapsing hardlink pairs (same dev+ino) to a single path.
    // A concurrent non-atomic move (moveIntoDir does link() then unlink()) briefly
    // exposes both the old and new path pointing at one inode; without this, the
    // new path would be scanned as a brand-new file and insertFromScan'd as a
    // permanent duplicate row. Prefer whichever path matches an existing record.
    const byInode = new Map<string, Scanned>();
    const stopped = (): boolean => signal.aborted;
    let statted = 0;
    onProgress(0, files.length);
    await eachInOrder(
      files,
      this.scanConcurrency(),
      (file) => stat(file.absPath),
      (file, outcome) => {
        onProgress(++statted, files.length);
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

    log.info('scan statted files', { files: byInode.size });
    const found = new Set([...byInode.values()].map((file) => file.relPath));
    const inserts =
      batched != null && dbPhotos.every((row) => found.has(row.file_path)) ? batched : null;

    const present = new Set<string>();
    const changed: DiskFile[] = [];
    const batch: DiskFile[] = [];
    const keep = async (file: DiskFile): Promise<void> => {
      if (inserts == null || dbByPath.has(file.filePath) || !inserts.accepts(file.filePath)) {
        changed.push(file);
        return;
      }
      batch.push(file);
      if (batch.length < INSERT_BATCH) return;
      inserts.insert(batch.splice(0));
      // Nothing else in this loop awaits: without it a 50k-photo import holds every request.
      await Bun.sleep(0);
    };

    const unchanged = (file: Scanned): boolean => {
      const record = dbByPath.get(file.relPath);
      return (
        record != null &&
        record.date_updated === file.stats.mtime.toISOString() &&
        record.file_size === file.stats.size
      );
    };
    const scanned = [...byInode.values()];
    // Asked only when some file changed: a scan that finds nothing costs the index nothing.
    const index =
      this.media == null || scanned.every(unchanged) ? null : await this.media.under(root);
    for (const file of scanned) {
      if (stopped()) break;
      present.add(file.relPath);
      if (unchanged(file)) continue;
      const metadata = provisionalMetadata(file, index?.get(file.absPath));
      await keep({
        filePath: file.relPath,
        hash: computeFileHash(file.absPath, metadata),
        metadata,
      });
    }

    // The tail of a batched scan, stopped or finished: it is as applicable as
    // every batch before it.
    if (batch.length > 0) inserts?.insert(batch.splice(0));
    // With rows, the rest of a stopped run's picture reads as removals.
    if (signal.aborted && dbByPath.size > 0) throw new ScanCancelled();
    return { present, changed };
  }
}

const EXIF_ORIENTATION_OF_DEGREES = new Map([
  [0, 1],
  [90, 6],
  [180, 3],
  [270, 8],
]);

/** What a row holds until its tile job reads the header: the stat, and whatever the device's index knows. */
function provisionalMetadata(file: Scanned, entry: MediaEntry | undefined): FileMetadata {
  const unread: FileMetadata = {
    width: 0,
    height: 0,
    orientation: 1,
    dateTaken: null,
    dateTakenOffset: null,
    latitude: null,
    longitude: null,
    iso: null,
    shutterSpeed: null,
    aperture: null,
    focalLength: null,
    cameraMake: null,
    cameraModel: null,
    lensModel: null,
    sequence: null,
    mtime: file.stats.mtime.toISOString(),
    fileSize: file.stats.size,
    provisional: true,
  };
  // Not a RAW: the index reports the sensor's size, and its thumbnail isn't the picture the grid shows.
  if (entry == null || entry.size !== file.stats.size || !isRendered(file.relPath)) return unread;
  const indexed = entry.imageId == null ? unread : { ...unread, mediaImageId: entry.imageId };
  const orientation = EXIF_ORIENTATION_OF_DEGREES.get(entry.orientationDegrees ?? 0);
  if (entry.width == null || entry.height == null || orientation == null) return indexed;
  const turned = orientation === 6 || orientation === 8;
  return {
    ...indexed,
    width: turned ? entry.height : entry.width,
    height: turned ? entry.width : entry.height,
    orientation,
    dateTaken: entry.takenWallMs == null ? null : new Date(entry.takenWallMs).toISOString(),
  };
}
