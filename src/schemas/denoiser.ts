// Not in `photo_edits.ts`: that imports zod, which the page keeps out of its bundle.
import type { Denoiser } from './photo_edits';

/** The denoiser that runs: the upscaler takes only a Bayer mosaic, and GALOSH denoises the rest. */
export function denoiserFor(requested: Denoiser, upscalable: boolean): Denoiser {
  return requested === 'upscaler' && !upscalable ? 'galosh' : requested;
}
