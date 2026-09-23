import { expect, it } from 'bun:test';
import { Hono } from 'hono';
import type { FrameTv, SendToFrameTvRequest } from '../../../schemas/frame_tv';
import { PathSegment, route } from '../../../schemas/route';
import type { FrameTvService } from '../../../services/frame_tv/frame_tv_service';
import { applyErrorHandler } from '../../error_handler';
import { FrameTvApi } from '../frame_tv_api';

const LIVING_ROOM: FrameTv = { id: 'uuid:living', name: 'Living room', host: '10.0.0.5' };

function serving(): { app: Hono; sent: SendToFrameTvRequest[] } {
  const sent: SendToFrameTvRequest[] = [];
  const frameTvs = {
    list: () => Promise.resolve([LIVING_ROOM]),
    send: (request: SendToFrameTvRequest) => {
      sent.push(request);
      return Promise.resolve();
    },
  };
  const app = new Hono();
  app.route(route(PathSegment.api(), PathSegment.frameTvs()), new FrameTvApi(frameTvs as unknown as FrameTvService).routes);
  applyErrorHandler(app);
  return { app, sent };
}

it('lists the TVs the search found', async () => {
  const answer = await serving().app.request(route(PathSegment.api(), PathSegment.frameTvs()));

  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ tvs: [LIVING_ROOM] });
});

it('sends one photo and answers with nothing', async () => {
  const { app, sent } = serving();
  const body: SendToFrameTvRequest = { tv_id: LIVING_ROOM.id, photo_id: 'aaaaaaaa', rendition: null, show: true };

  const answer = await app.request(route(PathSegment.api(), PathSegment.frameTvs(), PathSegment.send()), {
    method: 'POST',
    body: JSON.stringify(body),
  });

  expect(answer.status).toBe(204);
  expect(sent).toEqual([body]);
});

it('refuses a send that names no photo', async () => {
  const { app, sent } = serving();

  const answer = await app.request(route(PathSegment.api(), PathSegment.frameTvs(), PathSegment.send()), {
    method: 'POST',
    body: JSON.stringify({ tv_id: LIVING_ROOM.id, rendition: null, show: true }),
  });

  expect(answer.status).toBe(400);
  expect(sent).toEqual([]);
});
