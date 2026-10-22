import { action, toJS } from 'mobx';
import { pastableEdits, type EditDoc } from '../../../../../src/schemas/photo_edits';
import { type PhotoTarget } from '../../../../../src/schemas/photos';
import { photoEditsApi } from '../../../api/photo_edits';
import { photosApi } from '../../../api/photos';
import { describe } from '../../../errors';
import type { ToastsPresenter } from '../../toasts/toasts_presenter';
import type { PhotosPresenter } from '../photos_presenter';
import type { ViewerStore } from '../viewer/viewer_store';
import { EditsClipboardStrings } from './edits_clipboard.strings';
import type { EditsClipboardStore } from './edits_clipboard_store';

/** The editor open on a photo, which holds its document and pastes into it itself. */
export interface OpenEditor {
  photoId: string;
  doc: () => EditDoc | null;
  paste: (edits: Partial<EditDoc>) => void;
}

export class EditsClipboardPresenter {
  private editor: OpenEditor | null = null;

  constructor(
    private readonly store: EditsClipboardStore,
    private readonly viewer: ViewerStore,
    private readonly photos: PhotosPresenter,
    private readonly toasts: ToastsPresenter,
  ) {}

  /** @returns the detach, for the editor's cleanup. */
  attachEditor(editor: OpenEditor): () => void {
    this.editor = editor;
    return () => {
      if (this.editor === editor) this.editor = null;
    };
  }

  async copy(photoId: string): Promise<void> {
    try {
      // The editor's document is ahead of the server's by whatever save is still in flight.
      const open = this.editor?.photoId === photoId ? toJS(this.editor.doc()) : null;
      this.copied(pastableEdits(open ?? (await photoEditsApi.get(photoId)).doc));
      this.toasts.show(EditsClipboardStrings.copied());
    } catch (err) {
      this.toasts.showError(describe(err));
    }
  }

  /** `inViewer` where the paste came from the filmstrip under the photo on screen. */
  async paste(target: PhotoTarget, inViewer: boolean): Promise<void> {
    const edits = this.store.copied;
    if (edits == null) return;
    const editor = this.editor;
    const shown = inViewer && editor == null ? this.viewer.open?.id : undefined;
    try {
      const { pasted, editing_skipped } = await photosApi.pasteEdits(target, edits, {
        shown,
        editing: editor?.photoId,
      });
      let alsoPasted = 0;
      if (editing_skipped && editor != null) {
        // A copy: the editor writes its document in place, curve points and all.
        if (this.editor === editor) editor.paste(structuredClone(edits));
        // Closed while the request was out; its store is the next photo's now.
        else await photosApi.pasteEdits({ photo_ids: [editor.photoId] }, edits, {});
        alsoPasted = 1;
      }
      if (shown != null) this.photos.forgetEdits(shown);
      this.toasts.show(EditsClipboardStrings.pasted(pasted + alsoPasted));
      await this.photos.reload();
    } catch (err) {
      this.toasts.showError(describe(err));
    }
  }

  @action.bound
  private copied(edits: Partial<EditDoc>): void {
    this.store.copied = edits;
  }
}
