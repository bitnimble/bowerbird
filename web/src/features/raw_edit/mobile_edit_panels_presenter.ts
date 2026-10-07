import { action } from 'mobx';
import type { IsolationRectangle } from '../../ui/isolation';
import type { MobileEditPanelsStore } from './mobile_edit_panels_store';

export class MobileEditPanelsPresenter {
  constructor(private readonly store: MobileEditPanelsStore) {}

  @action.bound
  toggle = (id: string): void => {
    if (this.store.isolated != null) return;
    this.store.expanded = this.store.selectedId !== id || !this.store.expanded;
    this.store.selectedId = id;
  };

  @action.bound
  navigate = (id: string, ids: readonly string[], key: string): string | null => {
    if (this.store.isolated != null || ids.length === 0) return null;
    const index = ids.indexOf(id);
    const next =
      key === 'ArrowRight'
        ? (index + 1) % ids.length
        : key === 'ArrowLeft'
          ? (index + ids.length - 1) % ids.length
          : key === 'Home'
            ? 0
            : key === 'End'
              ? ids.length - 1
              : null;
    if (next == null) return null;
    this.store.selectedId = ids[next] ?? null;
    this.store.expanded = true;
    return this.store.selectedId;
  };

  @action.bound
  close = (): void => {
    if (this.store.isolated != null) return;
    this.store.expanded = false;
  };

  @action.bound
  begin = (id: string, rectangle: IsolationRectangle): void => {
    if (!this.store.expanded || this.store.isolated != null) return;
    this.store.isolated = { id, rectangle };
  };

  @action.bound
  end = (id: string): void => {
    if (this.store.isolated?.id === id) this.store.isolated = null;
  };

  @action.bound
  dispose = (): void => {
    this.store.isolated = null;
    this.store.expanded = false;
  };
}
