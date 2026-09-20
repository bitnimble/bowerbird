// Does fusing an import's two passes pay?
//
//   bun run scripts/bench_import.ts <split-corpus> <fused-corpus> [--limit N] [--concurrency N]
//
// **An arm per corpus, every file read exactly once by exactly one arm.** A file read a second
// time is answered from a cache somewhere - this machine's, or the NAS's, which
// `POSIX_FADV_DONTNEED` cannot reach - so a corpus both arms cross measures the cache rather
// than the disk. Two directories off the same body with the same file count and much the same
// file size stand in for each other.
//
// The split arm is the product's own code: the real `ScanPool` over the real `scan_worker`, in
// `inodeOrder` and `eachInOrder` at `scan_concurrency`, hashing each result as `ScanService`
// does - and then, once the whole corpus has been scanned, the real `ProcessingService` over
// the real `processing_worker`. That ordering is the point: prod scans every file in the
// library before it builds the first tile.
//
// The fused arm is one pool of `bench_import_worker`, which does what both of those do to a
// file over a single open (`Job.header`).
//
// What is left out is the database: both arms would do identical main-thread writes, and a
// benchmark that needed a schema, a library row and a photo row per file would be measuring
// SQLite. Everything that opens or reads the RAW is here.

process.env.DATA_DIR ??= `${process.env.TMPDIR ?? '/tmp'}/bb-bench-import-data`;

import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { ScanPool } from '../src/services/sync/scan/scan_pool';
import { eachInOrder, inodeOrder } from '../src/services/sync/scan/scan_order';
import { computeFileHash } from '../src/utils/hash';
import { ProcessingService } from '../src/services/processing/pipeline/processing_service';
import { AS_METERED } from '../src/services/processing/pipeline/developed';
import { encoderQuality } from '../src/services/processing/analysis/quality';
import { dataPathForLibraryId, renditionPathFor } from '../src/utils/paths';
import { newId } from '../src/schemas/id';
import { SettingsSchema } from '../src/schemas/settings';
import { fileRecipe } from '../src/schemas/recipes';
import type { PhotoListingRepository } from '../src/services/photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../src/services/photos/paths/photo_paths_repository';
import type { PendingPhoto, PhotoProcessingRepository } from '../src/services/photos/renditions/photo_processing_repository';
import type { SettingsRepository } from '../src/services/settings/settings_repository';
import type { FusedReply, FusedRequest } from './bench_import_worker';
import type { FileMetadata } from '../src/services/processing/analysis/metadata';

const RAW_EXTENSIONS = ['.arw', '.cr2', '.cr3', '.nef', '.raf', '.rw2', '.dng', '.orf'];
// The a7CR's files, which embed a full-resolution JPEG beside a small one. A smaller RAW is a
// different question, so it is not in the corpus.
const SMALLEST_RAW = 70_000_000;

const settings = SettingsSchema.parse({});
const settingsRepository = { get: () => settings } as unknown as SettingsRepository;

interface Corpus {
  dir: string;
  files: { relPath: string; absPath: string; stats: Stats }[];
}

/**
 * The corpus, chosen off directory entries alone.
 *
 * `stat` reads no data, which is the whole point: a corpus picked by opening its candidates
 * would arrive warm and there would be nothing left to measure.
 */
async function corpus(dir: string, limit: number): Promise<Corpus> {
  const names = (await readdir(dir)).filter((name) => RAW_EXTENSIONS.includes(path.extname(name).toLowerCase()));
  names.sort();
  const files: Corpus['files'] = [];
  for (const name of names) {
    if (files.length >= limit) break;
    const absPath = path.join(dir, name);
    const stats = await stat(absPath);
    if (stats.size >= SMALLEST_RAW) files.push({ relPath: name, absPath, stats });
  }
  return { dir, files };
}

/** The tile every import builds, exactly as `processing_service.target` describes it. */
function gridTarget(dataPath: string, photoId: string) {
  return {
    rendition: 'grid' as const,
    output: 'srgb' as const,
    outputPath: renditionPathFor(dataPath, photoId, 'grid', false),
    size: settings.grid_rendition_size,
    source: 'embedded' as const,
    sdrQuantizer: encoderQuality('avif-sdr', settings.grid_rendition_quality),
    hdrQuantizer: encoderQuality('avif-hdr', settings.grid_rendition_quality),
    preset: settings.hdr_preset,
    stillFullChroma: settings.hdr_still_full_chroma,
    sdrFullChroma: false,
  };
}

/**
 * Pass 1 then pass 2, over the product's own pools, in the product's own order.
 *
 * The scan covers the whole corpus before the first tile is built, which is what
 * `ScanService` does and what decides whether the tile pass finds a file still in memory.
 */
async function split(files: Corpus['files'], libraryId: string): Promise<{ scan: number; tiles: number; metadata: FileMetadata[] }> {
  const pool = new ScanPool(() => settings.scan_concurrency);
  const metadata: FileMetadata[] = [];

  const scanStarted = performance.now();
  await eachInOrder(
    inodeOrder([...files]),
    settings.scan_concurrency,
    (file) => pool.read(file.absPath),
    (file, outcome) => {
      if (!('value' in outcome)) throw outcome.error;
      // Hashed here, as the scan does, so the arm carries the same main-thread work.
      computeFileHash(file.absPath, outcome.value);
      metadata.push(outcome.value);
    },
    () => false,
  );
  const scan = performance.now() - scanStarted;

  const pending: PendingPhoto[] = files.map((file, index) => ({
    photo_id: `split-${index}`,
    root_path: path.dirname(file.absPath),
    library_id: libraryId,
    recipe: fileRecipe(file.relPath),
    needs_tile: 1,
    needs_renditions: 1,
    rendition_source: 'embedded',
    library_rendition_source: 'embedded',
    rendition_hdr: 0,
    edits: null,
    edits_stamp: null,
    inputs_edited: 0,
    built_from: null,
  }));
  const repository = {
    listPendingProcessing: () => pending,
    markTileBuilt: () => {},
    markRenditionsBuilt: () => {},
    markProcessingFailed: (_id: string, error: string) => {
      throw new Error(`a tile failed: ${error}`);
    },
  } as unknown as PhotoProcessingRepository;

  const tilesStarted = performance.now();
  await new ProcessingService(
    repository,
    {} as PhotoPathsRepository,
    {} as PhotoListingRepository,
    settingsRepository,
  ).processUnprocessed({ libraryId });
  return { scan, tiles: performance.now() - tilesStarted, metadata };
}

/** The same two answers per file, over one open, on a pool of the same width. */
async function fused(files: Corpus['files'], libraryId: string): Promise<{ taken: number; metadata: FileMetadata[] }> {
  const dataPath = dataPathForLibraryId(libraryId);
  const url = new URL('./bench_import_worker.ts', import.meta.url).href;
  const width = Math.min(settings.processing_concurrency, files.length);
  const metadata: FileMetadata[] = [];
  let next = 0;

  const started = performance.now();
  await Promise.all(
    Array.from({ length: width }, () => {
      const worker = new Worker(url);
      return new Promise<void>((resolve, reject) => {
        const assign = (): void => {
          const index = next++;
          const file = files[index];
          if (file == null) {
            worker.terminate();
            resolve();
            return;
          }
          const photoId = `fused-${index}`;
          const request: FusedRequest = {
            absPath: file.absPath,
            photoId,
            dataPath,
            job: {
              matchEmbeddedJpeg: settings.match_embedded_jpeg,
              defringe: settings.raw_defringe,
              ...AS_METERED,
              grade: {
                peakNits: settings.hdr_peak_nits,
                referenceWhiteNits: settings.hdr_reference_white_nits,
                whiteQuantile: settings.hdr_white_quantile,
              },
              targets: [gridTarget(dataPath, photoId)],
              header: true,
            },
          };
          worker.postMessage(request);
        };
        worker.onmessage = (event: MessageEvent<FusedReply>) => {
          if ('error' in event.data) {
            reject(new Error(event.data.error));
            return;
          }
          metadata.push(event.data.metadata);
          assign();
        };
        worker.onerror = (event: ErrorEvent) => reject(new Error(`fused worker crashed: ${event.message}`));
        assign();
      });
    }),
  );
  return { taken: performance.now() - started, metadata };
}

/** Both arms answer the catalogue the same way, or the comparison is between two things. */
function agree(a: FileMetadata[], b: FileMetadata[]): void {
  const shape = (m: FileMetadata): string =>
    JSON.stringify([m.width, m.height, m.orientation, m.dateTaken, m.iso, m.aperture, m.cameraModel, m.lensModel]);
  const left = new Set(a.map(shape));
  const missing = b.filter((m) => !left.has(shape(m)));
  // Different corpora, so what has to match is the *kind* of answer: every field populated on
  // one arm is populated on the other. A fused header that silently dropped the lens name would
  // otherwise read as a saving.
  const filled = (rows: FileMetadata[], key: keyof FileMetadata): number => rows.filter((m) => m[key] != null).length;
  for (const key of ['dateTaken', 'iso', 'aperture', 'focalLength', 'cameraModel', 'lensModel'] as const) {
    const [split, fusedShare] = [filled(a, key) / a.length, filled(b, key) / b.length];
    if (Math.abs(split - fusedShare) > 0.02) {
      throw new Error(`${key} is set on ${(split * 100).toFixed(0)}% of the split arm and ${(fusedShare * 100).toFixed(0)}% of the fused one`);
    }
  }
  if (missing.length === b.length && b.length > 0) {
    console.log(`  (the two corpora share no frame, as intended: ${missing.length} distinct headers)`);
  }
}

async function main(): Promise<void> {
  const [splitDir, fusedDir, ...rest] = process.argv.slice(2);
  if (splitDir == null || fusedDir == null) {
    console.error('bench_import <split-corpus> <fused-corpus> [--limit N]');
    process.exit(2);
  }
  const limit = Number(rest[rest.indexOf('--limit') + 1]) || 1000;

  const splitCorpus = await corpus(splitDir, limit);
  const fusedCorpus = await corpus(fusedDir, limit);
  const count = Math.min(splitCorpus.files.length, fusedCorpus.files.length);
  splitCorpus.files.length = count;
  fusedCorpus.files.length = count;

  console.log(`${count} files each, scan_concurrency ${settings.scan_concurrency}, processing_concurrency ${settings.processing_concurrency}`);
  console.log(`  split ${splitDir}`);
  console.log(`  fused ${fusedDir}`);

  const splitRun = await split(splitCorpus.files, newId());
  const fusedRun = await fused(fusedCorpus.files, newId());
  agree(splitRun.metadata, fusedRun.metadata);

  const per = (ms: number): string => `${(ms / count).toFixed(1)}ms/file`;
  const total = splitRun.scan + splitRun.tiles;
  console.log(`  split pass 1 (scan)  ${splitRun.scan.toFixed(0)}ms  ${per(splitRun.scan)}`);
  console.log(`  split pass 2 (tiles) ${splitRun.tiles.toFixed(0)}ms  ${per(splitRun.tiles)}`);
  console.log(`  split total          ${total.toFixed(0)}ms  ${per(total)}`);
  console.log(`  fused                ${fusedRun.taken.toFixed(0)}ms  ${per(fusedRun.taken)}`);
  console.log(`  fused is ${(100 * (fusedRun.taken / total - 1)).toFixed(1)}% of split`);
}

await main();
