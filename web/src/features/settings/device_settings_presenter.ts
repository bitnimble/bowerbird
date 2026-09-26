import { action } from 'mobx';
import { readSetting, writeSetting } from '../../app/local_setting';
import { DEFAULT_DISPLAY_PEAK_NITS, type DeviceSettingsStore } from './device_settings_store';

const RENDER_ON_THIS_DEVICE_KEY = 'bowerbird.renderOnThisDevice';
const DISPLAY_PEAK_NITS_KEY = 'bowerbird.displayPeakNits';

export class DeviceSettingsPresenter {
  constructor(private readonly store: DeviceSettingsStore) {
    this.restore();
  }

  @action.bound
  private restore(): void {
    this.store.renderOnThisDevice = readSetting(RENDER_ON_THIS_DEVICE_KEY) === '1';
    const peak = Number(readSetting(DISPLAY_PEAK_NITS_KEY) ?? DEFAULT_DISPLAY_PEAK_NITS);
    this.store.displayPeakNits = Number.isFinite(peak) && peak >= 1 ? peak : DEFAULT_DISPLAY_PEAK_NITS;
  }

  @action.bound
  setRenderOnThisDevice(on: boolean): void {
    this.store.renderOnThisDevice = on;
    writeSetting(RENDER_ON_THIS_DEVICE_KEY, on ? '1' : '0');
  }

  /** Ignores anything that is not a brightness, which leaves the field showing what it was. */
  @action.bound
  setDisplayPeakNits(nits: number): void {
    if (!Number.isFinite(nits) || nits < 1) return;
    this.store.displayPeakNits = nits;
    writeSetting(DISPLAY_PEAK_NITS_KEY, String(nits));
  }
}
