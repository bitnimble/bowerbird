import { observable } from 'mobx';

export interface ConfirmRequest {
  title: string;
  body?: string;
  /** Names the action, as the heading does: "Delete", never "OK". */
  action: string;
  tone?: 'danger';
}

export class ConfirmStore {
  @observable.ref accessor request: ConfirmRequest | null = null;
}
