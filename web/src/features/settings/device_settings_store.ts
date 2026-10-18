import { computed, observable } from 'mobx';
import { ScreenStore, screenStore } from '../../app/screen_store';
import { SDR_WHITE_NITS } from '../../app/sdr_white';

/** What a display is assumed to reach where nothing has been said about this one. */
export const DEFAULT_DISPLAY_PEAK_NITS = 1000;

/** A Shield's: SDR white at 480 nits, as scRGB counts them in 80s. */
export const DEFAULT_HDR_WHITE = 6;

const SCRGB_ONE_NITS = 80;

/** The settings that are about this browser's machine rather than the library it is looking at. */
export class DeviceSettingsStore {
  /**
   * Render the viewer's on-demand renditions on this device's GPU and hand the server the
   * pictures to encode, for a server whose own GPU is the slower of the two.
   */
  @observable accessor renderOnThisDevice = false;
  /**
   * The brightest this device's display shows, as the reader sets it: a browser exposes no
   * headroom on `screen`, and `dynamic-range` is a boolean.
   */
  @observable accessor displayPeakNits = DEFAULT_DISPLAY_PEAK_NITS;
  /**
   * The scRGB value an HDR photo's SDR white is drawn at to match the menus, as the reader
   * calibrates it, for a TV whose shell draws HDR photos (`shellDrawsStage`) on an Android that
   * does not measure the screen.
   */
  @observable accessor hdrWhite = DEFAULT_HDR_WHITE;
  /** The app's page zoom, which a browser has its own of. */
  @observable accessor uiScale = 1;
  @observable accessor viewerQualityNoticeClosed = false;
  @observable accessor editorQualityNoticeClosed = false;

  constructor(readonly screen: ScreenStore = screenStore) {}

  /**
   * What the viewer and the editor roll a photo's highlights off to, or null where the screen
   * shows nothing past SDR white.
   */
  @computed
  get peakNits(): number | null {
    if (!this.screen.hdr) return null;
    return this.screen.peakNits ?? this.displayPeakNits;
  }

  /** How far past SDR white the shell's stage rolls highlights to, or null on an SDR screen. */
  @computed
  get stageHeadroom(): number | null {
    const peak = this.peakNits;
    if (peak == null) return null;
    const white = this.screen.measures ? SDR_WHITE_NITS : this.hdrWhite * SCRGB_ONE_NITS;
    return Math.max(1, peak / white);
  }

  /** The scRGB value the shell's stage draws SDR white at: 1 where Android measures the screen. */
  @computed
  get stageWhite(): number {
    return this.screen.measures ? 1 : this.hdrWhite;
  }
}
