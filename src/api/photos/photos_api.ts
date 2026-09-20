import { Hono } from 'hono';
import { DeletedCountSchema, QueuedCountSchema, UpdatedCountSchema } from '../../schemas/common';
import {
  DeletePhotosRequestSchema,
  HidePhotosRequestSchema,
  MarkPhotosRequestSchema,
  PhotoDaysRequestSchema,
  PhotoDaysResponseSchema,
  PhotoDetailSchema,
  PhotoIdsResponseSchema,
  PhotoListQuerySchema,
  PhotoListResponseSchema,
  PhotoModelsRequestSchema,
  PhotoModelsResponseSchema,
  PhotoNeighboursRequestSchema,
  PhotoPositionsRequestSchema,
  PhotoPositionsResponseSchema,
  PhotoRangeRequestSchema,
  PhotoSummaryListSchema,
  PhotoTargetSchema,
  RenditionJobResponseSchema,
  UpdatePhotoRequestSchema,
} from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import { AppError } from '../../errors';
import { respond } from '../respond';
import { isRendition } from '../../services/processing/renditions/renditions';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import type { PhotoMutationService } from '../../services/photos/mutations/photo_mutation_service';
import type { PhotoRenditionService } from '../../services/photos/renditions/photo_rendition_service';
import type { ProcessingService } from '../../services/processing/pipeline/processing_service';

// Routes are registered relative to the /api mount (index.ts). Both the
// library-scoped list paths and the flat /photos/:id paths live here since they
// are all served by the photo domain services (DESIGN §13.2).
export class PhotosApi {
  readonly routes: Hono;

  constructor(
    private readonly read: PhotoReadService,
    private readonly mutations: PhotoMutationService,
    private readonly renditions: PhotoRenditionService,
    private readonly processing: ProcessingService,
  ) {
    const app = new Hono();

    // The same query as any other listing, not just pagination: a client acting
    // on a selection made here states the filters it was viewing under
    // (§18.3.3), so a route that silently dropped them would resolve a different
    // set of photos than the one on screen.
    app.get(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.photos(), PathSegment.missing()), (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(respond(PhotoListResponseSchema, this.read.listMissing(c.req.param('libraryId'), query)));
    });

    app.get(route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.photos()), (c) => {
      const query = PhotoListQuerySchema.parse(c.req.query());
      return c.json(respond(PhotoListResponseSchema, this.read.listByLibrary(c.req.param('libraryId'), query)));
    });

    // Where rows sit in a collection now, so a client holding open expansion
    // bands and a scroll anchor can re-place them after an import or a re-order
    // rather than closing them (§19.6.1) - and can carry a selection across the
    // renumbering when the listing itself collapses or expands (§19.5.4). A POST
    // because the scope, the filters and a few thousand keys do not belong in a
    // query string.
    app.post(route(PathSegment.photos(), PathSegment.positions()), async (c) =>
      c.json(respond(PhotoPositionsResponseSchema, this.read.positionsOf(PhotoPositionsRequestSchema.parse(await c.req.json())))),
    );

    // What the arrows step to, which is the collection uncollapsed: the grid
    // shows a stack as one tile, and the viewer walks every frame of it
    // (§19.5.3). A POST for the same reason as above, and a literal path so it
    // cannot be taken for `/photos/:id`.
    app.post(route(PathSegment.photos(), PathSegment.neighbours()), async (c) =>
      c.json(respond(PhotoSummaryListSchema, this.read.neighboursOf(PhotoNeighboursRequestSchema.parse(await c.req.json())))),
    );

    // The bodies and lenses a collection holds, so the filter menu offers what was
    // shot rather than every model in the catalogue. A POST because it is scoped the
    // same way the three routes above are.
    app.post(route(PathSegment.photos(), PathSegment.models()), async (c) =>
      c.json(respond(PhotoModelsResponseSchema, this.read.modelsOf(PhotoModelsRequestSchema.parse(await c.req.json())))),
    );

    // How many photographs sit on each day the collection holds any, which the filter
    // calendar draws its density from and opens its month at.
    app.post(route(PathSegment.photos(), PathSegment.days()), async (c) =>
      c.json(respond(PhotoDaysResponseSchema, this.read.daysOf(PhotoDaysRequestSchema.parse(await c.req.json())))),
    );

    // The same listing asked for by its ends, for a caller that already knows what
    // sits either side of a run and would otherwise have to know the collection's
    // ordering to say which end of it is "after".
    app.post(route(PathSegment.photos(), PathSegment.range()), async (c) =>
      c.json(respond(PhotoSummaryListSchema, this.read.rangeOf(PhotoRangeRequestSchema.parse(await c.req.json())))),
    );

    // The one route that hands the ids back, for a bulk action the client has to
    // run itself rather than ask for: an export renders one file per photograph
    // and only the client knows where each lands (§10.5.1), so it needs the list
    // the other routes resolve privately. Large by construction - a whole library
    // is megabytes of ids - which is exactly why nothing else answers this way.
    app.post(route(PathSegment.photos(), PathSegment.ids()), async (c) =>
      c.json(respond(PhotoIdsResponseSchema, { photo_ids: this.target(await c.req.json()) })),
    );

    // Answers with a count, not with the ids. The undo restores by the batch id
    // the client stamped the request with (§12.3): the selection those photos
    // came from resolves to different ones now that they have left the
    // collection, and handing back a million ids would be a 36MB response the
    // client only needs in order to say "that one bin".
    app.post(route(PathSegment.photos(), PathSegment.delete()), async (c) => {
      const { target, batch } = DeletePhotosRequestSchema.parse(await c.req.json());
      const photoIds = this.read.resolve(target);
      await this.mutations.delete(photoIds, batch);
      return c.json(respond(DeletedCountSchema, { deleted: photoIds.length }));
    });

    app.post(route(PathSegment.photos(), PathSegment.restore()), async (c) => {
      await this.mutations.restore(this.target(await c.req.json()));
      return c.body(null, 204);
    });

    // The verdict and the rating, over a selection. Separate from PATCH because a
    // cull marks a burst at a time and a request per photograph is a round trip
    // per frame - and because a selection can name more photos than a client can
    // hold the ids for (§18.3.1).
    app.post(route(PathSegment.photos(), PathSegment.mark()), async (c) => {
      const { target, ...marks } = MarkPhotosRequestSchema.parse(await c.req.json());
      return c.json(respond(UpdatedCountSchema, { updated: this.mutations.mark(this.read.resolve(target), marks) }));
    });

    // Puts a selection away, or brings it back. Its own route rather than a field of `mark`
    // because it carries its own stamp (§12.4).
    app.post(route(PathSegment.photos(), PathSegment.hide()), async (c) => {
      const { target, hidden } = HidePhotosRequestSchema.parse(await c.req.json());
      return c.json(respond(UpdatedCountSchema, { updated: this.mutations.hide(this.read.resolve(target), hidden) }));
    });

    // Rebuilds grid tiles, and nothing else: the photo view's renditions are built
    // and rebuilt on their own (§10.3). Separate from PATCH because it is work to
    // schedule, not a field to set, and it applies to a whole selection.
    app.post(route(PathSegment.photos(), PathSegment.rebuildTiles()), async (c) => {
      return c.json(respond(QueuedCountSchema, { queued: await this.processing.rebuildTiles(this.target(await c.req.json())) }));
    });

    // Re-reads the RAW headers. Sync only re-opens a file whose stat changed, so
    // photos catalogued before a field existed need an explicit nudge.
    app.post(route(PathSegment.photos(), PathSegment.refreshMetadata()), async (c) => {
      return c.json(respond(UpdatedCountSchema, { updated: await this.renditions.refreshMetadata(this.target(await c.req.json())) }));
    });

    // Ensures one rendition exists. Returns at once when it is already cached,
    // which is the common case after the first look. The max-resolution one is
    // slow and large by design, so this is one photo at a time and only on ask.
    app.post(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.renditions(), PathSegment.param('rendition')), async (c) => {
      const rendition = c.req.param('rendition') ?? '';
      if (!isRendition(rendition) || rendition === 'grid') {
        throw new AppError('NOT_FOUND', `not a rendition the viewer can build: ${rendition}`);
      }
      // `force` drops the cached copy first, for a viewer comparing settings that
      // changed since it was built - the file is the cache, so nothing else would
      // ever rebuild it.
      const force = c.req.query('force') === 'true';
      await this.renditions.buildRendition(c.req.param('id'), rendition, force);
      return c.body(null, 204);
    });

    // The same build as a job, for a client that renders it on its own GPU and PUTs the picture
    // back to the rendition's image URL. `{ job: null }` is "ask the POST above instead".
    app.get(
      route(PathSegment.photos(), PathSegment.param('id'), PathSegment.renditions(), PathSegment.param('rendition'), PathSegment.job()),
      (c) => {
        const rendition = c.req.param('rendition') ?? '';
        if (!isRendition(rendition) || rendition === 'grid') {
          throw new AppError('NOT_FOUND', `not a rendition the viewer can build: ${rendition}`);
        }
        const job = this.renditions.renditionJob(c.req.param('id'), rendition, c.req.query('force') === 'true');
        return c.json(respond(RenditionJobResponseSchema, job == null ? { job: null } : { job: job.command, builtFrom: job.builtFrom }));
      },
    );

    app.get(route(PathSegment.photos(), PathSegment.param('id')), (c) => c.json(respond(PhotoDetailSchema, this.read.get(c.req.param('id')))));

    // The frames a panorama is composed from, which its badge opens as a band. No ordering or
    // album to narrow by, unlike a stack's members: a recipe names its frames in one order and
    // that is the order the pan was shot in.
    app.get(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.frames()), (c) =>
      c.json(respond(PhotoSummaryListSchema, this.read.framesOf(c.req.param('id')))),
    );

    app.patch(route(PathSegment.photos(), PathSegment.param('id')), async (c) => {
      const body = UpdatePhotoRequestSchema.parse(await c.req.json());
      return c.json(respond(PhotoDetailSchema, this.mutations.update(c.req.param('id'), body)));
    });

    this.routes = app;
  }

  // Every bulk route takes the same two shapes: the ids, or the positions to
  // read them from.
  private target(body: unknown): string[] {
    return this.read.resolve(PhotoTargetSchema.parse(body));
  }
}
