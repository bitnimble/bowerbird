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
    // The store outlives the page, so everything derived from the last library
    // has to go or its folders appear as untracked rows in this one - each with
    // an "Add as shoot" pointing at a path that may not even exist here.
    if (this.libraryId !== libraryId) this.forgetLibrary();
    this.libraryId = libraryId;
    this.beginLoad();
    try {
      const [shoots, library] = await Promise.all([api.listShoots(libraryId), api.getLibrary(libraryId)]);
      if (this.libraryId !== libraryId) return; // navigated away while this was in flight
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
      // The folders holding no photographs, which no shoot's path implies and
      // nothing else would ever ask for. Without it "All folders" can only show
      // what the shoots already say, so a library with none - which is exactly
      // what mirroring turned off produces - shows an empty page under a message
      // telling the reader to look here.
      await this.browse('');
    } catch (err) {
      this.fail(message(err));
    }
  }

  @action.bound
  private forgetLibrary(): void {
    this.store.shoots = [];
    this.store.browsed = new Map();
    this.store.expanded = new Set(['']);
    this.store.scrollTop = 0;
    this.store.cursorPath = null;
    this.store.rootPhotoCount = 0;
  }

  // Which reading of the folders this is: about the machine you are sitting at
  // rather than about the catalogue, so it is remembered here and not on the
  // server (§18.3.1).
  @action.bound
  setView(view: ShootView): void {
    this.store.view = view;
    // Row four thousand of the folder tree says nothing about row four thousand
    // of the shoots alone, so the scroll starts over with the reading.
    this.store.scrollTop = 0;
    localStorage.setItem(VIEW_KEY, view);
  }

  // The scroller's own numbers, written straight to the store so nothing else
  // has to read the DOM to know what is on screen (§18.2).
  @action.bound
  setViewport(height: number): void {
    this.store.viewportHeight = height;
  }

  @action.bound
  setScrollTop(top: number): void {
    this.store.scrollTop = top;
  }

  // The keyboard cursor. Kept in the store rather than as focus on a row element,
  // because rows are mounted only while they are on screen: scrolling past the
  // cursor would otherwise drop it on the floor and leave the browser focusing
  // the document body (§18.3.4).
  @action.bound
  setCursor(folderPath: string | null): void {
    this.store.cursorPath = folderPath;
  }

  @action.bound
  moveCursor(delta: number): void {
    const rows = this.store.rows;
    if (rows.length === 0) return;
    // From the top on the first keystroke, so arrowing into an untouched list
    // starts somewhere rather than nowhere.
    const from = this.store.cursorIndex < 0 ? (delta > 0 ? -1 : rows.length) : this.store.cursorIndex;
    const next = Math.max(0, Math.min(from + delta, rows.length - 1));
    this.store.cursorPath = rows[next]!.folderPath;
  }

  // Right opens a folder and then walks into it; left closes one, or steps out to
  // the parent when it is already closed. The arrows a tree is expected to answer.
  async openCursor(): Promise<void> {
    const row = this.store.cursorRow;
    if (row == null) return;
    if (row.expandable && !this.store.expanded.has(row.folderPath)) {
      await this.toggleFolder(row.folderPath);
      return;
    }
    this.moveCursor(1);
  }

  async closeCursor(): Promise<void> {
    const row = this.store.cursorRow;
    if (row == null) return;
    if (row.expandable && this.store.expanded.has(row.folderPath)) {
      await this.toggleFolder(row.folderPath);
      return;
    }
    const slash = row.folderPath.lastIndexOf('/');
    if (slash > 0) this.setCursor(row.folderPath.slice(0, slash));
  }

  @action.bound
  startRename(folderPath: string, current: string): void {
    this.store.renamingPath = folderPath;
    this.store.renameDraft = current;
  }

  @action.bound
  setRenameDraft(draft: string): void {
    this.store.renameDraft = draft;
  }

  @action.bound
  cancelRename(): void {
    this.store.renamingPath = null;
    this.store.renameDraft = '';
  }

  // Committed against the shoot at the folder being renamed rather than an id
  // captured when the edit began: a sync landing mid-edit can replace the row.
  async commitRename(): Promise<void> {
    const folderPath = this.store.renamingPath;
    const next = this.store.renameDraft.trim();
    const shoot = folderPath == null ? undefined : this.store.shootByFolder.get(folderPath);
    this.cancelRename();
    if (shoot == null || next === '' || next === shoot.name) return;
    await this.rename(shoot.id, next);
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
    await this.browse(folderPath);
  }

  private async browse(folderPath: string): Promise<void> {
    const libraryId = this.libraryId;
    if (libraryId == null || this.store.browsed.has(folderPath)) return;
    try {
      const listing = await api.browseLibrary(libraryId, folderPath);
      // A listing that lands after the reader opened another library describes
      // folders that are not in front of them any more.
      if (this.libraryId !== libraryId) return;
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

  // Takes a folder as it stands, photos and all: the shoot's name is the folder's
  // own, and the server adopts what is already inside it (§8.5).
  async adopt(folderPath: string): Promise<boolean> {
    if (this.libraryId == null) return false;
    const slash = folderPath.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : folderPath.slice(0, slash);
    return this.create(this.libraryId, folderPath.slice(slash + 1), parentPath, 'taken_asc');
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
