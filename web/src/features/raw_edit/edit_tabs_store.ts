import { observable } from 'mobx';

export class EditTabsStore {
  @observable accessor selectedId: string | null = null;
  @observable accessor collapsed: ReadonlySet<string> = new Set();
}
