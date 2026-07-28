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

// Which photo the detail view is on, and what came back for it. A union rather
// than a detail plus two flags: "missing" carries the reason that made it
// missing, so a failure to read one photo cannot be reported as the state of
// another, and no combination of flags can describe a state that cannot happen.
export type OpenPhoto = { id: string; status: 'loading' | 'ready' } | { id: string; status: 'missing'; error: string };

// Which generation of a photo's renditions to ask the server for. The row
// carries it, so it is known for the frame on screen and for a neighbour being
// warmed alike, it survives a reload, and every client agrees - none of which a
// version a client made up for itself could manage (§13.5). 0 for a photo whose
// renditions have never been built, and before its row has loaded, which leaves
// the URL plain and the ETag in charge.
export function renditionVersion(photo: { date_reprocessed: string | null } | null | undefined): number {
  return photo?.date_reprocessed == null ? 0 : Date.parse(photo.date_reprocessed);
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

  // The photo the viewer is on and how far its read has got. One value, so it
  // cannot say "loading" and "no such photo" at once, and so "not asked for yet"
  // (null) is distinct from both: the fetch starts in an effect, and the render
  // before it once read as a photo the catalogue does not have.
  @observable.ref accessor open: OpenPhoto | null = null;
  // The last detail that arrived, which is the *previous* photo's until this
  // one's read lands - deliberately, so the rail and the panels do not collapse
  // on every step. Nothing should read it without saying which photo it wants,
  // which is what `detailFor` is for.
  @observable.ref accessor loadedDetail: PhotoDetail | null = null;
  @observable accessor notesSavedAt: number | null = null;

  // This photo's detail, or null while it is still the one before it. Every
  // consumer needs this check and none of them can be trusted to remember it:
  // the store holds one detail, the view holds another photo's id, and the two
  // disagree for the length of a fetch.
  detailFor(photoId: string): PhotoDetail | null {
    return this.loadedDetail?.id === photoId ? this.loadedDetail : null;
  }

  // For a photo the view knows only by id - the neighbours the viewer warms.
  // Anything holding the row itself reads `renditionVersion` off it directly,
  // which is both cheaper and narrower to observe.
  renditionVersionOf(photoId: string | null): number {
    if (photoId == null) return 0;
    return renditionVersion(this.photos.find((p) => p.id === photoId) ?? this.detailFor(photoId));
  }

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
    return this.loadedDetail?.library_id ?? null;
  }

  // The open photo as the client already knows it: the row the grid loaded, or
  // the last detail when there is no row to have (a deep link, before the
  // collection behind it is fetched). Everything the viewer has to decide before
  // its own fetch returns is answered from here.
  @computed get openPhoto(): PhotoSummary | null {
    const id = this.open?.id;
    return id == null ? null : (this.photos.find((p) => p.id === id) ?? this.detailFor(id));
  }

  // What the open photo's library builds on import: it serves the camera's JPEG
  // or it renders. The server names this on the detail, but it is a property of
  // the *library*, and the library list is loaded for the rail long before any
  // photo is opened - so it is read from the row the grid already holds. Taken
  // off the detail it was a fetch behind, which is what made the viewer paint a
  // render for a reader set to the camera's JPEG and swap it out a moment later;
  // and in an album spanning two libraries it was the previous photo's answer.
  @computed get defaultRendition(): PreviewRendition {
    const library = this.libraries.byId.get(this.openPhoto?.library_id ?? '');
    // Unknown only until the collection loads, and the camera's JPEG is the one
    // rendition every photo has, so it is the safe answer to guess with.
    return library?.preview_source === 'render' ? 'full' : 'embedded';
  }

  // What the setting says to open at. Null only when nothing has been chosen for
  // it to remember: the per-photo memory is on the row like everything else the
  // first frame needs, so "last used per photo" no longer has to wait for the
  // detail and paint the library's default in the meantime.
  @computed get preferredRendition(): PreviewRendition | null {
    const mode = this.settings.previewRenditionMode;
    if (mode === 'remember') return this.settings.lastPreviewRendition;
    if (mode === 'remember_per_photo') return this.openPhoto?.preview_rendition ?? null;
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
    const id = this.open?.id;
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
