import { observable } from 'mobx';

export interface Toast {
  id: number;
  message: string;
  // Present only when the action is reversible. The label names what pressing it
  // does, so the toast never says a bare "Undo" with no context.
  undoLabel?: string;
  undo?: () => Promise<void>;
}

export class ToastsStore {
  @observable.shallow accessor toasts: Toast[] = [];
}
