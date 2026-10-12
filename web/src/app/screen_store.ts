import { computed, observable } from 'mobx';
import type { DynamicRange } from '../api/transport';
import { SDR_WHITE_NITS } from './sdr_white';

const HEADROOM_STEPS_PER_STOP = 8;

/** The window's screen: how far past SDR white it shows light. */
export class ScreenStore {
  /** Null in a browser. */
  @observable.ref accessor reading: DynamicRange | null = null;
  /** `(dynamic-range: high)`, which WKWebView and Android's WebView answer "no" on HDR screens. */
  @observable accessor mediaHdr = false;

  @computed
  get hdr(): boolean {
    return this.reading?.hdr ?? this.mediaHdr;
  }

  @computed
  get measures(): boolean {
    return this.reading?.measures === true;
  }

  /** The brightest a draw can show right now. Null until the shell reads the headroom. */
  @computed
  get peakNits(): number | null {
    const headroom = this.reading?.headroom;
    if (headroom == null) return null;
    // Rounded down: every change redraws the stage, and auto-brightness moves it on most readings.
    const steps = Math.floor(Math.log2(Math.max(headroom, 1)) * HEADROOM_STEPS_PER_STOP);
    return 2 ** (steps / HEADROOM_STEPS_PER_STOP) * SDR_WHITE_NITS;
  }

  /** The brightest a draw can show once the screen's brightness opens its headroom fully. */
  @computed
  get potentialNits(): number | null {
    const potential = this.reading?.potential;
    return potential == null ? null : potential * SDR_WHITE_NITS;
  }
}

export const screenStore = new ScreenStore();
