import { action, runInAction } from 'mobx';
import { ApiError, api, type Ordering } from '../../api/client';
import type { ShootsStore } from './shoots_store';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class ShootsPresenter {
  private libraryId: string | null = null;

  constructor(private readonly store: ShootsStore) {}

  async load(libraryId: string): Promise<void> {
    this.libraryId = libraryId;
    this.beginLoad();
    try {
      const shoots = await api.listShoots(libraryId);
      runInAction(() => {
        this.store.shoots = shoots;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  // Deep-linking to /shoots/:id gives no library id, so fetch the shoot to learn
  // which library it belongs to and then load that library's shoots. Without this
  // the shell can't show the library the user is actually inside.
  async openShoot(shootId: string): Promise<void> {
    const known = this.store.byId.get(shootId);
    if (known != null) {
      await this.load(known.library_id);
      return;
    }
    try {
      const shoot = await api.getShoot(shootId);
      await this.load(shoot.library_id);
    } catch (err) {
      this.fail(message(err));
    }
  }

  async create(libraryId: string, name: string, parentId: string | null, ordering: Ordering): Promise<boolean> {
    try {
      await api.createShoot({
        library_id: libraryId,
        name,
        ordering,
        ...(parentId == null ? {} : { parent_id: parentId }),
      });
    } catch (err) {
      this.fail(message(err));
      return false;
    }
    await this.load(libraryId);
    return true;
  }

  async rename(shootId: string, name: string): Promise<void> {
    try {
      await api.updateShoot(shootId, { name });
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.reload();
  }

  async remove(shootId: string): Promise<void> {
    try {
      await api.deleteShoot(shootId);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.reload();
  }

  // Called by PhotosPresenter for bulk actions: the shoots domain owns its own
  // writes, so the photos presenter never touches this store directly.
  async addPhotos(shootId: string, photoIds: string[]): Promise<void> {
    await api.addPhotosToShoot(shootId, photoIds);
  }

  async removePhotos(shootId: string, photoIds: string[]): Promise<void> {
    await api.removePhotosFromShoot(shootId, photoIds);
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  private async reload(): Promise<void> {
    if (this.libraryId != null) await this.load(this.libraryId);
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
