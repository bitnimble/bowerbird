import { Hono } from 'hono';
import { AppError } from '../../errors';
import { ModelsStatusSchema } from '../../schemas/models';
import { PathSegment, route } from '../../schemas/route';
import type { ModelsService } from '../../services/models/models_service';
import { respond } from '../respond';

export class ModelsApi {
  readonly routes: Hono;

  constructor(private readonly models: ModelsService) {
    const app = new Hono();

    app.get(route(), async (c) => c.json(respond(ModelsStatusSchema, await this.models.check())));

    app.post(route(PathSegment.check()), async (c) =>
      c.json(respond(ModelsStatusSchema, await this.models.check(true))),
    );

    app.post(route(PathSegment.download()), async (c) =>
      c.json(respond(ModelsStatusSchema, await this.models.download())),
    );

    // What a page's own renderer asks before it renders, so without going to Hugging Face.
    app.get(route(PathSegment.status()), (c) =>
      c.json(respond(ModelsStatusSchema, this.models.status())),
    );

    // A downloaded model's files, for a page's own renderer.
    app.get(
      route(PathSegment.files(), PathSegment.param('revision'), PathSegment.param('name')),
      (c) => {
        const { revision, name } = c.req.param();
        const file = this.models.file(revision, name);
        if (file == null) {
          throw new AppError('NOT_FOUND', `no downloaded model file ${name} at ${revision}`);
        }
        return new Response(Bun.file(file), {
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
      },
    );

    this.routes = app;
  }
}
