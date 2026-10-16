import type { ProcessingWorkKind } from '../../../../src/schemas/libraries';

const WINDOW_MS = 10_000;

/** How fast each keyed count of remaining work is falling, per second. */
export class RemainingRates {
  private readonly samples = new Map<string, { at: number; remaining: number }[]>();

  /** Rates for the keys whose count fell across the window; a key absent from `counts` is done. */
  observe(counts: ReadonlyMap<string, number>, now: number): Map<string, number> {
    for (const key of this.samples.keys()) if (!counts.has(key)) this.samples.delete(key);
    const rates = new Map<string, number>();
    for (const [key, remaining] of counts) {
      const previous = this.samples.get(key) ?? [];
      const last = previous.at(-1);
      // More work queued is a new run to measure, not negative progress.
      const kept =
        last != null && remaining > last.remaining
          ? []
          : previous.filter((sample) => now - sample.at <= WINDOW_MS);
      kept.push({ at: now, remaining });
      this.samples.set(key, kept);
      const oldest = kept[0];
      if (oldest == null) continue;
      const fell = oldest.remaining - remaining;
      const seconds = (now - oldest.at) / 1000;
      if (fell > 0 && seconds > 0) rates.set(key, fell / seconds);
    }
    return rates;
  }
}

export function rateKey(libraryId: string | null, kind: string): string {
  return `${libraryId ?? ''}/${kind}`;
}

/** A processing queue's kind, kept apart from the activity of the same name. */
export function queueKind(kind: ProcessingWorkKind): string {
  return `queue:${kind}`;
}
