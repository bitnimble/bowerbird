import { action } from 'mobx';
import type { PrecompileStore } from './precompile_store';

type Precompile = (onCompiled: (compiled: number, of: number) => void) => Promise<unknown>;

export type Remembered = {
  read: () => string | null;
  write: (version: string) => void;
};

const LONGEST_PRECOMPILE_WAIT_MS = 60_000;

export class PrecompilePresenter {
  private started = false;

  constructor(
    private readonly store: PrecompileStore,
    private readonly precompile: Precompile,
    private readonly version: string,
    private readonly remembered: Remembered,
    private readonly longestWaitMs = LONGEST_PRECOMPILE_WAIT_MS,
  ) {
    if (remembered.read() === version) this.markReady();
  }

  @action.bound
  start(): void {
    if (this.started || this.store.ready) return;
    this.started = true;
    const compiling = this.precompile(this.compiled)
      .then(() => this.remembered.write(this.version))
      // Unremembered, so the next visit retries.
      .catch(() => undefined);
    let cap: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      compiling,
      new Promise((resolve) => {
        cap = setTimeout(resolve, this.longestWaitMs);
      }),
    ]).finally(() => {
      clearTimeout(cap);
      this.markReady();
    });
  }

  @action.bound
  private compiled(compiled: number, of: number): void {
    this.store.compiled = compiled;
    this.store.toCompile = of;
  }

  @action.bound
  private markReady(): void {
    this.store.ready = true;
  }
}
