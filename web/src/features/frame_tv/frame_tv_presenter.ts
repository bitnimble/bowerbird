import { action } from 'mobx';
import type { FrameTv } from '../../../../src/schemas/frame_tv';
import type { ViewerRendition } from '../../../../src/schemas/settings';
import { frameTvsApi } from '../../api/frame_tvs';
import { photosApi } from '../../api/photos';
import { ApiError } from '../../api/request';
import { describe } from '../../errors';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ViewerStore } from '../photos/viewer/viewer_store';
import type { AppSettingsStore } from '../settings/app_settings_store';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { FrameTvPresenterStrings } from './frame_tv_presenter.strings';
import type { FrameTvStore } from './frame_tv_store';

export class FrameTvPresenter {
  constructor(
    private readonly store: FrameTvStore,
    private readonly settings: AppSettingsStore,
    private readonly viewer: ViewerStore,
    private readonly photos: PhotosPresenter,
    private readonly toasts: ToastsPresenter,
  ) {}

  async search(): Promise<void> {
    if (this.store.searching || !this.settings.frameTvEnabled) return;
    this.setSearching(true);
    try {
      this.found((await frameTvsApi.list()).tvs);
    } catch {
      this.found([]);
    } finally {
      this.setSearching(false);
    }
  }

  /** The photo at the rendition on screen, as Share sends it. */
  async sendPhoto(photoId: string, tvId: string): Promise<void> {
    await this.send([photoId], this.viewer.frameOf(photoId).rendition, tvId);
  }

  async sendSelection(tvId: string): Promise<void> {
    const target = this.photos.selectionTarget();
    if (target == null) return;
    let photoIds: string[];
    try {
      photoIds = 'photo_ids' in target ? target.photo_ids : (await photosApi.ids(target)).photo_ids;
    } catch (err) {
      this.toasts.showError(FrameTvPresenterStrings.couldNotSendSelection(this.store.nameOf(tvId)), describe(err));
      return;
    }
    await this.send(photoIds, null, tvId);
  }

  private async send(photoIds: string[], rendition: ViewerRendition | null, tvId: string): Promise<void> {
    const name = this.store.nameOf(tvId);
    const message = FrameTvPresenterStrings.sending(name, photoIds.length);
    const toast = this.toasts.showProgress(message, 0);
    let sent = 0;
    let failure: string | null = null;
    try {
      for (const [index, photoId] of photoIds.entries()) {
        try {
          await frameTvsApi.send({ tv_id: tvId, photo_id: photoId, rendition, show: index === 0 });
          sent += 1;
        } catch (err) {
          failure = describe(err);
          // 503 is the TV itself not answering, which every photo after this one would wait out too.
          if (err instanceof ApiError && err.status === 503) break;
        }
        this.toasts.progressed(toast, message, (index + 1) / photoIds.length);
      }
    } finally {
      this.toasts.dismiss(toast);
    }
    if (failure == null) this.toasts.show(FrameTvPresenterStrings.sent(name, sent));
    else this.toasts.showError(FrameTvPresenterStrings.couldNotSend(name, photoIds.length - sent), failure);
  }

  @action.bound
  private setSearching(searching: boolean): void {
    this.store.searching = searching;
  }

  @action.bound
  private found(tvs: FrameTv[]): void {
    this.store.tvs = tvs;
  }
}
