import { observable } from 'mobx';

export class EditTabsStore {
  @observable accessor selectedId: string | null = null;
  /** Panel groups shown by their heading alone. */
  @observable accessor collapsed: ReadonlySet<string> = new Set();
}
