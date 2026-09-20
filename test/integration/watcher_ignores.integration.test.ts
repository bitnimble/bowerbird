// What the watcher refuses to wake for, which is the half of the scope rules a
// scan cannot demonstrate: an excluded folder must not keep triggering syncs,
// and a root-only library must not be roused by its subfolders.
//   docker exec bowerbird-dev bun test test/integration
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../src/schemas/libraries';
import type { LibrariesRepository } from '../../src/services/libraries/libraries_repository';
import { LibraryWatcher } from '../../src/services/sync/watch/library_watcher';
import type { ScanService } from '../../src/services/sync/scan/scan_service';
import type { ScanScope } from '../../src/services/sync/scan/scan_evidence';
import { libraryScope, type LibraryScope } from '../../src/utils/scope';

const LIB = 'lib-ignores';
const DEBOUNCE = 30;
const POLL = 20_000;

let root: string;
let watcher: LibraryWatcher;
let calls: (readonly string[] | undefined)[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Long enough for a debounce plus a scan that was never going to come: the
// assertion is an absence, so it has to outlast the thing it denies.
async function quiet(): Promise<void> {
  await sleep(DEBOUNCE * 6 + 100);
}

async function start(over: Partial<Pick<LibraryScope, 'includeSubfolders' | 'binName' | 'excluded'>>): Promise<void> {
  const library = { id: LIB, root_path: root, bin_name: 'Bin', ordering: 'taken_desc' } as Library;
  const libraries = { list: () => [library], getById: () => library } as unknown as LibrariesRepository;
  const scan = {
    scanLibrary: async (_id: string, scope?: ScanScope) => {
      calls.push(scope?.paths);
      return {};
    },
    scopeFor: (): LibraryScope =>
      libraryScope(
        {
          root_path: root,
          include_subfolders: over.includeSubfolders ?? true,
          include_non_raw: false,
          bin_name: over.binName ?? 'Bin',
        },
        over.excluded ?? new Set<string>(),
      ),
  } as unknown as ScanService;
  watcher = new LibraryWatcher(libraries, scan, DEBOUNCE, POLL);
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

test('an excluded folder never wakes a scan, and its siblings still do', async () => {
  mkdirSync(path.join(root, 'Rejects', '2019'), { recursive: true });
  mkdirSync(path.join(root, 'Trip'));
  await start({ excluded: new Set(['Rejects']) });

  writeFileSync(path.join(root, 'Rejects', '2019', 'old.arw'), '');
  await quiet();
  expect(calls).toHaveLength(0);

  writeFileSync(path.join(root, 'Trip', 'new.arw'), '');
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toContain('Trip/new.arw');
});

test('a root-only library is woken by its root and not by its subfolders', async () => {
  mkdirSync(path.join(root, 'Trip'));
  await start({ includeSubfolders: false });

  writeFileSync(path.join(root, 'Trip', 'deep.arw'), '');
  await quiet();
  expect(calls).toHaveLength(0);

  writeFileSync(path.join(root, 'top.arw'), '');
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toContain('top.arw');
});

// The data directory is not under the root at all any more (§6), so what is left
// to prove here is the Bin - and a legacy `.bowerbird` tree, which is skipped as
// a dotfolder like any other.
test('the Bin and a legacy .bowerbird tree never wake a scan', async () => {
  mkdirSync(path.join(root, 'Bin', 'Trip'), { recursive: true });
  mkdirSync(path.join(root, '.bowerbird'), { recursive: true });
  await start({});

  writeFileSync(path.join(root, 'Bin', 'Trip', 'binned.arw'), '');
  writeFileSync(path.join(root, '.bowerbird', 'stray.arw'), '');
  await quiet();
  expect(calls).toHaveLength(0);
});

// Files the library will never hold, sitting right beside the ones it does.
test('a file of a format the library does not hold never wakes a scan', async () => {
  mkdirSync(path.join(root, 'Trip'));
  await start({});

  writeFileSync(path.join(root, 'Trip', 'notes.txt'), 'hello');
  writeFileSync(path.join(root, 'Trip', 'export.jpg'), '');
  await quiet();
  expect(calls).toHaveLength(0);

  writeFileSync(path.join(root, 'Trip', 'shot.arw'), '');
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toEqual(['Trip/shot.arw']);
});

// A folder is what an empty shoot's rename reports and the only thing it reports
// (§9.4.1), so the "not one of our formats" test must never be applied to one -
// and a folder is free to be named like a file.
test('a folder whose name looks like a file still wakes a scan', async () => {
  mkdirSync(path.join(root, 'Trip.v2'));
  await start({});

  renameSync(path.join(root, 'Trip.v2'), path.join(root, 'Trip.v3'));
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toContain('Trip.v3');
});

// The bin is one folder at the root, so the name means nothing anywhere else: a
// folder of the user's own called Bin is theirs, and its photographs are the
// library's (§12.3).
test('a folder called Bin below the root is watched like any other', async () => {
  mkdirSync(path.join(root, 'Trip', 'Bin'), { recursive: true });
  await start({});

  writeFileSync(path.join(root, 'Trip', 'Bin', 'kept.arw'), '');
  await quiet();
  expect(calls.flatMap((c) => c ?? [])).toContain('Trip/Bin/kept.arw');
});
