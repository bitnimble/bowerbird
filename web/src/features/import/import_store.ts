import { computed, observable } from 'mobx';
import type {
  ImportFile,
  ImportHeader,
  ImportJob,
  ImportScan,
  ImportVolume,
} from '../../../../src/schemas/imports';
import type { PhotoFormat } from '../../../../src/schemas/photos';
import type { Shoot } from '../../../../src/schemas/shoots';
import { visibleRows, type Span } from '../../ui/virtual_rows';
import type { LibrariesStore } from '../libraries/libraries_store';
import { dayDensities } from '../photos/grid/photo_filters';
import { buildEntries, filenameOf, type ImportEntry, isRawFormat } from './import_entries';

export const IMPORT_TILE = 180;
export const IMPORT_TILE_GAP = 8;

export interface ImportFilters {
  search: string;
  formats: PhotoFormat[];
  cameraModels: string[];
  lensModels: string[];
  takenFrom: string | undefined;
  takenTo: string | undefined;
  hideInLibrary: boolean;
}

export const NO_IMPORT_FILTERS: ImportFilters = {
  search: '',
  formats: [],
  cameraModels: [],
  lensModels: [],
  takenFrom: undefined,
  takenTo: undefined,
  hideInLibrary: false,
};

export type ImportShootChoice = { kind: 'root' } | { kind: 'shoot'; id: string } | { kind: 'new' };

export class ImportStore {
  constructor(private readonly libraries: Pick<LibrariesStore, 'byId'>) {}

  @observable.ref accessor volumes: ImportVolume[] = [];
  @observable accessor libraryId = '';
  @observable.ref accessor shoots: Shoot[] = [];
  @observable.ref accessor shootChoice: ImportShootChoice = { kind: 'root' };
  @observable accessor newShootName = '';

  @observable accessor scanning = false;
  @observable accessor error: string | null = null;
  @observable.ref accessor scan: ImportScan | null = null;
  @observable.ref accessor headers: ReadonlyMap<number, ImportHeader> = new Map();
  @observable.ref accessor inLibrary: ReadonlySet<number> = new Set();
  @observable.ref accessor selected: ReadonlySet<number> = new Set();

  @observable accessor merge = true;
  @observable.ref accessor filters: ImportFilters = NO_IMPORT_FILTERS;

  @observable accessor viewportWidth = 0;
  @observable accessor viewportHeight = 0;
  @observable accessor scrollTop = 0;

  @observable.ref accessor job: ImportJob | null = null;
  @observable accessor starting = false;

  @computed get copying(): boolean {
    return this.job?.status === 'copying';
  }

  // A library that takes only RAWs never makes a row for a copied JPEG, so it would never appear.
  @computed get files(): readonly ImportFile[] {
    const found = this.scan?.files ?? [];
    return this.libraries.byId.get(this.libraryId)?.include_non_raw === false
      ? found.filter((file) => isRawFormat(file.format))
      : found;
  }

  @computed get unlistedCount(): number {
    return (this.scan?.files.length ?? 0) - this.files.length;
  }

  @computed get formatOptions(): PhotoFormat[] {
    return [...new Set(this.files.map((file) => file.format))];
  }

  @computed get cameraModelOptions(): string[] {
    return this.modelOptions((header) => header.camera_model);
  }

  @computed get lensModelOptions(): string[] {
    return this.modelOptions((header) => header.lens_model);
  }

  @computed get days(): string[] {
    return [...new Set(this.files.map((file) => this.dayOf(file)))].sort();
  }

  @computed get dayDensity(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const file of this.files) {
      const day = this.dayOf(file);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return dayDensities([...counts].map(([day, count]) => ({ day, count })));
  }

  @computed get activeFilterCount(): number {
    const { search, formats, cameraModels, lensModels, takenFrom, takenTo, hideInLibrary } =
      this.filters;
    return [
      search !== '',
      formats.length > 0,
      cameraModels.length > 0,
      lensModels.length > 0,
      takenFrom != null || takenTo != null,
      hideInLibrary,
    ].filter(Boolean).length;
  }

  @computed get entries(): ImportEntry[] {
    const { formats } = this.filters;
    const kept =
      formats.length === 0
        ? this.files
        : this.files.filter((file) => formats.includes(file.format));
    return buildEntries(kept, this.merge)
      .filter((entry) => this.passes(entry))
      .sort(
        (a, b) => b.lead.modified_at.localeCompare(a.lead.modified_at) || a.lead.id - b.lead.id,
      );
  }

  @computed get selectedFileIds(): number[] {
    return this.entries.flatMap((entry) =>
      entry.files.filter((file) => this.selected.has(file.id)).map((file) => file.id),
    );
  }

  @computed get selectedEntryCount(): number {
    return this.entries.filter((entry) => this.isSelected(entry)).length;
  }

  @computed get columns(): number {
    return Math.max(
      1,
      Math.floor((this.viewportWidth + IMPORT_TILE_GAP) / (IMPORT_TILE + IMPORT_TILE_GAP)),
    );
  }

  @computed get rowCount(): number {
    return Math.ceil(this.entries.length / this.columns);
  }

  @computed get rowHeight(): number {
    return IMPORT_TILE + IMPORT_TILE_GAP;
  }

  @computed get visibleSpan(): Span {
    return visibleRows(this.scrollTop, this.viewportHeight, this.rowHeight, this.rowCount);
  }

  isSelected(entry: ImportEntry): boolean {
    return entry.files.some((file) => this.selected.has(file.id));
  }

  isInLibrary(entry: ImportEntry): boolean {
    return entry.files.every((file) => this.inLibrary.has(file.id));
  }

  private modelOptions(model: (header: ImportHeader) => string | null): string[] {
    const models = new Set<string>();
    for (const header of this.headers.values()) {
      const value = model(header);
      if (value != null) models.add(value);
    }
    return [...models].sort((a, b) => a.localeCompare(b));
  }

  // Until its header lands, a file is dated by its mtime and passes the camera and lens ticks.
  private passes(entry: ImportEntry): boolean {
    const { search, cameraModels, lensModels, takenFrom, takenTo, hideInLibrary } = this.filters;
    if (hideInLibrary && this.isInLibrary(entry)) return false;
    if (search !== '') {
      const needle = search.toLowerCase();
      if (!entry.files.some((file) => filenameOf(file).toLowerCase().includes(needle)))
        return false;
    }
    const day = this.dayOf(entry.lead);
    if (takenFrom != null && day < takenFrom) return false;
    if (takenTo != null && day > takenTo) return false;
    const header = this.headers.get(entry.lead.id);
    if (header == null) return true;
    if (cameraModels.length > 0 && !cameraModels.includes(header.camera_model ?? '')) return false;
    return lensModels.length === 0 || lensModels.includes(header.lens_model ?? '');
  }

  private dayOf(file: ImportFile): string {
    // A taken date is the camera's wall clock as a Z string, so its UTC day is the day it reads.
    const taken = this.headers.get(file.id)?.date_taken;
    if (taken != null) return taken.slice(0, 10);
    const modified = new Date(file.modified_at);
    const month = String(modified.getMonth() + 1).padStart(2, '0');
    const date = String(modified.getDate()).padStart(2, '0');
    return `${modified.getFullYear()}-${month}-${date}`;
  }
}
