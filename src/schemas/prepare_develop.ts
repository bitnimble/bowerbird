// The edit settings a server prepare runs below the coding, without zod, which the page keeps out of
// its bundle. `photo_edits.ts` holds what each one may be.
import type { EditDoc } from './photo_edits';

/**
 * What a picture prepared on the server is a function of that its client cannot apply itself: the
 * denoise, the sharpen and the dust removal all run before the samples cross. A client previewing
 * one names all of them on every prepare it asks for, since the stored document is the last save.
 */
export type PrepareDevelop = Pick<
  EditDoc,
  | 'luminanceNoise'
  | 'colourNoise'
  | 'denoiser'
  | 'sharpening'
  | 'dustRemoval'
  | 'dustSensitivity'
  | 'dustIntensity'
>;
