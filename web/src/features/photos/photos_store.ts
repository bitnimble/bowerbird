import { computed, observable } from 'mobx';
import type { Ordering, PhotoDetail, PhotoSummary, PreviewRendition, Triage } from '../../api/client';

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

  // Bumped on every completed list fetch. A tile whose thumbnail 404'd (it was
  // still being generated) uses this to know a newer generation exists and the
  // image is worth requesting again.
  @observable accessor reloadToken = 0;

  // Bumped when thumbnails are rebuilt. The file changes behind a URL that does
  // not, so images already decoded in the page would otherwise never be
  // re-requested; appending this defeats that without polluting normal URLs.
  @observable accessor rebuiltAt = 0;

  // Which rendition the detail view is showing: the same picture at one of three
  // quality levels, each built on request and cached (§10.2). Null is the photo's
  // own thumbnail, which is whichever of the first two the library builds on
  // import, and is the only one that costs nothing to show.
  @observable accessor rendition: PreviewRendition | null = null;
  @observable accessor buildingRendition = false;

  // Rebuild a rendition even when one is already on disk. Session-scoped and off
  // by default: it is for working on the pipeline, where the cached copy is the
  // thing standing between a changed setting and seeing what it did.
  @observable accessor forceRebuild = false;

  @observable.ref accessor detail: PhotoDetail | null = null;
  @observable accessor detailLoading = false;
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

  @computed get isEmpty(): boolean {
    return !this.loading && this.photos.length === 0;
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

  // Position of the open detail photo within the loaded page, so the detail view
  // can step to its neighbours.
  @computed get detailIndex(): number {
    return this.detail == null ? -1 : this.photos.findIndex((p) => p.id === this.detail?.id);
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
