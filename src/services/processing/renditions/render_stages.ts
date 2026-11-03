import { normaliseStages, type OptionalStage } from '../../../schemas/render_stages';

/**
 * The stages a library has turned off, as the column holds them.
 *
 * A name this build does not know is dropped rather than refused: the column is written by
 * whichever version of the app the reader last used, and an import that fails because a stage was
 * renamed is a scan that never finishes.
 */
export function readStages(stored: string): OptionalStage[] {
  return normaliseStages(stored.split(','));
}

/** In the order `OPTIONAL_STAGES` names them, so two equal sets are one string. */
export function writeStages(stages: readonly OptionalStage[]): string {
  return normaliseStages(stages).join(',');
}
