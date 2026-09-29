import { computed, observable } from 'mobx';

export interface DraftLabel {
  /** Stable across renames, for the list's keys and its drag handles. */
  key: string;
  /** Null for a label added in this dialog and not saved yet. */
  id: string | null;
  name: string;
  colour: string;
  photoCount: number;
  /** What the label held when the dialog opened, null for a new one. */
  original: { name: string; colour: string } | null;
}

export function renamed(draft: DraftLabel): boolean {
  return draft.original == null || draft.name.trim() !== draft.original.name;
}

export class LabelEditorStore {
  /** Null while the dialog is closed. */
  @observable accessor libraryId: string | null = null;
  /** Whether the dialog offers a choice of library: it was opened somewhere that spans several. */
  @observable accessor choosesLibrary = false;
  @observable.shallow accessor drafts: DraftLabel[] = [];
  @observable.shallow accessor removed: string[] = [];
  @observable accessor dirty = false;
  @observable accessor saving = false;
  @observable accessor error: string | null = null;

  @computed get open(): boolean {
    return this.libraryId != null;
  }

  /**
   * Keys of the drafts given a name another draft already has, ignoring case. Only a name given in
   * this dialog: two labels replication left sharing one are not the reader's to fix before saving.
   */
  @computed get duplicates(): Set<string> {
    const named = (draft: DraftLabel): string => draft.name.trim().toLowerCase();
    return new Set(
      this.drafts
        .filter(
          (draft) =>
            renamed(draft) &&
            this.drafts.some((other) => other.key !== draft.key && named(other) === named(draft)),
        )
        .map((draft) => draft.key),
    );
  }

  @computed get canSave(): boolean {
    return (
      this.dirty &&
      !this.saving &&
      this.duplicates.size === 0 &&
      this.drafts.every((draft) => draft.name.trim() !== '')
    );
  }
}
