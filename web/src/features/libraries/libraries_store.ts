import { computed, observable } from 'mobx';
import type { FolderRule, Library, LibrarySettings } from '../../api/client';

// Data only: observables + computeds. Every mutation lives on LibrariesPresenter.
export class LibrariesStore {
  @observable.shallow accessor libraries: Library[] = [];
  /** What a new library is created with, for the settings page's reset. Null until it arrives. */
  @observable.ref accessor defaults: LibrarySettings | null = null;
  // Per library, keyed by id, because only the library being looked at in
  // Settings has ever had its rules read.
  @observable.shallow accessor folderRules = new Map<string, FolderRule[]>();
  // True until the first load lands: an unread list is not an empty one, and
  // callers branch on emptiness to decide where to send the user.
  @observable accessor loading = true;
  @observable accessor error: string | null = null;

  @computed get byId(): Map<string, Library> {
    return new Map(this.libraries.map((l) => [l.id, l]));
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.libraries.length === 0;
  }
}
