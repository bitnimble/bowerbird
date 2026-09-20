import { action } from 'mobx';
import { type ExportRun } from '../../../../src/schemas/exports';
import { exportsApi } from '../../api/exports';
import { shellInvoke } from '../../api/transport';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import type { ExportHistoryStore } from './export_history_store';
import { ExportsPageStrings } from './exports_page.strings';

export class ExportHistoryPresenter {
  constructor(
    private readonly store: ExportHistoryStore,
    private readonly toasts: ToastsPresenter,
  ) {}

  @action.bound
  async load(): Promise<void> {
    this.store.loading = true;
    this.store.error = null;
    try {
      const runs = await exportsApi.list();
      this.loaded(runs);
    } catch {
      this.failed(ExportsPageStrings.couldNotLoad());
    }
  }

  /** Only the desktop shell has a file manager to show a file in; a browser has no path. */
  get canReveal(): boolean {
    return shellInvoke() != null;
  }

  async reveal(path: string): Promise<void> {
    const invoke = shellInvoke();
    if (invoke == null) return;
    try {
      await invoke('reveal_export', { path });
    } catch {
      this.toasts.show(ExportsPageStrings.couldNotShowFile());
    }
  }

  /**
   * Drops one file from the history. The file itself is untouched - it is the reader's, and
   * this page is a record of where it went rather than a handle on it.
   */
  async forget(id: string): Promise<void> {
    try {
      await exportsApi.forget(id);
    } catch {
      this.failed(ExportsPageStrings.couldNotRemove());
      return;
    }
    this.forgot(id);
  }

  /** The same, over every file of one run: what a selection's export is a single row of. */
  async forgetRun(runId: string): Promise<void> {
    try {
      await exportsApi.forgetRun(runId);
    } catch {
      this.failed(ExportsPageStrings.couldNotRemove());
      return;
    }
    this.forgotRun(runId);
  }

  @action.bound
  private failed(error: string): void {
    this.store.loading = false;
    this.store.error = error;
  }

  @action.bound
  private loaded(runs: ExportRun[]): void {
    this.store.runs = runs;
    this.store.loading = false;
  }

  @action.bound
  private forgot(id: string): void {
    this.store.runs = this.store.runs
      .map((run) => ({ ...run, photos: run.photos.filter((photo) => photo.id !== id) }))
      .filter((run) => run.photos.length > 0);
  }

  @action.bound
  private forgotRun(runId: string): void {
    this.store.runs = this.store.runs.filter((run) => run.id !== runId);
  }
}
