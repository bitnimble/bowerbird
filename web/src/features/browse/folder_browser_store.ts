import { computed, observable } from 'mobx';
import { type BrowseResponse } from '../../../../src/schemas/browse';

export class FolderBrowserStore {
  @observable.ref accessor listing: BrowseResponse | null = null;
  @observable.ref accessor selection: Pick<BrowseResponse, 'path'> | null = null;
  @observable accessor loading = false;
  @observable accessor error: string | null = null;

  @computed
  get selectedPath(): string {
    return this.selection?.path ?? '';
  }
}
