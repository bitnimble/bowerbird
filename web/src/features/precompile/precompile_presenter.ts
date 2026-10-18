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

  private readonly longestWaitMs: number;
  private readonly warmStage: (() => Promise<unknown>) | null;

  /**
   * @param options.precompiles false where nothing should compile ahead of use (`onMobileDevice`),
   *   which then compiles only `warmStage`, the photo viewer's.
   */
  constructor(
    private readonly store: PrecompileStore,
    private readonly precompile: Precompile,
    private readonly version: string,
    private readonly remembered: Remembered,
    private readonly toasts: Toasts,
    {
      longestWaitMs = LONGEST_PRECOMPILE_WAIT_MS,
      precompiles = true,
      warmStage,
    }: {
      longestWaitMs?: number;
      precompiles?: boolean;
      warmStage?: () => Promise<unknown>;
    } = {},
  ) {
    this.longestWaitMs = longestWaitMs;
    this.warmStage = precompiles ? null : (warmStage ?? null);
    if (!precompiles || remembered.read() === version) this.markReady();
  }

  @action.bound
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.warmStage != null) {
      this.store.stageCompiling = true;
      void this.warmStage()
        .catch(() => undefined)
        .finally(this.stageWarmed);
    }
    if (this.store.ready) return;
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
  private stageWarmed(): void {
    this.store.stageCompiling = false;
  }

  @action.bound
  private markReady(): void {
    this.store.ready = true;
  }

  private fraction(): number {
    return this.store.toCompile === 0 ? 0 : this.store.compiled / this.store.toCompile;
  }
}
