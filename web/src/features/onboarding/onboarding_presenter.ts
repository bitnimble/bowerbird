import { action } from 'mobx';
import type { OnboardingStore } from './onboarding_store';

type Precompile = (onCompiled: (compiled: number, of: number) => void) => Promise<unknown>;

const LONGEST_PRECOMPILE_WAIT_MS = 60_000;

export class OnboardingPresenter {
  private started = false;

  /** `precompile` is null where there is nothing to compile ahead: everywhere but the desktop app. */
  constructor(
    private readonly store: OnboardingStore,
    private readonly precompile: Precompile | null,
    private readonly longestWaitMs = LONGEST_PRECOMPILE_WAIT_MS,
  ) {
    if (precompile == null) this.markReady();
  }

  @action.bound
  preparePipelines(): void {
    if (this.started || this.precompile == null) return;
    this.started = true;
    let cap: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      this.precompile(this.compiled),
      new Promise((resolve) => {
        cap = setTimeout(resolve, this.longestWaitMs);
      }),
    ])
      // A compile that fails or stalls leaves the rest to compile in the background or on first use.
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(cap);
        this.markReady();
      });
  }

  @action.bound
  private compiled(compiled: number, of: number): void {
    this.store.pipelinesCompiled = compiled;
    this.store.pipelinesToCompile = of;
  }

  @action.bound
  private markReady(): void {
    this.store.pipelinesReady = true;
  }
}
