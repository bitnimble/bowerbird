import { type ModelsStatus, ModelsStatusSchema } from '../../../src/schemas/models';
import { PathSegment, route } from '../../../src/schemas/route';
import { request } from './request';

export const modelsApi = {
  get: (): Promise<ModelsStatus> =>
    request(ModelsStatusSchema, 'GET', route(PathSegment.api(), PathSegment.models()), undefined, {
      activity: 'background',
    }),
  /** Skips the cache, which is what the button in Settings is for. */
  check: (): Promise<ModelsStatus> =>
    request(
      ModelsStatusSchema,
      'POST',
      route(PathSegment.api(), PathSegment.models(), PathSegment.check()),
    ),
  download: (): Promise<ModelsStatus> =>
    request(
      ModelsStatusSchema,
      'POST',
      route(PathSegment.api(), PathSegment.models(), PathSegment.download()),
    ),
};
