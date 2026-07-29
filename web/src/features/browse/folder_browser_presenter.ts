import { action, runInAction } from 'mobx';
import { ApiError, api } from '../../api/client';
import type { FolderBrowserStore } from './folder_browser_store';

export class FolderBrowserPresenter {
  /**
   * With a library id the walk is fenced to that library and every path is
   * root-relative; without one it is the whole server, in absolute paths.
   */
  constructor(
    private readonly store: FolderBrowserStore,
    private readonly libraryId: string | null = null,
  ) {}

  // Undefined asks for wherever the walk starts: the library root, or the
  // account's home directory. A path that cannot be read leaves the previous
  // listing on screen rather than emptying the picker, so the way back out is
  // still there.
  async open(path?: string): Promise<void> {
    this.beginLoad();
    try {
      const listing = this.libraryId == null ? await api.browse(path) : await api.browseLibrary(this.libraryId, path ?? '');
      runInAction(() => {
        this.store.listing = listing;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  @action.bound
  private beginLoad(): void {
    this.store.loading = true;
    this.store.error = null;
  }

  @action.bound
  private fail(error: string): void {
    this.store.loading = false;
    this.store.error = error;
  }
}
