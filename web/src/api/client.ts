import type { Album, CreateAlbumRequest, UpdateAlbumRequest } from '../../../src/schemas/albums';
import type { BrowseResponse } from '../../../src/schemas/browse';
import type {
  CreateLibraryRequest,
  FolderRule,
  Library,
  LibrarySettings,
  LibrarySyncStatus,
  SetFolderRuleRequest,
  UpdateLibraryRequest,
} from '../../../src/schemas/libraries';
import type {
  PhotoDetail,
  PhotoListResponse,
  PhotoNeighboursRequest,
  PhotoPositionsRequest,
  PhotoRangeRequest,
  PhotoSelection,
  PhotoTarget,
  Triage,
  UpdatePhotoRequest,
} from '../../../src/schemas/photos';
import type { Stack } from '../../../src/schemas/stacks';
import type { ViewerRendition, ViewerRenditionMode, Settings, UpdateSettingsRequest } from '../../../src/schemas/settings';
import type { CreateShootRequest, Shoot, ShootRemoval, UpdateShootRequest } from '../../../src/schemas/shoots';
import type { Rendition } from '../../../src/services/processing/renditions';
import type { ProcessingStage } from '../../../src/services/processing/processing_types';
import { type Reply, assetUrl, send } from './transport';

// Types come straight from the server's Zod schemas as type-only imports, so the
// client can never drift from the API and nothing is added to the bundle.
export type {
  Album,
  BrowseResponse,
  CreateLibraryRequest,
  FolderRule,
  Library,
  LibrarySettings,
  LibrarySyncStatus,
  PhotoDetail,
  PhotoListResponse,
  PhotoSelection,
  PhotoTarget,
  ViewerRendition,
  ViewerRenditionMode,
  Settings,
  UpdateSettingsRequest,
  Shoot,
  Triage,
  UpdateLibraryRequest,
};
export type PhotoSummary = PhotoListResponse['photos'][number];
export type { Rendition, ProcessingStage };
export type Ordering = Library['ordering'];
// One type for both: the library states which source to build renditions from,
// and each photo records the one it was actually built with.
export type RenditionSource = Library['rendition_source'];

// Every URL below is same-origin: the web server proxies /api and /image through
// to the API, which the browser cannot reach itself once the web server is the
// only thing exposed. Where the API actually lives is the proxy's business
// (VITE_API_URL / VITE_API_PORT in vite.config.ts), not the client's.

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/**
 * Every call below, over whichever transport is running (`transport.ts`).
 *
 * `cmd` is the caller's own name and is carried rather than used: it is what a Rust side
 * answering from a local library would match on, and until offline mode exists every one
 * of them proxies. Derived from the method and path so a new call cannot forget one.
 */
async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let reply: Reply;
  try {
    reply = await send(commandName(method, path), method, path, body, signal);
  } catch (err) {
    // A transport only rejects when it never got an answer, so this is "API unreachable",
    // which is a different thing for the UI to say than any HTTP status.
    throw new ApiError('NETWORK_ERROR', `cannot reach the API at ${path}: ${(err as Error).message}`, 0);
  }

  if (reply.status === 204 || reply.bytes.length === 0) return undefined as T;

  const text = new TextDecoder().decode(reply.bytes);
  if (reply.status < 200 || reply.status >= 300) throw errorFrom(reply.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    return null as T;
  }
}

/** `PATCH /api/libraries/abc/photos` becomes `patch:libraries/:id/photos`. */
function commandName(method: string, path: string): string {
  const route = path
    .split('?')[0]!
    .replace(/^\/(api|image)\//, '')
    .split('/')
    .map((part) => (/^[0-9a-f-]{16,}$/i.test(part) ? ':id' : part))
    .join('/');
  return `${method.toLowerCase()}:${route}`;
}

function errorFrom(status: number, text: string): ApiError {
  let envelope: ErrorEnvelope | null = null;
  try {
    envelope = JSON.parse(text) as ErrorEnvelope;
  } catch {
    envelope = null;
  }
  return new ApiError(
    envelope?.error?.code ?? 'INTERNAL_ERROR',
    envelope?.error?.message ?? text.slice(0, 200),
    status,
  );
}

export interface PhotoListParams {
  offset?: number;
  limit?: number;
  /** Defaults on. Off for blocks after the first of a pass, which cannot change the total. */
  count?: boolean;
  is_missing?: boolean;
  needs_tile?: boolean;
  include_deleted?: boolean;
  is_deleted?: boolean;
  rated?: boolean;
  triage?: Triage[];
  ordering?: Ordering;
  q?: string;
  taken_from?: string;
  taken_to?: string;
  match?: 'all' | 'any';
  /** Every photograph of a stack as a row of its own, rather than the stack as one (§19.5.4). */
  expand_stacks?: boolean;
}

function query(params: PhotoListParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) search.set(key, String(value));
  }
  const s = search.toString();
  return s === '' ? '' : `?${s}`;
}

export const api = {
  getSettings: (): Promise<Settings> => request('GET', '/api/settings'),
  updateSettings: (body: UpdateSettingsRequest): Promise<Settings> => request('PATCH', '/api/settings', body),
  // What the app ships with, so the settings page can say which values have been
  // moved and put them back. Asked for rather than compiled in: the defaults are
  // the server's, and a client holding its own copy is a client that can disagree
  // with the database about what "default" means.
  getSettingsDefaults: (): Promise<Settings> => request('GET', '/api/settings/defaults'),
  // The server's directories, not this browser's: a library root is a path the
  // server has to be able to open.
  browse: (path?: string): Promise<BrowseResponse> =>
    request('GET', `/api/browse${path == null ? '' : `?path=${encodeURIComponent(path)}`}`),
  // Folders inside one library, in the root-relative paths a shoot's folder is
  // stored as, and refusing anything above the root.
  browseLibrary: (libraryId: string, path = ''): Promise<BrowseResponse> =>
    request('GET', `/api/libraries/${libraryId}/browse?path=${encodeURIComponent(path)}`),
  // Where a folder differs from what the library's settings say in general (§4.7).
  listFolderRules: (libraryId: string): Promise<FolderRule[]> => request('GET', `/api/libraries/${libraryId}/folder-rules`),
  setFolderRule: (libraryId: string, body: SetFolderRuleRequest): Promise<FolderRule[]> =>
    request('PUT', `/api/libraries/${libraryId}/folder-rules`, body),
  clearFolderRule: (libraryId: string, folderPath: string): Promise<void> =>
    request('DELETE', `/api/libraries/${libraryId}/folder-rules?folder_path=${encodeURIComponent(folderPath)}`),
  listLibraries: (): Promise<Library[]> => request('GET', '/api/libraries'),
  /** The per-library knobs a new library is created with, for the same reason as `getSettingsDefaults`. */
  getLibraryDefaults: (): Promise<LibrarySettings> => request('GET', '/api/libraries/defaults'),
  getLibrary: (id: string): Promise<Library> => request('GET', `/api/libraries/${id}`),
  createLibrary: (body: CreateLibraryRequest): Promise<Library> => request('POST', '/api/libraries', body),
  updateLibrary: (id: string, body: UpdateLibraryRequest): Promise<Library> => request('PATCH', `/api/libraries/${id}`, body),
  deleteLibrary: (id: string): Promise<void> => request('DELETE', `/api/libraries/${id}`),
  syncLibrary: (id: string): Promise<LibrarySyncStatus> => request('POST', `/api/libraries/${id}/sync`),
  cancelSync: (id: string): Promise<void> => request('DELETE', `/api/libraries/${id}/sync`),
  getSyncStatus: (id: string): Promise<LibrarySyncStatus> => request('GET', `/api/libraries/${id}/sync/status`),
  rebuildLibraryTiles: (id: string): Promise<LibrarySyncStatus> => request('POST', `/api/libraries/${id}/jobs/tiles`),
  rebuildLibraryRenditions: (id: string): Promise<LibrarySyncStatus> =>
    request('POST', `/api/libraries/${id}/jobs/renditions`),

  // The list calls take a signal because a scroll abandons blocks faster than
  // they answer: without it every request a flick started stays on the wire,
  // competing with the ones the reader is actually waiting for.
  listLibraryPhotos: (libraryId: string, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> =>
    request('GET', `/api/libraries/${libraryId}/photos${query(params)}`, undefined, signal),
  listMissingPhotos: (libraryId: string, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> =>
    request('GET', `/api/libraries/${libraryId}/photos/missing${query(params)}`, undefined, signal),
  getPhoto: (id: string): Promise<PhotoDetail> => request('GET', `/api/photos/${id}`),
  updatePhoto: (id: string, body: UpdatePhotoRequest): Promise<PhotoDetail> => request('PATCH', `/api/photos/${id}`, body),
  // Every bulk call names its photos either by id or by position in a filtered
  // collection (§18.3.3), so a selection of a hundred thousand is one small
  // request rather than a client reading back every id first.
  // The bin stamps its rows with a batch the caller generates, and the undo names
  // that batch rather than every id: the selection resolves elsewhere once those
  // photos have left the collection, and a million ids would be a 36MB round
  // trip in each direction (§12.3). Generated client-side so the undo still
  // works if the answer never arrives.
  deletePhotos: (target: PhotoTarget, batch: string): Promise<{ deleted: number }> =>
    request('POST', '/api/photos/delete', { ...target, batch }),
  restorePhotos: (target: PhotoTarget): Promise<void> => request('POST', '/api/photos/restore', target),
  rebuildTiles: (target: PhotoTarget): Promise<{ queued: number }> => request('POST', '/api/photos/rebuild-tiles', target),
  refreshMetadata: (target: PhotoTarget): Promise<{ updated: number }> =>
    request('POST', '/api/photos/refresh-metadata', target),
  buildRendition: (photoId: string, rendition: Rendition, force = false): Promise<void> =>
    request('POST', `/api/photos/${photoId}/renditions/${rendition}${force ? '?force=true' : ''}`),

  listShoots: (libraryId: string): Promise<Shoot[]> => request('GET', `/api/libraries/${libraryId}/shoots`),
  getShoot: (id: string): Promise<Shoot> => request('GET', `/api/shoots/${id}`),
  createShoot: (body: CreateShootRequest): Promise<Shoot> => request('POST', '/api/shoots', body),
  updateShoot: (id: string, body: UpdateShootRequest): Promise<Shoot> => request('PATCH', `/api/shoots/${id}`, body),
  // How many photo records `photos: 'remove'` would take, counted by the server
  // with the same query the delete runs (§8.5).
  getShootRemoval: (id: string): Promise<ShootRemoval> => request('GET', `/api/shoots/${id}/removal`),
  // 'remove' takes the photo records and their renditions with the shoot; the
  // files on disk are untouched either way (§8.5).
  deleteShoot: (id: string, photos: 'keep' | 'remove'): Promise<void> =>
    request('DELETE', `/api/shoots/${id}?photos=${photos}`),
  addPhotosToShoot: (id: string, target: PhotoTarget): Promise<void> => request('POST', `/api/shoots/${id}/photos`, target),
  removePhotosFromShoot: (id: string, target: PhotoTarget): Promise<void> =>
    request('DELETE', `/api/shoots/${id}/photos`, target),
  listShootPhotos: (id: string, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> =>
    request('GET', `/api/shoots/${id}/photos${query(params)}`, undefined, signal),

  listAlbums: (): Promise<Album[]> => request('GET', '/api/albums'),
  createAlbum: (body: CreateAlbumRequest): Promise<Album> => request('POST', '/api/albums', body),
  updateAlbum: (id: string, body: UpdateAlbumRequest): Promise<Album> => request('PATCH', `/api/albums/${id}`, body),
  deleteAlbum: (id: string): Promise<void> => request('DELETE', `/api/albums/${id}`),
  addPhotosToAlbum: (id: string, target: PhotoTarget): Promise<void> => request('POST', `/api/albums/${id}/photos`, target),
  removePhotosFromAlbum: (id: string, target: PhotoTarget): Promise<void> =>
    request('DELETE', `/api/albums/${id}/photos`, target),
  listAlbumPhotos: (id: string, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> =>
    request('GET', `/api/albums/${id}/photos${query(params)}`, undefined, signal),

  // Stacks (§19). A stack is made from whatever the bulk bar has selected, which
  // is positions rather than ids for anything larger than a screenful, so this
  // takes the same target shape every other bulk call does.
  createStack: (target: PhotoTarget): Promise<Stack> => request('POST', '/api/stacks', target),
  // Every member, so a shoot can dim the ones that are not in it; `albumId`
  // narrows to what that album holds, because an album is strict (§19.5.3).
  listStackPhotos: (
    id: string,
    options: { albumId?: string; deleted?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<PhotoSummary[]> => {
    const search = new URLSearchParams();
    if (options.albumId != null) search.set('album_id', options.albumId);
    if (options.deleted === true) search.set('deleted', 'true');
    const query = search.toString();
    return request('GET', `/api/stacks/${id}/photos${query === '' ? '' : `?${query}`}`, undefined, signal);
  },
  unstack: (id: string): Promise<void> => request('DELETE', `/api/stacks/${id}`),
  removeFromStack: (id: string, photoIds: string[]): Promise<void> =>
    request('POST', `/api/stacks/${id}/remove`, { photo_ids: photoIds }),
  // Where rows sit in a collection now, so open bands and the scroll anchor can
  // be re-placed after an import or a re-order instead of being thrown away
  // (§19.6.1). A key is a stack id or a photo id, and it names every position it
  // stands for: one collapsed row, or one per member uncollapsed (§19.5.4).
  photoPositions: (body: PhotoPositionsRequest, signal?: AbortSignal): Promise<Record<string, number[]>> =>
    request('POST', '/api/photos/positions', body, signal),
  // What the viewer's arrows step through: the collection uncollapsed, so a stack
  // is one tile in the grid and every frame of it in the viewer (§19.5.3). Rows
  // rather than ids, because a warmed neighbour is fetched at the URL its own
  // stamps version - given only an id the stage paints one file and downloads
  // another when the row lands.
  photoNeighbours: (body: PhotoNeighboursRequest, signal?: AbortSignal): Promise<PhotoSummary[]> =>
    request('POST', '/api/photos/neighbours', body, signal),
  // The same listing asked for by its ends: hand it the photographs a stack lies
  // between and it answers with the stack, so nothing on this side has to know
  // which end of the collection's ordering is "after".
  photoRange: (body: PhotoRangeRequest, signal?: AbortSignal): Promise<PhotoSummary[]> =>
    request('POST', '/api/photos/range', body, signal),
};

// The URLs below are loaded by the browser itself - an `<img>`, an `EventSource`, a
// download - so they cannot go through `send`, and under the desktop shell they carry its
// own scheme instead (`assetUrl`). Everything after the prefix is the same path the API
// serves, which is what keeps one set of routes for both.

// `version` is appended only once renditions have been rebuilt in this session:
// the file changes behind a stable URL, and an image already decoded in the page
// is never re-requested without it.
// One URL shape for every stored rendition. Dynamic range is not in the URL: the
// library decides it, so a client guessing would ask for a file that was never
// built (§10.2). Firefox is served the same AVIF as everything else and rewraps
// it into a video for itself (`hdr_video.ts`).
export function renditionUrl(photoId: string, rendition: Rendition, version = 0): string {
  const url = assetUrl(`/image/${photoId}/renditions/${rendition}`);
  return version === 0 ? url : `${url}?v=${version}`;
}

// The camera's own JPEG, handed over as the camera wrote it (§10.2). Versioned
// like a stored rendition even though nothing builds it: it is lifted out of the
// RAW on each request, so a RAW replaced on disk changes these bytes too, and a
// page holding the previous ones would otherwise never ask again.
export function embeddedUrl(photoId: string, version = 0): string {
  const url = assetUrl(`/image/${photoId}/embedded.jpg`);
  return version === 0 ? url : `${url}?v=${version}`;
}

// Server-sent events: which photos have a rendition worth re-requesting.
export function eventsUrl(): string {
  return assetUrl('/api/events');
}

// One of the four things a photo can be taken away as: the RAW itself, or any of
// the three renditions the viewer offers. No extension in the URL - the
// catalogue holds several RAW formats, and the server names the download off the
// file it served.
export function downloadUrl(photoId: string, form: 'original' | ViewerRendition): string {
  return assetUrl(`/image/${photoId}/download/${form}`);
}

/**
 * The editor's open: the decoded, fitted and warped frame every tick then grades.
 *
 * Seconds of work and hundreds of megabytes back, asked for once per photo rather than per
 * tick (`docs/raw-edit-gpu.md` §10.2b). `longEdge` is the client's, not the library's, and
 * 0 is the sensor's own resolution.
 *
 * A path rather than a URL: this one *is* fetched, through `send`, because the frame is the
 * one response whose bytes go straight into a texture upload.
 */
export function preparedPath(photoId: string, longEdge: number): string {
  return `/image/${photoId}/prepared?longEdge=${Math.round(longEdge)}`;
}

// What the viewer shows for one of its three choices: the camera's JPEG served
// directly, or a stored rendition.
export function viewerUrl(photoId: string, rendition: ViewerRendition, version = 0): string {
  return rendition === 'embedded' ? embeddedUrl(photoId, version) : renditionUrl(photoId, rendition, version);
}
