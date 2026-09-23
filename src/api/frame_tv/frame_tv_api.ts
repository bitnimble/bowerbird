import { Hono } from 'hono';
import { FrameTvListSchema, SendToFrameTvRequestSchema } from '../../schemas/frame_tv';
import { PathSegment, route } from '../../schemas/route';
import type { FrameTvService } from '../../services/frame_tv/frame_tv_service';
import { respond } from '../respond';

// One photograph per send, so a selection is this route in a loop and the client draws the progress.
export class FrameTvApi {
  readonly routes: Hono;

  constructor(private readonly frameTvs: FrameTvService) {
    const app = new Hono();

    app.get(route(), async (c) => c.json(respond(FrameTvListSchema, { tvs: await this.frameTvs.list() })));

    app.post(route(PathSegment.send()), async (c) => {
      await this.frameTvs.send(SendToFrameTvRequestSchema.parse(await c.req.json()));
      return new Response(null, { status: 204 });
    });

    this.routes = app;
  }
}
