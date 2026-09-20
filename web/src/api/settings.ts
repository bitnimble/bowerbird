import {
  type Settings,
  SettingsSchema,
  type UpdateSettingsRequest,
  UpdateSettingsRequestSchema,
} from '../../../src/schemas/settings';
import { PathSegment, route } from '../../../src/schemas/route';
import { request } from './request';

export const settingsApi = {
  get: (): Promise<Settings> => request(SettingsSchema, 'GET', route(PathSegment.api(), PathSegment.settings())),
  update: (body: UpdateSettingsRequest): Promise<Settings> =>
    request(SettingsSchema, 'PATCH', route(PathSegment.api(), PathSegment.settings()), UpdateSettingsRequestSchema.parse(body)),
  // What the app ships with, so the settings page can say which values have been
  // moved and put them back. Asked for rather than compiled in: the defaults are
  // the server's, and a client holding its own copy is a client that can disagree
  // with the database about what "default" means.
  getDefaults: (): Promise<Settings> =>
    request(SettingsSchema, 'GET', route(PathSegment.api(), PathSegment.settings(), PathSegment.defaults())),
};
