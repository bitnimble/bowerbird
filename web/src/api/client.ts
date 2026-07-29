import type { Album, CreateAlbumRequest, UpdateAlbumRequest } from '../../../src/schemas/albums';
import type { CreateLibraryRequest, Library, LibrarySyncStatus, UpdateLibraryRequest } from '../../../src/schemas/libraries';
import type { PhotoDetail, PhotoListResponse, PhotoSelection, PhotoTarget, Triage, UpdatePhotoRequest } from '../../../src/schemas/photos';
import type { ViewerRendition, ViewerRenditionMode, Settings, UpdateSettingsRequest } from '../../../src/schemas/settings';
import type { CreateShootRequest, Shoot, UpdateShootRequest } from '../../../src/schemas/shoots';
import type { Rendition } from '../../../src/services/processing/renditions';
import type { ProcessingStage } from '../../../src/services/processing/processing_types';

// Types come straight from the server's Zod schemas as type-only imports, so the
// client can never drift from the API and nothing is added to the bundle.
export type {
  Album,
  Library,
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

// Default to the API on the same host the page was served from. Hardcoding
// localhost only works when the browser runs on the server; reached over the
// network, "localhost" is the viewer's own machine and every call fails.
// VITE_API_URL overrides this when the API lives elsewhere.
function defaultApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3000';
  return `${window.location.protocol}//${window.location.hostname}:3000`;
}

const BASE: string = import.meta.env.VITE_API_URL ?? defaultApiBase();

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // fetch only rejects on transport failure, so this is "API unreachable",
    // which is a different thing for the UI to say than any HTTP status.
    throw new ApiError('NETWORK_ERROR', `cannot reach the API at ${BASE}: ${(err as Error).message}`, 0);
  }

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = payload as ErrorEnvelope | null;
    throw new ApiError(envelope?.error?.code ?? 'INTERNAL_ERROR', envelope?.error?.message ?? res.statusText, res.status);
  }
  return payload as T;
}

export interface PhotoListParams {
  offset?: number;
  limit?: number;
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
  listLibraries: (): Promise<Library[]> => request('GET', '/api/libraries'),
  getLibrary: (id: string): Promise<Library> => request('GET', `/api/libraries/${id}`),
  createLibrary: (body: CreateLibraryRequest): Promise<Library> => request('POST', '/api/libraries', body),
  updateLibrary: (id: string, body: UpdateLibraryRequest): Promise<Library> => request('PATCH', `/api/libraries/${id}`, body),
  deleteLibrary: (id: string): Promise<void> => request('DELETE', `/api/libraries/${id}`),
  syncLibrary: (id: string): Promise<LibrarySyncStatus> => request('POST', `/api/libraries/${id}/sync`),
  cancelSync: (id: string): Promise<void> => request('DELETE', `/api/libraries/${id}/sync`),
  getSyncStatus: (id: string): Promise<LibrarySyncStatus> => request('GET', `/api/libraries/${id}/sync/status`),

  listLibraryPhotos: (libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/libraries/${libraryId}/photos${query(params)}`),
  listMissingPhotos: (libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/libraries/${libraryId}/photos/missing${query(params)}`),
  getPhoto: (id: string): Promise<PhotoDetail> => request('GET', `/api/photos/${id}`),
  updatePhoto: (id: string, body: UpdatePhotoRequest): Promise<PhotoDetail> => request('PATCH', `/api/photos/${id}`, body),
  // Every bulk call names its photos either by id or by position in a filtered
  // collection (§18.3.3), so a selection of a hundred thousand is one small
  // request rather than a client reading back every id first.
  // Delete answers with what it binned, which is what an undo restores: the same
  // selection resolves elsewhere once those photos have left the collection.
  deletePhotos: (target: PhotoTarget): Promise<{ photo_ids: string[] }> => request('POST', '/api/photos/delete', target),
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
  deleteShoot: (id: string): Promise<void> => request('DELETE', `/api/shoots/${id}`),
  addPhotosToShoot: (id: string, target: PhotoTarget): Promise<void> => request('POST', `/api/shoots/${id}/photos`, target),
  removePhotosFromShoot: (id: string, target: PhotoTarget): Promise<void> =>
    request('DELETE', `/api/shoots/${id}/photos`, target),
  listShootPhotos: (id: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/shoots/${id}/photos${query(params)}`),

  listAlbums: (): Promise<Album[]> => request('GET', '/api/albums'),
  createAlbum: (body: CreateAlbumRequest): Promise<Album> => request('POST', '/api/albums', body),
  updateAlbum: (id: string, body: UpdateAlbumRequest): Promise<Album> => request('PATCH', `/api/albums/${id}`, body),
  deleteAlbum: (id: string): Promise<void> => request('DELETE', `/api/albums/${id}`),
  addPhotosToAlbum: (id: string, target: PhotoTarget): Promise<void> => request('POST', `/api/albums/${id}/photos`, target),
  removePhotosFromAlbum: (id: string, target: PhotoTarget): Promise<void> =>
    request('DELETE', `/api/albums/${id}/photos`, target),
  listAlbumPhotos: (id: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/albums/${id}/photos${query(params)}`),
};

// `version` is appended only once renditions have been rebuilt in this session:
// the file changes behind a stable URL, and an image already decoded in the page
// is never re-requested without it.
// One URL shape for every stored rendition, and `video` for the one-frame AV1
// twin an HDR one carries. Dynamic range is not in the URL: the library decides
// it, so a client guessing would ask for a file that was never built (§10.2).
export function renditionUrl(photoId: string, rendition: Rendition, version = 0): string {
  const url = `${BASE}/image/${photoId}/renditions/${rendition}`;
  return version === 0 ? url : `${url}?v=${version}`;
}

// Only Firefox needs this: it applies a PQ transfer to nothing but video, so it
// renders an HDR still dark (§10.7). Everything else takes the AVIF, which is
// better in every way that matters - no video element, no autoplay rules, and it
// decodes as an image.
export function renditionVideoUrl(photoId: string, rendition: Rendition, version = 0): string {
  const url = `${BASE}/image/${photoId}/renditions/${rendition}/video`;
  return version === 0 ? url : `${url}?v=${version}`;
}

// Firefox is the only engine with no HDR image path at all. Sniffing the engine
// is normally the wrong tool, but there is nothing to feature-detect here: the
// failure is that Firefox renders a PQ still *wrongly* rather than refusing it,
// so nothing in the page can observe it.
export function needsHdrVideo(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes('Firefox');
}

// The camera's own JPEG, handed over as the camera wrote it (§10.2). Versioned
// like a stored rendition even though nothing builds it: it is lifted out of the
// RAW on each request, so a RAW replaced on disk changes these bytes too, and a
// page holding the previous ones would otherwise never ask again.
export function embeddedUrl(photoId: string, version = 0): string {
  const url = `${BASE}/image/${photoId}/embedded.jpg`;
  return version === 0 ? url : `${url}?v=${version}`;
}

// Server-sent events: which photos have a rendition worth re-requesting.
export function eventsUrl(): string {
  return `${BASE}/api/events`;
}

// One of the four things a photo can be taken away as: the RAW itself, or any of
// the three renditions the viewer offers. No extension in the URL - the
// catalogue holds several RAW formats, and the server names the download off the
// file it served.
export function downloadUrl(photoId: string, form: 'original' | ViewerRendition): string {
  return `${BASE}/image/${photoId}/download/${form}`;
}

// What the viewer shows for one of its three choices: the camera's JPEG served
// directly, or a stored rendition.
export function viewerUrl(photoId: string, rendition: ViewerRendition, version = 0): string {
  return rendition === 'embedded' ? embeddedUrl(photoId, version) : renditionUrl(photoId, rendition, version);
}
