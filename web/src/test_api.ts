// Handing each domain API back the methods a test file stubbed on it.
//
// `bun test` runs every file in one process and each API is a module singleton, so a stub outlives
// the file that installed it: one that never resolves hangs an unrelated test several files later.
import { afterAll } from 'bun:test';
import { albumsApi } from './api/albums';
import { backupApi } from './api/backup';
import { blobsApi } from './api/blobs';
import { browseApi } from './api/browse';
import { compositesApi } from './api/composites';
import { exportsApi } from './api/exports';
import { folderRulesApi } from './api/folder_rules';
import { frameTvsApi } from './api/frame_tvs';
import { librariesApi } from './api/libraries';
import { photoEditsApi } from './api/photo_edits';
import { photosApi } from './api/photos';
import { renditionsApi } from './api/renditions';
import { replicationApi } from './api/replication';
import { settingsApi } from './api/settings';
import { shootsApi } from './api/shoots';
import { stacksApi } from './api/stacks';
import { updatesApi } from './api/updates';

// Taken as this module is imported, which is before the body of the file importing it runs, so a
// caller cannot snapshot its own stubs by placing the call after them.
function restore<T extends object>(domainApi: T): () => void {
  const pristine = { ...domainApi };
  return () => Object.assign(domainApi, pristine);
}

const RESTORE = [
  albumsApi,
  backupApi,
  blobsApi,
  browseApi,
  compositesApi,
  exportsApi,
  folderRulesApi,
  frameTvsApi,
  librariesApi,
  photoEditsApi,
  photosApi,
  renditionsApi,
  replicationApi,
  settingsApi,
  shootsApi,
  stacksApi,
  updatesApi,
].map(restore);

export function restoreApiAfterTests(): void {
  afterAll(() => RESTORE.forEach((restoreApi) => restoreApi()));
}
