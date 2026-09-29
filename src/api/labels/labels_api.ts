import { Hono } from 'hono';
import {
  CreateLabelRequestSchema,
  LabelListSchema,
  LabelSchema,
  SaveLabelsRequestSchema,
} from '../../schemas/labels';
import { PhotoTargetSchema } from '../../schemas/photos';
import { PathSegment, route } from '../../schemas/route';
import { respond } from '../respond';
import type { LabelsService } from '../../services/labels/labels_service';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';

export class LabelsApi {
  readonly routes: Hono;

  constructor(
    private readonly labels: LabelsService,
    private readonly photos: PhotoReadService,
  ) {
    const app = new Hono();

    app.get(route(), (c) => c.json(respond(LabelListSchema, this.labels.list())));

    app.post(route(), async (c) =>
      c.json(
        respond(
          LabelSchema,
          this.labels.create(CreateLabelRequestSchema.parse(await c.req.json())),
        ),
        201,
      ),
    );

    app.put(route(), async (c) =>
      c.json(
        respond(
          LabelListSchema,
          this.labels.save(SaveLabelsRequestSchema.parse(await c.req.json())),
        ),
      ),
    );

    app.post(route(PathSegment.param('id'), PathSegment.photos()), async (c) => {
      this.labels.addPhotos(
        c.req.param('id'),
        this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())),
      );
      return c.body(null, 204);
    });

    app.delete(route(PathSegment.param('id'), PathSegment.photos()), async (c) => {
      this.labels.removePhotos(
        c.req.param('id'),
        this.photos.resolve(PhotoTargetSchema.parse(await c.req.json())),
      );
      return c.body(null, 204);
    });

    this.routes = app;
  }
}
