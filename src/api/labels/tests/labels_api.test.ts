import { describe, expect, it, jest } from 'bun:test';
import { Hono } from 'hono';
import { applyErrorHandler } from '../../error_handler';
import type { Label } from '../../../schemas/labels';
import { PathSegment, route } from '../../../schemas/route';
import type { LabelsService } from '../../../services/labels/labels_service';
import type { PhotoReadService } from '../../../services/photos/listing/photo_read_service';
import { LabelsApi } from '../labels_api';

const LIB = 'library1';
const label: Label = { id: 'label001', library_id: LIB, name: 'Keeper', colour: '#ff0000', position: 0, photo_count: 0 };

function buildApp(): { app: Hono; labels: LabelsService } {
  const labels = {
    list: jest.fn(() => [label]),
    create: jest.fn(() => label),
    save: jest.fn(() => [label]),
    addPhotos: jest.fn(),
    removePhotos: jest.fn(),
  } as unknown as LabelsService;
  const photos = {
    resolve: jest.fn((target: { photo_ids?: string[] }) => target.photo_ids ?? []),
  } as unknown as PhotoReadService;
  const app = new Hono();
  app.route(route(PathSegment.api(), PathSegment.labels()), new LabelsApi(labels, photos).routes);
  applyErrorHandler(app);
  return { app, labels };
}

async function create(app: Hono, name: string, colour = '#00ff00'): Promise<Response> {
  return app.request(route(PathSegment.api(), PathSegment.labels()), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ library_id: LIB, name, colour }),
  });
}

describe('LabelsApi', () => {
  it('creates a label of one line up to 20 characters, trimmed', async () => {
    const { app, labels } = buildApp();
    expect((await create(app, '  Best of 2026 & more ')).status).toBe(201);
    expect(labels.create).toHaveBeenCalledWith({ library_id: LIB, name: 'Best of 2026 & more', colour: '#00ff00' });
  });

  it('refuses a name too long, blank or over two lines, and a colour that is not hex', async () => {
    const { app, labels } = buildApp();
    expect((await create(app, 'x'.repeat(21))).status).toBe(400);
    expect((await create(app, '   ')).status).toBe(400);
    expect((await create(app, 'two\nlines')).status).toBe(400);
    expect((await create(app, 'Keeper', 'red')).status).toBe(400);
    expect(labels.create).not.toHaveBeenCalled();
  });

  it('labels the photos a target names', async () => {
    const { app, labels } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.labels(), 'label001', PathSegment.photos()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo_ids: ['photo001'] }),
    });
    expect(res.status).toBe(204);
    expect(labels.addPhotos).toHaveBeenCalledWith('label001', ['photo001']);
  });
});
