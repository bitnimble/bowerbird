import { computed, observable } from 'mobx';
import type { Printer } from '../../../../../src/schemas/printing';
import type { PrintTarget } from '../local_decode/local_open';
import { DEFAULT_PRINT_SCENE, type PrintScene } from './print_scene';

export type PrintTiltStatus = 'permission' | 'waiting' | 'active' | 'denied' | 'unavailable';

/** Generic paper proofs in Adobe RGB; a printer at the best colour path it offers. */
export type ProofSource =
  { kind: 'generic' } | { kind: 'file'; name: string } | { kind: 'printer'; id: string };

export type PrintProof = { source: ProofSource; target: PrintTarget };

export class PrintStore {
  /** Whether the stage shows the print at all, flat or as a sheet. */
  @observable accessor open = false;
  @observable.ref accessor scene: PrintScene = { ...DEFAULT_PRINT_SCENE };
  @observable accessor dragging = false;
  @observable accessor tiltStatus: PrintTiltStatus = 'unavailable';
  @observable.ref accessor printerProfiles: string[] = [];
  @observable.ref accessor printers: Printer[] = [];
  @observable.ref accessor proof: PrintProof = {
    source: { kind: 'generic' },
    target: { kind: 'adobe-rgb' },
  };

  /** Whether a profile of the paper, rather than a colour space, sets its white and black. */
  @computed get profiled(): boolean {
    return this.proof.target.kind === 'profile';
  }
  @computed get flat(): boolean {
    return this.scene.presentation === 'flat';
  }
  @computed get surface(): boolean {
    return this.scene.presentation === 'surface';
  }
  /** The sheet hanging in a room, which the reader turns with a drag. */
  @computed get hanging(): boolean {
    return this.open && this.scene.presentation === 'scene';
  }
}
