import { deviceMemoryGb } from '../../../app/device';

export interface WarmBudget {
  neighbours: number;
  /** The open photo's other decoded renditions, which make switching back to one instant. */
  otherRenditions: boolean;
  /** Fitted frames at the screen's size rather than 4096, so any zoom past fit decodes in full. */
  fittedToScreen: boolean;
}

export function warmBudget(memoryGb: number | undefined): WarmBudget {
  // `navigator.deviceMemory`: Chromium caps it at 8, other browsers leave it unset.
  if (memoryGb == null || memoryGb >= 8) {
    return { neighbours: Infinity, otherRenditions: true, fittedToScreen: false };
  }
  if (memoryGb >= 4) return { neighbours: 2, otherRenditions: true, fittedToScreen: true };
  return { neighbours: memoryGb >= 2 ? 1 : 0, otherRenditions: false, fittedToScreen: true };
}

export const WARM = warmBudget(deviceMemoryGb());

/** How readily a photo `offset` from the open one is stepped to next: lower is sooner. */
export function stepNearness(offset: number, travel: 'next' | 'prev' | null): number {
  const away = travel === 'prev' ? -offset : offset;
  return away > 0 ? away : -away + 0.5;
}

/** `run` down to the open photo and the `neighbours` it is likeliest to step to, in run order. */
export function warmedRun(
  run: readonly string[],
  photoId: string,
  travel: 'next' | 'prev' | null,
  neighbours: number,
): string[] {
  const at = run.indexOf(photoId);
  if (at < 0) return [photoId];
  const warmed = new Set(
    run
      .map((_, index) => index)
      .filter((index) => index !== at)
      .sort((a, b) => stepNearness(a - at, travel) - stepNearness(b - at, travel))
      .slice(0, neighbours),
  );
  return run.filter((_, index) => index === at || warmed.has(index));
}
