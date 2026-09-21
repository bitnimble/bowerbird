import { computed, observable } from 'mobx';
import { DEFAULT_PRINT_SCENE, type PrintScene } from './print_scene';

export type PrintTiltStatus = 'permission' | 'waiting' | 'active' | 'denied' | 'unavailable';

export class PrintStore {
  @observable accessor open = false;
  @observable.ref accessor scene: PrintScene = { ...DEFAULT_PRINT_SCENE };
  @observable accessor dragging = false;
  @observable accessor tiltStatus: PrintTiltStatus = 'unavailable';

  @computed get surface(): boolean { return this.scene.presentation === 'surface'; }
}
