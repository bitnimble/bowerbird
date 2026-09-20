import { runInAction } from 'mobx';
import { type Settings, type UpdateSettingsRequest, type ViewerRendition, type ViewerRenditionMode } from '../../../../src/schemas/settings';
import { settingsApi } from '../../api/settings';
import type { AppSettingsStore } from './app_settings_store';

export class AppSettingsPresenter {
  constructor(private readonly store: AppSettingsStore) {}

  private loaded = false;
  private inFlight: Promise<void> | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;
    // The shell and the page it is showing both ask on the same mount, and a child's
    // effect runs before its parent's, so `loaded` has not been set by either yet.
    this.inFlight ??= this.fetch().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(): Promise<void> {
    try {
      const [settings, defaults] = await Promise.all([settingsApi.get(), settingsApi.getDefaults()]);
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
    this.apply(await settingsApi.update(patch));
  }

  async setViewerRenditionMode(mode: ViewerRenditionMode): Promise<void> {
    await this.update({ viewer_rendition_mode: mode });
  }

  /**
   * Recorded only in the mode that reads it back. The per-photo memory is the photo's own
   * column, written by the presenter that owns it.
   *
   * True where the setting actually moved, which is what tells a caller that answers
   * resolved against it - `shown_rendition` on every row this client is holding - are now
   * stale. Three of the six modes never write here at all.
   */
  async rememberRendition(rendition: ViewerRendition): Promise<boolean> {
    if (this.store.viewerRenditionMode !== 'remember') return false;
    if (this.store.lastViewerRendition === rendition) return false;
    await this.update({ last_viewer_rendition: rendition });
    return true;
  }

  private apply(settings: Settings): void {
    runInAction(() => (this.store.settings = settings));
  }
}
