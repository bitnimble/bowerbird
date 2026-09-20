import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PhotoListingRepository } from '../../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { ProcessingService } from '../processing_service';
import { DESCRIPTOR, LIB, MockWorker, REAL_WORKER, posted, settingsWith } from './processing_test_helpers';

describe('single-photo rendering', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bb-proc-'));
    posted.length = 0;
    (globalThis as { Worker?: unknown }).Worker = MockWorker;
  });
  afterEach(() => {
    globalThis.Worker = REAL_WORKER;
    rmSync(root, { recursive: true, force: true });
    rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true });
  });



  it('hands over the descriptor from a tile repaired on demand, not just a queued one', async () => {
    // The repair path builds a grid tile outside the queue (§18.6), so it computes a
    // descriptor exactly as an import does. Dropping it leaves a photo whose tile has
    // been rebuilt permanently unstackable: nothing revisits a tile that is on disk, so
    // there is no second chance at it.
    const repo = { markTileBuilt: jest.fn(), markRenditionsBuilt: jest.fn() } as unknown as PhotoProcessingRepository;
    const service = makeService(repo);
    const seen: { photoId: string; descriptor: Uint8Array }[] = [];
    service.onDescribed((photoId, descriptor) => seen.push({ photoId, descriptor }));

    const library = { id: 'lib', root_path: root } as never;
    await service.renderOne('/lib/a.arw', 'p1', library, 'grid', false, 'embedded');

    expect(seen).toEqual([{ photoId: 'p1', descriptor: DESCRIPTOR }]);

    // A viewer rendition produces none, so this is not just "forward whatever came
    // back" - it is the tile that carries one.
    seen.length = 0;
    await service.renderOne('/lib/a.arw', 'p1', library, 'full', false);
    expect(seen).toEqual([]);
  });


  it('moves the stamp belonging to what a one-off job actually wrote', async () => {
    // The queue splits a photo into a tile job and a renditions job, so which stamp to
    // move is never in question there. A one-off job carries its own targets, and
    // deriving the stage from them wrongly is silent: a tile that lands with
    // `tile_built_at` unset is never revisited, because it is now on disk.
    const markTileBuilt = jest.fn();
    const markRenditionsBuilt = jest.fn();
    const markCopyBuilt = jest.fn();
    const repo = { markTileBuilt, markRenditionsBuilt, markCopyBuilt } as unknown as PhotoProcessingRepository;
    const service = makeService(repo);
    const library = { id: 'lib', root_path: root, data_path: null } as never;
    const announced: { stage: string; version: string }[] = [];
    service.onProcessed((_photoId, each) => announced.push(each));

    await service.renderOne('/lib/a.arw', 'p1', library, 'grid', false, 'embedded');
    expect(markTileBuilt).toHaveBeenCalledTimes(1);
    expect(markRenditionsBuilt).not.toHaveBeenCalled();
    expect(announced.map((each) => each.stage)).toEqual(['tile']);

    markTileBuilt.mockClear();
    announced.length = 0;
    await service.renderOne('/lib/a.arw', 'p1', library, 'full', false);
    expect(markRenditionsBuilt).toHaveBeenCalledTimes(1);
    expect(markTileBuilt).not.toHaveBeenCalled();
    expect(announced.map((each) => each.stage)).toEqual(['renditions']);

    // **A max export moves the version and stamps its own variant.** The announcement
    // moves it in the row a client is already holding; the column is what a client that
    // re-reads the row afterwards gets, and left behind it names a file older than the one
    // on disk - which the page then never asks for, holding its decoded frames by URL.
    //
    // `markRenditionsBuilt` is the wrong half: a max build claiming the stage would retire
    // a pending edit's rebuild with `full` and the grid tile never built, and
    // `rendition_source` on an `embedded` library would claim the viewer is served a render
    // while it is handed the camera's JPEG.
    markRenditionsBuilt.mockClear();
    announced.length = 0;
    await service.renderOne('/lib/a.arw', 'p1', library, 'max', false);
    expect(markRenditionsBuilt).not.toHaveBeenCalled();
    expect(markTileBuilt).not.toHaveBeenCalled();
    expect(markCopyBuilt).toHaveBeenCalledTimes(1);
    // Its own variant and no other: `full` is a different file this build did not write.
    expect(markCopyBuilt.mock.calls[0]?.[3]).toBe('max');
    expect(announced.map((each) => each.stage)).toEqual(['renditions']);
    // The same value both ways, or a client that re-reads the row lands on a URL it has
    // already decoded under.
    expect(markCopyBuilt.mock.calls[0]?.[1]).toBe(announced[0]!.version);
  });


  it('refuses an HDR grid tile rather than quietly building an SDR one', async () => {
    // `hdr` is the caller's, unlike the chroma setting above, so a caller that asks
    // for something that cannot exist is told. Coercing instead put the mistake
    // somewhere nobody would ever read it, and the mistake is not harmless:
    // `renditionVariant` gives no HDR grid path, so an honoured request would encode HDR
    // and file it as SDR - a tile that decodes wrong rather than one that is large.
    //
    // Rejecting is only half the claim; the test above is the other half, building a
    // grid target and asserting on it, so this cannot pass by refusing everything.
    // It rejects rather than throwing, which is also load-bearing: the tile repair
    // calls this fire-and-forget and clears its in-flight set in a `.finally()`.
    const service = makeService({} as unknown as PhotoProcessingRepository);
    const library = { id: 'lib', root_path: '/lib' } as never;

    await expect(service.renderOne('/lib/a.arw', 'p1', library, 'grid', true, 'embedded')).rejects.toThrow(
      /grid tile is always SDR/,
    );
  });
});
function makeService(photoProcessing: PhotoProcessingRepository): ProcessingService {
  return new ProcessingService(
    photoProcessing,
    {} as unknown as PhotoPathsRepository,
    {} as unknown as PhotoListingRepository,
    settingsWith({}),
  );
}
