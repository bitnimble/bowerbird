import { observable } from 'mobx';

export class EditTabsStore {
  @observable accessor selectedId: string | null = null;
}
