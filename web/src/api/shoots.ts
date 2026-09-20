import { type PhotoListResponse, PhotoListResponseSchema, type PhotoTarget, PhotoTargetSchema } from '../../../src/schemas/photos';
import { PathSegment, route } from '../../../src/schemas/route';
import {
  type CreateShootRequest,
  CreateShootRequestSchema,
  type Shoot,
  ShootListSchema,
  type ShootRemoval,
  ShootRemovalSchema,
  ShootSchema,
  type UpdateShootRequest,
  UpdateShootRequestSchema,
} from '../../../src/schemas/shoots';
import { photoListQuery, type PhotoListParams } from './photos';
import { NothingSchema, request } from './request';

export const shootsApi = {
  // The shoots put away are left out unless asked for, so nothing that lists shoots has to remember
  // to filter them (§12.4). Resolving one by id is a different question: `getShoot` always answers.
  list: (libraryId: string, includeHidden = false): Promise<Shoot[]> =>
    request(
      ShootListSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.shoots())}${includeHidden ? '?include_hidden=true' : ''}`,
    ),
  get: (id: string): Promise<Shoot> => request(ShootSchema, 'GET', route(PathSegment.api(), PathSegment.shoots(), id)),
  create: (body: CreateShootRequest): Promise<Shoot> =>
    request(ShootSchema, 'POST', route(PathSegment.api(), PathSegment.shoots()), CreateShootRequestSchema.parse(body)),
  update: (id: string, body: UpdateShootRequest): Promise<Shoot> =>
    request(ShootSchema, 'PATCH', route(PathSegment.api(), PathSegment.shoots(), id), UpdateShootRequestSchema.parse(body)),
  // How many photo records `photos: 'remove'` would take, counted by the server
  // with the same query the delete runs (§8.5).
  removal: (id: string): Promise<ShootRemoval> =>
    request(ShootRemovalSchema, 'GET', route(PathSegment.api(), PathSegment.shoots(), id, PathSegment.removal())),
  // 'remove' takes the photo records and their renditions with the shoot; the
  // files on disk are untouched either way (§8.5).
  delete: (id: string, photos: 'keep' | 'remove'): Promise<void> =>
    request(NothingSchema, 'DELETE', `${route(PathSegment.api(), PathSegment.shoots(), id)}?photos=${photos}`),
  addPhotos: (id: string, target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.shoots(), id, PathSegment.photos()),
      PhotoTargetSchema.parse(target),
    ),
  removePhotos: (id: string, target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'DELETE',
      route(PathSegment.api(), PathSegment.shoots(), id, PathSegment.photos()),
      PhotoTargetSchema.parse(target),
    ),
  listPhotos: (id: string, params: PhotoListParams, signal?: AbortSignal): Promise<PhotoListResponse> =>
    request(
      PhotoListResponseSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.shoots(), id, PathSegment.photos())}${photoListQuery(params)}`,
      undefined,
      signal,
    ),
};
