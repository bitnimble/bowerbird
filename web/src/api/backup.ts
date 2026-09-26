import {
  type BackupRunResponse,
  BackupRunResponseSchema,
  type BackupStatus,
  BackupStatusSchema,
  BackupStatusesSchema,
  type FetchBackProgress,
  FetchBackStatusSchema,
  SetBackupRequestSchema,
  SetLocalBudgetRequestSchema,
} from '../../../src/schemas/backup';
import { PathSegment, route } from '../../../src/schemas/route';
import { NothingSchema, request } from './request';

// Backing a library's originals up to a folder (§14).
export const backupApi = {
  list: (): Promise<{ backups: BackupStatus[] }> =>
    request(BackupStatusesSchema, 'GET', route(PathSegment.api(), PathSegment.backup())),
  setFolder: (libraryId: string, path: string): Promise<BackupStatus> =>
    request(
      BackupStatusSchema,
      'PUT',
      route(PathSegment.api(), PathSegment.backup()),
      SetBackupRequestSchema.parse({ library_id: libraryId, path }),
    ),
  // Fetching every offloaded original back first is minutes, like a pass.
  remove: (libraryId: string, fetchFirst: boolean): Promise<void> =>
    request(
      NothingSchema,
      'DELETE',
      `${route(PathSegment.api(), PathSegment.backup(), libraryId)}${fetchFirst ? '?fetch_first=1' : ''}`,
    ),
  fetchBackProgress: (libraryId: string): Promise<FetchBackProgress | null> =>
    request(
      FetchBackStatusSchema,
      'GET',
      route(PathSegment.api(), PathSegment.backup(), libraryId, PathSegment.fetch()),
      undefined,
      { activity: 'background' },
    ).then((status) => status.progress),
  setBudget: (libraryId: string, bytes: number | null): Promise<BackupStatus> =>
    request(
      BackupStatusSchema,
      'PUT',
      route(PathSegment.api(), PathSegment.backup(), libraryId, PathSegment.budget()),
      SetLocalBudgetRequestSchema.parse({ local_budget_bytes: bytes }),
    ),
  // Copies what the folder is owed and then culls, so it is minutes rather than seconds.
  run: (libraryId: string): Promise<BackupRunResponse> =>
    request(BackupRunResponseSchema, 'POST', route(PathSegment.api(), PathSegment.backup(), libraryId, PathSegment.run())),
};
