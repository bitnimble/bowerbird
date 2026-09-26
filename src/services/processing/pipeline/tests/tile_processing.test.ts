import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PhotoListingRepository } from '../../../photos/listing/photo_listing_repository';
import type { PhotoPathsRepository } from '../../../photos/paths/photo_paths_repository';
import type { PhotoProcessingRepository } from '../../../photos/renditions/photo_processing_repository';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { encoderQuality } from '../../analysis/quality';
import { ProcessingService } from '../processing_service';
import { LIB, MockWorker, REAL_WORKER, posted, settings, settingsWith } from './processing_test_helpers';

function makeService(
  photoProcessing: PhotoProcessingRepository,
  currentSettings: ConstructorParameters<typeof ProcessingService>[3],
): ProcessingService {
  return new ProcessingService(
    photoProcessing,
    {} as unknown as PhotoPathsRepository,
    {} as unknown as PhotoListingRepository,
    currentSettings,
  );
}

describe('scan-built tiles', () => {
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

  const renditions = (dir: string): string => path.join(dataPathForLibraryId(LIB), 'renditions', dir);



  it('takes on a tile the scan built, recording it exactly as a tile it had built itself', async () => {
    // The rename is the whole of adopting one, and what has to come with it is the bookkeeping:
    // a tile on disk whose row still says `needs_tile` is a tile nothing serves, and a client
    // versions its URL off the stamp, so a stamp that never moved is a grid that never fills.
    const markTileBuilt = jest.fn();
    const service = makeService(
      { markTileBuilt, markRenditionsBuilt: jest.fn() } as unknown as PhotoProcessingRepository,
      settings,
    );
    const described: Uint8Array[] = [];
    service.onDescribed((_id, descriptor) => described.push(descriptor));

    const dataPath = dataPathForLibraryId(LIB);
    const staged = path.join(dataPath, 'renditions', 'grid', 'scanned-name.avif');
    mkdirSync(path.dirname(staged), { recursive: true });
    writeFileSync(staged, 'tile-bytes');
    writeFileSync(`${staged}.descriptor`, new Uint8Array([4, 5, 6]));

    expect(await service.adoptScannedTile('a', dataPath, staged)).toBe(true);

    expect(await Bun.file(path.join(renditions('grid'), 'a.avif')).text()).toBe('tile-bytes');
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${staged}.descriptor`)).toBe(false);
    expect(markTileBuilt.mock.calls.map((c) => c[0])).toEqual(['a']);
    // The stacking descriptor is the tile pass's own answer either way, so a photo adopted from
    // the scan is as stackable as one built here.
    expect([...(described[0] ?? [])]).toEqual([4, 5, 6]);
  });


  it('leaves the photo owing a tile when there was nothing to take on', async () => {
    // Every reason there might be nothing - a body that embeds no JPEG, a scan that failed, a
    // run killed before it got here - has the same answer: the flag stays set and the rendition
    // pass builds the tile the way it always did.
    const markTileBuilt = jest.fn();
    const service = makeService({ markTileBuilt } as unknown as PhotoProcessingRepository, settings);
    const dataPath = dataPathForLibraryId(LIB);

    const adopted = await service.adoptScannedTile('a', dataPath, path.join(dataPath, 'renditions', 'grid', 'never-written.avif'));

    expect(adopted).toBe(false);
    expect(markTileBuilt).not.toHaveBeenCalled();
  });


  it('encodes a scan-built tile with the settings a tile pass would have used', async () => {
    // One answer for "what is a grid tile", wherever it is built. A scan reading its own
    // idea of the size or the quality would fill a library with tiles that no setting
    // explains and that no rebuild reproduces.
    const service = makeService(
      {} as PhotoProcessingRepository,
      settingsWith({ grid_rendition_size: 640, grid_rendition_quality: 70, avif_speed: 7 }),
    );
    expect(service.tileEncoding()).toEqual({ size: 640, quantizer: encoderQuality('avif-sdr', 70), speed: 7 });
  });
});
