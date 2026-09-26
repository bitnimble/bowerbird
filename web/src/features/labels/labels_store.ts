import { computed, observable } from 'mobx';
import { type Label } from '../../../../src/schemas/labels';

export class LabelsStore {
  // Every library's, in each library's own order.
  @observable.shallow accessor labels: Label[] = [];

  @computed get byId(): Map<string, Label> {
    return new Map(this.labels.map((label) => [label.id, label]));
  }

  @computed get libraryIds(): string[] {
    return [...new Set(this.labels.map((label) => label.library_id))];
  }

  labelsOf(libraryId: string): Label[] {
    return this.labels.filter((label) => label.library_id === libraryId);
  }
}
