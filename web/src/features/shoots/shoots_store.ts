import { computed, observable } from 'mobx';
import type { Shoot } from '../../api/client';
import { type Span, visibleRows } from '../../ui/virtual_rows';

// A folder tree and a list of shoots are both honest readings of the same thing,
// so the page offers all three rather than picking one (§18.3.2).
export type ShootView = 'flat' | 'tree' | 'tree_full';

export interface FolderRow {
  /** Root-relative folder path; `''` is the library root, which is always shown. */
  folderPath: string;
  /** The shoot covering this folder, absent for a folder nobody has claimed. */
  shoot: Shoot | null;
  name: string;
  /** What the name cannot say: the folders skipped above it, or the folder's own name. */
  subtitle: string;
  depth: number;
  photoCount: number;
  /** Whether it has anything under it to open, so a chevron is only offered where it does. */
  expandable: boolean;
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

// What .list__row is fixed to, plus its border. A row that grew with its
// contents would make the scroll's height a measurement rather than a sum.
export const SHOOT_ROW_H = 47;

export class ShootsStore {
  @observable.shallow accessor shoots: Shoot[] = [];
  @observable accessor loading = false;
  @observable accessor error: string | null = null;
  @observable accessor view: ShootView = 'tree';
  // Written by the presenter from a ResizeObserver and the scroll handler, so
  // every layout question below is a computed rather than a DOM read (§18.2).
  @observable accessor viewportHeight = 0;
  @observable accessor scrollTop = 0;
  /** How many photographs the library holds that are in no shoot at all. */
  @observable accessor rootPhotoCount = 0;
  /** Folders whose children are drawn; every ancestor of a shoot is one. */
  @observable.shallow accessor expanded = new Set<string>(['']);
  /** Child folders read from the server, for the ones holding no photographs. */
  @observable.shallow accessor browsed = new Map<string, string[]>();

  @computed get byId(): Map<string, Shoot> {
    return new Map(this.shoots.map((s) => [s.id, s]));
  }

  @computed get shootByFolder(): Map<string, Shoot> {
    return new Map(this.shoots.map((s) => [s.folder_path, s]));
  }

  // Everything a delete would take with it, which is the whole subtree and not
  // just the shoot's own members: removing a shoot's photographs removes every
  // photograph under its folder, descendant shoots included. The dialog says this
  // number out loud, so it has to be the one that is about to be true.
  photosUnder(folderPath: string): number {
    return this.shoots
      .filter((s) => s.folder_path === folderPath || s.folder_path.startsWith(`${folderPath}/`))
      .reduce((total, s) => total + s.photo_count, 0);
  }

  @computed get isEmpty(): boolean {
    return !this.loading && this.shoots.length === 0;
  }

  // Every folder the page knows of without asking: each shoot's own folder and
  // every folder on the way to it. The shoots carry their full paths, so the
  // hierarchy is already in hand and only genuinely empty folders need a request.
  @computed get knownFolders(): Set<string> {
    const folders = new Set<string>();
    for (const shoot of this.shoots) {
      const segments = shoot.folder_path.split('/');
      for (let i = 1; i <= segments.length; i++) folders.add(segments.slice(0, i).join('/'));
    }
    for (const [parent, children] of this.browsed) {
      folders.add(parent);
      for (const child of children) folders.add(child);
    }
    folders.delete('');
    return folders;
  }

  @computed get rows(): FolderRow[] {
    return this.view === 'tree_full' ? this.fullTree : this.shootRows;
  }

  // Mirroring gives a library a shoot per folder, so this list is as long as the
  // tree is: the same reason the gallery scrolls virtually (§18.3.2), reached
  // from the other direction. Rows are uniform, so the whole thing is arithmetic
  // over the viewport and one row height.
  @computed get visible(): Span {
    return visibleRows(this.scrollTop, this.viewportHeight, SHOOT_ROW_H, this.rows.length);
  }

  /** The rows actually mounted, and where to put the window holding them. */
  @computed get visibleRowsSlice(): FolderRow[] {
    return this.rows.slice(this.visible.from, this.visible.to);
  }

  @computed get visibleTop(): number {
    return this.visible.from * SHOOT_ROW_H;
  }

  @computed get scrollHeight(): number {
    return this.rows.length * SHOOT_ROW_H;
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
        return {
          folderPath: shoot.folder_path,
          shoot,
          name: shoot.name,
          subtitle: flat ? shoot.folder_path : between === '' ? '' : `${between}/`,
          depth: flat ? 0 : ancestors.length,
          photoCount: shoot.photo_count,
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
        rows.push({
          folderPath: folder,
          shoot,
          name,
          // Only when the label has drifted from the folder it names.
          subtitle: name === basename(folder) ? '' : basename(folder),
          depth,
          photoCount: shoot?.photo_count ?? 0,
          expandable: true,
        });
        if (this.expanded.has(folder)) walk(folder, depth + 1);
      }
    };
    walk('', 0);
    return rows;
  }
}
