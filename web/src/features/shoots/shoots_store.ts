import { computed, observable } from 'mobx';
import type { Shoot } from '../../api/client';

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

export class ShootsStore {
  @observable.shallow accessor shoots: Shoot[] = [];
  @observable accessor loading = false;
  @observable accessor error: string | null = null;
  @observable accessor view: ShootView = 'tree';
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

  // Shoots alone: unnested and stating their whole path, or nested under the
  // nearest shoot above them with the skipped folders named in the subtitle.
  private get shootRows(): FolderRow[] {
    const flat = this.view === 'flat';
    const paths = this.shoots.map((s) => s.folder_path).sort();
    return [...this.shoots]
      .sort((a, b) => a.folder_path.localeCompare(b.folder_path))
      .map((shoot) => {
        const ancestors = flat ? [] : paths.filter((p) => shoot.folder_path.startsWith(`${p}/`));
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
    const known = this.knownFolders;
    const childrenOf = (parent: string): string[] =>
      [...known].filter((folder) => parentOf(folder) === parent && folder !== parent).sort();

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
