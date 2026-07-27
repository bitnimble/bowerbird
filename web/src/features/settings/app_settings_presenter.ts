import { runInAction } from 'mobx';
import { api, type PreviewRendition, type PreviewRenditionMode, type Settings } from '../../api/client';
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
      // opening at its own thumbnail is better than not opening.
    }
  }

  async setPreviewRenditionMode(mode: PreviewRenditionMode): Promise<void> {
    this.apply(await api.updateSettings({ preview_rendition_mode: mode }));
  }

  // Recorded only in the mode that reads it back. The per-photo memory is the
  // photo's own column, written by the presenter that owns it.
  async rememberRendition(rendition: PreviewRendition): Promise<void> {
    if (this.store.previewRenditionMode !== 'remember') return;
    this.apply(await api.updateSettings({ last_preview_rendition: rendition }));
  }

  private apply(settings: Settings): void {
    runInAction(() => {
      this.store.previewRenditionMode = settings.preview_rendition_mode;
      this.store.lastPreviewRendition = settings.last_preview_rendition;
    });
  }
}
