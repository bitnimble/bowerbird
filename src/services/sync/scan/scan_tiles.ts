import { Logger } from '../../../logger';
import type { Library } from '../../../schemas/libraries';
import { dataPathForLibraryId, getDataPath, scannedTilePath } from '../../../utils/paths';
import type { TileStage } from '../../processing/analysis/metadata';
import type { ProcessingTrigger } from './scan_rebuilds';

const log = new Logger('scan');

/**
 * Every grid tile this run built, and the rows that turned out to own them.
 *
 * Held rather than renamed on the spot because the rename is file work and the inserts are a
 * transaction. A stop or throw still reaches `settle`, so no minted name waits for the orphan
 * sweep to reclaim it a week later (§10.4).
 */
export class ScanTiles {
  private readonly minted = new Set<string>();
  private readonly adoptable: { photoId: string; staged: string }[] = [];
  private readonly adopting: Promise<void>[] = [];

  constructor(
    private readonly libraryId: string,
    private readonly processing: ProcessingTrigger,
  ) {}

  /**
   * Where each file's grid tile goes while the scan has no photo id to name it with (§10.4).
   * Undefined where the processing trigger has nothing to say.
   */
  stageFor(library: Library): () => TileStage | undefined {
    const encoding = this.processing.tileEncoding?.();
    if (encoding == null) return () => undefined;
    const dataPath = getDataPath(library);
    return () => {
      const stage = { outputPath: scannedTilePath(dataPath), ...encoding };
      this.minted.add(stage.outputPath);
      return stage;
    };
  }

  claim(photoId: string, staged: string | undefined): void {
    if (staged != null) this.adoptable.push({ photoId, staged });
  }

  adopt(): void {
    const taken = this.adoptable.splice(0);
    if (taken.length === 0) return;
    for (const { staged } of taken) this.minted.delete(staged);
    // Claimed as each batch commits: a first scan can run for hours, and a tile left under a
    // minted name for all of that is indistinguishable from an orphan.
    this.adopting.push(
      (async () => {
        for (const { photoId, staged } of taken) {
          await this.processing.adoptScannedTile?.(photoId, dataPathForLibraryId(this.libraryId), staged);
        }
      })().catch((err: unknown) => {
        // Never fatal: the row keeps `needs_tile`, so the rendition pass builds the tile.
        log.warn('could not take on a tile the scan built', { library: this.libraryId, err });
      }),
    );
  }

  /**
   * Every tile this run built ends up on a photo or gone, however the run ended.
   *
   * `claim` is false for a run that threw or was stopped: rows it had not committed do not exist,
   * so their tiles are dropped rather than filed under ids nothing will ever read.
   */
  async settle(claim: boolean): Promise<void> {
    if (claim) this.adopt();
    await Promise.all(this.adopting.splice(0));
    for (const staged of this.minted) await this.processing.discardScannedTile?.(staged);
    this.minted.clear();
    this.adoptable.length = 0;
  }
}
