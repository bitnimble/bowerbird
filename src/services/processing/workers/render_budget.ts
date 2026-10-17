import { totalmem } from 'node:os';

const RENDER_PEAK_BYTES = 2 * 1024 ** 3;

/** How many renders run at once on this machine, shared by the queue and on-demand renders. */
export class RenderBudget {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly freed = new Set<() => void>();

  constructor(readonly slots: number) {}

  static forThisMachine(): RenderBudget {
    return new RenderBudget(Math.max(1, Math.floor(totalmem() / RENDER_PEAK_BYTES)));
  }

  /** False while on-demand renders wait: those take a freed slot ahead of the queue. */
  hasRoom(): boolean {
    return this.running < this.slots;
  }

  /** Only straight after `hasRoom`. */
  claim(): void {
    this.running++;
  }

  /** A slot for an on-demand render. Waiting ones start newest first: the latest asked is on screen. */
  async take(): Promise<void> {
    if (this.hasRoom()) return this.claim();
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  give(): void {
    const newest = this.waiting.pop();
    if (newest != null) return newest();
    this.running--;
    for (const listener of this.freed) listener();
  }

  onFreed(listener: () => void): void {
    this.freed.add(listener);
  }
}
