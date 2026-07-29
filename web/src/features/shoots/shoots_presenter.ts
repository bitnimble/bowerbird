import { action, runInAction } from 'mobx';
import { ApiError, api, type Ordering, type PhotoTarget } from '../../api/client';
import type { ShootsStore, ShootView } from './shoots_store';

const VIEW_KEY = 'bowerbird.shoots.view';

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
      const [shoots, library] = await Promise.all([api.listShoots(libraryId), api.getLibrary(libraryId)]);
      runInAction(() => {
        this.store.shoots = shoots;
        // A photo belongs to at most one shoot, so what the shoots do not account
        // for is what sits outside them. Derived rather than asked for, since both
        // counts are already on the wire.
        this.store.rootPhotoCount = Math.max(0, library.photo_count - shoots.reduce((n, s) => n + s.photo_count, 0));
        // Every folder on the way to a shoot starts open, or a shoot three
        // folders down would be hidden behind clicks in the view meant to show
        // everything.
        for (const shoot of shoots) {
          const segments = shoot.folder_path.split('/');
          for (let i = 1; i < segments.length; i++) this.store.expanded.add(segments.slice(0, i).join('/'));
        }
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  // Which reading of the folders this is: about the machine you are sitting at
  // rather than about the catalogue, so it is remembered here and not on the
  // server (§18.3.1).
  @action.bound
  setView(view: ShootView): void {
    this.store.view = view;
    localStorage.setItem(VIEW_KEY, view);
  }

  @action.bound
  restoreView(): void {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'flat' || saved === 'tree' || saved === 'tree_full') this.store.view = saved;
  }

  // Folders holding photographs are already known from the shoots' paths; this
  // is what finds the ones holding none, which is where a new shoot often goes.
  async toggleFolder(folderPath: string): Promise<void> {
    if (this.store.expanded.has(folderPath)) {
      this.collapse(folderPath);
      return;
    }
    this.expand(folderPath);
    if (this.libraryId == null || this.store.browsed.has(folderPath)) return;
    try {
      const listing = await api.browseLibrary(this.libraryId, folderPath);
      this.putBrowsed(
        folderPath,
        listing.directories.map((d) => d.path),
      );
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

  // `parentPath` is the library-relative folder the shoot's own folder goes in,
  // empty for the library root. The parent shoot follows from it server-side.
  async create(libraryId: string, name: string, parentPath: string, ordering: Ordering): Promise<boolean> {
    try {
      await api.createShoot({ library_id: libraryId, parent_path: parentPath, name, ordering });
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

  // How this shoot is sorted, which is the shoot's own property rather than a
  // per-browser preference, so it is the same wherever it is opened (§18.3.1).
  async setOrdering(shootId: string, ordering: Ordering): Promise<void> {
    try {
      await api.updateShoot(shootId, { ordering });
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.reload();
  }

  // `photos` is the question the delete dialog asks: 'keep' leaves them in the
  // library and marks the folder plain, 'remove' takes their records and
  // renditions with the shoot. Neither touches a file on disk.
  async remove(shootId: string, photos: 'keep' | 'remove'): Promise<void> {
    try {
      await api.deleteShoot(shootId, photos);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.reload();
  }

  // Called by PhotosPresenter for bulk actions: the shoots domain owns its own
  // writes, so the photos presenter never touches this store directly.
  async addPhotos(shootId: string, target: PhotoTarget): Promise<void> {
    await api.addPhotosToShoot(shootId, target);
  }

  async removePhotos(shootId: string, target: PhotoTarget): Promise<void> {
    await api.removePhotosFromShoot(shootId, target);
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  @action.bound
  private expand(folderPath: string): void {
    this.store.expanded.add(folderPath);
  }

  @action.bound
  private collapse(folderPath: string): void {
    this.store.expanded.delete(folderPath);
  }

  @action.bound
  private putBrowsed(folderPath: string, children: string[]): void {
    this.store.browsed.set(folderPath, children);
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
