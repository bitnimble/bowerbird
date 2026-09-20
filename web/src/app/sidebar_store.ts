import { computed, observable } from 'mobx';
import { type Shoot } from '../../../src/schemas/shoots';
import type { AppSettingsStore } from '../features/settings/app_settings_store';

/** A shoot and the shoots filed under it, as the sidebar nests them. */
export interface ShootNode {
  shoot: Shoot;
  children: ShootNode[];
}

// A library stands open and everything under it starts shut, so the set below
// holds what differs from that rather than what is open: a library the reader has
// never touched is in no set and is open all the same.
export function opensByDefault(key: string): boolean {
  return key.startsWith('library:');
}

export class SidebarStore {
  constructor(private readonly settings: AppSettingsStore) {}

  /** The desktop preference, remembered across visits. */
  @observable accessor collapsed = false;
  /** Where the sidebar overlays the content, whether the drawer is pulled out. */
  @observable accessor drawerOpen = false;
  /** Asked back inside the viewer that hid it, for this visit to the viewer only. */
  @observable accessor revealed = false;
  @observable accessor mobile = false;
  @observable accessor viewing = false;

  @computed get hiddenByViewer(): boolean {
    return this.viewing && this.settings.hideSidebarInViewer;
  }

  @computed get open(): boolean {
    if (this.mobile) return this.drawerOpen;
    return this.revealed || (!this.collapsed && !this.hiddenByViewer);
  }

  /** Each library's shoots, absent until its Shoots row is first opened. */
  @observable.shallow accessor shootsByLibrary = new Map<string, Shoot[]>();
  @observable.shallow accessor toggled = new Set<string>();
  /** What a drag made the sidebar, or null while it is at the width the stylesheet gives it. */
  @observable accessor width: number | null = null;

  isOpen(key: string): boolean {
    return this.toggled.has(key) !== opensByDefault(key);
  }

  @computed get shootTrees(): Map<string, ShootNode[]> {
    return new Map([...this.shootsByLibrary].map(([libraryId, shoots]) => [libraryId, nest(shoots)]));
  }
}

// By `parent_id` rather than by folder path: the sidebar lists shoots, and the
// folders in between two of them are the Shoots page's full tree, not this one.
//
// Nothing here filters the shoots put away: the listing this is built from does not
// carry them unless it was asked to, and a second filter in each consumer is the
// shape of rule that hiding was moved to the server to stop being (§12.4).
function nest(shoots: Shoot[]): ShootNode[] {
  const nodes = new Map(shoots.map((shoot) => [shoot.id, { shoot, children: [] as ShootNode[] }]));
  const roots: ShootNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.shoot.parent_id == null ? null : nodes.get(node.shoot.parent_id);
    (parent?.children ?? roots).push(node);
  }
  const sort = (siblings: ShootNode[]): void => {
    siblings.sort((a, b) => a.shoot.name.localeCompare(b.shoot.name));
    for (const node of siblings) sort(node.children);
  };
  sort(roots);
  return roots;
}
