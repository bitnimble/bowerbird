// One type for both: the library states which source to build renditions from,
// and each photo records the one it was actually built with.
import {
  type CreateLibraryRequest,
  CreateLibraryRequestSchema,
  DetectStacksResponseSchema,
  type Library,
  LibrariesSchema,
  LibraryFoldersSchema,
  type LibraryScanStatus,
  LibraryScanStatusSchema,
  LibrarySchema,
  type LibrarySettings,
  LibrarySettingsSchema,
  type UpdateLibraryRequest,
  UpdateLibraryRequestSchema,
} from '../../../src/schemas/libraries';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

export const librariesApi = {
  // Every folder inside one library, in the root-relative paths a shoot's folder
  // is stored as. A hidden shoot's folders are left out with the shoot itself unless
  // `includeHidden` asks for them (§12.4).
  folders: (libraryId: string, includeHidden = false): Promise<string[]> =>
    request(
      LibraryFoldersSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.folders())}${includeHidden ? '?include_hidden=true' : ''}`,
    ),
  list: (): Promise<Library[]> => request(LibrariesSchema, 'GET', route(PathSegment.api(), PathSegment.libraries())),
  /** The per-library knobs a new library is created with, for the same reason as `getSettingsDefaults`. */
  getDefaults: (): Promise<LibrarySettings> =>
    request(LibrarySettingsSchema, 'GET', route(PathSegment.api(), PathSegment.libraries(), PathSegment.defaults())),
  get: (id: string): Promise<Library> => request(LibrarySchema, 'GET', route(PathSegment.api(), PathSegment.libraries(), id)),
  create: (body: CreateLibraryRequest): Promise<Library> =>
    request(LibrarySchema, 'POST', route(PathSegment.api(), PathSegment.libraries()), CreateLibraryRequestSchema.parse(body)),
  update: (id: string, body: UpdateLibraryRequest): Promise<Library> =>
    request(LibrarySchema, 'PATCH', route(PathSegment.api(), PathSegment.libraries(), id), UpdateLibraryRequestSchema.parse(body)),
  delete: (id: string): Promise<void> =>
    request(NothingSchema, 'DELETE', route(PathSegment.api(), PathSegment.libraries(), id)),
  scan: (id: string): Promise<LibraryScanStatus> =>
    request(LibraryScanStatusSchema, 'POST', route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.sync())),
  cancelScan: (id: string): Promise<void> =>
    request(NothingSchema, 'DELETE', route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.sync())),
  scanStatus: (id: string): Promise<LibraryScanStatus> =>
    request(
      LibraryScanStatusSchema,
      'GET',
      route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.sync(), PathSegment.status()),
    ),
  rebuildTiles: (id: string): Promise<LibraryScanStatus> =>
    request(
      LibraryScanStatusSchema,
      'POST',
      route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.jobs(), PathSegment.tiles()),
    ),
  rebuildRenditions: (id: string): Promise<LibraryScanStatus> =>
    request(
      LibraryScanStatusSchema,
      'POST',
      route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.jobs(), PathSegment.renditions()),
    ),
  // Re-forms the library's automatic stacks, answering with how many it now has.
  detectStacks: (id: string): Promise<{ stacks: number }> =>
    request(
      DetectStacksResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.libraries(), id, PathSegment.jobs(), PathSegment.stacks()),
    ),
};
