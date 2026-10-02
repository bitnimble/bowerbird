import { stat } from 'node:fs/promises';
import { Logger } from '../../logger';
import { deleteGeneratedFile } from '../../utils/deletions';
import { dataPathForLibraryId, renditionVariantPath } from '../../utils/paths';
import { LibraryActivity } from '../activity/library_activity';
import type { RenditionCache } from '../blobs/rendition_cache';
import { variantParts } from '../processing/renditions/renditions';
import type {
  EvictableCopy,
  RenditionsRepository,
} from '../processing/renditions/renditions_repository';
import type { StorageUsageService } from './storage_usage_service';

const log = new Logger('disk-space');

const GIB = 1024 ** 3;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const EVICTION_BATCH = 64;

const keyOf = (copy: EvictableCopy): string => `${copy.photo_id}:${copy.variant}`;

export class DiskSpaceLimit {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private limitGb = 0;

  constructor(
    private readonly renditions: RenditionsRepository,
    private readonly fetched: RenditionCache,
    private readonly usage: StorageUsageService,
    private readonly activity = new LibraryActivity(),
  ) {}

  /** Applies a changed limit (§15) without a restart, and holds to it at once. */
  configure(limitGb: number): void {
    if (limitGb === this.limitGb && this.timer != null) return;
    this.limitGb = limitGb;
    this.timer ??= setInterval(() => void this.fire(), CHECK_EVERY_MS);
    void this.fire();
  }

  stop(): void {
    if (this.timer == null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Evicts renditions until Bowerbird's data is under `limitBytes`, and returns the bytes freed. */
  async enforce(limitBytes: number): Promise<number> {
    const over = (await this.usage.measure()).bytes - limitBytes;
    if (over <= 0) return 0;
    const { freed, evicted } = await this.activity.track(null, 'pruning', 'renditions', () =>
      this.evictUntilFreed(over),
    );
    const fields = { evicted, freedBytes: freed, overBytes: over };
    if (freed < over) log.warn('still over the disk space limit with no renditions left', fields);
    else log.info('evicted renditions to stay under the disk space limit', fields);
    return freed;
  }

  private async evictUntilFreed(over: number): Promise<{ freed: number; evicted: number }> {
    let freed = 0;
    let evicted = 0;
    const failed = new Set<string>();
    while (freed < over) {
      const batch = this.renditions
        .leastRecentlyUsed(EVICTION_BATCH + failed.size)
        .filter((copy) => !failed.has(keyOf(copy)));
      if (batch.length === 0) break;
      for (const copy of batch) {
        if (freed >= over) break;
        const bytes = await this.evict(copy);
        if (bytes == null) {
          failed.add(keyOf(copy));
          continue;
        }
        freed += bytes;
        evicted++;
      }
    }
    return { freed, evicted };
  }

  /** The bytes freed, or null where the file would not go. */
  private async evict(copy: EvictableCopy): Promise<number | null> {
    const { photo_id, variant, library_id } = copy;
    const dataPath = dataPathForLibraryId(library_id);
    const file = renditionVariantPath(dataPath, photo_id, variant);
    const bytes = (await stat(file).catch(() => null))?.size ?? 0;
    try {
      await deleteGeneratedFile(dataPath, file);
    } catch (err) {
      log.warn('could not evict a rendition', { file, err });
      return null;
    }
    this.renditions.markEvicted(copy);
    const { rendition, hdr } = variantParts(variant);
    this.fetched.release(library_id, photo_id, rendition, hdr);
    return bytes;
  }

  private async fire(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let enforced: number;
      do {
        enforced = this.limitGb;
        await this.enforce(enforced * GIB);
      } while (enforced !== this.limitGb);
    } catch (err) {
      log.error('could not hold to the disk space limit', { err });
    } finally {
      this.running = false;
    }
  }
}
