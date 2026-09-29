import {
  type Settings,
  SettingsSchema,
  type UpdateSettingsRequest,
  UpdateSettingsRequestSchema,
} from '../../../src/schemas/settings';
import {
  RenderTimingSchema,
  RenderTimingsSchema,
  type RenderTiming,
  type RenderTimings,
  type RenderedRendition,
} from '../../../src/schemas/render_stages';
import { type Denoiser } from '../../../src/schemas/photo_edits';
import { StorageUsageSchema, type StorageUsage } from '../../../src/schemas/storage_usage';
import { PathSegment, route } from '../../../src/schemas/route';
import { request } from './request';

export const settingsApi = {
  storageUsage: (): Promise<StorageUsage> =>
    request(
      StorageUsageSchema,
      'GET',
      route(PathSegment.api(), PathSegment.settings(), PathSegment.storageUsage()),
    ),
  get: (): Promise<Settings> =>
    request(SettingsSchema, 'GET', route(PathSegment.api(), PathSegment.settings())),
  update: (body: UpdateSettingsRequest): Promise<Settings> =>
    request(
      SettingsSchema,
      'PATCH',
      route(PathSegment.api(), PathSegment.settings()),
      UpdateSettingsRequestSchema.parse(body),
    ),
  // What the app ships with, so the settings page can say which values have been
  // moved and put them back. Asked for rather than compiled in: the defaults are
  // the server's, and a client holding its own copy is a client that can disagree
  // with the database about what "default" means.
  getDefaults: (): Promise<Settings> =>
    request(
      SettingsSchema,
      'GET',
      route(PathSegment.api(), PathSegment.settings(), PathSegment.defaults()),
    ),
  // What a render costs on the machine the server is on, stage by stage. Empty until somebody
  // has measured one.
  renderTimings: (): Promise<RenderTimings> =>
    request(
      RenderTimingsSchema,
      'GET',
      route(PathSegment.api(), PathSegment.settings(), PathSegment.renderTimings()),
    ),
  // Measures it now: several renders of one photograph, so it answers in seconds on a `full` and
  // in tens of them on a `max`.
  benchmarkRender: (rendition: RenderedRendition, denoiser: Denoiser): Promise<RenderTiming> =>
    request(
      RenderTimingSchema,
      'POST',
      `${route(PathSegment.api(), PathSegment.settings(), PathSegment.renderTimings(), PathSegment.benchmark())}?${new URLSearchParams({ rendition, denoiser })}`,
    ),
};
