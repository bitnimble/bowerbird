import { runInAction } from 'mobx';
import { api, type ThumbnailSource } from '../../api/client';
import type { ServerConfigStore } from './server_config_store';

export class ServerConfigPresenter {
  constructor(private readonly store: ServerConfigStore) {}

  // Static for the server's lifetime, so it is fetched once and never refreshed.
  async load(): Promise<void> {
    if (this.store.config != null) return;
    try {
      const config = await api.getConfig();
      runInAction(() => (this.store.config = config));
    } catch {
      // Non-fatal: the thumbnail panel just omits the encoding details.
    }
  }

  async loadSettings(): Promise<void> {
    try {
      const settings = await api.getSettings();
      runInAction(() => (this.store.settings = settings));
    } catch {
      // Non-fatal: the settings page shows nothing selected rather than failing.
    }
  }

  async setThumbnailSource(source: ThumbnailSource): Promise<void> {
    runInAction(() => (this.store.saving = true));
    try {
      const settings = await api.updateSettings({ thumbnail_source: source });
      runInAction(() => (this.store.settings = settings));
    } finally {
      runInAction(() => (this.store.saving = false));
    }
  }
}
