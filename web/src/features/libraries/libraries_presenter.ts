import { action, runInAction } from 'mobx';
import {
  ApiError,
  api,
  type CreateLibraryRequest,
  type FolderRule,
  type Ordering,
  type RenditionSource,
  type UpdateLibraryRequest,
} from '../../api/client';
import type { LibrariesStore } from './libraries_store';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class LibrariesPresenter {
  constructor(private readonly store: LibrariesStore) {}

  async load(): Promise<void> {
    this.beginLoad();
    try {
      // Alongside the list rather than once at startup: it is one small immutable
      // record, and pairing them means the settings page never has a library in
      // hand with nothing to compare it against.
      const [libraries, defaults] = await Promise.all([api.listLibraries(), api.getLibraryDefaults()]);
      runInAction(() => {
        this.store.libraries = libraries;
        this.store.defaults = defaults;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  async create(request: CreateLibraryRequest): Promise<boolean> {
    this.beginLoad();
    try {
      await api.createLibrary(request);
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

  async setName(libraryId: string, name: string): Promise<void> {
    if (name.trim() === '') return;
    await this.update(libraryId, { name: name.trim() });
  }

  // Which pixels new photos get their renditions from, and whether the full-size
  // one is HDR. Not retroactive: it decides what gets built next, and rebuilding
  // an existing catalogue is an explicit action (§10.2).
  async setRenditionSource(libraryId: string, rendition_source: RenditionSource): Promise<void> {
    await this.update(libraryId, { rendition_source });
  }

  async setRenditionHdr(libraryId: string, rendition_hdr: boolean): Promise<void> {
    await this.update(libraryId, { rendition_hdr });
  }

  // Automatic photo stacking (§19.4). None of the three is retroactive: they
  // decide what the next detection pass does, and that pass runs when a sync
  // brings something in.
  async setAutoStack(libraryId: string, auto_stack: boolean): Promise<void> {
    await this.update(libraryId, { auto_stack });
  }

  async setAutoStackSimilarity(libraryId: string, auto_stack_similarity: number): Promise<void> {
    if (!Number.isFinite(auto_stack_similarity)) return;
    await this.update(libraryId, { auto_stack_similarity: Math.min(1, Math.max(0, auto_stack_similarity)) });
  }

  async setAutoStackWindow(libraryId: string, auto_stack_window_seconds: number): Promise<void> {
    if (!Number.isFinite(auto_stack_window_seconds)) return;
    await this.update(libraryId, { auto_stack_window_seconds: Math.max(1, Math.round(auto_stack_window_seconds)) });
  }

  // How much of the folder tree the library is, and whether those folders are its
  // shoots (§4.1). The server forces mirroring off with subfolders, so the reload
  // in update() is what puts the second control in the state it actually has.
  async setIncludeSubfolders(libraryId: string, include_subfolders: boolean): Promise<void> {
    await this.update(libraryId, { include_subfolders });
  }

  async setMirrorShoots(libraryId: string, mirror_shoots: boolean): Promise<void> {
    await this.update(libraryId, { mirror_shoots });
  }

  async loadFolderRules(libraryId: string): Promise<void> {
    try {
      const rules = await api.listFolderRules(libraryId);
      this.putFolderRules(libraryId, rules);
    } catch (err) {
      this.fail(message(err));
    }
  }

  // Returns the folder to whatever the library's settings say in general, which
  // for an excluded one means the next sync imports its photographs afresh.
  async clearFolderRule(libraryId: string, folderPath: string): Promise<void> {
    try {
      await api.clearFolderRule(libraryId, folderPath);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.loadFolderRules(libraryId);
  }

  @action.bound
  private putFolderRules(libraryId: string, rules: FolderRule[]): void {
    this.store.folderRules.set(libraryId, rules);
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
