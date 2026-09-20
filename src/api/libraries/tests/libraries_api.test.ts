import { describe, it, expect, jest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../../errors';
import { libraryScope } from '../../../utils/scope';
import { applyErrorHandler } from '../../error_handler';
import type { Library, LibraryScanStatus } from '../../../schemas/libraries';
import { PathSegment, route } from '../../../schemas/route';
import type { LibrariesService } from '../../../services/libraries/libraries_service';
import type { FolderRulesRepository } from '../../../services/shoots/folder_rules_repository';
import type { ShootsService } from '../../../services/shoots/shoots_service';
import type { ScanService } from '../../../services/sync/scan/scan_service';
import { LibrariesApi } from '../libraries_api';

const LIBRARY_ID = 'lib00001';
const library: Library = { id: LIBRARY_ID, root_path: '/r', bin_name: 'Bin', read_only: false, name: 'lib', ordering: 'taken_desc',
  rendition_source: 'embedded',
  rendition_hdr: false,
  include_subfolders: true, include_non_raw: false, auto_stack: true, auto_stack_similarity: 0.78, auto_stack_window_seconds: 60, last_synced_at: null, photo_count: 0 };
const status: LibraryScanStatus = {
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

function buildApp(
  lib: Partial<LibrariesService> = {},
  scan: Partial<ScanService> = {},
  rules: Partial<FolderRulesRepository> = {},
  detectStacks: (libraryId: string) => number = jest.fn(() => 0),
  shootsOver: Partial<ShootsService> = {},
) {
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
  const shoots = { hiddenFolders: jest.fn(() => [] as string[]), ...shootsOver } as unknown as ShootsService;
  const app = new Hono();
  app.route(route(PathSegment.api(), PathSegment.libraries()), new LibrariesApi(libraries, syncSvc, folderRules, shoots, detectStacks).routes);
  applyErrorHandler(app);
  return { app, libraries, scan: syncSvc, folderRules, shoots, detectStacks };
}

describe('LibrariesApi', () => {
  it('creates a library (201)', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '/r' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects an empty root_path (400 envelope)', async () => {
    const { app } = buildApp();
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('maps a CONFLICT from the service', async () => {
    const { app } = buildApp({ create: jest.fn(() => { throw new AppError('CONFLICT', 'dup'); }) });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root_path: '/r' }),
    });
    expect(res.status).toBe(409);
  });

  it('triggers a scan and returns its status', async () => {
    const scanLibrary = jest.fn(async () => status);
    const { app } = buildApp({}, { scanLibrary });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.sync()), { method: 'POST' });
    expect(res.status).toBe(200);
    expect(scanLibrary).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('queues a library-wide tile rebuild', async () => {
    const rebuildTiles = jest.fn(() => status);
    const { app } = buildApp({}, { rebuildTiles });
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.tiles()),
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(rebuildTiles).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('queues a library-wide rendition rebuild', async () => {
    const rebuildRenditions = jest.fn(() => status);
    const { app } = buildApp({}, { rebuildRenditions });
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.renditions()),
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(rebuildRenditions).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('re-forms the automatic stacks and answers with how many there are', async () => {
    const detectStacks = jest.fn(() => 4);
    const { app } = buildApp({}, {}, {}, detectStacks);
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.stacks()),
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stacks: 4 });
    expect(detectStacks).toHaveBeenCalledWith(LIBRARY_ID);
  });

  it('refuses stack detection for a library that does not exist', async () => {
    const detectStacks = jest.fn(() => 0);
    const { app } = buildApp(
      { get: jest.fn(() => { throw new AppError('NOT_FOUND', 'no such library'); }) },
      {},
      {},
      detectStacks,
    );
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), 'nope', PathSegment.jobs(), PathSegment.stacks()),
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
    expect(detectStacks).not.toHaveBeenCalled();
  });

  it('maps VALIDATION_ERROR when a library has no renders to rebuild', async () => {
    const { app } = buildApp(
      {},
      { rebuildRenditions: jest.fn(() => { throw new AppError('VALIDATION_ERROR', 'no renders'); }) },
    );
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.renditions()),
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 409 when a rebuild is asked for while a scan is running', async () => {
    const { app } = buildApp(
      {},
      { rebuildTiles: jest.fn(() => { throw new AppError('SYNC_IN_PROGRESS', 'busy'); }) },
    );
    const res = await app.request(
      route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.jobs(), PathSegment.tiles()),
      { method: 'POST' },
    );
    expect(res.status).toBe(409);
  });

  it('returns 409 when a scan is already running', async () => {
    const { app } = buildApp({}, { scanLibrary: jest.fn(() => { throw new AppError('SYNC_IN_PROGRESS', 'busy'); }) });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.sync()), { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('deletes a library (204)', async () => {
    const del = jest.fn();
    const { app } = buildApp({ delete: del });
    const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID), { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalledWith(LIBRARY_ID);
  });

  // A hidden shoot's folders leave the tree with the shoot (§12.4), which is what stops Tree (full)
  // drawing them back as unclaimed rows offering to adopt the shoot already on them. Over a real
  // temp tree, so the walk and the filter are held against each other rather than mocked apart.
  describe('the folder tree and the shoots put away', () => {
    function withTree(): { root: string; drop: () => void } {
      const root = mkdtempSync(path.join(tmpdir(), 'bowerbird-folders-'));
      for (const folder of ['Trip', 'Trip/Day one', 'Other']) mkdirSync(path.join(root, folder), { recursive: true });
      return { root, drop: () => rmSync(root, { recursive: true, force: true }) };
    }

    function appOver(root: string, hiddenFolders: string[]) {
      const rooted = { ...library, root_path: root };
      return buildApp(
        { get: jest.fn(() => rooted) },
        { scopeFor: jest.fn(() => libraryScope(rooted, new Set<string>())) },
        {},
        jest.fn(() => 0),
        { hiddenFolders: jest.fn(() => hiddenFolders) },
      );
    }

    it('drops a hidden shoot and everything under it by default', async () => {
      const { root, drop } = withTree();
      try {
        const { app, shoots } = appOver(root, ['Trip']);
        const res = await app.request(route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.folders()));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(['Other']);
        expect(shoots.hiddenFolders).toHaveBeenCalledWith(LIBRARY_ID);
      } finally {
        drop();
      }
    });

    it('answers with the whole tree when the hidden are asked for', async () => {
      const { root, drop } = withTree();
      try {
        const { app, shoots } = appOver(root, ['Trip']);
        const res = await app.request(
          `${route(PathSegment.api(), PathSegment.libraries(), LIBRARY_ID, PathSegment.folders())}?include_hidden=true`,
        );
        expect(((await res.json()) as string[]).sort()).toEqual(['Other', 'Trip', 'Trip/Day one']);
        // Nothing to filter by, so nothing is asked for.
        expect(shoots.hiddenFolders).not.toHaveBeenCalled();
      } finally {
        drop();
      }
    });
  });
});
