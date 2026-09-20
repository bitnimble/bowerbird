import { observable } from 'mobx';

export interface Toast {
  id: number;
  message: string;
  // Present only when the action is reversible. The label names what pressing it
  // does, so the toast never says a bare "Undo" with no context.
  undoLabel?: string;
  undo?: () => Promise<void>;
  // Errors are red and stay until dismissed. `detail` carries the code and status
  // the message alone cannot: "Unexpected error" says nothing on its own.
  tone?: 'error';
  detail?: string;
  /**
   * How far through the work this toast is about, 0 to 1, for one that stays until it is done.
   *
   * A merge is minutes behind a single request, and a bar is the difference between waiting and
   * wondering whether anything is happening at all.
   */
  progress?: number;
}

export class ToastsStore {
  @observable.shallow accessor toasts: Toast[] = [];
}
