import { action, runInAction } from 'mobx';
import { type Ordering, type RenditionSource } from '../../../../src/schemas/common';
import { type CreateLibraryRequest, type FolderRule, type Library, type UpdateLibraryRequest } from '../../../../src/schemas/libraries';
import { type OptionalStage, type RenderedRendition } from '../../../../src/schemas/render_stages';
import { folderRulesApi } from '../../api/folder_rules';
import { librariesApi } from '../../api/libraries';
import { ApiError } from '../../api/request';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import { LibrariesPresenterStrings } from './libraries_presenter.strings';
import { benchmarkKey, type LibrariesStore } from './libraries_store';

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error).message;
}

export class LibrariesPresenter {
  constructor(
    private readonly store: LibrariesStore,
    private readonly toasts: ToastsPresenter,
  ) {}

  async load(): Promise<void> {
    this.beginLoad();
    try {
      // Alongside the list rather than once at startup: it is one small immutable
      // record, and pairing them means the settings page never has a library in
      // hand with nothing to compare it against.
      const [libraries, defaults] = await Promise.all([librariesApi.list(), librariesApi.getDefaults()]);
      runInAction(() => {
        this.store.libraries = libraries;
        this.store.defaults = defaults;
        this.store.loading = false;
      });
    } catch (err) {
      this.fail(message(err));
    }
  }

  /**
   * Null when the library was not created. `READ_ONLY` is handed back to the
   * caller as well as reported, because it is the one refusal the dialog can act
   * on: the root is not writable after all, and the answer is to tick the box
   * rather than to read an error. `access(2)` can be wrong - an exotic ACL, a
   * volume remounted between the listing and the create - so this is reachable
   * even when the picker said the folder was writable.
   */
  async create(request: CreateLibraryRequest): Promise<{ created: Library | null; readOnlyRoot: boolean }> {
    this.beginLoad();
    let created: Library;
    try {
      created = await librariesApi.create(request);
    } catch (err) {
      this.fail(message(err));
      return { created: null, readOnlyRoot: err instanceof ApiError && err.code === 'READ_ONLY' };
    }
    await this.load();
    return { created, readOnlyRoot: false };
  }

  async setOrdering(libraryId: string, ordering: Ordering): Promise<void> {
    await this.update(libraryId, { ordering });
  }

  async setName(libraryId: string, name: string): Promise<void> {
    if (name.trim() === '') return;
    await this.update(libraryId, { name: name.trim() });
  }

  // Which pixels new photos get their renditions from, and whether the full-size
  // one is HDR. Not retroactive: it decides what gets built next, and rebuilding
  // an existing catalogue is an explicit action (§10.2).
  async setRenditionSource(libraryId: string, rendition_source: RenditionSource): Promise<void> {
    await this.update(libraryId, { rendition_source });
  }

  async setRenditionHdr(libraryId: string, rendition_hdr: boolean): Promise<void> {
    await this.update(libraryId, { rendition_hdr });
  }

  /**
   * Whether that rendition runs that stage. Not retroactive, like everything else in this panel:
   * it decides what gets built next, and rebuilding a catalogue is a job you ask for.
   *
   * Stored as what is left *out*, so the row is empty for a library that has traded nothing away
   * and a stage added in a later version arrives switched on.
   */
  async setRenderStage(
    libraryId: string,
    rendition: RenderedRendition,
    stage: OptionalStage,
    runs: boolean,
  ): Promise<void> {
    const library = this.store.byId.get(libraryId);
    if (library == null) return;
    const skipped = rendition === 'full' ? library.render_skip_full : library.render_skip_max;
    const next =
      runs ? skipped.filter((off) => off !== stage)
      : skipped.includes(stage) ? skipped
      : [...skipped, stage];
    await this.update(libraryId, rendition === 'full' ? { render_skip_full: next } : { render_skip_max: next });
  }

  /**
   * Times this library's own render here, so the panel stops quoting one machine's estimates.
   *
   * Minutes on a `max`. The list is re-read afterwards because the answer is filed under the
   * library, which is what the panel draws from.
   */
  async benchmarkRender(libraryId: string, rendition: RenderedRendition): Promise<void> {
    if (this.store.isBenchmarking(libraryId, rendition)) return;
    this.markBenchmarking(libraryId, rendition, true);
    try {
      await librariesApi.benchmarkRender(libraryId, rendition);
      await this.load();
    } catch (err) {
      this.toasts.showError(LibrariesPresenterStrings.couldNotBenchmark(), message(err));
    } finally {
      this.markBenchmarking(libraryId, rendition, false);
    }
  }

  @action.bound
  private markBenchmarking(libraryId: string, rendition: RenderedRendition, running: boolean): void {
    const key = benchmarkKey(libraryId, rendition);
    if (running) this.store.benchmarking.add(key);
    else this.store.benchmarking.delete(key);
  }

  // Automatic photo stacking (§19.4). None of the three is retroactive: they
  // decide what the next detection pass does, and that pass runs when a sync
  // brings something in.
  async setAutoStack(libraryId: string, auto_stack: boolean): Promise<void> {
    await this.update(libraryId, { auto_stack });
  }

  async setAutoStackSimilarity(libraryId: string, auto_stack_similarity: number): Promise<void> {
    if (!Number.isFinite(auto_stack_similarity)) return;
    await this.update(libraryId, { auto_stack_similarity: Math.min(1, Math.max(0, auto_stack_similarity)) });
  }

  async setAutoStackWindow(libraryId: string, auto_stack_window_seconds: number): Promise<void> {
    if (!Number.isFinite(auto_stack_window_seconds)) return;
    await this.update(libraryId, { auto_stack_window_seconds: Math.max(1, Math.round(auto_stack_window_seconds)) });
  }

  // The pass the three settings above decide, run now instead of at the next sync.
  // It finishes without moving anything on this page, so the count is the only sign
  // it ran at all.
  async detectStacks(libraryId: string): Promise<void> {
    try {
      const { stacks } = await librariesApi.detectStacks(libraryId);
      this.toasts.show(LibrariesPresenterStrings.stacksDetected(stacks));
    } catch (err) {
      this.fail(message(err));
    }
  }

  // How much of the folder tree the library is (§4.1).
  async setIncludeSubfolders(libraryId: string, include_subfolders: boolean): Promise<void> {
    await this.update(libraryId, { include_subfolders });
  }

  // Whether the rendered formats are photographs here. Both directions are a scan away rather
  // than immediate: turning it on imports every one of them on the next one, and turning it off
  // makes the next scan stop finding them, so their rows go missing exactly as they would if the
  // files had been moved off the disk. The files are never touched either way.
  async setIncludeNonRaw(libraryId: string, include_non_raw: boolean): Promise<void> {
    await this.update(libraryId, { include_non_raw });
  }

  // Whether the app may write under the library root at all. Clearing it on a
  // library that has never had a bin needs one named in the same request, since
  // that is a folder this is about to make.
  async setReadOnly(libraryId: string, read_only: boolean, bin_name?: string): Promise<void> {
    await this.update(libraryId, read_only ? { read_only } : { read_only, bin_name });
  }

  // Renames the folder on disk as well as the setting: changing one without the
  // other would strand every already-binned RAW in a folder the scan walks back in.
  async setBinName(libraryId: string, bin_name: string): Promise<void> {
    if (bin_name.trim() === '') return;
    await this.update(libraryId, { bin_name: bin_name.trim() });
  }

  async loadFolderRules(libraryId: string): Promise<void> {
    try {
      const rules = await folderRulesApi.list(libraryId);
      this.putFolderRules(libraryId, rules);
    } catch (err) {
      this.fail(message(err));
    }
  }

  // Returns the folder to whatever the library's settings say in general, which
  // for an excluded one means the next sync imports its photographs afresh.
  async clearFolderRule(libraryId: string, folderPath: string): Promise<void> {
    try {
      await folderRulesApi.clear(libraryId, folderPath);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.loadFolderRules(libraryId);
  }

  @action.bound
  private putFolderRules(libraryId: string, rules: FolderRule[]): void {
    this.store.folderRules.set(libraryId, rules);
  }

  private async update(libraryId: string, body: UpdateLibraryRequest): Promise<void> {
    try {
      await librariesApi.update(libraryId, body);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  async remove(libraryId: string): Promise<void> {
    try {
      await librariesApi.delete(libraryId);
    } catch (err) {
      this.fail(message(err));
      return;
    }
    await this.load();
  }

  @action.bound
  clearError(): void {
    this.store.error = null;
  }

  @action.bound
  private beginLoad(): void {
    this.store.loading = true;
    this.store.error = null;
  }

  @action.bound
  private fail(error: string): void {
    this.store.loading = false;
    this.store.error = error;
  }
}
