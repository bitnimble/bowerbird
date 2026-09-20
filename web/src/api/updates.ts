import { type UpdateStatus, UpdateStatusSchema } from '../../../src/schemas/updates';
import { PathSegment, route } from '../../../src/schemas/route';
import { request } from './request';

export const updatesApi = {
  get: (): Promise<UpdateStatus> =>
    request(UpdateStatusSchema, 'GET', route(PathSegment.api(), PathSegment.updates())),
  /** Skips the cache, which is what the button in Settings is for. */
  check: (): Promise<UpdateStatus> =>
    request(UpdateStatusSchema, 'POST', route(PathSegment.api(), PathSegment.updates(), PathSegment.check())),
  /** Answers, and then the server exits so its supervisor can start the new version. */
  apply: (): Promise<UpdateStatus> =>
    request(UpdateStatusSchema, 'POST', route(PathSegment.api(), PathSegment.updates(), PathSegment.apply())),
};
