import { computed, observable } from 'mobx';
import type { Library } from '../../api/client';

// Data only: observables + computeds. Every mutation lives on LibrariesPresenter.
export class LibrariesStore {
  @observable.shallow accessor libraries: Library[] = [];
  @observable accessor loading = false;
  @observable accessor error: string | null = null;

  @computed get byId(): Map<string, Library> {
    return new Map(this.libraries.map((l) => [l.id, l]));
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.libraries.length === 0;
  }
}
