import { action, runInAction } from 'mobx';
import { type Ordering } from '../../../../src/schemas/common';
import { type PhotoTarget } from '../../../../src/schemas/photos';
import { type Shoot } from '../../../../src/schemas/shoots';
import { librariesApi } from '../../api/libraries';
import { photosApi } from '../../api/photos';
import { ApiError } from '../../api/request';
import { shootsApi } from '../../api/shoots';
import { CollectionListPresenter } from '../../app/collection_list_presenter';
import { readSetting, writeSetting } from '../../app/local_setting';
import type { SidebarPresenter } from '../../app/sidebar_presenter';
import type { ShootsStore, ShootView } from './shoots_store';

const VIEW_KEY = 'bowerbird.shoots.view';
const SHOW_HIDDEN_KEY = 'bowerbird.shoots.showHidden';

function parentOf(folderPath: string): string {
  const slash = folderPath.lastIndexOf('/');
  return slash < 0 ? '' : folderPath.slice(0, slash);
}

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class ShootsPresenter extends CollectionListPresenter<ShootsStore> {
  constructor(store: ShootsStore, private readonly sidebar: SidebarPresenter) {
    super(store);
  }

  async load(libraryId: string): Promise<void> {
    // The store outlives the page, so everything derived from the last library
    // has to go or its folders appear as untracked rows in this one - each with
    // an "Add as shoot" pointing at a path that may not even exist here.
    if (this.store.libraryId !== libraryId) this.switchLibrary(libraryId);
    this.beginLoad();
    try {
      // The folders come with the shoots rather than a level at a time as they
      // are opened: what a folder has under it decides whether it is drawn with a
      // chevron at all, which is a question every row asks before it is clicked.
      // Without them "All folders" can only show what the shoots already say, so
      // a library with none - every folder pass-through, or set aside - shows an
      // empty page under a message telling the reader to look here.
      // Both readings take the same flag, or the tree keeps a hidden shoot's folders after the
      // shoot itself has gone from it and draws them as unclaimed (§12.4).
      const includeHidden = this.store.showHidden;
      const [shoots, folders, root] = await Promise.all([
        shootsApi.list(libraryId, includeHidden),
        librariesApi.folders(libraryId, includeHidden),
        // What the "not in any shoot" row shows, the way a shoot's row shows its
        // own first photograph. Named by nobody, so it is asked for rather than
        // derived: one row of the listing that row opens into, in the ordering
        // the server takes from the library when the request names none - and its
        // count off the same pass, so the number on the row is the number of rows
        // behind it whatever hiding has taken out of either (§12.4).
        photosApi.listLibrary(libraryId, { no_shoot: true, limit: 1 }),
      ]);
      if (this.store.libraryId !== libraryId) return; // navigated away while this was in flight
      // Handed to the sidebar so it follows a rename without reading the same list again -
      // but only the reading it would have asked for itself. With Hidden showing, this
      // one holds the shoots put away, which the sidebar offers no way to put back (§12.4).
      if (!includeHidden) this.sidebar.adopt(libraryId, shoots);
      runInAction(() => {
        this.store.shoots = shoots;
        this.store.folders = folders;
        this.store.rootPhotoCount = root.photo_total ?? 0;
        this.store.rootBannerPhotoId = root.photos[0]?.id ?? null;
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

  @action.bound
  private switchLibrary(libraryId: string): void {
    this.forgetRows();
    this.store.libraryId = libraryId;
    this.store.shoots = [];
    this.store.resolved = new Map();
    this.store.folders = [];
    this.store.rootPhotoCount = 0;
    this.store.rootBannerPhotoId = null;
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
    writeSetting(VIEW_KEY, view);
  }

  // The parent may be a folder the reading skips over, and in flat there are no
  // ancestors at all, so the left arrow walks up until it finds a row.
  protected override parentKey(folderPath: string): string | null {
    const parent = parentOf(folderPath);
    return parent === '' ? null : parent;
  }

  // Whether the shoots put away are drawn, which is about this reader looking rather than about the
  // catalogue - so it is remembered here, beside the reading (§12.4).
  //
  // A re-read rather than a filter lifting: the server does not send a hidden shoot unless the
  // request asks for it, so there is nothing already in hand for a computed to reveal.
  // Hands back the re-read rather than firing it off, so a caller that has to know the rows have
  // landed can wait for them. The writes above it are the action's; only the fetch is awaited.
  @action.bound
  setShowHidden(showHidden: boolean): Promise<void> {
    this.store.showHidden = showHidden;
    this.store.scrollTop = 0;
    writeSetting(SHOW_HIDDEN_KEY, String(showHidden));
    return this.reload();
  }

  @action.bound
  restoreView(): void {
    const saved = readSetting(VIEW_KEY);
    if (saved === 'flat' || saved === 'tree' || saved === 'tree_full') this.store.view = saved;
    this.store.showHidden = readSetting(SHOW_HIDDEN_KEY) === 'true';
  }

  /**
   * Puts a shoot away, or brings it back, its subtree with it (§12.4).
   *
   * The rows are re-read rather than the one patched: the server hides the descendants too, and
   * the shoot's photographs leave every other listing at the same moment.
   */
  async setHidden(shootId: string, hidden: boolean): Promise<void> {
    try {
      await shootsApi.update(shootId, { is_hidden: hidden });
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.reload();
    // Hiding takes the cursor's own row off the list unless the reader is looking at the hidden
    // ones, in which case it stays exactly where it was.
    this.settleCursor();
  }

  // Deep-linking to /shoots/:id gives no library id, so fetch the shoot to learn
  // which library it belongs to and then load that library's shoots. Without this
  // the shell can't show the library the user is actually inside.
  async openShoot(shootId: string): Promise<void> {
    const shoot = await this.ensure(shootId);
    if (shoot != null) await this.load(shoot.library_id);
  }

  /**
   * One shoot by id, whether or not a listing would hold it (§12.4).
   *
   * What lets a reader stand on a hidden shoot - its own page names it, and so does a photograph in
   * it - while the shoots they are working with leave it out. Public because the photographs domain
   * asks: a shoot is the shoots presenter's to fetch, not the photo detail's.
   */
  async ensure(shootId: string): Promise<Shoot | null> {
    const known = this.store.byId.get(shootId);
    if (known != null) return known;
    try {
      const shoot = await shootsApi.get(shootId);
      runInAction(() => this.store.resolved.set(shootId, shoot));
      return shoot;
    } catch (err) {
      this.fail(message(err));
      return null;
    }
  }

  // `parentPath` is the library-relative folder the shoot's own folder goes in,
  // empty for the library root. The parent shoot follows from it server-side.
  async create(libraryId: string, name: string, parentPath: string, ordering: Ordering): Promise<string | null> {
    let shoot: Shoot;
    try {
      shoot = await shootsApi.create({ library_id: libraryId, parent_path: parentPath, name, ordering });
    } catch (err) {
      this.fail(message(err));
      return null;
    }
    await this.load(libraryId);
    return shoot.id;
  }

  // Takes a folder as it stands, photos and all: the shoot's name is the folder's
  // own, and the server adopts what is already inside it (§8.5).
  async adopt(folderPath: string): Promise<void> {
    if (this.store.libraryId === '') return;
    const slash = folderPath.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : folderPath.slice(0, slash);
    await this.create(this.store.libraryId, folderPath.slice(slash + 1), parentPath, 'taken_asc');
  }

  protected override async renameRow(folderPath: string, name: string): Promise<void> {
    const shoot = this.store.shootByFolder.get(folderPath);
    if (shoot == null) return;
    await this.rename(shoot.id, name);
  }

  async rename(shootId: string, name: string): Promise<void> {
    try {
      await shootsApi.update(shootId, { name });
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
      await shootsApi.update(shootId, { ordering });
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
      await shootsApi.delete(shootId, photos);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.reload();
    // The deleted shoot may have been the cursor, and in the shoots-only views
    // its row goes with it.
    this.settleCursor();
  }

  // Called by PhotosPresenter for bulk actions: the shoots domain owns its own
  // writes, so the photos presenter never touches this store directly.
  async addPhotos(shootId: string, target: PhotoTarget): Promise<void> {
    await shootsApi.addPhotos(shootId, target);
  }

  async removePhotos(shootId: string, target: PhotoTarget): Promise<void> {
    await shootsApi.removePhotos(shootId, target);
  }

  // The shoot's own thumbnail in every list that draws one, so the rows are
  // re-read rather than the chosen row patched into place.
  async setBanner(shootId: string, photoId: string): Promise<void> {
    await shootsApi.update(shootId, { banner_photo_id: photoId });
    await this.reload();
  }

  private async reload(): Promise<void> {
    if (this.store.libraryId !== '') await this.load(this.store.libraryId);
  }
}
