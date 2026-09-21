import { action } from 'mobx';
import type { SliderIsolationRectangle } from '../../ui/slider_isolation';
import type { MobileEditPanelsStore } from './mobile_edit_panels_store';

export class MobileEditPanelsPresenter {
  constructor(private readonly store: MobileEditPanelsStore) {}

  @action.bound
  toggle = (id: string): void => {
    if (this.store.activeSlider != null) return;
    this.store.expanded = this.store.selectedId !== id || !this.store.expanded;
    this.store.selectedId = id;
  };

  @action.bound
  navigate = (id: string, ids: readonly string[], key: string): string | null => {
    if (this.store.activeSlider != null || ids.length === 0) return null;
    const index = ids.indexOf(id);
    const next = key === 'ArrowRight' ? (index + 1) % ids.length
      : key === 'ArrowLeft' ? (index + ids.length - 1) % ids.length
      : key === 'Home' ? 0
      : key === 'End' ? ids.length - 1
      : null;
    if (next == null) return null;
    this.store.selectedId = ids[next] ?? null;
    this.store.expanded = true;
    return this.store.selectedId;
  };

  @action.bound
  close = (): void => {
    if (this.store.activeSlider != null) return;
    this.store.expanded = false;
  };

  @action.bound
  begin = (id: string, rectangle: SliderIsolationRectangle): void => {
    if (!this.store.expanded || this.store.activeSlider != null) return;
    this.store.activeSlider = { id, rectangle };
  };

  @action.bound
  end = (id: string): void => {
    if (this.store.activeSlider?.id === id) this.store.activeSlider = null;
  };

  @action.bound
  dispose = (): void => {
    this.store.activeSlider = null;
    this.store.expanded = false;
  };
}
