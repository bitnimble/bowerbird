// What the watcher refuses to wake for, which is the half of the scope rules a
// scan cannot demonstrate: an excluded folder must not keep triggering syncs,
// and a root-only library must not be roused by its subfolders.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../src/schemas/libraries';
import type { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { LibraryWatcher } from '../../src/services/sync/library_watcher';
import type { SyncService } from '../../src/services/sync/sync_service';
import { libraryScope, type LibraryScope } from '../../src/utils/scope';

const LIB = 'lib-ignores';
const DEBOUNCE = 30;

let root: string;
let watcher: LibraryWatcher;
let calls: (readonly string[] | undefined)[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Long enough for a debounce plus a sync that was never going to come: the
// assertion is an absence, so it has to outlast the thing it denies.
async function quiet(): Promise<void> {
  await sleep(DEBOUNCE * 6 + 100);
}

async function start(over: Partial<LibraryScope>): Promise<void> {
  const library = { id: LIB, root_path: root, data_path: null, ordering: 'taken_desc' } as Library;
  const libraries = { list: () => [library], getById: () => library } as unknown as LibrariesRepository;
  const sync = {
    syncLibrary: async (_id: string, scope?: readonly string[]) => {
      calls.push(scope);
      return {};
    },
    scopeFor: (): LibraryScope =>
      libraryScope(
        { root_path: root, include_subfolders: over.includeSubfolders ?? true },
        over.dataPath ?? path.join(root, '.bowerbird'),
        over.excluded ?? new Set<string>(),
      ),
  } as unknown as SyncService;
  watcher = new LibraryWatcher(libraries, sync, DEBOUNCE);
  watcher.start();
  await watcher.whenReady();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bb-ignore-'));
  calls = [];
});

afterEach(() => {
  watcher.stop();
  rmSync(root, { recursive: true, force: true });
});

test('an excluded folder never wakes a sync, and its siblings still do', async () => {
  mkdirSync(path.join(root, 'Rejects', '2019'), { recursive: true });
  mkdirSync(path.join(root, 'Trip'));
  await start({ excluded: new Set(['Rejects']) });

  writeFileSync(path.join(root, 'Rejects', '2019', 'old.arw'), '');
  await quiet();
  expect(calls).toEqual([]);

  writeFileSync(path.join(root, 'Trip', 'new.arw'), '');
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toContain('Trip/new.arw');
});

test('a root-only library is woken by its root and not by its subfolders', async () => {
  mkdirSync(path.join(root, 'Trip'));
  await start({ includeSubfolders: false });

  writeFileSync(path.join(root, 'Trip', 'deep.arw'), '');
  await quiet();
  expect(calls).toEqual([]);

  writeFileSync(path.join(root, 'top.arw'), '');
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toContain('top.arw');
});

test('the Bin and the data directory never wake a sync', async () => {
  mkdirSync(path.join(root, 'Trip', 'Bin'), { recursive: true });
  mkdirSync(path.join(root, '.bowerbird'), { recursive: true });
  await start({});

  writeFileSync(path.join(root, 'Trip', 'Bin', 'binned.arw'), '');
  writeFileSync(path.join(root, '.bowerbird', 'stray.arw'), '');
  await quiet();
  expect(calls).toEqual([]);
});
