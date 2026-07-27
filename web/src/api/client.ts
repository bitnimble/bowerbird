import type { Album, CreateAlbumRequest, UpdateAlbumRequest } from '../../../src/schemas/albums';
import type { CreateLibraryRequest, Library, LibrarySyncStatus, UpdateLibraryRequest } from '../../../src/schemas/libraries';
import type { PhotoDetail, PhotoListResponse, Triage, UpdatePhotoRequest } from '../../../src/schemas/photos';
import type { PreviewRendition, PreviewRenditionMode, Settings, UpdateSettingsRequest } from '../../../src/schemas/settings';
import type { CreateShootRequest, Shoot, UpdateShootRequest } from '../../../src/schemas/shoots';
import type { ServerConfig } from '../features/settings/server_config_store';

// Types come straight from the server's Zod schemas as type-only imports, so the
// client can never drift from the API and nothing is added to the bundle.
export type {
  Album,
  Library,
  LibrarySyncStatus,
  PhotoDetail,
  PhotoListResponse,
  PreviewRendition,
  PreviewRenditionMode,
  Settings,
  Shoot,
  Triage,
  UpdateLibraryRequest,
};
export type PhotoSummary = PhotoListResponse['photos'][number];
export type Ordering = Library['ordering'];
export type PreviewSource = Library['preview_source'];
// NonNullable: the column is null until a photo has been processed once.
export type ThumbnailSource = NonNullable<PhotoDetail['thumbnail_source']>;

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
  needs_processing?: boolean;
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
  getConfig: (): Promise<ServerConfig> => request('GET', '/api/config'),
  getSettings: (): Promise<Settings> => request('GET', '/api/settings'),
  updateSettings: (body: UpdateSettingsRequest): Promise<Settings> => request('PATCH', '/api/settings', body),
  listLibraries: (): Promise<Library[]> => request('GET', '/api/libraries'),
  getLibrary: (id: string): Promise<Library> => request('GET', `/api/libraries/${id}`),
  createLibrary: (body: CreateLibraryRequest): Promise<Library> => request('POST', '/api/libraries', body),
  updateLibrary: (id: string, body: UpdateLibraryRequest): Promise<Library> => request('PATCH', `/api/libraries/${id}`, body),
  deleteLibrary: (id: string): Promise<void> => request('DELETE', `/api/libraries/${id}`),
  syncLibrary: (id: string): Promise<LibrarySyncStatus> => request('POST', `/api/libraries/${id}/sync`),
  getSyncStatus: (id: string): Promise<LibrarySyncStatus> => request('GET', `/api/libraries/${id}/sync/status`),

  listLibraryPhotos: (libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/libraries/${libraryId}/photos${query(params)}`),
  listMissingPhotos: (libraryId: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/libraries/${libraryId}/photos/missing${query(params)}`),
  getPhoto: (id: string): Promise<PhotoDetail> => request('GET', `/api/photos/${id}`),
  updatePhoto: (id: string, body: UpdatePhotoRequest): Promise<PhotoDetail> => request('PATCH', `/api/photos/${id}`, body),
  deletePhotos: (photoIds: string[]): Promise<void> => request('POST', '/api/photos/delete', { photo_ids: photoIds }),
  restorePhotos: (photoIds: string[]): Promise<void> => request('POST', '/api/photos/restore', { photo_ids: photoIds }),
  reprocessPhotos: (photoIds: string[], source: ThumbnailSource): Promise<{ queued: number }> =>
    request('POST', '/api/photos/reprocess', { photo_ids: photoIds, source }),
  refreshMetadata: (photoIds: string[]): Promise<{ updated: number }> =>
    request('POST', '/api/photos/refresh-metadata', { photo_ids: photoIds }),
  buildPreview: (photoId: string, source: ThumbnailSource): Promise<void> =>
    request('POST', `/api/photos/${photoId}/preview`, { source }),
  buildLossless: (photoId: string): Promise<void> => request('POST', `/api/photos/${photoId}/lossless`),

  listShoots: (libraryId: string): Promise<Shoot[]> => request('GET', `/api/libraries/${libraryId}/shoots`),
  getShoot: (id: string): Promise<Shoot> => request('GET', `/api/shoots/${id}`),
  createShoot: (body: CreateShootRequest): Promise<Shoot> => request('POST', '/api/shoots', body),
  updateShoot: (id: string, body: UpdateShootRequest): Promise<Shoot> => request('PATCH', `/api/shoots/${id}`, body),
  deleteShoot: (id: string): Promise<void> => request('DELETE', `/api/shoots/${id}`),
  addPhotosToShoot: (id: string, photoIds: string[]): Promise<void> =>
    request('POST', `/api/shoots/${id}/photos`, { photo_ids: photoIds }),
  removePhotosFromShoot: (id: string, photoIds: string[]): Promise<void> =>
    request('DELETE', `/api/shoots/${id}/photos`, { photo_ids: photoIds }),
  listShootPhotos: (id: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/shoots/${id}/photos${query(params)}`),

  listAlbums: (): Promise<Album[]> => request('GET', '/api/albums'),
  createAlbum: (body: CreateAlbumRequest): Promise<Album> => request('POST', '/api/albums', body),
  updateAlbum: (id: string, body: UpdateAlbumRequest): Promise<Album> => request('PATCH', `/api/albums/${id}`, body),
  deleteAlbum: (id: string): Promise<void> => request('DELETE', `/api/albums/${id}`),
  addPhotosToAlbum: (id: string, photoIds: string[]): Promise<void> =>
    request('POST', `/api/albums/${id}/photos`, { photo_ids: photoIds }),
  removePhotosFromAlbum: (id: string, photoIds: string[]): Promise<void> =>
    request('DELETE', `/api/albums/${id}/photos`, { photo_ids: photoIds }),
  listAlbumPhotos: (id: string, params: PhotoListParams): Promise<PhotoListResponse> =>
    request('GET', `/api/albums/${id}/photos${query(params)}`),
};

// `version` is appended only once thumbnails have been rebuilt in this session:
// the file changes behind a stable URL, and an image already decoded in the page
// is never re-requested without it.
export function thumbnailUrl(photoId: string, size: 'small' | 'full', version = 0): string {
  const url = `${BASE}/image/${photoId}/${size}.avif`;
  return version === 0 ? url : `${url}?v=${version}`;
}

// The full-size preview built from one named source, as opposed to whichever one
// this photo's own thumbnails came from.
// The HDR preview as a one-frame video. Only Firefox needs it: it applies a PQ
// transfer to nothing but video, so it renders an HDR still dark (§10.7).
// Everything else takes the AVIF, which is better in every way that matters -
// no video element, no autoplay rules, and it decodes as an image.
export function losslessVideoUrl(photoId: string): string {
  return `${BASE}/image/${photoId}/lossless-video`;
}

export function previewVideoUrl(photoId: string, version = 0): string {
  const url = `${BASE}/image/${photoId}/preview-video`;
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

export function previewUrl(photoId: string, source: ThumbnailSource, version = 0): string {
  const url = `${BASE}/image/${photoId}/preview/${source}`;
  return version === 0 ? url : `${url}?v=${version}`;
}

export function originalUrl(photoId: string): string {
  return `${BASE}/image/${photoId}/original.arw`;
}

export function jpegUrl(photoId: string): string {
  return `${BASE}/image/${photoId}/full.jpg`;
}

export function losslessUrl(photoId: string): string {
  return `${BASE}/image/${photoId}/lossless.avif`;
}
