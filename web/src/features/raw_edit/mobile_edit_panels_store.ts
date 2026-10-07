import { observable } from 'mobx';
import type { Isolated } from '../../ui/isolation';

export class MobileEditPanelsStore {
  @observable accessor selectedId: string | null = null;
  @observable accessor expanded = false;
  @observable.ref accessor isolated: Isolated | null = null;
}
