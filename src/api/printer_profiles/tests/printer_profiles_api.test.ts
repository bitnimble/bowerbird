import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { applyErrorHandler } from '../../error_handler';
import { PathSegment, route } from '../../../schemas/route';
import { PrinterProfilesApi } from '../printer_profiles_api';

const AT = route(PathSegment.api(), PathSegment.printerProfiles());

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'printer-profiles-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function buildApp(at: string): Hono {
  const app = new Hono();
  app.route(AT, new PrinterProfilesApi(at).routes);
  applyErrorHandler(app);
  return app;
}

describe('PrinterProfilesApi', () => {
  it('lists the ICC profiles in the folder by name', async () => {
    await writeFile(path.join(dir, 'Satin PRO-200.icc'), 'a');
    await writeFile(path.join(dir, 'Matte.ICM'), 'b');
    await writeFile(path.join(dir, 'notes.txt'), 'c');
    const res = await buildApp(dir).request(AT);
    expect(await res.json()).toEqual({ profiles: ['Matte.ICM', 'Satin PRO-200.icc'] });
  });

  it('lists none where the folder does not exist', async () => {
    const res = await buildApp(path.join(dir, 'absent')).request(AT);
    expect(await res.json()).toEqual({ profiles: [] });
  });

  it('serves a listed profile and nothing outside the folder', async () => {
    await writeFile(path.join(dir, 'Satin.icc'), 'profile bytes');
    await writeFile(path.join(path.dirname(dir), 'outside.icc'), 'secret');
    const app = buildApp(dir);
    const served = await app.request(`${AT}/Satin.icc`);
    expect(await served.text()).toBe('profile bytes');
    expect((await app.request(`${AT}/${encodeURIComponent('../outside.icc')}`)).status).toBe(404);
  });
});
