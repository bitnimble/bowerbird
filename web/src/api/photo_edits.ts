import {
  type EditConflict,
  EditConflictsSchema,
  type EditDoc,
  type EditState,
  EditStateSchema,
  SaveEditsRequestSchema,
  StepEditsRequestSchema,
} from '../../../src/schemas/photo_edits';
import { PathSegment, route } from '../../../src/schemas/route';
import type { RequestActivity } from '../../../src/schemas/request_activity';
import { NothingSchema, request } from './request';

export const photoEditsApi = {
  // Develop settings. Every one of these answers with the same state, including
  // the revision the next write has to carry: a client that saved without it
  // would have the server diff a stale document and record a change nobody made.
  get: (photoId: string): Promise<EditState> =>
    request(EditStateSchema, 'GET', route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits())),
  // `session` is which editor open this belongs to (docs/replication.md §5.3):
  // it is the unit a merge takes whole, so an afternoon's work is never half
  // replaced by one slider moved on another device.
  save: (photoId: string, doc: EditDoc, rev: number, session: string): Promise<EditState> =>
    request(
      EditStateSchema,
      'PUT',
      route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits()),
      SaveEditsRequestSchema.parse({ doc, rev, session }),
    ),
  undo: (photoId: string, rev: number): Promise<EditState> =>
    request(
      EditStateSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits(), PathSegment.undo()),
      StepEditsRequestSchema.parse({ rev }),
    ),
  redo: (photoId: string, rev: number): Promise<EditState> =>
    request(
      EditStateSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits(), PathSegment.redo()),
      StepEditsRequestSchema.parse({ rev }),
    ),
  // The editor has closed: build the picture the reader ended up with. None of the
  // writes above rebuild anything, because a slider release says nothing about whether
  // they are finished - so this is the one moment worth spending a render on.
  finish: (photoId: string): Promise<void> =>
    request(NothingSchema, 'POST', route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits(), PathSegment.done())),

  // The divergences waiting on a person (§5.3), and the choice that ends one.
  listConflicts: (libraryId?: string, activity: RequestActivity = 'interactive'): Promise<EditConflict[]> =>
    request(
      EditConflictsSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.edits(), PathSegment.conflicts())}${libraryId == null ? '' : `?library_id=${libraryId}`}`,
      undefined,
      { activity },
    ),
  keepCandidate: (photoId: string, sessionId: string): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(
        PathSegment.api(),
        PathSegment.photos(),
        photoId,
        PathSegment.edits(),
        PathSegment.conflicts(),
        sessionId,
        PathSegment.keep(),
      ),
    ),
};
