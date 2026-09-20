import {
  type Album,
  AlbumListSchema,
  AlbumSchema,
  type CreateAlbumRequest,
  CreateAlbumRequestSchema,
  type UpdateAlbumRequest,
  UpdateAlbumRequestSchema,
} from '../../../src/schemas/albums';
import { type PhotoListResponse, PhotoListResponseSchema, type PhotoTarget, PhotoTargetSchema } from '../../../src/schemas/photos';
import { PathSegment, route } from '../../../src/schemas/route';
import { photoListQuery, type PhotoListParams } from './photos';
import { NothingSchema, request } from './request';

export const albumsApi = {
  list: (): Promise<Album[]> => request(AlbumListSchema, 'GET', route(PathSegment.api(), PathSegment.albums())),
  create: (body: CreateAlbumRequest): Promise<Album> =>
    request(AlbumSchema, 'POST', route(PathSegment.api(), PathSegment.albums()), CreateAlbumRequestSchema.parse(body)),
  update: (id: string, body: UpdateAlbumRequest): Promise<Album> =>
    request(AlbumSchema, 'PATCH', route(PathSegment.api(), PathSegment.albums(), id), UpdateAlbumRequestSchema.parse(body)),
  delete: (id: string): Promise<void> =>
    request(NothingSchema, 'DELETE', route(PathSegment.api(), PathSegment.albums(), id)),
  addPhotos: (id: string, target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.albums(), id, PathSegment.photos()),
      PhotoTargetSchema.parse(target),
    ),
  removePhotos: (id: string, target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'DELETE',
      route(PathSegment.api(), PathSegment.albums(), id, PathSegment.photos()),
      PhotoTargetSchema.parse(target),
    ),
  listPhotos: (id: string, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> =>
    request(
      PhotoListResponseSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.albums(), id, PathSegment.photos())}${photoListQuery(params)}`,
      undefined,
      signal,
    ),
};
