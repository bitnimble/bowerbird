import { runInAction } from 'mobx';
import { api, type ViewerRendition, type ViewerRenditionMode, type Settings, type UpdateSettingsRequest } from '../../api/client';
import type { AppSettingsStore } from './app_settings_store';

export class AppSettingsPresenter {
  constructor(private readonly store: AppSettingsStore) {}

  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const [settings, defaults] = await Promise.all([api.getSettings(), api.getSettingsDefaults()]);
      runInAction(() => {
        this.store.settings = settings;
        this.store.defaults = defaults;
      });
      this.loaded = true;
    } catch {
      // Non-fatal: the store's fallbacks are the shipped behaviour, and a photo
      // opening at its own rendition is better than not opening. Without the
      // defaults the settings page simply offers nothing to reset.
    }
  }

  async update(patch: UpdateSettingsRequest): Promise<void> {
    this.apply(await api.updateSettings(patch));
  }

  async setViewerRenditionMode(mode: ViewerRenditionMode): Promise<void> {
    await this.update({ viewer_rendition_mode: mode });
  }

  // Recorded only in the mode that reads it back. The per-photo memory is the
  // photo's own column, written by the presenter that owns it.
  async rememberRendition(rendition: ViewerRendition): Promise<void> {
    if (this.store.viewerRenditionMode !== 'remember') return;
    if (this.store.lastViewerRendition === rendition) return;
    await this.update({ last_viewer_rendition: rendition });
  }

  private apply(settings: Settings): void {
    runInAction(() => (this.store.settings = settings));
  }
}
