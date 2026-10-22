import { action } from 'mobx';
import type { EditTabsStore } from './edit_tabs_store';

export class EditTabsPresenter {
  private shownIds: readonly string[] | null = null;

  constructor(private readonly store: EditTabsStore) {}

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
}
