import { computed, observable } from 'mobx';
import { DEFAULT_PRINT_SCENE, type PrintScene } from './print_scene';

export type PrintTiltStatus = 'permission' | 'waiting' | 'active' | 'denied' | 'unavailable';

/** An ICC output profile, standing for the printer, its ink and its paper together. */
export type PrinterProfile = { name: string; bytes: Uint8Array<ArrayBuffer> };

export class PrintStore {
  /** Whether the stage shows the print at all, flat or as a sheet. */
  @observable accessor open = false;
  @observable.ref accessor scene: PrintScene = { ...DEFAULT_PRINT_SCENE };
  @observable accessor dragging = false;
  @observable accessor tiltStatus: PrintTiltStatus = 'unavailable';
  @observable.ref accessor printerProfiles: string[] = [];
  @observable.ref accessor printerProfile: PrinterProfile | null = null;

  @computed get flat(): boolean { return this.scene.presentation === 'flat'; }
  @computed get surface(): boolean { return this.scene.presentation === 'surface'; }
  /** The sheet hanging in a room, which the reader turns with a drag. */
  @computed get hanging(): boolean { return this.open && this.scene.presentation === 'scene'; }
}
