import { action } from 'mobx';
import { type BrowseResponse } from '../../../../src/schemas/browse';
import { browseApi } from '../../api/browse';
import { canPickFolder, pickFolder } from '../../api/pick_folder';
import { PickFolderStrings } from '../../api/pick_folder.strings';
import type { FolderBrowserStore } from './folder_browser_store';

export class FolderBrowserPresenter {
  readonly native = canPickFolder();
  private walk = 0;

  constructor(private readonly store: FolderBrowserStore) {}

  async open(path?: string): Promise<boolean> {
    if (this.native) return false;
    return await this.land(() => browseApi.get(path));
  }

  async pick(): Promise<void> {
    if (!this.native || this.store.loading) return;
    this.beginLoad();
    try {
      const folder = await pickFolder();
      switch (folder.kind) {
        case 'picked':
          this.selected(folder.path);
          await this.land(() => browseApi.get(folder.path));
          return;
        case 'dismissed':
          this.finishLoad();
          return;
        case 'unsupported':
          this.fail(PickFolderStrings.couldNotChoose());
          return;
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  @action.bound
  confirm(listing: BrowseResponse): void {
    this.walk++;
    this.store.selection = { path: listing.path };
    this.store.listing = listing;
    this.store.loading = false;
    this.store.error = null;
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
      if (walk !== this.walk) return false;
      this.landed(listing);
      return true;
    } catch (err) {
      if (walk === this.walk) this.fail(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  @action.bound
  private beginLoad(): void {
    this.store.loading = true;
    this.store.error = null;
  }

  @action.bound
  private selected(path: string): void {
    this.store.selection = { path };
    this.store.listing = null;
  }

  @action.bound
  private finishLoad(): void {
    this.store.loading = false;
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
