// Not in `photo_edits.ts`: that imports zod, which the page keeps out of its bundle.
import type { Denoiser } from './photo_edits';

const DEFAULT_SHARPENING = 50;
// `models/upscaler`'s `SHARPEN`, as a slider position.
const UPSCALER_DEFAULT_SHARPENING = 35;
// GALOSH leaves a softer frame than the upscaler, so at one position it reads as 25 less sharp.
const GALOSH_SHARPENING_LIFT = 25;

/** The sharpening slider's position, where a null document value is the denoiser's default. */
export function sharpeningOf(sharpening: number | null, denoiser: Denoiser): number {
  return sharpening ?? (denoiser === 'upscaler' ? UPSCALER_DEFAULT_SHARPENING : DEFAULT_SHARPENING);
}

/** The strength a render's sharpen takes, `Job.sharpen`, for the slider's position under this denoiser. */
export function sharpenOf(sharpening: number | null, denoiser: Denoiser): number {
  const position = sharpeningOf(sharpening, denoiser);
  // 0 is the Rendering tab's sharpen switched off, which must skip the stage.
  if (position === 0) return 0;
  const lift = denoiser === 'galosh' ? GALOSH_SHARPENING_LIFT : 0;
  return (position + lift) / 100;
}
