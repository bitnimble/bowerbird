import { action } from 'mobx';
import { readSetting, writeSetting } from '../../app/local_setting';
import type { EditTabsStore } from './edit_tabs_store';

const COLLAPSED_KEY = 'bowerbird.edit.collapsed';

export class EditTabsPresenter {
  private shownIds: readonly string[] | null = null;

  constructor(private readonly store: EditTabsStore) {
    this.restore();
  }

  @action.bound
  select = (id: string): void => {
    this.store.selectedId = id;
  };

  /** Selects a tab that appears after the first showing, such as a soft proof's. */
  @action.bound
  syncTabs = (ids: readonly string[]): void => {
    const before = this.shownIds;
    this.shownIds = ids;
    const added = ids.find((id) => before != null && !before.includes(id));
    if (added != null) this.store.selectedId = added;
  };

  @action.bound
  toggleCollapsed = (id: string): void => {
    const next = new Set(this.store.collapsed);
    if (!next.delete(id)) next.add(id);
    this.store.collapsed = next;
    writeSetting(COLLAPSED_KEY, [...next].join('\n'));
  };

  @action.bound
  private restore(): void {
    const kept = readSetting(COLLAPSED_KEY);
    if (kept != null && kept !== '') this.store.collapsed = new Set(kept.split('\n'));
  }
}
