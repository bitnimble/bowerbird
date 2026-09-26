import { observable } from 'mobx';

/** What a display is assumed to reach where nothing has been said about this one. */
export const DEFAULT_DISPLAY_PEAK_NITS = 1000;

/** The settings that are about this browser's machine rather than the library it is looking at. */
export class DeviceSettingsStore {
  /**
   * Render the viewer's on-demand renditions on this device's GPU and hand the server the
   * pictures to encode, for a server whose own GPU is the slower of the two.
   */
  @observable accessor renderOnThisDevice = false;
  /**
   * The brightest this device's display shows, which the viewer and the editor roll a photo's
   * highlights off to. The platform will not say: Chrome exposes no headroom on `screen`, and
   * `dynamic-range` is a boolean.
   */
  @observable accessor displayPeakNits = DEFAULT_DISPLAY_PEAK_NITS;
}
