import { Hono } from 'hono';
import { AppError } from '../../errors';
import { SaveEditsRequestSchema, StepEditsRequestSchema } from '../../schemas/photo_edits';
import type { PhotoEditsService } from '../../services/photo_edits/photo_edits_service';

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
    app.get('/photos/:id/edits', (c) => c.json(this.service.get(this.id(c.req.param('id')))));

    // The whole document, and the revision it was read at. The server derives the
    // delta by diffing against what it holds, which keeps the delta's shape a
    // server concern; `rev` is what stops a second tab's stale document being
    // diffed into a change nobody made (§6).
    app.put('/photos/:id/edits', async (c) => {
      const { doc, rev } = SaveEditsRequestSchema.parse(await c.req.json());
      return c.json(this.service.save(this.id(c.req.param('id')), doc, rev));
    });

    // Both steps carry `rev` for the same reason a save does, plus one of their
    // own: without it a retried request steps twice.
    app.post('/photos/:id/edits/undo', async (c) => {
      const { rev } = StepEditsRequestSchema.parse(await c.req.json());
      return c.json(this.service.undo(this.id(c.req.param('id')), rev));
    });

    app.post('/photos/:id/edits/redo', async (c) => {
      const { rev } = StepEditsRequestSchema.parse(await c.req.json());
      return c.json(this.service.redo(this.id(c.req.param('id')), rev));
    });

    this.routes = app;
  }

  private id(photoId: string | undefined): string {
    if (photoId == null) throw new AppError('NOT_FOUND', 'photo not found');
    return photoId;
  }
}
