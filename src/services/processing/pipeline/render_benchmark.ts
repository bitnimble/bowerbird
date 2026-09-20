import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../../errors';
import { deleteScratchDirectory } from '../../../utils/deletions';
import type { Library } from '../../../schemas/libraries';
import {
  OPTIONAL_STAGES,
  type OptionalStage,
  type RenderTiming,
  type RenderedRendition,
} from '../../../schemas/render_stages';
import { originalPathOf } from '../../../utils/paths';
import type { PhotoPathsRepository } from '../../photos/paths/photo_paths_repository';
import type { RenderTimingsRepository } from '../renditions/render_timings_repository';
import { openCompositeWorker } from '../workers/composite_worker';
import type { SinglePhotoRenderer } from './single_photo_renderer';

/**
 * Rounds per configuration, the fastest kept.
 *
 * Not 1: a single round on a busy machine priced the denoise and the defringe at zero, having read
 * 17ms and 64ms on the same frame minutes earlier.
 */
const ROUNDS = 3;

/**
 * What each optional stage costs on this machine, as the difference two renders of one of this
 * library's photographs make (§10.1).
 *
 * Tens of seconds on a `full` and minutes on a `max`: the caller is a button somebody pressed.
 */
export class RenderBenchmark {
  constructor(
    private readonly photoPaths: PhotoPathsRepository,
    private readonly renderer: SinglePhotoRenderer,
  ) {}

  /**
   * `into` is a parameter rather than a field because the renderers are built without a database
   * handle: what owns one is the caller, and a benchmark is the only thing here that files a row.
   */
  async run(library: Library, rendition: RenderedRendition, into: RenderTimingsRepository): Promise<RenderTiming> {
    const photo = this.photoPaths.firstFileIn(library.id);
    if (photo == null) throw new AppError('NOT_FOUND', `${library.name} has no photograph to time a render against`);
    const raw = originalPathOf(library, photo);
    if (raw == null || !existsSync(raw)) {
      throw new AppError('NOT_FOUND', `the file behind ${photo.id} is not on this device`);
    }

    // Everything the rounds write goes in here and leaves with it: the renditions, and the analysis
    // each cold round measures. Nothing under the library is touched.
    const scratch = await mkdtemp(join(tmpdir(), 'bowerbird-benchmark-'));
    // One worker for every round, so the half second spent acquiring an adapter and compiling the
    // shader modules is paid once rather than folded into each difference.
    const on = openCompositeWorker();
    try {
      const time = async (skip: readonly OptionalStage[]): Promise<number> => {
        const began = performance.now();
        await on.run(this.renderer.benchmarkJob(raw, photo.id, library, rendition, scratch, skip));
        return performance.now() - began;
      };

      // Discarded: the first render on a fresh device builds every pipeline and allocates the
      // working textures, which is a one-off nothing after it pays.
      await time([]);

      // Every configuration once per round rather than every round of one configuration together,
      // so a machine that gets busy halfway through slows all six alike instead of biasing
      // whichever stage happened to be under measurement at the time.
      const fastest = new Map<OptionalStage | 'total', number>();
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const stage of [undefined, ...OPTIONAL_STAGES] as const) {
          const at = stage ?? 'total';
          const took = await time(stage == null ? [] : [stage]);
          fastest.set(at, Math.min(fastest.get(at) ?? Infinity, took));
        }
      }

      const total = fastest.get('total') ?? 0;
      const stages: RenderTiming['stages'] = {};
      for (const stage of OPTIONAL_STAGES) {
        // Floored at zero: a stage that cost less than the spread across rounds can come out
        // negative, and a row reading "-3 ms" is worse than one reading nothing.
        stages[stage] = Math.max(0, Math.round(total - (fastest.get(stage) ?? total)));
      }
      const timing: RenderTiming = { total: Math.round(total), stages, measured_at: new Date().toISOString() };
      into.put(library.id, rendition, timing);
      return timing;
    } finally {
      on.close();
      await deleteScratchDirectory(scratch);
    }
  }
}
