import { jest } from 'bun:test';
import { Hono } from 'hono';
import { applyErrorHandler } from '../../error_handler';
import type { Library, LibraryScanStatus } from '../../../schemas/libraries';
import { PathSegment, route } from '../../../schemas/route';
import type { LibrariesService } from '../../../services/libraries/libraries_service';
import type { FolderRulesRepository } from '../../../services/shoots/folder_rules_repository';
import type { ShootsService } from '../../../services/shoots/shoots_service';
import type { ScanService } from '../../../services/sync/scan/scan_service';
import { LibrariesApi } from '../libraries_api';
import type { Activity } from '../../../schemas/activity';

export const LIBRARY_ID = 'lib00001';
export const library: Library = {
  id: LIBRARY_ID,
  root_path: '/r',
  bin_name: 'Bin',
  read_only: false,
  name: 'lib',
  ordering: 'taken_desc',
  rendition_source: 'embedded',
  rendition_hdr: false,
  render_skip_full: [],
  render_skip_max: [],
  denoiser: 'galosh',
  include_subfolders: true,
  include_non_raw: false,
  auto_stack: true,
  auto_stack_similarity: 0.78,
  auto_stack_window_seconds: 60,
  last_synced_at: null,
  photo_count: 0,
  missing_photo_count: 0,
  unavailable_photo_count: 0,
  rendered_photo_count: 0,
};
export const status: LibraryScanStatus = {
  library_id: LIBRARY_ID,
  status: 'processing',
  photos_to_scan: 3,
  photos_scanned: 3,
  photos_added: 3,
  photos_removed: 0,
  photos_moved: 0,
  photos_modified: 0,
  photos_processing: 0,
  photos_processed: 0,
  photos_per_second: null,
};

export interface LibrariesApp {
  app: Hono;
  libraries: LibrariesService;
  scan: ScanService;
  folderRules: FolderRulesRepository;
  shoots: ShootsService;
  detectStacks: (libraryId: string) => number;
}

export function buildApp(
  lib: Partial<LibrariesService> = {},
  scan: Partial<ScanService> = {},
  rules: Partial<FolderRulesRepository> = {},
  detectStacks: (libraryId: string) => number = jest.fn(() => 0),
  shootsOver: Partial<ShootsService> = {},
  activityFor: (libraryId: string) => Activity[] = () => [],
  globalActivity: () => Activity[] = () => [],
): LibrariesApp {
  const libraries = {
    create: jest.fn(async () => library),
    list: jest.fn(() => [library]),
    get: jest.fn(() => library),
    delete: jest.fn(),
    ...lib,
  } as unknown as LibrariesService;
  const syncSvc = {
    scanLibrary: jest.fn(async () => status),
    getScanStatus: jest.fn(() => status),
    ...scan,
  } as unknown as ScanService;
  const folderRules = {
    listByLibrary: jest.fn(() => []),
    set: jest.fn(),
    clear: jest.fn(() => true),
    ...rules,
  } as unknown as FolderRulesRepository;
  const shoots = {
    hiddenFolders: jest.fn(() => [] as string[]),
    ...shootsOver,
  } as unknown as ShootsService;
  const app = new Hono();
  app.route(
    route(PathSegment.api(), PathSegment.libraries()),
    new LibrariesApi(
      libraries,
      syncSvc,
      folderRules,
      shoots,
      detectStacks,
      activityFor,
      globalActivity,
    ).routes,
  );
  applyErrorHandler(app);
  return { app, libraries, scan: syncSvc, folderRules, shoots, detectStacks };
}
