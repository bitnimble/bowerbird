import { runInAction } from 'mobx';
import { api, type ViewerRendition, type ViewerRenditionMode, type Settings } from '../../api/client';
import type { AppSettingsStore } from './app_settings_store';

export class AppSettingsPresenter {
  constructor(private readonly store: AppSettingsStore) {}

  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.apply(await api.getSettings());
      this.loaded = true;
    } catch {
      // Non-fatal: the store's defaults are the shipped behaviour, and a photo
      // opening at its own rendition is better than not opening.
    }
  }

  async setViewerRenditionMode(mode: ViewerRenditionMode): Promise<void> {
    this.apply(await api.updateSettings({ viewer_rendition_mode: mode }));
  }

  // Recorded only in the mode that reads it back. The per-photo memory is the
  // photo's own column, written by the presenter that owns it.
  async rememberRendition(rendition: ViewerRendition): Promise<void> {
    if (this.store.viewerRenditionMode !== 'remember') return;
    this.apply(await api.updateSettings({ last_viewer_rendition: rendition }));
  }

  private apply(settings: Settings): void {
    runInAction(() => {
      this.store.viewerRenditionMode = settings.viewer_rendition_mode;
      this.store.lastViewerRendition = settings.last_viewer_rendition;
    });
  }
}
