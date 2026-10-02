import { action } from 'mobx';
import { applyUiScale } from '../../api/transport';
import { readSetting, writeSetting } from '../../app/local_setting';
import { DEFAULT_DISPLAY_PEAK_NITS, type DeviceSettingsStore } from './device_settings_store';

const RENDER_ON_THIS_DEVICE_KEY = 'bowerbird.renderOnThisDevice';
const DISPLAY_PEAK_NITS_KEY = 'bowerbird.displayPeakNits';
const UI_SCALE_KEY = 'bowerbird.uiScale';

export class DeviceSettingsPresenter {
  constructor(private readonly store: DeviceSettingsStore) {
    this.restore();
  }

  @action.bound
  private restore(): void {
    this.store.renderOnThisDevice = readSetting(RENDER_ON_THIS_DEVICE_KEY) === '1';
    const peak = Number(readSetting(DISPLAY_PEAK_NITS_KEY) ?? DEFAULT_DISPLAY_PEAK_NITS);
    this.store.displayPeakNits =
      Number.isFinite(peak) && peak >= 1 ? peak : DEFAULT_DISPLAY_PEAK_NITS;
    this.store.uiScale = savedUiScale();
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

  /** Kept only once the shell has applied it, so a refused scale is not the one restored. */
  readonly setUiScale = async (scale: number): Promise<void> => {
    await applyUiScale(scale);
    this.adoptUiScale(scale);
  };

  @action.bound
  private adoptUiScale(scale: number): void {
    this.store.uiScale = scale;
    writeSetting(UI_SCALE_KEY, String(scale));
  }
}

/** Applies the saved scale, before the first render so the page is not laid out at another. */
export function restoreUiScale(): Promise<void> {
  const scale = savedUiScale();
  return scale === 1 ? Promise.resolve() : applyUiScale(scale);
}

function savedUiScale(): number {
  const scale = Number(readSetting(UI_SCALE_KEY) ?? '');
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
