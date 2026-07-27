import { action, runInAction } from 'mobx';
import { ApiError, api, type Ordering, type PreviewSource, type UpdateLibraryRequest } from '../../api/client';
import type { LibrariesStore } from './libraries_store';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class LibrariesPresenter {
  constructor(private readonly store: LibrariesStore) {}

  async load(): Promise<void> {
    this.beginLoad();
    try {
      const libraries = await api.listLibraries();
      runInAction(() => {
        this.store.libraries = libraries;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  async create(rootPath: string, ordering: Ordering): Promise<boolean> {
    this.beginLoad();
    try {
      await api.createLibrary({ root_path: rootPath, ordering });
    } catch (err) {
      this.fail(message(err));
      return false;
    }
    await this.load();
    return true;
  }

  async setOrdering(libraryId: string, ordering: Ordering): Promise<void> {
    await this.update(libraryId, { ordering });
  }

  // Which pixels new photos get their thumbnails and previews from, and whether
  // the full-size one is HDR. Not retroactive: it decides what gets built next,
  // and rebuilding an existing catalogue is an explicit action (§10.2).
  async setPreviewSource(libraryId: string, preview_source: PreviewSource): Promise<void> {
    await this.update(libraryId, { preview_source });
  }

  async setPreviewHdr(libraryId: string, preview_hdr: boolean): Promise<void> {
    await this.update(libraryId, { preview_hdr });
  }

  async setPreviewHdrVideo(libraryId: string, preview_hdr_video: boolean): Promise<void> {
    await this.update(libraryId, { preview_hdr_video });
  }

  private async update(libraryId: string, body: UpdateLibraryRequest): Promise<void> {
    try {
      await api.updateLibrary(libraryId, body);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  async remove(libraryId: string): Promise<void> {
    try {
      await api.deleteLibrary(libraryId);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
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
