import { computed, observable } from 'mobx';

export type EditStatus = 'idle' | 'fetching' | 'preparing' | 'live' | 'failed';

// Observables and computeds only. Every mutation is on RawEditPresenter.
export class RawEditStore {
  @observable accessor status: EditStatus = 'idle';
  /** Why, where the status alone does not say - a fetch failure, or what is in flight. */
  @observable accessor message = '';

  @observable accessor width = 0;
  @observable accessor height = 0;
  @observable accessor exposureEv = 0;

  /** Whether the camera's own colour is in play, or the grade fell back to neutral. */
  @observable accessor matched = false;

  /** How long the server spent decoding, fitting and warping the frame. */
  @observable accessor openMs = 0;
  /** How long a tick takes, wall clock, from slider move to submitted frame. */
  @observable accessor gradeMs = 0;
  @observable accessor fps = 0;

  /** The adapter behind the tick, for the readout: this is a GPU pipeline now. */
  @observable accessor adapter = '';

  @computed get live(): boolean {
    return this.status === 'live';
  }

  /** What the readout calls the frame this route delivers. There is only one now. */
  @computed get output(): string {
    return 'extended-range WebGPU canvas, Display P3, 16-bit float';
  }
}
