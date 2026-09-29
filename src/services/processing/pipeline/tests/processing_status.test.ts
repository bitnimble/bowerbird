import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import { PhotoListingRepository } from '../../../photos/listing/photo_listing_repository';
import { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { RenditionsRepository } from '../../renditions/renditions_repository';
import { StackMembership } from '../../../stacks/stack_membership';
import { idleScanStatus, ScanStatus } from '../../../sync/scan/scan_status';
import type { CompositeJob, RenditionJob } from '../../workers/processing_types';
import { ProcessingService } from '../processing_service';
import { LibraryActivity } from '../../../activity/library_activity';
import type { PrepareAnswer, PrepareAsk } from '../../workers/prepare_worker';
import { PhotoRenditionService } from '../../../photos/renditions/photo_rendition_service';
import { PhotoMetadataRepository } from '../../../photos/metadata/photo_metadata_repository';
import { localOriginals } from '../../../blobs/originals_for_testing';
import type { FileMetadata } from '../../analysis/metadata';
import type { RenderTiming } from '../../../../schemas/render_stages';
import { RenderTimingsFile } from '../../renditions/render_timings_file';
import { RenderBenchmark } from '../render_benchmark';
import { MockWorker, REAL_WORKER, settingsWith } from './processing_test_helpers';

const LIB = 'status01';
const OTHER = 'status02';

class HeldWorker extends MockWorker {
  static readonly jobs: { worker: HeldWorker; job: RenditionJob | CompositeJob }[] = [];

  override postMessage(job: RenditionJob | CompositeJob): void {
    HeldWorker.jobs.push({ worker: this, job });
  }

  static finish(photoId: string, rendition: string, success = true): void {
    const index = this.jobs.findIndex(({ job }) => job.photoId === photoId && job.targets[0]?.rendition === rendition);
    if (index < 0) throw new Error(`no held ${rendition} for ${photoId}`);
    const held = this.jobs.splice(index, 1)[0];
    if (held == null) throw new Error(`no held ${rendition} for ${photoId}`);
    held.worker.onmessage?.({
      data: success ? { photoId, success: true } : { photoId, success: false, error: 'render failed' },
    });
  }
}

class HeldPrepareWorker {
  static readonly posted: HeldPrepareWorker[] = [];
  onmessage: ((event: { data: PrepareAnswer }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;

  postMessage(_ask: PrepareAsk): void {
    HeldPrepareWorker.posted.push(this);
  }

  terminate(): void {}
}

describe('live library processing status', () => {
  let db: Database;
  let root: string;
  let photos: PhotoProcessingRepository;
  let processing: ProcessingService;
  let status: ScanStatus;
  let activity: LibraryActivity;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    root = mkdtempSync(path.join(tmpdir(), 'bb-processing-status-'));
    for (const libraryId of [LIB, OTHER]) {
      const libraryRoot = path.join(root, libraryId);
      mkdirSync(libraryRoot);
      db.query(`INSERT INTO libraries (id, root_path, name) VALUES (?, ?, ?)`).run(libraryId, libraryRoot, libraryId);
    }
    photos = new PhotoProcessingRepository(db, new RenditionsRepository(db));
    activity = new LibraryActivity();
    const libraries = new LibrariesRepository(db);
    processing = new ProcessingService(
      photos,
      new PhotoPathsRepository(db, new StackMembership(db)),
      new PhotoListingRepository(db),
      settingsWith({}),
      undefined,
      (id) => libraries.getById(id),
      undefined,
      undefined,
      activity,
    );
    status = new ScanStatus(photos, libraries, processing);
    HeldWorker.jobs.length = 0;
    HeldPrepareWorker.posted.length = 0;
    (globalThis as { Worker?: unknown }).Worker = HeldWorker;
  });

  afterEach(() => {
    globalThis.Worker = REAL_WORKER;
    db.close();
    rmSync(root, { recursive: true, force: true });
    for (const libraryId of [LIB, OTHER]) rmSync(dataPathForLibraryId(libraryId), { recursive: true, force: true });
  });

  function add(photoId: string, libraryId = LIB): void {
    writeFileSync(path.join(root, libraryId, `${photoId}.arw`), 'RAW');
    db.query(`INSERT INTO photos (id, library_id, recipe, width, height, date_added)
      VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, '2026-01-01T00:00:00.000Z')`)
      .run(photoId, libraryId, `${photoId}.arw`);
    photos.queueBothPasses(photoId);
  }

  it('keeps rendering visible after transfer settles and includes queued arrivals once per photo', async () => {
    add('a');
    add('b');
    const first = processing.processUnprocessed({ photoIds: ['a', 'b'] });
    await Bun.sleep(0);

    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'idle', photos_processing: 2 });
    add('c');
    add('x', OTHER);
    const arrivals = processing.processUnprocessed({ photoIds: ['b', 'c', 'c', 'x'] });
    status.set(LIB, idleScanStatus(LIB, 'processing'));
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'processing', photos_processing: 3 });
    status.set(LIB, idleScanStatus(LIB, 'rendition'));
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'rendition', photos_processing: 3 });
    status.set(LIB, idleScanStatus(LIB));
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'idle', photos_processing: 3 });
    expect(status.getScanStatus(OTHER)).toMatchObject({ status: 'idle', photos_processing: 1 });

    HeldWorker.finish('a', 'grid');
    HeldWorker.finish('b', 'grid');
    await Bun.sleep(0);
    expect(status.getScanStatus(LIB).photos_processing).toBe(3);
    HeldWorker.finish('a', 'full');
    expect(status.getScanStatus(LIB).photos_processing).toBe(2);
    HeldWorker.finish('b', 'full');
    await Bun.sleep(0);
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);

    HeldWorker.finish('c', 'grid');
    HeldWorker.finish('x', 'grid');
    await Bun.sleep(0);
    HeldWorker.finish('c', 'full');
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'idle', photos_processing: 0 });
    expect(status.getScanStatus(OTHER)).toMatchObject({ status: 'idle', photos_processing: 1 });
    HeldWorker.finish('x', 'full');
    await Promise.all([first, arrivals]);
    expect(status.getScanStatus(OTHER)).toMatchObject({ status: 'idle', photos_processing: 0 });
    expect(photos.countPendingProcessing()).toBe(0);
  });

  it('removes failed work while leaving unrelated persisted backlog idle', async () => {
    add('a');
    add('b');
    add('backlog');
    const run = processing.processUnprocessed({ libraryId: LIB, photoIds: ['a', 'b'] });
    await Bun.sleep(0);
    expect(status.getScanStatus(LIB).photos_processing).toBe(2);

    rmSync(path.join(root, LIB, 'a.arw'));
    HeldWorker.finish('a', 'grid', false);
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    HeldWorker.finish('b', 'grid', false);
    await run;

    expect(photos.countPendingProcessing(LIB)).toBe(2);
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'idle', photos_processing: 0 });
  });

  it('clears stopped batches and queued arrivals without showing their persisted backlog as active', async () => {
    for (const photoId of ['a', 'b', 'c']) add(photoId);
    let stopped = false;
    const run = processing.processUnprocessed({ libraryId: LIB }, () => stopped);
    await Bun.sleep(0);
    add('d');
    processing.processUnprocessed({ libraryId: LIB, photoIds: ['a', 'd'] });
    processing.processUnprocessed({ libraryId: LIB });
    expect(status.getScanStatus(LIB).photos_processing).toBe(4);

    stopped = true;
    HeldWorker.finish('a', 'grid');
    HeldWorker.finish('b', 'grid');
    await run;

    expect(photos.countPendingProcessing(LIB)).toBe(4);
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'idle', photos_processing: 0 });
  });

  it('counts overlapping library and unscoped batches once until both finish', async () => {
    add('a');
    add('b', OTHER);
    const library = processing.processUnprocessed({ libraryId: LIB, photoIds: ['a'] });
    const unscoped = processing.processUnprocessed({ photoIds: ['a', 'b'] });
    await Bun.sleep(0);
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    expect(status.getScanStatus(OTHER).photos_processing).toBe(1);

    HeldWorker.finish('a', 'grid');
    HeldWorker.finish('a', 'grid');
    HeldWorker.finish('b', 'grid');
    await Bun.sleep(0);
    HeldWorker.finish('a', 'full');
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    HeldWorker.finish('a', 'full');
    expect(status.getScanStatus(LIB)).toMatchObject({ status: 'idle', photos_processing: 0 });
    HeldWorker.finish('b', 'full');
    await Promise.all([library, unscoped]);
    expect(status.getScanStatus(OTHER)).toMatchObject({ status: 'idle', photos_processing: 0 });
  });

  it('counts one-off rendering once per photo alongside batch work until every render settles', async () => {
    add('a');
    add('b', OTHER);
    const library = new LibrariesRepository(db).getById(LIB);
    if (library == null) throw new Error('library missing');
    const original = path.join(root, LIB, 'a.arw');
    const full = processing.renderOne(original, 'a', library, 'full', false);
    const max = processing.renderOne(original, 'a', library, 'max', false);
    const refused = max.then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    expect(status.getScanStatus(OTHER).photos_processing).toBe(0);

    const batch = processing.processUnprocessed({ libraryId: LIB, photoIds: ['a'] });
    await Bun.sleep(0);
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    HeldWorker.finish('a', 'full');
    await full;
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    HeldWorker.finish('a', 'max', false);
    expect(await refused).toBe('render failed');
    expect(status.getScanStatus(LIB).photos_processing).toBe(1);
    HeldWorker.finish('a', 'grid');
    await Bun.sleep(0);
    HeldWorker.finish('a', 'full');
    await batch;
    expect(status.getScanStatus(LIB).photos_processing).toBe(0);
    expect(activity.current(LIB)).toEqual([]);
  });

  it('keeps queued prepares visible until their success or failure settles', async () => {
    add('a');
    Reflect.set(globalThis, 'Worker', HeldPrepareWorker);
    const first = processing.preparePicture('a');
    const second = processing.preparePicture('a');
    const refused = second.then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(activity.current(LIB)).toEqual([{ kind: 'preparing', count: 1 }]);
    expect(activity.current(OTHER)).toEqual([]);
    expect(status.getScanStatus(LIB).photos_processing).toBe(0);
    await Bun.sleep(0);
    expect(HeldPrepareWorker.posted).toHaveLength(1);
    HeldPrepareWorker.posted[0]?.onmessage?.({ data: { ok: true, framed: new Uint8Array([1]) } });
    expect(await first).toEqual(new Uint8Array([1]));
    expect(activity.current(LIB)).toEqual([{ kind: 'preparing', count: 1 }]);
    await Bun.sleep(0);
    expect(HeldPrepareWorker.posted).toHaveLength(2);
    HeldPrepareWorker.posted[1]?.onmessage?.({ data: { ok: false, error: 'prepare failed' } });
    expect(await refused).toBe('prepare failed');
    expect(activity.current(LIB)).toEqual([]);
  });

  it('reports metadata reads separately and clears failed reads', async () => {
    add('a');
    const metadata = Promise.withResolvers<FileMetadata>();
    const renditions = new PhotoRenditionService(
      new PhotoPathsRepository(db, new StackMembership(db)),
      new PhotoListingRepository(db),
      new PhotoMetadataRepository(db, photos),
      photos,
      new LibrariesRepository(db),
      processing,
      localOriginals(),
      () => metadata.promise,
      null,
      activity,
    );
    const run = renditions.refreshMetadata(['a']);
    expect(activity.current(LIB)).toEqual([{ kind: 'refreshing_metadata', count: 1 }]);
    expect(status.getScanStatus(LIB).photos_processing).toBe(0);
    metadata.reject(new Error('header failed'));
    expect(await run).toBe(0);
    expect(activity.current(LIB)).toEqual([]);
  });

  it('reports stage measurements as device-wide work and clears successful measurements', async () => {
    const timing: RenderTiming = { total: 1, stages: {}, measured_at: '2026-01-01T00:00:00.000Z' };
    const measured = Promise.withResolvers<RenderTiming>();
    const benchmark = jest.spyOn(RenderBenchmark.prototype, 'run').mockImplementation(() => measured.promise);
    try {
      const run = processing.benchmarkRender('full', 'galosh', new RenderTimingsFile(path.join(root, 'timings.json')));
      expect(activity.current(null)).toEqual([{ kind: 'measuring', count: 1 }]);
      expect(activity.current(LIB)).toEqual([]);
      measured.resolve(timing);
      expect(await run).toEqual(timing);
      expect(activity.current(null)).toEqual([]);
    } finally {
      benchmark.mockRestore();
    }
  });
});
