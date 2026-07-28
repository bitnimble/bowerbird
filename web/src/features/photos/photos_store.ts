import { computed, observable } from 'mobx';
import type { Ordering, PhotoDetail, PhotoSummary, PreviewRendition, Triage } from '../../api/client';
import type { LibrariesStore } from '../libraries/libraries_store';
import type { AppSettingsStore } from '../settings/app_settings_store';

// Which collection the grid is showing. One store serves the library, shoot,
// album, bin and missing views because they differ only in the fetch call.
export type PhotoSource =
  | { kind: 'library'; libraryId: string }
  | { kind: 'shoot'; shootId: string }
  | { kind: 'album'; albumId: string }
  | { kind: 'bin'; libraryId: string }
  | { kind: 'missing'; libraryId: string };

// grid crops every tile to one aspect so rows line up and the eye can scan;
// masonry keeps each photo's own shape; list trades density for metadata.
export type ViewMode = 'grid' | 'masonry' | 'list';

// What the user narrowed the view to. Separate from PhotoSource: the source is
// which collection, this is which slice of it.
export interface PhotoFilters {
  rated?: boolean;
  triage?: Triage[];
  isMissing?: boolean;
  needsProcessing?: boolean;
  search?: string;
  // Inclusive YYYY-MM-DD bounds from the calendar.
  takenFrom?: string;
  takenTo?: string;
  // 'any' is what the Custom menu sends: picking "picks, unrated and missing"
  // means a photo that is any of those, which as an intersection is empty.
  match?: 'all' | 'any';
}

// A gallery opens on the working set: everything not yet rejected. Rejecting is
// a decision to stop seeing a frame, so it should leave the view at once. Lives
// here so the presenter's opening state and the "Active" chip cannot disagree.
export function activeFilters(): PhotoFilters {
  return { triage: ['untriaged', 'picked'] };
}

export class PhotosStore {
  // Read-only peers, both for resolving which rendition the viewer opens at
  // without waiting on the photo's detail: the setting says which one the reader
  // wants, the library says which one is certain to have been built.
  constructor(
    private readonly settings: AppSettingsStore,
    private readonly libraries: LibrariesStore,
  ) {}

  // Deep, not shallow: a tile observes its own row's fields, so rating or
  // rejecting one photo re-renders that tile alone. Shallow rows can only be
  // updated by replacing the array, which invalidates every tile in the grid.
  @observable accessor photos: PhotoSummary[] = [];
  @observable accessor total = 0;
  @observable accessor offset = 0;
  @observable accessor limit = 100;
  @observable accessor source: PhotoSource | null = null;
  @observable accessor loading = false;
  @observable accessor error: string | null = null;

  @observable accessor filters: PhotoFilters = {};
  @observable accessor ordering: Ordering = 'taken_desc';

  // Minimum tile width in px, driven by the grid's zoom slider.
  @observable accessor thumbSize = 240;
  @observable accessor mode: ViewMode = 'grid';

  // A Map, not a Set, purely for observability: mobx's ObservableSet reports its
  // whole atom on `has`, so every tile would re-render whenever any tile was
  // selected. ObservableMap tracks `has` per key, so only the tile that changed
  // re-renders. The value is unused.
  @observable accessor selected = new Map<string, true>();
  // Anchor for shift-click range selection: the last photo toggled on its own.
  @observable accessor lastToggled: string | null = null;

  // Which tile the keyboard is on. -1 means the grid has not been entered yet.
  @observable accessor focusIndex = -1;

  // The rendition picked for this photo, for as long as it is open: the same
  // picture at one of three quality levels, each built on request and cached
  // (§10.2). Null until something is picked, which is the usual state - the
  // setting answers for the rest, and `showing` is what is actually on screen.
  @observable accessor rendition: PreviewRendition | null = null;
  @observable accessor buildingRendition = false;

  // Rebuild a rendition even when one is already on disk. Session-scoped and off
  // by default: it is for working on the pipeline, where the cached copy is the
  // thing standing between a changed setting and seeing what it did.
  @observable accessor forceRebuild = false;

  @observable.ref accessor detail: PhotoDetail | null = null;
  @observable accessor detailLoading = false;
  // Which photo the detail state is about, in flight or landed. What tells "no
  // such photo" apart from "not asked for yet": `detail` still holds the
  // previous one across a step, and the fetch for the next does not start until
  // the effect that follows its first render.
  @observable accessor requestedDetailId: string | null = null;
  @observable accessor notesSavedAt: number | null = null;

  @computed get selectedIds(): string[] {
    return [...this.selected.keys()];
  }

  @computed get selectionCount(): number {
    return this.selected.size;
  }

  @computed get hasSelection(): boolean {
    return this.selected.size > 0;
  }

  @computed get allOnPageSelected(): boolean {
    return this.photos.length > 0 && this.photos.every((p) => this.selected.has(p.id));
  }

  // Length first, so a populated grid's dependency on `loading` short-circuits
  // away: it toggles twice on every refetch, and the answer cannot change.
  @computed get isEmpty(): boolean {
    return this.photos.length === 0 && !this.loading;
  }

  @computed get focusedPhoto(): PhotoSummary | null {
    return this.photos[this.focusIndex] ?? null;
  }

  @computed get isBin(): boolean {
    return this.source?.kind === 'bin';
  }

  // The shell reads this rather than detail?.library_id. As a computed it only
  // notifies when the *library* changes, so stepping through photos in one
  // library never re-renders the rail or the title bar.
  @computed get detailLibraryId(): string | null {
    return this.detail?.library_id ?? null;
  }

  // What the open photo's library builds on import: it serves the camera's JPEG
  // or it renders. The server names this on the detail, but it is a property of
  // the *library*, and the library list is loaded for the rail long before any
  // photo is opened - so it is read from the row the grid already holds. Taken
  // off the detail it was a fetch behind, which is what made the viewer paint a
  // render for a reader set to the camera's JPEG and swap it out a moment later;
  // and in an album spanning two libraries it was the previous photo's answer.
  @computed get defaultRendition(): PreviewRendition {
    const photo = this.photos.find((p) => p.id === this.requestedDetailId);
    const library = this.libraries.byId.get(photo?.library_id ?? this.detail?.library_id ?? '');
    // Unknown only until the collection loads, and the camera's JPEG is the one
    // rendition every photo has, so it is the safe answer to guess with.
    return library?.preview_source === 'render' ? 'full' : 'embedded';
  }

  // What the setting alone says to open at, before the photo's detail lands.
  // Null when only the detail can answer: the per-photo memory lives on it, and
  // 'remember' has nothing to remember until something is picked.
  @computed get preferredRendition(): PreviewRendition | null {
    const mode = this.settings.previewRenditionMode;
    if (mode === 'remember') return this.settings.lastPreviewRendition;
    if (mode === 'remember_per_photo') return null;
    return mode;
  }

  // The rendition on screen. Answered from the setting wherever it can be, so
  // stepping to the next photo asks for the file the reader actually wants on
  // the first frame instead of painting the library's default and swapping.
  @computed get showing(): PreviewRendition {
    if (this.rendition != null) return this.rendition;
    const preferred = this.preferredRendition;
    return preferred != null && this.isAlwaysBuilt(preferred) ? preferred : this.defaultRendition;
  }

  // Exists for every photo in the library, so it can be asked for before that
  // photo's own detail says whether it does: the camera's JPEG is extracted from
  // the RAW on demand, and the library's default is built on import. The other
  // two are built on request, and asking early is a 404, not a picture.
  isAlwaysBuilt(rendition: PreviewRendition): boolean {
    return rendition === 'embedded' || rendition === this.defaultRendition;
  }

  @computed get hasActiveFilters(): boolean {
    const f = this.filters;
    return (
      f.rated != null ||
      f.triage != null ||
      f.isMissing != null ||
      f.needsProcessing != null ||
      f.takenFrom != null ||
      f.takenTo != null ||
      (f.search ?? '') !== ''
    );
  }

  @computed get pageStart(): number {
    return this.total === 0 ? 0 : this.offset + 1;
  }

  @computed get pageEnd(): number {
    return Math.min(this.offset + this.photos.length, this.total);
  }

  @computed get pageCount(): number {
    return Math.max(1, Math.ceil(this.total / this.limit));
  }

  @computed get pageIndex(): number {
    return Math.floor(this.offset / this.limit);
  }

  @computed get hasPrevPage(): boolean {
    return this.offset > 0;
  }

  @computed get hasNextPage(): boolean {
    return this.offset + this.limit < this.total;
  }

  // Position of the open photo within the loaded page, so the detail view can
  // step to its neighbours. Off the photo that was asked for, not the detail on
  // hand: that is still the previous photo until the fetch lands, and stepping
  // faster than it does made the arrow keys offer the neighbours of the frame
  // before - so a press navigated to the photo already open and did nothing.
  @computed get detailIndex(): number {
    const id = this.requestedDetailId;
    return id == null ? -1 : this.photos.findIndex((p) => p.id === id);
  }

  @computed get prevPhotoId(): string | null {
    const i = this.detailIndex;
    return i > 0 ? (this.photos[i - 1]?.id ?? null) : null;
  }

  @computed get nextPhotoId(): string | null {
    const i = this.detailIndex;
    return i >= 0 && i < this.photos.length - 1 ? (this.photos[i + 1]?.id ?? null) : null;
  }
}
