import { action } from 'mobx';
import type {
  ImportFileStates,
  ImportHeader,
  ImportJob,
  ImportScan,
  ImportVolume,
} from '../../../../src/schemas/imports';
import type { Shoot } from '../../../../src/schemas/shoots';
import { readSetting, writeSetting } from '../../app/local_setting';
import { importsApi } from '../../api/imports';
import { shootsApi } from '../../api/shoots';
import { describe } from '../../errors';
import { newFolderBrowser } from '../browse/folder_browser_presenter';
import type { ConfirmPresenter } from '../confirm/confirm_presenter';
import type { ShootsPresenter } from '../shoots/shoots_presenter';
import type { ToastsPresenter } from '../toasts/toasts_presenter';
import type { ImportEntry } from './import_entries';
import { ImportPageStrings } from './import_page.strings';
import {
  type ImportFilters,
  type ImportShootChoice,
  type ImportStore,
  NO_IMPORT_FILTERS,
} from './import_store';

const HEADER_BATCH = 50;
const DELETE_ORIGINALS_KEY = 'bowerbird.import.deleteOriginals';

export class ImportPresenter {
  readonly source = newFolderBrowser();
  private scanRun = 0;
  private libraryRun = 0;

  constructor(
    private readonly store: ImportStore,
    private readonly shoots: Pick<ShootsPresenter, 'create'>,
    private readonly toasts: Pick<ToastsPresenter, 'show' | 'showError'>,
    private readonly confirm: Pick<ConfirmPresenter, 'ask'>,
  ) {
    this.restore();
  }

  async loadVolumes(): Promise<void> {
    try {
      this.setVolumes(await importsApi.volumes());
    } catch (err) {
      this.fail(describe(err));
    }
  }

  async loadJob(): Promise<void> {
    try {
      const job = await importsApi.currentJob();
      if (job != null) this.jobProgressed(job);
      else if (this.store.copying) this.forgetJob();
    } catch (err) {
      this.fail(describe(err));
    }
  }

  selectVolume(path: string): void {
    this.source.presenter.selected(path);
  }

  /**
   * Settles the destination whenever the page opens: this store outlives the page, and a library
   * or shoot can be deleted, and photos added, while it is away.
   */
  async chooseLibrary(): Promise<void> {
    const { destinations } = this.store;
    if (destinations.some((library) => library.id === this.store.libraryId)) {
      await this.reloadLibrary(++this.libraryRun, this.store.libraryId);
      return;
    }
    const first = destinations[0];
    if (first != null) await this.setLibrary(first.id);
  }

  async setLibrary(libraryId: string): Promise<void> {
    const run = ++this.libraryRun;
    this.applyLibrary(libraryId);
    await this.reloadLibrary(run, libraryId);
  }

  async scan(): Promise<void> {
    const source = this.source.store.selectedPath;
    if (source === '') return;
    const run = ++this.scanRun;
    this.beginScan();
    try {
      const scan = await importsApi.scan(source);
      if (run !== this.scanRun) return;
      this.landScan(scan);
    } catch (err) {
      if (run === this.scanRun) this.scanFailed(describe(err));
      return;
    }
    await this.refreshFileStates(this.libraryRun);
    void this.readHeaders(run);
  }

  async add(): Promise<void> {
    const { scan, libraryId, shootChoice, newShootName, selectedFileIds, deleteOriginals } =
      this.store;
    if (scan == null || libraryId === '' || selectedFileIds.length === 0) return;
    if (deleteOriginals && !(await this.confirmDeletion(selectedFileIds.length))) return;
    this.setStarting(true);
    try {
      const destination = await this.resolveShoot(libraryId, shootChoice, newShootName);
      if (destination == null) return;
      const job = await importsApi.start({
        scan_id: scan.id,
        library_id: libraryId,
        shoot_id: destination.shootId,
        file_ids: selectedFileIds,
        delete_originals: deleteOriginals,
      });
      // The stream can overtake this answer, which then reads a finished run as still copying.
      if (this.store.job?.id !== job.id) this.jobProgressed(job);
    } catch (err) {
      this.fail(describe(err));
    } finally {
      this.setStarting(false);
    }
  }

  async stop(): Promise<void> {
    try {
      await importsApi.stop();
    } catch (err) {
      this.fail(describe(err));
    }
  }

  @action.bound
  jobProgressed(job: ImportJob): void {
    const previous = this.store.job;
    this.store.job = job;
    if (previous?.status !== 'copying' || job.status === 'copying') return;
    this.announceFinish(job);
    void this.refreshFileStates(this.libraryRun);
  }

  @action.bound
  setShootChoice(choice: ImportShootChoice): void {
    this.store.shootChoice = choice;
  }

  @action.bound
  setNewShootName(name: string): void {
    this.store.newShootName = name;
  }

  @action.bound
  setMerge(merge: boolean): void {
    this.store.merge = merge;
  }

  @action.bound
  setDeleteOriginals(deleteOriginals: boolean): void {
    this.store.deleteOriginals = deleteOriginals;
    writeSetting(DELETE_ORIGINALS_KEY, String(deleteOriginals));
  }

  @action.bound
  setFilters(change: Partial<ImportFilters>): void {
    this.store.filters = { ...this.store.filters, ...change };
  }

  @action.bound
  toggleFilter<K extends 'formats' | 'cameraModels' | 'lensModels'>(
    key: K,
    value: ImportFilters[K][number],
    on: boolean,
  ): void {
    const list = this.store.filters[key];
    this.store.filters = {
      ...this.store.filters,
      [key]: on ? [...list, value] : list.filter((item) => item !== value),
    };
  }

  @action.bound
  resetFilters(): void {
    this.store.filters = NO_IMPORT_FILTERS;
  }

  @action.bound
  toggle(entry: ImportEntry): void {
    const selected = new Set(this.store.selected);
    if (this.store.isSelected(entry)) {
      for (const file of entry.files) selected.delete(file.id);
    } else {
      for (const id of this.idsToAdd(entry)) selected.add(id);
    }
    this.store.selected = selected;
  }

  @action.bound
  selectAll(): void {
    const selected = new Set(this.store.selected);
    for (const entry of this.store.entries) {
      for (const file of entry.files) if (!this.store.inLibrary.has(file.id)) selected.add(file.id);
    }
    this.store.selected = selected;
  }

  @action.bound
  selectNone(): void {
    const selected = new Set(this.store.selected);
    for (const entry of this.store.entries)
      for (const file of entry.files) selected.delete(file.id);
    this.store.selected = selected;
  }

  @action.bound
  setViewport(width: number, height: number): void {
    this.store.viewportWidth = width;
    this.store.viewportHeight = height;
  }

  @action.bound
  setScrollTop(top: number): void {
    this.store.scrollTop = top;
  }

  private confirmDeletion(count: number): Promise<boolean> {
    return this.confirm.ask({
      title: ImportPageStrings.confirmDeleteTitle(count),
      body: ImportPageStrings.confirmDeleteBody(),
      action: ImportPageStrings.confirmDeleteAction(),
      tone: 'danger',
    });
  }

  // Only ticking the whole entry again on a photo the library already holds copies those files.
  private idsToAdd(entry: ImportEntry): number[] {
    const missing = entry.files.filter((file) => !this.store.inLibrary.has(file.id));
    return (missing.length > 0 ? missing : entry.files).map((file) => file.id);
  }

  // Null means the shoot could not be made, which `ShootsPresenter` has already said.
  private async resolveShoot(
    libraryId: string,
    choice: ImportShootChoice,
    newName: string,
  ): Promise<{ shootId: string | null } | null> {
    switch (choice.kind) {
      case 'root':
        return { shootId: null };
      case 'shoot':
        return { shootId: choice.id };
      case 'new': {
        const id = await this.shoots.create(libraryId, newName.trim(), '', 'taken_asc');
        if (id == null) return null;
        const shoots = await shootsApi.list(libraryId);
        this.setShoots(shoots);
        this.setShootChoice({ kind: 'shoot', id });
        this.setNewShootName('');
        return { shootId: id };
      }
    }
  }

  private async reloadLibrary(run: number, libraryId: string): Promise<void> {
    try {
      const shoots = await shootsApi.list(libraryId);
      if (run === this.libraryRun) this.setShoots(shoots);
    } catch (err) {
      if (run === this.libraryRun) this.fail(describe(err));
    }
    await this.refreshFileStates(run);
  }

  private async refreshFileStates(run: number): Promise<void> {
    const { scan, libraryId } = this.store;
    if (scan == null || libraryId === '') return;
    const isCurrent = (): boolean => run === this.libraryRun && scan.id === this.store.scan?.id;
    try {
      const states = await importsApi.fileStates(scan.id, libraryId);
      if (isCurrent()) this.landFileStates(states);
    } catch (err) {
      if (isCurrent()) this.fail(describe(err));
    }
  }

  private async readHeaders(run: number): Promise<void> {
    const scan = this.store.scan;
    if (scan == null) return;
    for (let from = 0; from < scan.files.length; from += HEADER_BATCH) {
      if (run !== this.scanRun) return;
      const ids = scan.files.slice(from, from + HEADER_BATCH).map((file) => file.id);
      try {
        const headers = await importsApi.headers(scan.id, ids);
        if (run === this.scanRun) this.landHeaders(headers);
      } catch {
        return;
      }
    }
  }

  private announceFinish(job: ImportJob): void {
    const added = job.copied + job.skipped;
    if (job.failed > 0) this.toasts.showError(ImportPageStrings.notAllAdded(job.failed));
    else if (job.kept > 0) this.toasts.showError(ImportPageStrings.notAllDeleted(job.kept));
    else if (job.deleted > 0)
      this.toasts.show(ImportPageStrings.addedAndDeleted(added, job.deleted));
    else this.toasts.show(ImportPageStrings.added(added));
  }

  @action.bound
  private restore(): void {
    this.store.deleteOriginals = readSetting(DELETE_ORIGINALS_KEY) === 'true';
  }

  @action.bound
  private forgetJob(): void {
    this.store.job = null;
  }

  @action.bound
  private setVolumes(volumes: ImportVolume[]): void {
    this.store.volumes = volumes;
  }

  @action.bound
  private setShoots(shoots: Shoot[]): void {
    this.store.shoots = shoots;
    const choice = this.store.shootChoice;
    if (choice.kind === 'shoot' && !shoots.some((shoot) => shoot.id === choice.id))
      this.store.shootChoice = { kind: 'root' };
  }

  @action.bound
  private applyLibrary(libraryId: string): void {
    this.store.libraryId = libraryId;
    this.store.shoots = [];
    this.store.shootChoice = { kind: 'root' };
    // A ticked format this library doesn't list would leave an empty grid with no row to untick it.
    this.store.filters = { ...this.store.filters, formats: [] };
  }

  @action.bound
  private beginScan(): void {
    this.store.scanning = true;
    this.store.error = null;
    this.store.scan = null;
    this.store.headers = new Map();
    this.store.inLibrary = new Set();
    this.store.selected = new Set();
    this.store.filters = NO_IMPORT_FILTERS;
    this.store.scrollTop = 0;
  }

  @action.bound
  private landScan(scan: ImportScan): void {
    this.store.scanning = false;
    this.store.scan = scan;
    this.store.selected = new Set(scan.files.map((file) => file.id));
  }

  @action.bound
  private landFileStates(states: ImportFileStates): void {
    const inLibrary = new Set(states.in_library);
    const selected = new Set(this.store.selected);
    for (const id of states.in_library) if (!this.store.inLibrary.has(id)) selected.delete(id);
    // What another destination held isn't held here, so its untick no longer stands.
    for (const id of this.store.inLibrary) if (!inLibrary.has(id)) selected.add(id);
    for (const id of states.deleted) selected.delete(id);
    this.store.inLibrary = inLibrary;
    this.store.selected = selected;
    this.dropDeleted(new Set(states.deleted));
  }

  private dropDeleted(deleted: ReadonlySet<number>): void {
    const { scan } = this.store;
    if (scan == null || deleted.size === 0) return;
    this.store.scan = { ...scan, files: scan.files.filter((file) => !deleted.has(file.id)) };
    this.store.headers = new Map(
      [...this.store.headers].filter(([fileId]) => !deleted.has(fileId)),
    );
  }

  @action.bound
  private landHeaders(headers: ImportHeader[]): void {
    const held = new Map(this.store.headers);
    for (const header of headers) held.set(header.file_id, header);
    this.store.headers = held;
  }

  @action.bound
  private setStarting(starting: boolean): void {
    this.store.starting = starting;
    if (starting) this.store.error = null;
  }

  @action.bound
  private scanFailed(error: string): void {
    this.store.scanning = false;
    this.store.error = error;
  }

  @action.bound
  private fail(error: string): void {
    this.store.error = error;
  }
}
