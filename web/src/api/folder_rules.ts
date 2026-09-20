import {
  type FolderRule,
  FolderRulesSchema,
  type SetFolderRuleRequest,
  SetFolderRuleRequestSchema,
} from '../../../src/schemas/libraries';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

export const folderRulesApi = {
  // Where a folder differs from what the library's settings say in general (§4.7).
  list: (libraryId: string): Promise<FolderRule[]> =>
    request(FolderRulesSchema, 'GET', route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.folderRules())),
  set: (libraryId: string, body: SetFolderRuleRequest): Promise<FolderRule[]> =>
    request(
      FolderRulesSchema,
      'PUT',
      route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.folderRules()),
      SetFolderRuleRequestSchema.parse(body),
    ),
  clear: (libraryId: string, folderPath: string): Promise<void> =>
    request(
      NothingSchema,
      'DELETE',
      `${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.folderRules())}?folder_path=${encodeURIComponent(folderPath)}`,
    ),
};
