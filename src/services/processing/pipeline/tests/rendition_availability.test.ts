import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from '../../../../db/driver';
import { runMigrations } from '../../../../db/migrate';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { LibrariesRepository } from '../../../libraries/libraries_repository';
import { localOriginals } from '../../../blobs/originals_for_testing';
import { PhotoListingRepository } from '../../../photos/listing/photo_listing_repository';
import { PhotoMetadataRepository } from '../../../photos/metadata/photo_metadata_repository';
import { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { PhotoRenditionService } from '../../../photos/renditions/photo_rendition_service';
import { StackMembership } from '../../../stacks/stack_membership';
import type { RenditionVariant } from '../../renditions/renditions';
import { RenditionsRepository } from '../../renditions/renditions_repository';
import { ProcessingService } from '../processing_service';
import { CRASH, LIB, settings, usingMockWorker } from './processing_test_helpers';

const AT = '2026-01-01T00:00:00.000Z';

usingMockWorker();

describe('rendition availability after processing', () => {
  let db: Database;
  let root: string;
  let renditions: RenditionsRepository;
  let photos: PhotoProcessingRepository;
  let libraries: LibrariesRepository;
  let processing: ProcessingService;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    root = mkdtempSync(path.join(tmpdir(), 'bb-rendition-availability-'));
    db.query('INSERT INTO libraries (id, root_path, name, rendition_hdr) VALUES (?, ?, ?, 0)').run(
      LIB,
      root,
      LIB,
    );
    renditions = new RenditionsRepository(db);
    photos = new PhotoProcessingRepository(db, renditions);
    libraries = new LibrariesRepository(db);
    processing = new ProcessingService(
      photos,
      new PhotoPathsRepository(db, new StackMembership(db)),
      new PhotoListingRepository(db),
      settings,
    );
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });

  function add(photoId: string, sourcePresent = true): void {
    db.query(
      `INSERT INTO photos (id, library_id, recipe, width, height, date_added)
      VALUES (?, ?, json_object('kind', 'file', 'path', ?), 100, 100, ?)`,
    ).run(photoId, LIB, `${photoId}.arw`, AT);
    if (sourcePresent) writeFileSync(path.join(root, `${photoId}.arw`), 'RAW');
    renditions.unqueue(photoId, ['grid', 'full']);
  }

  function built(photoId: string, variants: readonly RenditionVariant[]): void {
    for (const variant of variants) {
      const file = path.join(dataPathForLibraryId(LIB), 'renditions', variant, `${photoId}.avif`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, 'picture');
      renditions.markBuilt(photoId, variant, AT, 'edits', { from: 'render', matched: true });
    }
  }

  function error(photoId: string): unknown {
    return db.query('SELECT processing_error FROM photos WHERE id = ?').get(photoId);
  }

  function onDemand(): PhotoRenditionService {
    return new PhotoRenditionService(
      new PhotoPathsRepository(db, new StackMembership(db)),
      new PhotoListingRepository(db),
      new PhotoMetadataRepository(db, photos),
      photos,
      libraries,
      processing,
      localOriginals(),
      undefined,
      null,
    );
  }

  it('forgets only the deleted viewer copy when an on-demand rebuild fails', async () => {
    add(CRASH);
    built(CRASH, ['grid', 'full']);
    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(1);

    await expect(onDemand().buildRendition(CRASH, 'full', true)).rejects.toThrow('segfault');

    expect(
      existsSync(path.join(dataPathForLibraryId(LIB), 'renditions', 'full', `${CRASH}.avif`)),
    ).toBe(false);
    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(0);
    expect(renditions.versions(CRASH)).toEqual({ grid: AT });
  });

  it('forgets a deleted composite copy when its frames cannot be composed', async () => {
    add('composite', false);
    const recipe = readFileSync(
      path.join(import.meta.dir, '../../../../../test/fixtures/assembly-recipe.json'),
      'utf8',
    );
    db.query("UPDATE photos SET recipe = json_set(?, '$.kind', 'assembly') WHERE id = ?").run(
      recipe,
      'composite',
    );
    built('composite', ['full']);
    const build = spyOn(processing, 'buildComposite').mockResolvedValue(false);
    try {
      await expect(onDemand().buildRendition('composite', 'full', true)).rejects.toThrow(
        'nothing on this device can compose',
      );

      expect(
        existsSync(path.join(dataPathForLibraryId(LIB), 'renditions', 'full', 'composite.avif')),
      ).toBe(false);
      expect(libraries.getById(LIB)?.rendered_photo_count).toBe(0);
      expect(renditions.versions('composite')).toEqual({});
    } finally {
      build.mockRestore();
    }
  });

  it('retains a real viewer copy when no original can start its forced rebuild', async () => {
    add('missing', false);
    built('missing', ['full']);

    await expect(onDemand().buildRendition('missing', 'full', true)).rejects.toThrow(
      'nothing on this device can build',
    );

    expect(
      existsSync(path.join(dataPathForLibraryId(LIB), 'renditions', 'full', 'missing.avif')),
    ).toBe(true);
    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(1);
    expect(renditions.versions('missing')).toEqual({ full: AT });
  });

  it('stops counting copies removed after a failed full rebuild', async () => {
    add(CRASH);
    built(CRASH, ['grid', 'full', 'full-hdr', 'max']);
    photos.queueRenditionRebuildForLibrary(LIB);
    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(1);

    await processing.processUnprocessed({ libraryId: LIB });

    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(0);
    expect(renditions.versions(CRASH)).toEqual({});
    expect(photos.countPendingProcessing(LIB)).toBe(0);
    expect(error(CRASH)).toEqual({ processing_error: 'worker crashed: segfault' });
  });

  it('preserves viewer copies when only a tile rebuild fails', async () => {
    add(CRASH);
    built(CRASH, ['grid', 'full', 'full-hdr', 'max']);
    photos.queueTileRebuild([CRASH]);

    await processing.processUnprocessed({ libraryId: LIB });

    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(1);
    expect(renditions.versions(CRASH)).toEqual({ full: AT, 'full-hdr': AT, max: AT });
    expect(photos.countPendingProcessing(LIB)).toBe(0);
    expect(
      existsSync(path.join(dataPathForLibraryId(LIB), 'renditions', 'full-hdr', `${CRASH}.avif`)),
    ).toBe(true);
  });

  it('forgets a failed target whose source vanished, while retaining retry work', async () => {
    add(CRASH, false);
    built(CRASH, ['grid']);
    photos.queueTileRebuild([CRASH]);

    await processing.processUnprocessed({ libraryId: LIB });

    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(0);
    expect(renditions.versions(CRASH)).toEqual({});
    expect(photos.countPendingProcessing(LIB)).toBe(1);
    expect(error(CRASH)).toEqual({ processing_error: null });
  });

  it('forgets stale variants swept after a successful rebuild', async () => {
    add('photo');
    built('photo', ['grid', 'full', 'full-hdr', 'max']);
    photos.queueBothPasses('photo');

    await processing.processUnprocessed({ libraryId: LIB });

    expect(libraries.getById(LIB)?.rendered_photo_count).toBe(1);
    expect(renditions.stamps('photo', 'grid').built_at).not.toBeNull();
    expect(renditions.stamps('photo', 'full').built_at).not.toBeNull();
    expect(renditions.stamps('photo', 'full-hdr')).toEqual({ built_at: null, built_from: null });
    expect(renditions.stamps('photo', 'max')).toEqual({ built_at: null, built_from: null });
    expect(photos.countPendingProcessing(LIB)).toBe(0);
  });
});
