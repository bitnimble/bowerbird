import { action } from 'mobx';
import { arrayMove } from '@dnd-kit/sortable';
import { type Label } from '../../../../src/schemas/labels';
import { type PhotoTarget } from '../../../../src/schemas/photos';
import type { RequestActivity } from '../../../../src/schemas/request_activity';
import { labelsApi } from '../../api/labels';
import { ApiError } from '../../api/request';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { type DraftLabel, type LabelEditorStore, renamed } from './label_editor_store';
import type { LabelsStore } from './labels_store';
import { LabelsPresenterStrings } from './labels_presenter.strings';

const LABEL_COLOURS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class LabelsPresenter {
  private nextDraft = 0;

  constructor(
    private readonly store: LabelsStore,
    private readonly editor: LabelEditorStore,
    private readonly photos: Pick<PhotosPresenter, 'photoLabelled' | 'keepLabelFilters' | 'reload'>,
    private readonly toasts: ToastsPresenter,
  ) {}

  async load(activity: RequestActivity = 'interactive'): Promise<void> {
    try {
      this.setLabels(await labelsApi.list(activity));
    } catch (err) {
      this.toasts.showError(LabelsPresenterStrings.couldNotLoadLabels(), message(err));
    }
  }

  /** @returns the new label, or null where it could not be made. */
  async create(libraryId: string, name: string): Promise<Label | null> {
    const colour = LABEL_COLOURS[this.store.labelsOf(libraryId).length % LABEL_COLOURS.length]!;
    let label: Label;
    try {
      label = await labelsApi.create({ library_id: libraryId, name: name.trim(), colour });
    } catch (err) {
      this.toasts.showError(LabelsPresenterStrings.couldNotCreateLabel(), message(err));
      return null;
    }
    this.setLabels([...this.store.labels, label]);
    return label;
  }

  async labelPhoto(photoId: string, labelId: string, labelled: boolean): Promise<void> {
    const target = { photo_ids: [photoId] };
    try {
      await (labelled ? labelsApi.addPhotos(labelId, target) : labelsApi.removePhotos(labelId, target));
    } catch (err) {
      this.toasts.showError(LabelsPresenterStrings.couldNotChangeLabels(), message(err));
      return;
    }
    this.photos.photoLabelled(photoId, labelId, labelled);
  }

  async createForPhoto(photoId: string, libraryId: string, name: string): Promise<void> {
    const label = await this.create(libraryId, name);
    if (label != null) await this.labelPhoto(photoId, label.id, true);
  }

  async labelSelection(labelId: string, target: PhotoTarget, count: number): Promise<void> {
    try {
      await labelsApi.addPhotos(labelId, target);
    } catch (err) {
      this.toasts.showError(LabelsPresenterStrings.couldNotChangeLabels(), message(err));
      return;
    }
    this.toasts.show(LabelsPresenterStrings.labelled(count, this.store.byId.get(labelId)?.name ?? ''));
    // A grid filtered by this label now holds more photos.
    await this.photos.reload('background');
  }

  // --- the edit dialog ---

  /** @param choosesLibrary whether it was opened somewhere spanning several libraries. */
  async openEditor(libraryId: string, choosesLibrary = false): Promise<void> {
    this.beginEditing(libraryId, choosesLibrary);
    // Fresh counts, which the delete confirmation quotes: labelling photos since the last load moved them.
    await this.load();
    if (this.editor.libraryId === libraryId && !this.editor.dirty) this.beginEditing(libraryId, choosesLibrary);
  }

  @action.bound
  chooseEditorLibrary(libraryId: string): void {
    this.beginEditing(libraryId, this.editor.choosesLibrary);
  }

  @action.bound
  closeEditor(): void {
    this.editor.libraryId = null;
    this.editor.drafts = [];
    this.editor.removed = [];
    this.editor.dirty = false;
    this.editor.error = null;
  }

  @action.bound
  addDraft(): void {
    const colour = LABEL_COLOURS[this.editor.drafts.length % LABEL_COLOURS.length]!;
    this.editor.drafts = [
      ...this.editor.drafts,
      { key: this.draftKey(), id: null, name: '', colour, photoCount: 0, original: null },
    ];
    this.editor.dirty = true;
  }

  @action.bound
  renameDraft(key: string, name: string): void {
    this.editDraft(key, { name });
  }

  @action.bound
  recolourDraft(key: string, colour: string): void {
    this.editDraft(key, { colour });
  }

  @action.bound
  moveDraft(fromKey: string, toKey: string): void {
    const from = this.editor.drafts.findIndex((draft) => draft.key === fromKey);
    const to = this.editor.drafts.findIndex((draft) => draft.key === toKey);
    if (from < 0 || to < 0 || from === to) return;
    this.editor.drafts = arrayMove(this.editor.drafts, from, to);
    this.editor.dirty = true;
  }

  @action.bound
  removeDraft(key: string): void {
    const draft = this.editor.drafts.find((candidate) => candidate.key === key);
    if (draft == null) return;
    this.editor.drafts = this.editor.drafts.filter((candidate) => candidate.key !== key);
    if (draft.id != null) this.editor.removed = [...this.editor.removed, draft.id];
    this.editor.dirty = true;
  }

  /** @returns whether it saved, so the dialog knows to close. */
  async saveEditor(): Promise<boolean> {
    const libraryId = this.editor.libraryId;
    if (libraryId == null || !this.editor.canSave) return false;
    this.setSaving(true);
    try {
      const saved = await labelsApi.save({
        library_id: libraryId,
        // Only what the reader changed: the rest of a draft is as old as the dialog, and sent back it
        // would undo a rename another device made meanwhile.
        labels: this.editor.drafts.map((draft) => ({
          ...(draft.id != null ? { id: draft.id } : {}),
          ...(renamed(draft) ? { name: draft.name.trim() } : {}),
          ...(draft.colour !== draft.original?.colour ? { colour: draft.colour } : {}),
        })),
        removed: this.editor.removed,
      });
      this.setLabels([...this.store.labels.filter((label) => label.library_id !== libraryId), ...saved]);
    } catch {
      this.failSave(LabelsPresenterStrings.couldNotSaveLabels());
      return false;
    }
    this.closeEditor();
    return true;
  }

  @action.bound
  private beginEditing(libraryId: string, choosesLibrary: boolean): void {
    this.editor.libraryId = libraryId;
    this.editor.choosesLibrary = choosesLibrary;
    this.editor.drafts = this.store.labelsOf(libraryId).map(
      (label): DraftLabel => ({
        key: this.draftKey(),
        id: label.id,
        name: label.name,
        colour: label.colour,
        photoCount: label.photo_count,
        original: { name: label.name, colour: label.colour },
      }),
    );
    this.editor.removed = [];
    this.editor.dirty = false;
    this.editor.saving = false;
    this.editor.error = null;
  }

  private editDraft(key: string, fields: Partial<Pick<DraftLabel, 'name' | 'colour'>>): void {
    this.editor.drafts = this.editor.drafts.map((draft) => (draft.key === key ? { ...draft, ...fields } : draft));
    this.editor.dirty = true;
  }

  private draftKey(): string {
    return `draft-${this.nextDraft++}`;
  }

  private setLabels(labels: Label[]): void {
    this.putLabels(labels);
    void this.photos.keepLabelFilters(new Set(labels.map((label) => label.id)));
  }

  @action.bound
  private putLabels(labels: Label[]): void {
    this.store.labels = labels;
  }

  @action.bound
  private setSaving(saving: boolean): void {
    this.editor.saving = saving;
    this.editor.error = null;
  }

  @action.bound
  private failSave(error: string): void {
    this.editor.saving = false;
    this.editor.error = error;
  }
}
