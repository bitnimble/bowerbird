import { observable } from 'mobx';

/** The settings that are about this browser's machine rather than the library it is looking at. */
export class DeviceSettingsStore {
  /**
   * Render the viewer's on-demand renditions on this device's GPU and hand the server the
   * pictures to encode, for a server whose own GPU is the slower of the two.
   */
  @observable accessor renderOnThisDevice = false;
}
