import { action } from 'mobx';
import { readSetting, writeSetting } from '../../app/local_setting';
import type { DeviceSettingsStore } from './device_settings_store';

const RENDER_ON_THIS_DEVICE_KEY = 'bowerbird.renderOnThisDevice';

export class DeviceSettingsPresenter {
  constructor(private readonly store: DeviceSettingsStore) {
    this.restore();
  }

  @action.bound
  private restore(): void {
    this.store.renderOnThisDevice = readSetting(RENDER_ON_THIS_DEVICE_KEY) === '1';
  }

  @action.bound
  setRenderOnThisDevice(on: boolean): void {
    this.store.renderOnThisDevice = on;
    writeSetting(RENDER_ON_THIS_DEVICE_KEY, on ? '1' : '0');
  }
}
