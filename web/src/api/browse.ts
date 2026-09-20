import { type BrowseResponse, BrowseResponseSchema } from '../../../src/schemas/browse';
import { PathSegment, route } from '../../../src/schemas/route';
import { request } from './request';

export const browseApi = {
  // The server's directories, not this browser's: a library root is a path the
  // server has to be able to open.
  get: (path?: string): Promise<BrowseResponse> =>
    request(
      BrowseResponseSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.browse())}${path == null ? '' : `?path=${encodeURIComponent(path)}`}`,
    ),
};
