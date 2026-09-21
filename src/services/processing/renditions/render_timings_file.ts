import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../../config';
import {
  RenderTimingsSchema,
  type RenderTiming,
  type RenderTimings,
  type RenderedRendition,
} from '../../../schemas/render_stages';

/**
 * What a render was measured to cost on this machine, stage by stage (§10.1).
 *
 * One file for the whole app, beside the generated files rather than in the catalogue: it
 * describes this machine's hardware, so it is neither a library's property nor anything a peer
 * would want replicated.
 */
export class RenderTimingsFile {
  constructor(private readonly file = path.join(config.dataDir, 'render_timings.json')) {}

  /**
   * A file this build cannot parse reads as nothing measured: what it holds is an estimate shown
   * in place of a measurement, and that must not be the reason a settings page will not open.
   */
  read(): RenderTimings {
    try {
      const parsed = RenderTimingsSchema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  put(rendition: RenderedRendition, timing: RenderTiming): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Merged with what is on disk now rather than with anything read earlier: a benchmark takes
    // minutes, and the other rendition's may have landed while this one ran.
    writeFileSync(this.file, JSON.stringify({ ...this.read(), [rendition]: timing }, null, 2));
  }
}
