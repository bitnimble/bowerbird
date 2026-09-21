import { describe, it, expect, jest } from 'bun:test';
import { Hono } from 'hono';
import { applyErrorHandler } from '../../error_handler';
import type { RenderTiming, RenderTimings } from '../../../schemas/render_stages';
import { PathSegment, route } from '../../../schemas/route';
import { DEFAULT_SETTINGS } from '../../../schemas/settings';
import type { RenderTimingsFile } from '../../../services/processing/renditions/render_timings_file';
import type { SettingsRepository } from '../../../services/settings/settings_repository';
import { SettingsApi } from '../settings_api';

const MEASURED: RenderTiming = { total: 800, stages: { match: 400 }, measured_at: '2026-01-01T00:00:00.000Z' };

function buildApp(
  read: () => RenderTimings = () => ({}),
  benchmarkRender: () => Promise<RenderTiming> = jest.fn(async () => MEASURED),
) {
  const settings = { get: jest.fn(() => DEFAULT_SETTINGS) } as unknown as SettingsRepository;
  const timings = { read: jest.fn(read), put: jest.fn() } as unknown as RenderTimingsFile;
  const app = new Hono();
  app.route(route(PathSegment.api(), PathSegment.settings()), new SettingsApi(settings, timings, benchmarkRender).routes);
  applyErrorHandler(app);
  return { app, benchmarkRender };
}

const AT = route(PathSegment.api(), PathSegment.settings(), PathSegment.renderTimings());

describe('SettingsApi render timings', () => {
  it('answers with what has been measured here', async () => {
    const { app } = buildApp(() => ({ full: MEASURED }));
    const res = await app.request(AT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ full: MEASURED });
  });

  it('times a render of the rendition the query names', async () => {
    const { app, benchmarkRender } = buildApp();
    const res = await app.request(`${AT}/${PathSegment.benchmark()}?rendition=max`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MEASURED);
    expect(benchmarkRender).toHaveBeenCalledWith('max');
  });

  it('refuses a rendition it does not build, rather than timing whatever was asked for', async () => {
    // `grid` is the camera's own JPEG and takes no list of stages, so naming it here is a caller's
    // bug. Defaulted instead, this would report a `full` render's numbers under another name.
    const { app, benchmarkRender } = buildApp();
    const at = `${AT}/${PathSegment.benchmark()}`;

    expect((await app.request(`${at}?rendition=grid`, { method: 'POST' })).status).toBe(400);
    expect((await app.request(at, { method: 'POST' })).status).toBe(400);
    expect(benchmarkRender).not.toHaveBeenCalled();
  });
});
