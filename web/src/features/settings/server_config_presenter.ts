import { runInAction } from 'mobx';
import { api } from '../../api/client';
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
}
