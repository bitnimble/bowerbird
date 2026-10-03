import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { applyErrorHandler } from '../../error_handler';
import { PathSegment, route } from '../../../schemas/route';
import type { PrintRequest } from '../../../schemas/printing';
import type { PrintRenderTarget } from '../../../services/processing/exports/print_renderer';
import { PrintService } from '../../../services/printing/print_service';
import type { PrintCommand } from '../../../services/printing/printshim';
import { PrintingApi } from '../printing_api';

const AT = route(PathSegment.api(), PathSegment.printing());
const PRINTER = 'cups:Canon_PRO_200S';

let dir: string;
let commands: PrintCommand[];
let renders: { photoId: string; target: PrintRenderTarget; output: string }[];
let imageAtSubmit: string | null;
let outcomes: Partial<Record<PrintCommand['kind'], unknown>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'printing-api-'));
  commands = [];
  renders = [];
  imageAtSubmit = null;
  outcomes = {};
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function buildApp(): Hono {
  const service = new PrintService(
    async (command) => {
      commands.push(command);
      if (command.kind === 'submit') imageAtSubmit = await readFile(command.image, 'utf8');
      const outcome = outcomes[command.kind];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    dir,
    async (photoId, target, output) => {
      renders.push({ photoId, target, output });
      await writeFile(output, `png of ${photoId}`);
    },
  );
  const app = new Hono();
  app.route(AT, new PrintingApi(service).routes);
  applyErrorHandler(app);
  return app;
}

const REQUEST: PrintRequest = {
  photoId: 'photo-1',
  printer: PRINTER,
  colour: { kind: 'profile', bits: 16, profile: { from: 'file', name: 'Lustre.icc' } },
  intent: 'relativeColorimetric',
  quarterTurns: 1,
  job: {
    name: 'DSC0001.ARW',
    media: 'iso_a4_210x297mm',
    mediaType: 'photographic-glossy',
    borderless: false,
    copies: 2,
    resolutionDpi: 300,
    page: { widthPx: 2480, heightPx: 3508 },
    place: { x: 97, y: 40, width: 2285, height: 3428 },
  },
};

function post(app: Hono, at: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(`${AT}${at}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('PrintingApi', () => {
  it('lists the system printers through the printshim', async () => {
    const printer = {
      id: PRINTER,
      name: 'Canon PRO-200S',
      isDefault: true,
      location: null,
      model: 'Canon PRO-200S',
      connection: 'usb',
    };
    outcomes.list = { printers: [printer] };
    const res = await buildApp().request(`${AT}/printers`);
    expect(await res.json()).toEqual({ printers: [printer] });
  });

  it('asks for one printer by its encoded id', async () => {
    outcomes.capabilities = {
      media: [],
      defaultMedia: null,
      mediaTypes: [],
      defaultMediaType: null,
      resolutionsDpi: [300, 600],
      copiesMax: 99,
      colour: { transports: [{ space: 'srgb', bits: 8 }], profiles: [] },
    };
    const res = await buildApp().request(
      `${AT}/printers/${encodeURIComponent(PRINTER)}/capabilities`,
    );
    expect(res.status).toBe(200);
    expect(commands).toEqual([{ kind: 'capabilities', printer: PRINTER }]);
  });

  it('serves a printer profile as ICC bytes', async () => {
    outcomes.profile = { icc: Buffer.from('icc bytes').toString('base64') };
    const res = await buildApp().request(
      `${AT}/printers/${encodeURIComponent(PRINTER)}/profiles/${encodeURIComponent('PRO-200 Lustre')}`,
    );
    expect(res.headers.get('Content-Type')).toBe('application/vnd.iccprofile');
    expect(await res.text()).toBe('icc bytes');
    expect(commands).toEqual([{ kind: 'profile', printer: PRINTER, name: 'PRO-200 Lustre' }]);
  });

  it('renders through the chosen file profile, submits the PNG in device RGB, then deletes it', async () => {
    await writeFile(path.join(dir, 'Lustre.icc'), 'lustre');
    outcomes.submit = { jobId: 42 };
    const res = await post(buildApp(), '/jobs', REQUEST);
    expect(await res.json()).toEqual({ jobId: 42 });
    expect(renders).toHaveLength(1);
    const [render] = renders;
    expect({
      ...render?.target,
      icc: new TextDecoder().decode(render?.target.icc ?? undefined),
    }).toEqual({
      space: 'device',
      bits: 16,
      intent: 'relative',
      blackPointCompensation: true,
      icc: 'lustre',
      width: 2285,
      height: 3428,
      quarterTurns: 1,
    });
    expect(imageAtSubmit).toBe('png of photo-1');
    expect(commands).toEqual([
      {
        kind: 'submit',
        printer: PRINTER,
        image: render?.output ?? '',
        job: { ...REQUEST.job, transport: { space: 'device', bits: 16 } },
      },
    ]);
    expect(existsSync(render?.output ?? '')).toBe(false);
  });

  it('refuses a profile file outside the folder', async () => {
    const res = await post(buildApp(), '/jobs', {
      ...REQUEST,
      colour: { kind: 'profile', bits: 8, profile: { from: 'file', name: '../secret.icc' } },
    });
    expect(res.status).toBe(404);
    expect(renders).toEqual([]);
  });

  it('answers a malformed request with a validation error', async () => {
    const res = await post(buildApp(), '/jobs', { photoId: 'photo-1' });
    expect(res.status).toBe(400);
  });

  it('passes on what a printer that refused said', async () => {
    outcomes.job = new AppError('UNAVAILABLE', 'the printer is offline');
    const res = await buildApp().request(`${AT}/printers/${encodeURIComponent(PRINTER)}/jobs/42`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { message: 'the printer is offline' } });
  });

  it('reads a job state by its numeric id', async () => {
    outcomes.job = { state: 'processing', reasons: ['job-printing'] };
    const res = await buildApp().request(`${AT}/printers/${encodeURIComponent(PRINTER)}/jobs/42`);
    expect(await res.json()).toEqual({ state: 'processing', reasons: ['job-printing'] });
    expect(commands).toEqual([{ kind: 'job', printer: PRINTER, jobId: 42 }]);
  });

  it('renders an 8-bit sRGB sheet for the system print dialog', async () => {
    const res = await post(buildApp(), '/sheet', { photoId: 'photo-1', width: 3600, height: 2400 });
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(await res.text()).toBe('png of photo-1');
    expect(renders[0]?.target).toEqual({
      space: 'srgb',
      bits: 8,
      intent: 'perceptual',
      blackPointCompensation: true,
      icc: null,
      width: 3600,
      height: 2400,
      quarterTurns: 0,
    });
  });
});
