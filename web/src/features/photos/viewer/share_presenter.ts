import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { REQUEST_ACTIVITY_HEADER } from '../../../../../src/schemas/request_activity';
import { photosApi } from '../../../api/photos';
import type { ToastsPresenter } from '../../toasts/toasts_presenter';
import type { ViewerStore } from './viewer_store';
import { PhotosPresenterStrings } from '../photos_presenter.strings';

export class SharePresenter {
  private shareable: { key: string; file: Promise<File> } | null = null;
  private sharing = false;

  constructor(
    private readonly store: ViewerStore,
    private readonly toasts: ToastsPresenter,
  ) {}

  download(photoId: string, form: 'original'): void {
    window.location.href = photosApi.downloadUrl(photoId, form);
  }

  async share(photoId: string): Promise<void> {
    // Only one at a time: the Web Share API rejects a second call while a sheet is open, and
    // the reader pressing again during the encode means "get on with it", not "fail".
    if (this.sharing) return;
    const rendition = this.store.frameOf(photoId).rendition;
    // The build stamp is in the key, not only the rendition: a re-render replaces the file under
    // the same name, and a share of what is on screen has to be a share of what was rebuilt.
    const key = `${photoId}:${rendition}:${this.store.renditionVersionOf(photoId, rendition)}`;
    // Held past the press, so sharing again after closing the sheet costs nothing: the encode is
    // seconds on a large frame, and cancelling one and reaching for another application is an
    // ordinary thing to do.
    const held = this.shareable?.key === key ? this.shareable : null;
    const shareable = held ?? { key, file: this.shareableFile(photoId, rendition) };
    this.shareable = shareable;
    // The encode behind a press is seconds on a large frame, and a menu that closes onto nothing
    // for that long reads as a press that was swallowed. Nothing to say where the file is
    // already in hand and the sheet is about to open.
    const waiting = held == null ? this.toasts.showProgress(PhotosPresenterStrings.preparingShare(), 0) : null;

    this.sharing = true;
    try {
      let file: File;
      try {
        file = await shareable.file;
      } catch {
        this.shareable = null;
        this.toasts.show(PhotosPresenterStrings.shareFailed());
        return;
      } finally {
        if (waiting != null) this.toasts.dismiss(waiting);
      }

      await navigator.share({ files: [file] });
    } catch (error) {
      // Closing the sheet without picking anything is how most shares end.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.toasts.show(PhotosPresenterStrings.shareFailed());
    } finally {
      this.sharing = false;
    }
  }

  private async shareableFile(photoId: string, rendition: ViewerRendition): Promise<File> {
    const response = await fetch(photosApi.shareUrl(photoId, rendition), { headers: { [REQUEST_ACTIVITY_HEADER]: 'interactive' } });
    if (!response.ok) throw new Error(`${response.status}`);
    const name = this.store.photoFor(photoId)?.file_path?.split('/').pop() ?? photoId;
    return new File([await response.blob()], `${name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  }
}
