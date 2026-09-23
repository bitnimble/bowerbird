import { Hono } from 'hono';
import { AppError } from '../../errors';
import {
  AssemblyJobSchema,
  AssemblyJobStartedSchema,
  CommitAssemblyRequestSchema,
  ReopenedAssemblySchema,
} from '../../schemas/assembly';
import { CompositePhotoSchema } from '../../schemas/composition';
import { PhotoTargetSchema } from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import type { CompositesService } from '../../services/composites/composites_service';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import { respond } from '../respond';

export class CompositesApi {
  readonly routes: Hono;

  constructor(
    private readonly composites: CompositesService,
    private readonly photos: PhotoReadService,
  ) {
    const app = new Hono();

    // The same target body every bulk route takes (§18.3.3), so a client holding
    // positions rather than ids can merge what it has selected.
    //
    // Answers when the photograph exists and its tile is on disk, rather than
    // accepting and finishing later: what the client does next is show the new
    // row, and a merge that answered first would draw a hole.
    app.post(route(PathSegment.panorama()), async (c) => {
      const photoIds = this.photos.resolve(PhotoTargetSchema.parse(await c.req.json()));
      return c.json(respond(CompositePhotoSchema, await this.composites.mergePanorama(photoIds)), 201);
    });

    app.post(route(PathSegment.bracket()), async (c) => {
      const photoIds = this.photos.resolve(PhotoTargetSchema.parse(await c.req.json()));
      return c.json(respond(CompositePhotoSchema, await this.composites.mergeBracket(photoIds)), 201);
    });

    // Starts the analysis and answers its job at once; the page reads the job for the rest.
    app.post(route(PathSegment.assembly()), async (c) => {
      const photoIds = this.photos.resolve(PhotoTargetSchema.parse(await c.req.json()));
      return c.json(respond(AssemblyJobStartedSchema, { jobId: this.composites.startAssembly(photoIds) }), 201);
    });

    app.get(route(PathSegment.assembly(), PathSegment.jobs(), PathSegment.param('jobId')), (c) => {
      const job = this.composites.assemblyJob(c.req.param('jobId'));
      if (job == null) throw new AppError('NOT_FOUND', 'Merged photo not found');
      return c.json(respond(AssemblyJobSchema, job));
    });

    app.post(route(PathSegment.assembly(), PathSegment.jobs(), PathSegment.param('jobId'), PathSegment.cancel()), (c) => {
      this.composites.cancelAssembly(c.req.param('jobId'));
      return c.body(null, 204);
    });

    // §2.7's reopen. Under the composites rather than under the photograph because what it answers
    // is the merge - a recipe and its layers - rather than anything about the row.
    app.get(route(PathSegment.assembly(), PathSegment.param('photoId')), async (c) => {
      return c.json(respond(ReopenedAssemblySchema, await this.composites.reopenAssembly(c.req.param('photoId'))));
    });

    app.post(route(PathSegment.assembly(), PathSegment.commit()), async (c) => {
      const { recipe } = CommitAssemblyRequestSchema.parse(await c.req.json());
      return c.json(respond(CompositePhotoSchema, await this.composites.commitAssembly(recipe)), 201);
    });

    // §2.7's reopen: the picks as they now stand, onto the photograph that already exists.
    app.put(route(PathSegment.assembly(), PathSegment.param('photoId')), async (c) => {
      const { recipe } = CommitAssemblyRequestSchema.parse(await c.req.json());
      return c.json(respond(CompositePhotoSchema, await this.composites.updateAssembly(c.req.param('photoId'), recipe)));
    });

    this.routes = app;
  }
}
