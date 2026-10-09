// Not in `photo_edits.ts`: that imports zod, which the page keeps out of its bundle.
import type { Denoiser } from './photo_edits';

const DEFAULT_SHARPENING = 50;
// `models/upscaler`'s `SHARPEN`, as a slider position.
const UPSCALER_DEFAULT_SHARPENING = 35;

/** The sharpening slider's position, where a null document value is the denoiser's default. */
export function sharpeningOf(sharpening: number | null, denoiser: Denoiser): number {
  return sharpening ?? (denoiser === 'upscaler' ? UPSCALER_DEFAULT_SHARPENING : DEFAULT_SHARPENING);
}
