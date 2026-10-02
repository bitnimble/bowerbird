import { Hono } from 'hono';
import {
  RenderTimingSchema,
  RenderTimingsSchema,
  RenderedRenditionSchema,
  type RenderTiming,
  type RenderedRendition,
} from '../../schemas/render_stages';
import { DenoiserSchema, type Denoiser } from '../../schemas/photo_edits';
import { PathSegment, route } from '../../schemas/route';
import { config } from '../../config';
import { SettingsSchema, UpdateSettingsRequestSchema } from '../../schemas/settings';
import { StorageUsageSchema } from '../../schemas/storage_usage';
import type { StorageUsageService } from '../../services/maintenance/storage_usage_service';
import type { RenderTimingsFile } from '../../services/processing/renditions/render_timings_file';
import type { SettingsRepository } from '../../services/settings/settings_repository';
import { takeAsLongAsItTakes } from '../long_requests';
import { respond } from '../respond';

export class SettingsApi {
  readonly routes: Hono;

  constructor(
    private readonly settings: SettingsRepository,
    // What a render costs here, which belongs to the machine rather than to any library (§10.1).
    private readonly timings: RenderTimingsFile,
    private readonly benchmarkRender: (
      rendition: RenderedRendition,
      denoiser: Denoiser,
    ) => Promise<RenderTiming>,
    private readonly storageUsage: StorageUsageService,
  ) {
    const app = new Hono();

    app.get(route(), (c) => c.json(respond(SettingsSchema, this.settings.get())));

    // What the app ships with, so a client can offer "put this back" without
    // carrying a copy of the schema's defaults. Before `/` in no sense that
    // matters here - there is no `/:key` route to shadow it.
    app.get(route(PathSegment.defaults()), (c) =>
      c.json(respond(SettingsSchema, config.defaultSettings)),
    );

    app.get(route(PathSegment.renderTimings()), (c) =>
      c.json(respond(RenderTimingsSchema, this.timings.read())),
    );

    app.get(route(PathSegment.storageUsage()), async (c) => {
      takeAsLongAsItTakes(c);
      return c.json(respond(StorageUsageSchema, await this.storageUsage.measure()));
    });

    // Several renders of one photograph, which on a `max` is minutes - well past Bun's idle
    // ceiling, so this asks for the whole of it as a first scan does.
    app.post(route(PathSegment.renderTimings(), PathSegment.benchmark()), async (c) => {
      takeAsLongAsItTakes(c);
      const rendition = RenderedRenditionSchema.parse(c.req.query('rendition'));
      const denoiser = DenoiserSchema.parse(c.req.query('denoiser'));
      return c.json(respond(RenderTimingSchema, await this.benchmarkRender(rendition, denoiser)));
    });

    app.patch(route(), async (c) => {
      const body = UpdateSettingsRequestSchema.parse(await c.req.json());
      return c.json(respond(SettingsSchema, this.settings.update(body)));
    });

    this.routes = app;
  }
}
