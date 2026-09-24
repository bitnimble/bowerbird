import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteScratchDirectory } from '../../../utils/deletions';
import { newId } from '../../../schemas/id';
import {
  OPTIONAL_STAGES,
  scaledToReference,
  type OptionalStage,
  type RenderTiming,
  type RenderedRendition,
} from '../../../schemas/render_stages';
import type { RenderTimingsFile } from '../renditions/render_timings_file';
import { fetchReferenceFrame, REFERENCE_FRAME } from '../renditions/reference_frame';
import { readRawHeader } from '../rawshim/raw_decoder';
import { openCompositeWorker } from '../workers/composite_worker';
import type { SinglePhotoRenderer } from './single_photo_renderer';

/**
 * Rounds per configuration, the fastest kept.
 *
 * Not 1: a single round on a busy machine priced the denoise and the defringe at zero, having read
 * 17ms and 64ms on the same frame minutes earlier.
 */
const ROUNDS = 3;

const REFERENCE_FRAME_PATH = process.env.BOWERBIRD_REFERENCE_FRAME ?? REFERENCE_FRAME.path;

/**
 * What each optional stage costs on this machine, as the difference two renders of one photograph
 * make, scaled to a full-frame sensor (§10.1).
 *
 * Tens of seconds on a `full` and minutes on a `max`: the caller is a button somebody pressed.
 */
export class RenderBenchmark {
  private fetching: Promise<void> | null = null;

  constructor(
    private readonly renderer: SinglePhotoRenderer,
    private readonly frame: string = REFERENCE_FRAME_PATH,
  ) {}

  /**
   * `into` is a parameter rather than a field because the renderers are built without one: what
   * owns the file is the caller, and a benchmark is the only thing here that writes it.
   */
  async run(rendition: RenderedRendition, into: RenderTimingsFile): Promise<RenderTiming> {
    // Shared, so a second rendition's Measure does not write the same file while the first reads it.
    this.fetching ??= fetchReferenceFrame(this.frame).finally(() => (this.fetching = null));
    await this.fetching;
    const header = readRawHeader(this.frame);
    const benchmarkPhotoId = newId();

    const scratch = await mkdtemp(join(tmpdir(), 'bowerbird-benchmark-'));
    // One worker for every round, so the half second spent acquiring an adapter and compiling the
    // shader modules is paid once rather than folded into each difference.
    const on = openCompositeWorker();
    try {
      const time = async (skip: readonly OptionalStage[]): Promise<number> => {
        const began = performance.now();
        await on.run(
          this.renderer.benchmarkJob({
            rawFilePath: this.frame,
            photoId: benchmarkPhotoId,
            rendition,
            dataPath: scratch,
            skip,
          }),
        );
        return performance.now() - began;
      };

      // Discarded: the first render on a fresh device builds every pipeline and allocates the
      // working textures, which is a one-off nothing after it pays.
      await time([]);

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
        const baseline = stage === 'lens' ? fastest.get('colour') ?? total : total;
        stages[stage] = Math.max(0, baseline - (fastest.get(stage) ?? baseline));
      }
      const timing = scaledToReference(
        { total, stages, measured_at: new Date().toISOString() },
        header.width * header.height,
      );
      into.put(rendition, timing);
      return timing;
    } finally {
      on.close();
      await deleteScratchDirectory(scratch);
    }
  }
}
