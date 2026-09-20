import { action, runInAction } from 'mobx';
import { browseApi } from '../../api/browse';
import { ApiError } from '../../api/request';
import type { FolderBrowserStore } from './folder_browser_store';

// Walks the whole server in absolute paths, which is what choosing a library
// root needs. Folders *inside* a library are the Shoots page's own tree now
// (§18.3.2), so this no longer answers for both.
export class FolderBrowserPresenter {
  private walk = 0;

  constructor(private readonly store: FolderBrowserStore) {}

  // Undefined asks for wherever the walk starts, the account's home directory. A
  // path that cannot be read leaves the previous listing on screen rather than
  // emptying the picker, so the way back out is still there.
  async open(path?: string): Promise<void> {
    // Typing walks as it goes, so several folders are asked for in a row and a
    // big one answers after the small one asked for later. Whichever was asked
    // for last is the one wanted, whatever order they come back in.
    const walk = ++this.walk;
    this.beginLoad();
    try {
      const listing = await browseApi.get(path);
      if (walk !== this.walk) return;
      runInAction(() => {
        this.store.listing = listing;
        this.store.loading = false;
      });
    } catch (err) {
      if (walk !== this.walk) return;
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
