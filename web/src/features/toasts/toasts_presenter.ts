import { action, runInAction } from 'mobx';
import type { Toast, ToastsStore } from './toasts_store';

// How long an undoable action stays undoable. Long enough to notice the toast
// and react, short enough that it doesn't pile up on screen.
const UNDO_MS = 12_000;
const PLAIN_MS = 5_000;

export class ToastsPresenter {
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private readonly store: ToastsStore) {}

  @action.bound
  show(message: string): void {
    this.push({ id: this.nextId++, message }, PLAIN_MS);
  }

  @action.bound
  showUndoable(message: string, undoLabel: string, undo: () => Promise<void>): void {
    this.push({ id: this.nextId++, message, undoLabel, undo }, UNDO_MS);
  }

  async runUndo(id: number): Promise<void> {
    const toast = this.store.toasts.find((t) => t.id === id);
    if (toast?.undo == null) return;
    // Dismiss first: the action is committed either way, and leaving the button
    // live would let a second click double-apply the undo.
    this.dismiss(id);
    try {
      await toast.undo();
    } catch (err) {
      this.show((err as Error).message);
    }
  }

  @action.bound
  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer != null) clearTimeout(timer);
    this.timers.delete(id);
    this.store.toasts = this.store.toasts.filter((t) => t.id !== id);
  }

  @action.bound
  private push(toast: Toast, ms: number): void {
    this.store.toasts = [...this.store.toasts, toast];
    this.timers.set(
      toast.id,
      setTimeout(() => runInAction(() => this.dismiss(toast.id)), ms),
    );
  }
}
