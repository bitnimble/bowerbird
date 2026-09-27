import { action } from 'mobx';
import type { ConfirmRequest, ConfirmStore } from './confirm_store';

export class ConfirmPresenter {
  private resolve: ((confirmed: boolean) => void) | null = null;

  constructor(private readonly store: ConfirmStore) {}

  /** In place of `window.confirm`, which the macOS shell's WKWebView answers with "Cancel" unasked. */
  @action.bound
  ask(request: ConfirmRequest): Promise<boolean> {
    this.answer(false);
    this.store.request = request;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  @action.bound
  answer(confirmed: boolean): void {
    this.resolve?.(confirmed);
    this.resolve = null;
    this.store.request = null;
  }
}
