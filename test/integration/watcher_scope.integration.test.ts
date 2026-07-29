// Watcher scoping decisions, observed via a recording stub SyncService (real fs +
// real debounce, no DB work): scoped for small batches, full fallback past
// MAX_SCOPE, and paths re-queued when the sync loses the lock race.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../src/errors';
import type { Library } from '../../src/schemas/libraries';
import type { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { LibraryWatcher } from '../../src/services/sync/library_watcher';
import type { SyncService } from '../../src/services/sync/sync_service';
import { libraryScope, type LibraryScope } from '../../src/utils/scope';

const LIB = 'lib-scope';
const DEBOUNCE = 150;

let root: string;
let watcher: LibraryWatcher;
let calls: (string[] | undefined)[];
let failWith: AppError | null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !check(); i++) await sleep(50);
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-scope-'));
  calls = [];
  failWith = null;
  const library = {
    id: LIB,
    root_path: root,
    data_path: null,
    ordering: 'taken_desc',
    include_subfolders: true,
    mirror_shoots: true,
  } as Library;
  const libraries = { list: () => [library], getById: () => library } as unknown as LibrariesRepository;
  const sync = {
    syncLibrary: async (_id: string, scope?: readonly string[]) => {
      calls.push(scope ? [...scope].sort() : undefined);
      if (failWith != null) {
        const err = failWith;
        failWith = null;
        throw err;
      }
      return {};
    },
    scopeFor: (lib: Library): LibraryScope =>
      libraryScope(lib, path.join(lib.root_path, '.bowerbird'), new Set<string>()),
  } as unknown as SyncService;
  watcher = new LibraryWatcher(libraries, sync, DEBOUNCE);
  watcher.start();
  await watcher.whenReady(); // chokidar walks the tree before it delivers anything
});

afterEach(() => {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a small batch syncs scoped to the changed paths', async () => {
  writeFileSync(path.join(root, 'a.arw'), '');
  await settle(() => calls.length > 0);
  expect(calls[0]).toContain('a.arw');
});

test('a batch over MAX_SCOPE falls back to a full sync', async () => {
  for (let i = 0; i < 300; i++) writeFileSync(path.join(root, `bulk-${i}.arw`), '');
  await settle(() => calls.length > 0);
  expect(calls[0]).toBeUndefined(); // undefined scope == full sync
});

test('SYNC_IN_PROGRESS re-queues the paths so the retry stays scoped', async () => {
  failWith = new AppError('SYNC_IN_PROGRESS', 'busy');
  writeFileSync(path.join(root, 'c.arw'), '');
  await settle(() => calls.length >= 2);
  expect(calls[0]).toContain('c.arw');
  expect(calls[1]).toContain('c.arw'); // retried with the same scope, not dropped
});
