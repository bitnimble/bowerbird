import { action } from 'mobx';
import { type BrowseResponse } from '../../../../src/schemas/browse';
import { browseApi } from '../../api/browse';
import { ApiError } from '../../api/request';
import type { FolderBrowserStore } from './folder_browser_store';

// Walks the whole server in absolute paths, which is what choosing a library
// root needs. Folders inside a library are the Shoots page's own tree (§18.3.2).
export class FolderBrowserPresenter {
  private walk = 0;

  constructor(private readonly store: FolderBrowserStore) {}

  // Undefined asks for wherever the walk starts, the account's home directory. A
  // path that cannot be read leaves the previous listing on screen rather than
  // emptying the picker, so the way back out is still there.
  async open(path?: string): Promise<void> {
    await this.land(() => browseApi.get(path));
  }

  /** Makes a folder inside the one listed and walks into it. False where it was refused. */
  async createFolder(name: string): Promise<boolean> {
    const parent = this.store.listing?.path;
    if (parent == null || name.trim() === '') return false;
    return await this.land(() => browseApi.createFolder(parent, name.trim()));
  }

  private async land(read: () => Promise<BrowseResponse>): Promise<boolean> {
    // Typing walks as it goes, so several folders are asked for in a row and a
    // big one answers after the small one asked for later. Whichever was asked
    // for last is the one wanted, whatever order they come back in.
    const walk = ++this.walk;
    this.beginLoad();
    try {
      const listing = await read();
      if (walk === this.walk) this.landed(listing);
      return true;
    } catch (err) {
      if (walk === this.walk) this.fail(err instanceof ApiError ? err.message : (err as Error).message);
      return false;
    }
  }

  @action.bound
  private beginLoad(): void {
    this.store.loading = true;
    this.store.error = null;
  }

  @action.bound
  private landed(listing: BrowseResponse): void {
    this.store.listing = listing;
    this.store.loading = false;
  }

  @action.bound
  private fail(error: string): void {
    this.store.loading = false;
    this.store.error = error;
  }
}
