import { action } from 'mobx';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { PrecompilePageStrings } from './precompile_page.strings';
import type { PrecompileStore } from './precompile_store';

type Precompile = (onCompiled: (compiled: number, of: number) => void) => Promise<unknown>;

export type Remembered = {
  read: () => string | null;
  write: (version: string) => void;
};

type Toasts = Pick<ToastsPresenter, 'showProgress' | 'progressed' | 'dismiss'>;

const LONGEST_PRECOMPILE_WAIT_MS = 60_000;

export class PrecompilePresenter {
  private started = false;
  private settled = false;
  private toast: number | null = null;

  constructor(
    private readonly store: PrecompileStore,
    private readonly precompile: Precompile,
    private readonly version: string,
    private readonly remembered: Remembered,
    private readonly toasts: Toasts,
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
      .catch(() => undefined)
      .finally(this.finished);
    let cap: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      compiling,
      new Promise((resolve) => {
        cap = setTimeout(resolve, this.longestWaitMs);
      }),
    ]).finally(() => {
      clearTimeout(cap);
      this.markReady();
      if (!this.settled)
        this.toast = this.toasts.showProgress(
          PrecompilePageStrings.precompiling(),
          this.fraction(),
        );
    });
  }

  @action.bound
  private compiled(compiled: number, of: number): void {
    this.store.compiled = compiled;
    this.store.toCompile = of;
    if (this.toast != null)
      this.toasts.progressed(this.toast, PrecompilePageStrings.precompiling(), this.fraction());
  }

  @action.bound
  private finished(): void {
    this.settled = true;
    if (this.toast != null) this.toasts.dismiss(this.toast);
    this.toast = null;
  }

  @action.bound
  private markReady(): void {
    this.store.ready = true;
  }

  private fraction(): number {
    return this.store.toCompile === 0 ? 0 : this.store.compiled / this.store.toCompile;
  }
}
