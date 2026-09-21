import { PhotoIdListSchema, type Ordering } from '../../../src/schemas/common';
import { type PhotoSummary, PhotoSummaryListSchema, type PhotoTarget, PhotoTargetSchema } from '../../../src/schemas/photos';
import { PathSegment, route } from '../../../src/schemas/route';
import type { RequestActivity } from '../../../src/schemas/request_activity';
import { type Stack, StackSchema, UnstackedCountSchema } from '../../../src/schemas/stacks';
import { NothingSchema, request } from './request';

export const stacksApi = {
  // Stacks (§19). A stack is made from whatever the bulk bar has selected, which
  // is positions rather than ids for anything larger than a screenful, so this
  // takes the same target shape every other bulk call does.
  create: (target: PhotoTarget): Promise<Stack> =>
    request(StackSchema, 'POST', route(PathSegment.api(), PathSegment.stacks()), PhotoTargetSchema.parse(target)),
  // Every member, so a shoot can dim the ones that are not in it; `albumId`
  // narrows to what that album holds, because an album is strict (§19.5.3).
  listPhotos: (
    id: string,
    options: { ordering: Ordering; albumId?: string; shootId?: string; deleted?: boolean },
    signal?: AbortSignal,
    activity?: RequestActivity,
  ): Promise<PhotoSummary[]> => {
    const search = new URLSearchParams({ ordering: options.ordering });
    if (options.albumId != null) search.set('album_id', options.albumId);
    // Which shoot's hiding this band is exempt from, so it holds what the tile counted (§12.4).
    if (options.shootId != null) search.set('shoot_id', options.shootId);
    if (options.deleted === true) search.set('deleted', 'true');
    return request(
      PhotoSummaryListSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.stacks(), id, PathSegment.photos())}?${search.toString()}`,
      undefined,
      { signal, activity },
    );
  },
  // Every stack a selection touches, by the photographs in it: a client holding
  // positions can name a stack's row but never its id (§18.3.3).
  unstack: (target: PhotoTarget): Promise<{ unstacked: number }> =>
    request(
      UnstackedCountSchema,
      'POST',
      route(PathSegment.api(), PathSegment.stacks(), PathSegment.unstack()),
      PhotoTargetSchema.parse(target),
    ),
  removePhotos: (id: string, photoIds: string[]): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.stacks(), id, PathSegment.remove()),
      PhotoIdListSchema.parse({ photo_ids: photoIds }),
    ),
};
