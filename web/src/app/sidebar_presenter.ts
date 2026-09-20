import { action, runInAction } from 'mobx';
import { type Shoot } from '../../../src/schemas/shoots';
import { shootsApi } from '../api/shoots';
import { readSetting, writeSetting } from './local_setting';
import { inViewer } from './sidebar_state';
import type { SidebarStore } from './sidebar_store';

const COLLAPSED_KEY = 'bowerbird.sidebar.collapsed';
const OPEN_KEY = 'bowerbird.sidebar.toggled';
const WIDTH_KEY = 'bowerbird.sidebar.width';

const MIN_WIDTH = 160;
const MAX_WIDTH = 520;
// Mirrors `size.sidebar` in `tokens.stylex.ts`, which is what the sidebar is until a drag says
// otherwise - and the arrow keys need a number before there has ever been one.
const DEFAULT_WIDTH = 208;

const RESIZE_STEP = 16;

function clamp(width: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
}

export class SidebarPresenter {
  constructor(private readonly store: SidebarStore) {
    this.restore();
  }

  /** Opens or shuts whichever of the drawer, the viewer's override or the preference is in charge. */
  @action.bound
  toggleOpen(): void {
    if (this.store.mobile) {
      this.store.drawerOpen = !this.store.drawerOpen;
      return;
    }
    if (this.store.hiddenByViewer) {
      this.store.revealed = !this.store.revealed;
      return;
    }
    this.store.collapsed = !this.store.collapsed;
    writeSetting(COLLAPSED_KEY, this.store.collapsed ? '1' : '0');
  }

  @action.bound
  setDrawerOpen(open: boolean): void {
    this.store.drawerOpen = open;
  }

  @action.bound
  setMobile(mobile: boolean): void {
    this.store.mobile = mobile;
  }

  /** Tapping a link asked for the page, not for the drawer to stay over it; leaving the viewer puts back what it hid. */
  @action.bound
  navigated(pathname: string): void {
    this.store.drawerOpen = false;
    this.store.viewing = inViewer(pathname);
    if (!this.store.viewing) this.store.revealed = false;
  }

  @action.bound
  private restore(): void {
    this.store.collapsed = readSetting(COLLAPSED_KEY) === '1';
    const open = readSetting(OPEN_KEY);
    if (open != null && open !== '') this.store.toggled = new Set(open.split('\n'));
    const width = Number(readSetting(WIDTH_KEY));
    if (Number.isFinite(width) && width > 0) this.store.width = clamp(width);
  }

  @action.bound
  toggle(key: string): void {
    if (this.store.toggled.has(key)) this.store.toggled.delete(key);
    else this.store.toggled.add(key);
    writeSetting(OPEN_KEY, [...this.store.toggled].join('\n'));
  }

  @action.bound
  setWidth(width: number): void {
    this.store.width = clamp(width);
    writeSetting(WIDTH_KEY, String(this.store.width));
  }

  @action.bound
  nudgeWidth(steps: number): void {
    this.setWidth((this.store.width ?? DEFAULT_WIDTH) + steps * RESIZE_STEP);
  }

  /** The shoots an opened Shoots row lists, fetched once per library. */
  async loadShoots(libraryId: string): Promise<void> {
    if (this.store.shootsByLibrary.has(libraryId)) return;
    // Claimed before the request rather than after it, so a second render while
    // it is in flight does not fire another.
    const claim: Shoot[] = [];
    this.adopt(libraryId, claim);
    try {
      const shoots = await shootsApi.list(libraryId);
      // The Shoots page reads the same list and hands it straight over, so by now
      // this answer may be the older of the two - and after a rename, the wrong
      // one. The claim still being what is there is what says nothing has landed.
      if (this.store.shootsByLibrary.get(libraryId) !== claim) return;
      this.adopt(libraryId, shoots);
    } catch {
      // Dropped rather than reported: the sidebar is a list of destinations, and one
      // that would not load is retried the next time it is opened. Not over a page
      // that read the list meanwhile, which has given the sidebar something better
      // than the nothing this would leave it with.
      if (this.store.shootsByLibrary.get(libraryId) !== claim) return;
      runInAction(() => this.store.shootsByLibrary.delete(libraryId));
    }
  }

  /** What the Shoots page has just read, so the sidebar follows a rename without asking again. */
  @action.bound
  adopt(libraryId: string, shoots: Shoot[]): void {
    this.store.shootsByLibrary.set(libraryId, shoots);
  }
}
