import {
  FrameTvListSchema,
  SendToFrameTvRequestSchema,
  type FrameTvList,
  type SendToFrameTvRequest,
} from '../../../src/schemas/frame_tv';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

export const frameTvsApi = {
  // Searches the server's network, so it answers in seconds rather than milliseconds.
  list: (): Promise<FrameTvList> => request(FrameTvListSchema, 'GET', route(PathSegment.api(), PathSegment.frameTvs())),
  send: (body: SendToFrameTvRequest): Promise<undefined> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.frameTvs(), PathSegment.send()),
      SendToFrameTvRequestSchema.parse(body),
    ),
};
