import type { Library } from '../../../schemas/libraries';
import { cameraMatchWithStages, normaliseStages, type CameraMatch, type OptionalStage } from '../../../schemas/render_stages';
import type { Developed } from '../workers/processing_types';
import type { Rendition } from './renditions';

/**
 * What this library leaves out of that rendition.
 *
 * Nothing for the grid tile and nothing for the composited camera view: neither is a render this
 * setting covers (`RENDERED_RENDITIONS`), and the grid tile a rendition pass writes is cut from the
 * `full` job's own frame, so it carries whatever that job was built with.
 */
export function renditionSkips(library: Library, rendition: Rendition): readonly OptionalStage[] {
  if (rendition === 'full') return library.render_skip_full;
  if (rendition === 'max') return library.render_skip_max;
  return [];
}

/**
 * The stages a library has turned off, as the column holds them.
 *
 * A name this build does not know is dropped rather than refused: the column is written by
 * whichever version of the app the reader last used, and a rendition that will not build because
 * a stage was renamed is a photograph that never opens.
 */
export function readStages(stored: string): OptionalStage[] {
  return normaliseStages(stored.split(','));
}

/** In the order `OPTIONAL_STAGES` names them, so two equal sets are one string. */
export function writeStages(stages: readonly OptionalStage[]): string {
  return normaliseStages(stages).join(',');
}

/**
 * The same job with those stages left out, overriding the photograph's own document: a frame
 * somebody sharpened renders unsharpened into a library that has traded the sharpen away (§10.1).
 */
export function withStagesOff<T extends Developed & { cameraMatch: CameraMatch }>(
  job: T,
  skip: readonly OptionalStage[],
): Omit<T, 'cameraMatch'> & { cameraMatch: CameraMatch } {
  return {
    ...job,
    ...turnedDown(job, skip),
    cameraMatch: cameraMatchWithStages(job.cameraMatch, skip),
  };
}

type TurnedDown = Partial<Pick<Developed, 'denoiseLuminance' | 'denoiseColour' | 'dust' | 'sharpen' | 'defringe'>>;

function turnedDown(job: Developed, skip: readonly OptionalStage[]): TurnedDown {
  const off: TurnedDown = {};
  for (const stage of skip) {
    switch (stage) {
      case 'dust':
        off.dust = { ...job.dust, enabled: false };
        break;
      case 'denoise':
        off.denoiseLuminance = 0;
        off.denoiseColour = 0;
        break;
      case 'lens':
      case 'colour':
        break;
      case 'defringe':
        off.defringe = 0;
        break;
      case 'sharpen':
        off.sharpen = 0;
        break;
    }
  }
  return off;
}
