import { Hono } from 'hono';
import { AppError } from '../../errors';
import {
  AssemblyPreviewSchema,
  PreviewRequestSchema,
  SeamsRequestSchema,
  SolvedSeamsResponseSchema,
} from '../../schemas/assembly';
import { PathSegment, route } from '../../schemas/route';
import type { CompositesService } from '../../services/composites/composites_service';
import { dataPathForLibraryId, draftLayerPath, draftPreviewPath } from '../../utils/paths';
import { respond } from '../respond';

export class AssembliesApi {
  readonly routes: Hono;

  constructor(private readonly composites: CompositesService) {
    const app = new Hono();

    // §2.8's seams for each pick set; `null` where the recipe's carve volume has been reaped.
    app.post(route(PathSegment.seams()), async (c) => {
      const { recipe, picks } = SeamsRequestSchema.parse(await c.req.json());
      return c.json(respond(SolvedSeamsResponseSchema, { seams: await this.composites.solveSeams(recipe, picks) }));
    });

    // §4.2's settled preview: this pick set through the render the page is promising.
    app.post(route(PathSegment.preview()), async (c) => {
      const { recipe } = PreviewRequestSchema.parse(await c.req.json());
      return c.json(respond(AssemblyPreviewSchema, { url: await this.composites.previewOf(recipe) }));
    });

    this.routes = app;
  }

  /**
   * §4.3's layers, which a page loads as pictures rather than asks for as a call - so they hang off
   * `/image` with everything else an `ImageDecoder` is pointed at.
   *
   * **Every segment is checked against a spelling rather than resolved.** Nothing here reads a row,
   * so a path that escaped its library's data directory would be this server opening whatever the
   * client named; a key that is not a key and a layer that is not a number are a 404 instead.
   */
  get imageRoutes(): Hono {
    const app = new Hono();

    const layer = route(
      PathSegment.drafts(),
      PathSegment.param('libraryId'),
      PathSegment.param('layerKey'),
      PathSegment.param('at'),
    );
    app.get(layer, async (c) => {
      const libraryId = c.req.param('libraryId') ?? '';
      const layerKey = c.req.param('layerKey') ?? '';
      const asked = c.req.param('at') ?? '';
      const preview = PREVIEW.exec(asked)?.[1];
      const at = Number(asked);
      const named = preview != null || (Number.isInteger(at) && at >= 0);
      if (!NAME.test(libraryId) || !NAME.test(layerKey) || !named) {
        throw new AppError('NOT_FOUND', 'that is not a draft layer');
      }
      const dataPath = dataPathForLibraryId(libraryId);
      const file = Bun.file(
        preview == null ? draftLayerPath(dataPath, layerKey, at) : draftPreviewPath(dataPath, layerKey, preview),
      );
      if (!(await file.exists())) throw new AppError('NOT_FOUND', 'that draft layer has been reaped');
      return new Response(file, {
        headers: {
          'Content-Type': 'image/avif',
          // The key is what the pixels are a function of (§4.4), so these bytes never change under
          // this URL - and the seven-day reap is what ends it rather than a rewrite.
          'Cache-Control': 'private, max-age=604800, immutable',
        },
      });
    });

    return app;
  }
}

/** A library id or a layer key, either of which is a name rather than a path. */
const NAME = /^[A-Za-z0-9_-]+$/;

/** A settled preview's file, `preview-` and the hash `pictureKeyOf` named it by. */
const PREVIEW = /^preview-([a-f0-9]{32})$/;
