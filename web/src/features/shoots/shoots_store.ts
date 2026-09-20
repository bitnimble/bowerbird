import { computed, observable } from 'mobx';
import { type Shoot } from '../../../../src/schemas/shoots';
import { CollectionListStrings } from '../../app/collection_list.strings';
import { CollectionListStore, type CollectionRow } from '../../app/collection_list_store';
import { collectionPath } from '../photos/photos_store';
import { ShootsStoreStrings } from './shoots_store.strings';

// A folder tree and a list of shoots are both honest readings of the same thing,
// so the page offers all three rather than picking one (§18.3.2).
export type ShootView = 'flat' | 'tree' | 'tree_full';

export interface FolderRow extends CollectionRow {
  /** The shoot covering this folder, absent for a folder nobody has claimed. */
  shoot: Shoot | null;
}

/**
 * A shoot the reader has put away, and every shoot under it (§12.4).
 *
 * Read off each row's own flag rather than by testing its ancestors: the server hides a subtree
 * whole, so a descendant carries the flag itself and a nesting the reading does not draw - `flat`
 * draws none - cannot lose it.
 */
function hiddenShoot(shoot: Shoot | null): boolean {
  return shoot?.is_hidden === true;
}

function subtitleOf(shoot: Shoot, prefix: string): string {
  const subtitle = CollectionListStrings.subtitle(prefix, shoot.photo_count);
  return hiddenShoot(shoot) ? CollectionListStrings.hiddenSubtitle(subtitle) : subtitle;
}

function basename(folderPath: string): string {
  return folderPath.slice(folderPath.lastIndexOf('/') + 1);
}

function parentOf(folderPath: string): string {
  const slash = folderPath.lastIndexOf('/');
  return slash < 0 ? '' : folderPath.slice(0, slash);
}

/** Every folder above this one, shallowest first. */
function ancestorsOf(folderPath: string): string[] {
  const found: string[] = [];
  let prefix = '';
  for (const segment of folderPath.split('/').slice(0, -1)) {
    prefix = prefix === '' ? segment : `${prefix}/${segment}`;
    found.push(prefix);
  }
  return found;
}

// A leading slash is the one thing a root-relative folder path cannot start with,
// so nothing on disk can ever collide with it.
export const NO_SHOOT_PATH = '/no-shoot';

export class ShootsStore extends CollectionListStore<FolderRow> {
  @observable.shallow accessor shoots: Shoot[] = [];
  @observable accessor view: ShootView = 'tree';
  // Whether the shoots the reader has put away are drawn, greyed, where they belong (§12.4). What it
  // decides is the *request*: the server leaves them out unless asked, so turning this on is a
  // re-read rather than a filter lifting (`ShootsPresenter.setShowHidden`).
  @observable accessor showHidden = false;
  /** Which library the rows are of, so a row knows where it opens. */
  @observable accessor libraryId = '';
  /** How many photographs the library holds that are in no shoot at all. */
  @observable accessor rootPhotoCount = 0;
  /** The first of them in the library's ordering, which is what its row shows. */
  @observable accessor rootBannerPhotoId: string | null = null;
  /** Every folder on disk, which is the only way to know of the ones holding no photographs. */
  @observable.shallow accessor folders: string[] = [];

  // Shoots learned one at a time rather than off the listing, because the listing leaves the hidden
  // out (§12.4) and a reader can still be standing on one - its own page, or a photograph that names
  // it. Answering "which shoot is this" is not the same question as "which shoots am I working
  // with", and only the second one hides.
  @observable.shallow accessor resolved = new Map<string, Shoot>();

  // The listing wins over what was resolved singly, being the fresher of the two.
  @computed get byId(): Map<string, Shoot> {
    return new Map([...this.resolved, ...this.shoots.map((s): [string, Shoot] => [s.id, s])]);
  }

  @computed get shootByFolder(): Map<string, Shoot> {
    return new Map(this.shoots.map((s) => [s.folder_path, s]));
  }

  override get nests(): boolean {
    return this.view === 'tree_full';
  }

  // The library's folders, from disk and from the shoots' own paths. The two
  // agree about everything the scan looks at; a shoot in a folder the library
  // has since excluded is still a shoot, and still has to be shown.
  //
  // Neither source needs filtering for hiding: the server leaves a hidden shoot out of both unless
  // the reading asked for it (§12.4), so what is here is already what the page draws.
  @computed get knownFolders(): Set<string> {
    const folders = new Set<string>(this.folders);
    for (const shoot of this.shoots) {
      const segments = shoot.folder_path.split('/');
      for (let i = 1; i <= segments.length; i++) folders.add(segments.slice(0, i).join('/'));
    }
    folders.delete('');
    return folders;
  }

  @computed get rows(): FolderRow[] {
    const folders = this.view === 'tree_full' ? this.fullTree : this.shootRows;
    const count = this.rootPhotoCount;
    // Only where it stands for something: a row reading zero opens onto nothing,
    // and while the first read is in flight it would be a populated list over the
    // page saying it is still reading.
    if (count === 0) return folders;
    const noShoot: FolderRow = {
      key: NO_SHOOT_PATH,
      shoot: null,
      tone: 'virtual',
      // Its name carries its own count, so it needs no line under it.
      name: ShootsStoreStrings.noShootRow(count),
      meta: '',
      bannerPhotoId: this.rootBannerPhotoId,
      href: collectionPath({ kind: 'no_shoot', libraryId: this.libraryId }),
      depth: 0,
      expandable: false,
    };
    return [noShoot, ...folders];
  }

  // Shoots alone: unnested and stating their whole path, or nested under the
  // nearest shoot above them with the skipped folders named in the subtitle.
  //
  // Ancestors are found by walking each path's own segments against a Set, not by
  // testing every shoot against every other: mirroring gives a library a shoot per
  // folder, and the pairwise version froze the page for seconds on every rename at
  // a few thousand of them.
  private get shootRows(): FolderRow[] {
    const flat = this.view === 'flat';
    const paths = new Set(this.shoots.map((s) => s.folder_path));
    return [...this.shoots]
      .sort((a, b) => a.folder_path.localeCompare(b.folder_path))
      .map((shoot) => {
        const ancestors = flat ? [] : ancestorsOf(shoot.folder_path).filter((p) => paths.has(p));
        const nearest = ancestors.length === 0 ? null : ancestors[ancestors.length - 1]!;
        const between = nearest == null ? parentOf(shoot.folder_path) : parentOf(shoot.folder_path).slice(nearest.length + 1);
        const skipped = flat ? shoot.folder_path : between === '' ? '' : `${between}/`;
        return {
          key: shoot.folder_path,
          shoot,
          tone: hiddenShoot(shoot) ? ('hidden' as const) : undefined,
          name: shoot.name,
          meta: subtitleOf(shoot, skipped),
          bannerPhotoId: shoot.banner_photo_id,
          href: collectionPath({ kind: 'shoot', shootId: shoot.id }),
          depth: flat ? 0 : ancestors.length,
          expandable: false,
        };
      });
  }

  // Every folder, shoots and untracked alike, walked from the root through
  // whatever is open. A folder nobody has claimed is still a row, because "what
  // have I got" and "make that a shoot" are the same question in the same place.
  private get fullTree(): FolderRow[] {
    const byFolder = this.shootByFolder;
    // Grouped once rather than filtered per expanded row: the walk visits every
    // open folder, and scanning the whole folder set at each of them is quadratic
    // in a tree that is mostly open, which is what auto-expanding to every shoot
    // makes it.
    const children = new Map<string, string[]>();
    for (const folder of this.knownFolders) {
      const parent = parentOf(folder);
      const siblings = children.get(parent);
      if (siblings) siblings.push(folder);
      else children.set(parent, [folder]);
    }
    for (const siblings of children.values()) siblings.sort();
    const childrenOf = (parent: string): string[] => children.get(parent) ?? [];

    const rows: FolderRow[] = [];
    const walk = (parent: string, depth: number): void => {
      for (const folder of childrenOf(parent)) {
        const shoot = byFolder.get(folder) ?? null;
        const name = shoot?.name ?? basename(folder);
        // Only when the label has drifted from the folder it names.
        const drifted = name === basename(folder) ? '' : basename(folder);
        rows.push({
          key: folder,
          shoot,
          tone:
            shoot == null ? 'untracked'
            : hiddenShoot(shoot) ? 'hidden'
            : undefined,
          name,
          // An untracked folder is drawn dimmed and italic already, and has no
          // count to state.
          meta: shoot == null ? drifted : subtitleOf(shoot, drifted),
          bannerPhotoId: shoot?.banner_photo_id ?? null,
          href: shoot == null ? null : collectionPath({ kind: 'shoot', shootId: shoot.id }),
          depth,
          expandable: childrenOf(folder).length > 0,
        });
        if (this.expanded.has(folder)) walk(folder, depth + 1);
      }
    };
    walk('', 0);
    return rows;
  }
}
