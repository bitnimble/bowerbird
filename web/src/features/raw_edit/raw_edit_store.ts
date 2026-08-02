import { computed, observable } from 'mobx';
import type { Route } from './raw_edit_route';

export type EditStatus = 'idle' | 'fetching' | 'decoding' | 'live' | 'failed';

// Observables and computeds only. Every mutation is on RawEditPresenter.
export class RawEditStore {
  /** Fixed at construction: the route decides the sink, and the sink decides the decode. */
  constructor(readonly route: Route) {}

  @observable accessor status: EditStatus = 'idle';
  /** Why, where the status alone does not say - a fetch failure, or what is in flight. */
  @observable accessor message = '';

  @observable accessor width = 0;
  @observable accessor height = 0;
  @observable accessor exposureEv = 0;

  /** Whether the camera's own colour is in play, or the grade fell back to neutral. */
  @observable accessor matched = false;
  /** How many workers the wasm thread pool actually started. */
  @observable accessor threads = 0;

  @observable accessor decodeMs = 0;
  @observable accessor gradeMs = 0;
  /** Frames actually delivered per second, which is what the drag feels like. */
  @observable accessor fps = 0;

  /** Object URL of the latest graded file, on the two routes that encode one. */
  @observable accessor fileUrl = '';
  /** The track the frames are written to, once whichever side owns it has built one. */
  @observable.ref accessor track: MediaStreamTrack | null = null;

  @computed get live(): boolean {
    return this.status === 'live';
  }

  /** Whether the stage is a `<video>`, which two of the three routes need. */
  @computed get moving(): boolean {
    return this.route !== 'still';
  }

  /** What the readout calls the frame this route delivers. */
  @computed get output(): string {
    if (this.route === 'still') return '16-bit PQ PNG in an <img>, 4:4:4';
    if (this.route === 'track') return '10-bit PQ video track, 4:4:4';
    return '10-bit PQ AV1 rewrapped as MP4, 4:2:0';
  }
}
