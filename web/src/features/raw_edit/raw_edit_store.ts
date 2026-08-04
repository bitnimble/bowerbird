import { computed, observable } from 'mobx';
import type { Region } from './gpu/tick_pipeline';

export type EditStatus = 'idle' | 'fetching' | 'preparing' | 'live' | 'failed';

// Observables and computeds only. Every mutation is on RawEditPresenter.
export class RawEditStore {
  @observable accessor status: EditStatus = 'idle';
  /** Why, where the status alone does not say - a fetch failure, or what is in flight. */
  @observable accessor message = '';

  @observable accessor width = 0;
  @observable accessor height = 0;
  @observable accessor exposureEv = 0;

  /**
   * The part of the frame on screen, in source pixels. Null until the frame is open.
   *
   * Where zoom and pan live: the draw runs at canvas resolution over this rectangle, so
   * moving it is the whole of navigating a photograph, and nothing else has to change.
   */
  @observable accessor region: Region | null = null;

  /** The canvas backing store, which is the viewport in device pixels and then some. */
  @observable accessor stageWidth = 0;
  @observable accessor stageHeight = 0;

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

  /** Source pixels per canvas pixel. Below 1 the reader is past the frame's own detail. */
  @computed get zoom(): number {
    const region = this.region;
    if (region == null || this.stageWidth === 0) return 1;
    return this.stageWidth / region.width;
  }

  /** What the readout calls the frame this route delivers. There is only one now. */
  @computed get output(): string {
    return 'extended-range WebGPU canvas, Display P3, 16-bit float';
  }
}
