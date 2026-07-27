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
}

export class ToastsStore {
  @observable.shallow accessor toasts: Toast[] = [];
}
