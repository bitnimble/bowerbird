/** Stages closed opens left on the worker, each under its visit's key, for the next open to adopt. */
export class KeptStages<S> {
  private readonly kept = new Map<number, S>();
  /** Keys the page has let go of, so a close that lands after the drop does not keep a stage forever. */
  private readonly dropped = new Set<number>();
  private readonly waiting = new Map<number, ((stage: S | null) => void)[]>();
  private abandoned = false;

  constructor(private readonly free: (stage: S) => void) {}

  keep(key: number, stage: S): void {
    if (this.dropped.has(key)) {
      this.free(stage);
      return;
    }
    const next = this.waiting.get(key)?.shift();
    if (next != null) {
      next(stage);
      return;
    }
    const previous = this.kept.get(key);
    if (previous != null) this.free(previous);
    this.kept.set(key, stage);
  }

  /**
   * The stage kept under `key`, or the next one kept there: an open superseded mid-prepare still
   * holds it, and keeps it once its page closes it.
   */
  take(key: number): Promise<S | null> {
    const stage = this.kept.get(key);
    if (stage != null) {
      this.kept.delete(key);
      return Promise.resolve(stage);
    }
    if (this.abandoned || this.dropped.has(key)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiting = this.waiting.get(key) ?? [];
      waiting.push(resolve);
      this.waiting.set(key, waiting);
    });
  }

  /** Wakes every open waiting on a stage, with none: nothing will be kept again. */
  abandon(): void {
    this.abandoned = true;
    for (const waiting of this.waiting.values()) for (const resolve of waiting) resolve(null);
    this.waiting.clear();
  }

  drop(key: number): void {
    this.dropped.add(key);
    for (const resolve of this.waiting.get(key) ?? []) resolve(null);
    this.waiting.delete(key);
    const stage = this.kept.get(key);
    this.kept.delete(key);
    if (stage != null) this.free(stage);
  }
}
