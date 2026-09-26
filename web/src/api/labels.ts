import {
  type CreateLabelRequest,
  CreateLabelRequestSchema,
  type Label,
  LabelListSchema,
  LabelSchema,
  type SaveLabelsRequest,
  SaveLabelsRequestSchema,
} from '../../../src/schemas/labels';
import { type PhotoTarget, PhotoTargetSchema } from '../../../src/schemas/photos';
import { PathSegment, route } from '../../../src/schemas/route';
import type { RequestActivity } from '../../../src/schemas/request_activity';
import { NothingSchema, request } from './request';

export const labelsApi = {
  list: (activity?: RequestActivity): Promise<Label[]> =>
    request(LabelListSchema, 'GET', route(PathSegment.api(), PathSegment.labels()), undefined, { activity }),
  create: (body: CreateLabelRequest): Promise<Label> =>
    request(LabelSchema, 'POST', route(PathSegment.api(), PathSegment.labels()), CreateLabelRequestSchema.parse(body)),
  save: (body: SaveLabelsRequest): Promise<Label[]> =>
    request(LabelListSchema, 'PUT', route(PathSegment.api(), PathSegment.labels()), SaveLabelsRequestSchema.parse(body)),
  addPhotos: (id: string, target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.labels(), id, PathSegment.photos()),
      PhotoTargetSchema.parse(target),
    ),
  removePhotos: (id: string, target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'DELETE',
      route(PathSegment.api(), PathSegment.labels(), id, PathSegment.photos()),
      PhotoTargetSchema.parse(target),
    ),
};
