import { computed, observable } from 'mobx';
import { type FolderRule, type Library, type LibrarySettings } from '../../../../src/schemas/libraries';
import { type RenderedRendition } from '../../../../src/schemas/render_stages';

/** How the in-flight benchmarks below are keyed, for the presenter that writes them. */
export function benchmarkKey(libraryId: string, rendition: RenderedRendition): string {
  return `${libraryId}:${rendition}`;
}

// Data only: observables + computeds. Every mutation lives on LibrariesPresenter.
export class LibrariesStore {
  @observable.shallow accessor libraries: Library[] = [];
  /** What a new library is created with, for the settings page's reset. Null until it arrives. */
  @observable.ref accessor defaults: LibrarySettings | null = null;
  // Per library, keyed by id, because only the library being looked at in
  // Settings has ever had its rules read.
  @observable.shallow accessor folderRules = new Map<string, FolderRule[]>();
  // Which render benchmarks are in flight. Several renders of one photograph, so the button that
  // starts one has to stay busy for as long as it takes.
  @observable.shallow accessor benchmarking = new Set<string>();
  // True until the first load lands: an unread list is not an empty one, and
  // callers branch on emptiness to decide where to send the user.
  @observable accessor loading = true;
  @observable accessor error: string | null = null;

  isBenchmarking(libraryId: string, rendition: RenderedRendition): boolean {
    return this.benchmarking.has(benchmarkKey(libraryId, rendition));
  }

  @computed get byId(): Map<string, Library> {
    return new Map(this.libraries.map((l) => [l.id, l]));
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.libraries.length === 0;
  }
}
