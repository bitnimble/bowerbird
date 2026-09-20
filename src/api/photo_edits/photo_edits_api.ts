import { Hono } from 'hono';
import { AppError } from '../../errors';
import {
  EditConflictsQuerySchema,
  EditConflictsSchema,
  EditStateSchema,
  SaveEditsRequestSchema,
  StepEditsRequestSchema,
} from '../../schemas/photo_edits';
import { PathSegment, route } from '../../schemas/route';
import type { PhotoEditsService } from '../../services/photo_edits/photo_edits_service';
import { respond } from '../respond';

// Registered relative to the /api mount (index.ts), beside the other photo routes.
// Its own class rather than more methods on PhotosApi because everything here is
// one photo's develop settings and none of it takes a selection, which is the
// shape every route in PhotosApi is built around.
export class PhotoEditsApi {
  readonly routes: Hono;

  constructor(private readonly service: PhotoEditsService) {
    const app = new Hono();

    // Answers for a photo with no edits too, with the neutral document at
    // revision 0 rather than a 404: the editor needs a document to open against
    // either way, and nothing is stored until the first change.
    app.get(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.edits()), (c) =>
      c.json(respond(EditStateSchema, this.service.get(this.id(c.req.param('id'))))),
    );

    // The whole document, and the revision it was read at. The server derives the
    // delta by diffing against what it holds, which keeps the delta's shape a
    // server concern; `rev` is what stops a second tab's stale document being
    // diffed into a change nobody made (§6).
    app.put(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.edits()), async (c) => {
      const { doc, rev, session } = SaveEditsRequestSchema.parse(await c.req.json());
      return c.json(respond(EditStateSchema, this.service.save(this.id(c.req.param('id')), doc, rev, session)));
    });

    // Both steps carry `rev` for the same reason a save does, plus one of their
    // own: without it a retried request steps twice.
    app.post(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.edits(), PathSegment.undo()), async (c) => {
      const { rev } = StepEditsRequestSchema.parse(await c.req.json());
      return c.json(respond(EditStateSchema, this.service.undo(this.id(c.req.param('id')), rev)));
    });

    app.post(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.edits(), PathSegment.redo()), async (c) => {
      const { rev } = StepEditsRequestSchema.parse(await c.req.json());
      return c.json(respond(EditStateSchema, this.service.redo(this.id(c.req.param('id')), rev)));
    });

    // The editor has closed. Queues the rebuild none of the writes above do, because a
    // slider release says nothing about whether the reader is finished and rebuilding
    // on one spends seconds of GPU on a frame they are about to change again.
    //
    // No body and no revision: this is not a write, it asks for the picture the stored
    // document already describes. 204 for the same reason - there is no new state to
    // report, and the client is navigating away as it calls this.
    app.post(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.edits(), PathSegment.done()), (c) => {
      this.service.finish(this.id(c.req.param('id')));
      return c.body(null, 204);
    });

    // The divergences waiting on someone (§5.3), across the library or all of
    // them - a badge in the sidebar counts what is unresolved anywhere.
    app.get(route(PathSegment.edits(), PathSegment.conflicts()), (c) => {
      const { library_id } = EditConflictsQuerySchema.parse(c.req.query());
      return c.json(respond(EditConflictsSchema, this.service.conflicts(library_id)));
    });

    // Which candidate to keep. The picture rebuilds after it, exactly as closing
    // the editor on the same document would.
    app.post(route(PathSegment.photos(), PathSegment.param('id'), PathSegment.edits(), PathSegment.conflicts(), PathSegment.param('sessionId'), PathSegment.keep()), (c) => {
      const sessionId = c.req.param('sessionId');
      if (sessionId == null) throw new AppError('NOT_FOUND', 'no such parked edit');
      this.service.resolve(this.id(c.req.param('id')), sessionId);
      return c.body(null, 204);
    });

    this.routes = app;
  }

  private id(photoId: string | undefined): string {
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    return photoId;
  }
}
