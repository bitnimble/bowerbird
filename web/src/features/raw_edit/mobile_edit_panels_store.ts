import { observable } from 'mobx';
import type { IsolatedSlider } from '../../ui/slider_isolation';

export class MobileEditPanelsStore {
  @observable accessor selectedId: string | null = null;
  @observable accessor expanded = false;
  @observable.ref accessor activeSlider: IsolatedSlider | null = null;
}
