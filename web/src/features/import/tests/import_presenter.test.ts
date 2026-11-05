import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type {
  ImportFile,
  ImportFileStates,
  ImportHeader,
  ImportJob,
  ImportScan,
} from '../../../../../src/schemas/imports';
import type { Library } from '../../../../../src/schemas/libraries';
import type { PhotoFormat } from '../../../../../src/schemas/photos';
import type { Shoot } from '../../../../../src/schemas/shoots';
import { importsApi } from '../../../api/imports';
import { shootsApi } from '../../../api/shoots';
import { restoreApiAfterTests } from '../../../test_api';
import { MemoryStorage } from '../../../test_storage';
import type { ConfirmRequest } from '../../confirm/confirm_store';
import { buildEntries, filenameOf } from '../import_entries';
import { ImportPresenter } from '../import_presenter';
import { ImportStore } from '../import_store';

restoreApiAfterTests();

const FORMAT: Record<string, PhotoFormat> = {
  arw: 'arw',
  jpg: 'jpeg',
  heic: 'heif',
  png: 'png',
};

function fileOf(id: number, relPath: string, day = '01'): ImportFile {
  return {
    id,
    rel_path: relPath,
    format: FORMAT[relPath.slice(relPath.lastIndexOf('.') + 1).toLowerCase()] ?? 'arw',
    file_size: 10,
    modified_at: `2026-03-${day}T12:00:00.000Z`,
  };
}

const CARD: ImportFile[] = [
  fileOf(0, 'DCIM/DSC1.ARW', '02'),
  fileOf(1, 'DCIM/DSC1.JPG', '02'),
  fileOf(2, 'DCIM/DSC2.ARW', '03'),
  fileOf(3, 'DCIM/DSC3.JPG', '01'),
];

const FIRST_LIBRARY = { id: 'lib00001', name: 'One', read_only: false, include_non_raw: true };
const RAW_ONLY = { id: 'lib00002', name: 'Two', read_only: false, include_non_raw: false };

let store: ImportStore;
let presenter: ImportPresenter;
let toasts: string[];
let errors: string[];
let started: Parameters<typeof importsApi.start>[0][];
let inLibrary: number[];
let deletedFiles: number[];
let createdShoots: string[];
let asked: ConfirmRequest[];
let confirmed: boolean;

function scanOf(files: ImportFile[]): ImportScan {
  return { id: 'scan0001', source: '/card', files, complete: true };
}

const job = (change: Partial<ImportJob> = {}): ImportJob => ({
  id: 'job00001',
  library_id: FIRST_LIBRARY.id,
  shoot_id: null,
  status: 'copying',
  total: 4,
  copied: 0,
  skipped: 0,
  failed: 0,
  failed_names: [],
  deleted: 0,
  kept: 0,
  kept_names: [],
  ...change,
});

async function scanned(files: ImportFile[] = CARD): Promise<void> {
  importsApi.scan = mock(async () => scanOf(files));
  presenter.selectVolume('/card');
  await presenter.scan();
}

function storeOf(libraries: Library[]): ImportStore {
  return new ImportStore({
    libraries,
    byId: new Map(libraries.map((library) => [library.id, library])),
  });
}

function tileNames(): string[][] {
  return store.entries.map((entry) => entry.files.map(filenameOf));
}

beforeEach(async () => {
  globalThis.localStorage = new MemoryStorage();
  const libraries = [FIRST_LIBRARY, RAW_ONLY] as Library[];
  store = storeOf(libraries);
  toasts = [];
  errors = [];
  started = [];
  inLibrary = [];
  deletedFiles = [];
  createdShoots = [];
  asked = [];
  confirmed = true;
  presenter = new ImportPresenter(
    store,
    {
      create: async (_, name) => {
        createdShoots.push(name);
        return 'sht00001';
      },
    },
    { show: (message) => toasts.push(message), showError: (message) => errors.push(message) },
    {
      ask: async (request) => {
        asked.push(request);
        return confirmed;
      },
    },
  );
  shootsApi.list = mock(async () => []);
  importsApi.fileStates = mock(async () => ({ in_library: inLibrary, deleted: deletedFiles }));
  importsApi.headers = mock(async () => []);
  importsApi.start = mock(async (body) => {
    started.push(body);
    return job();
  });
  await presenter.setLibrary(FIRST_LIBRARY.id);
});

afterEach(() => {
  mock.restore();
});

test('merging puts a RAW and its camera file on 1 tile drawn from the JPEG', () => {
  const [pair] = buildEntries(CARD.slice(0, 2), true);

  expect(pair?.files.map((file) => file.id)).toEqual([0, 1]);
  expect(pair?.thumbnail?.id).toBe(1);
  expect(pair?.mergedFormats).toEqual(['jpeg']);
});

test('without merging every file is its own tile', () => {
  expect(buildEntries(CARD.slice(0, 2), false).map((entry) => entry.files.length)).toEqual([1, 1]);
});

test('a RAW+HEIC pair draws from the RAW, which a browser can show', () => {
  const [pair] = buildEntries([fileOf(0, 'a.ARW'), fileOf(1, 'a.HEIC')], true);

  expect(pair?.thumbnail?.id).toBe(0);
  expect(pair?.mergedFormats).toEqual(['heif']);
});

test('a lone HEIC has nothing to draw', () => {
  expect(buildEntries([fileOf(0, 'a.HEIC')], true)[0]?.thumbnail).toBeNull();
});

test('the same stem in another folder does not merge', () => {
  const entries = buildEntries([fileOf(0, '100/a.ARW'), fileOf(1, '101/a.JPG')], true);

  expect(entries.map((entry) => entry.mergedFormats)).toEqual([[], []]);
});

test('a PNG beside a RAW is not its camera file', () => {
  const entries = buildEntries([fileOf(0, 'a.ARW'), fileOf(1, 'a.PNG')], true);

  expect(entries.map((entry) => entry.files.length)).toEqual([1, 1]);
});

test('everything starts selected, newest first', async () => {
  await scanned();

  expect(tileNames()).toEqual([['DSC2.ARW'], ['DSC1.ARW', 'DSC1.JPG'], ['DSC3.JPG']]);
  expect(store.selectedEntryCount).toBe(3);
  expect(store.selectedFileIds.sort()).toEqual([0, 1, 2, 3]);
});

test('what the library holds starts unselected and can be ticked back on', async () => {
  inLibrary = [2];
  await scanned();
  const held = store.entries.find((entry) => entry.lead.id === 2)!;

  expect(store.isInLibrary(held)).toBe(true);
  expect(store.isSelected(held)).toBe(false);

  presenter.toggle(held);

  expect(store.isSelected(held)).toBe(true);
});

test('select all leaves what the library holds unticked', async () => {
  inLibrary = [2];
  await scanned();
  presenter.selectNone();

  presenter.selectAll();

  expect(store.selectedFileIds.sort()).toEqual([0, 1, 3]);
});

test('hiding what the library holds drops those tiles from the copy too', async () => {
  inLibrary = [2];
  await scanned();
  presenter.toggle(store.entries.find((entry) => entry.lead.id === 2)!);

  presenter.setFilters({ hideInLibrary: true });

  expect(tileNames()).toEqual([['DSC1.ARW', 'DSC1.JPG'], ['DSC3.JPG']]);
  expect(store.selectedFileIds).not.toContain(2);
});

test('a pair half in the library copies the other half only', async () => {
  inLibrary = [0];
  await scanned();
  const pair = store.entries.find((entry) => entry.lead.id === 0)!;

  expect(store.isInLibrary(pair)).toBe(false);
  expect(store.selectedFileIds).toContain(1);
  expect(store.selectedFileIds).not.toContain(0);
});

test('filtering out JPEG leaves the RAW alone, with no pair badge', async () => {
  await scanned();

  presenter.setFilters({ formats: ['arw'] });

  expect(tileNames()).toEqual([['DSC2.ARW'], ['DSC1.ARW']]);
  expect(store.entries.every((entry) => entry.mergedFormats.length === 0)).toBe(true);
  expect(store.selectedFileIds.sort()).toEqual([0, 2]);
});

test('the merge option keeps each file ticked as it was', async () => {
  await scanned();
  presenter.toggle(store.entries.find((entry) => entry.lead.id === 0)!);

  presenter.setMerge(false);

  expect(store.entries).toHaveLength(4);
  expect(store.selectedFileIds.sort()).toEqual([2, 3]);
});

test('a RAW-only destination lists and copies only RAWs, and says what it left out', async () => {
  await presenter.setLibrary(RAW_ONLY.id);
  await scanned();

  expect(tileNames()).toEqual([['DSC2.ARW'], ['DSC1.ARW']]);
  expect(store.unlistedCount).toBe(2);
  expect(store.selectedFileIds.sort()).toEqual([0, 2]);
  expect(store.activeFilterCount).toBe(0);
});

test('resetting filters cannot bring a JPEG back for a RAW-only destination', async () => {
  await presenter.setLibrary(RAW_ONLY.id);
  await scanned();

  presenter.resetFilters();

  expect(store.selectedFileIds.sort()).toEqual([0, 2]);
});

test('a format ticked for one library does not empty the grid of the next', async () => {
  await scanned();
  presenter.setFilters({ formats: ['jpeg'] });

  await presenter.setLibrary(RAW_ONLY.id);

  expect(store.filters.formats).toEqual([]);
  expect(tileNames()).toEqual([['DSC2.ARW'], ['DSC1.ARW']]);
});

test('what one destination held is ticked again for one that does not hold it', async () => {
  inLibrary = [2];
  await scanned();
  expect(store.selectedFileIds).not.toContain(2);

  inLibrary = [];
  await presenter.setLibrary(RAW_ONLY.id);

  expect(store.selectedFileIds).toContain(2);
});

test('a file is dated by its mtime until its header lands', async () => {
  let answer: (headers: ImportHeader[]) => void = () => {};
  importsApi.headers = mock(
    () =>
      new Promise<ImportHeader[]>((resolve) => {
        answer = resolve;
      }),
  );
  await scanned(CARD.slice(2, 3));
  presenter.setFilters({ takenFrom: '2026-03-03', takenTo: '2026-03-03' });
  expect(tileNames()).toEqual([['DSC2.ARW']]);

  answer([
    { file_id: 2, date_taken: '2020-01-05T10:00:00.000Z', camera_model: null, lens_model: null },
  ]);
  await Bun.sleep(0);

  expect(tileNames()).toEqual([]);
});

test('a scan superseded by another never lands', async () => {
  let first: (scan: ImportScan) => void = () => {};
  importsApi.scan = mock(
    () =>
      new Promise<ImportScan>((resolve) => {
        first = resolve;
      }),
  );
  presenter.selectVolume('/card');
  const stale = presenter.scan();
  importsApi.scan = mock(async () => scanOf(CARD.slice(0, 1)));

  await presenter.scan();
  first(scanOf(CARD));
  await stale;

  expect(store.files.map((file) => file.id)).toEqual([0]);
});

test('an in-library answer for a library since changed never lands', async () => {
  await scanned();
  let answer: (states: ImportFileStates) => void = () => {};
  importsApi.fileStates = mock(
    () =>
      new Promise<ImportFileStates>((resolve) => {
        answer = resolve;
      }),
  );
  const stale = presenter.setLibrary(RAW_ONLY.id);
  await Bun.sleep(0);
  const staleAnswer = answer;
  importsApi.fileStates = mock(async () => ({ in_library: [], deleted: [] }));

  await presenter.setLibrary(FIRST_LIBRARY.id);
  staleAnswer({ in_library: [0, 1, 2, 3], deleted: [] });
  await stale;

  expect(store.inLibrary.size).toBe(0);
  expect(store.selectedFileIds.sort()).toEqual([0, 1, 2, 3]);
});

test('a failed in-library read still lands the scan and reads its headers', async () => {
  importsApi.fileStates = mock(async () => {
    throw new Error('unreachable');
  });
  importsApi.headers = mock(async () => [
    { file_id: 0, date_taken: null, camera_model: 'R5', lens_model: null },
  ]);

  await scanned();
  await Bun.sleep(0);

  expect(store.error).not.toBeNull();
  expect(store.files).toHaveLength(4);
  expect(store.cameraModelOptions).toEqual(['R5']);
});

test('opening the page picks the first library that can take photos', async () => {
  const libraries = [
    { id: 'lib00003', read_only: true, include_non_raw: true },
    RAW_ONLY,
  ] as Library[];
  const fresh = storeOf(libraries);
  const page = new ImportPresenter(
    fresh,
    { create: async () => null },
    { show: () => {}, showError: () => {} },
    { ask: async () => false },
  );

  await page.chooseLibrary();

  expect(fresh.libraryId).toBe(RAW_ONLY.id);
});

test('reopening the page moves off a library gone, and off a shoot gone', async () => {
  const libraries = [RAW_ONLY] as Library[];
  const fresh = storeOf(libraries);
  const page = new ImportPresenter(
    fresh,
    { create: async () => null },
    { show: () => {}, showError: () => {} },
    { ask: async () => false },
  );
  await page.setLibrary(FIRST_LIBRARY.id);
  await page.chooseLibrary();
  expect(fresh.libraryId).toBe(RAW_ONLY.id);

  page.setShootChoice({ kind: 'shoot', id: 'sht00009' });
  await page.chooseLibrary();

  expect(fresh.shootChoice).toEqual({ kind: 'root' });
});

test('date and camera filters read headers once they land', async () => {
  importsApi.headers = mock(async () => [
    { file_id: 2, date_taken: '2020-01-05T10:00:00.000Z', camera_model: 'A7 IV', lens_model: null },
    { file_id: 0, date_taken: '2026-03-02T10:00:00.000Z', camera_model: 'R5', lens_model: null },
  ]);
  await scanned(CARD.slice(0, 3));
  await Bun.sleep(0);

  expect(store.cameraModelOptions).toEqual(['A7 IV', 'R5']);

  presenter.setFilters({ takenFrom: '2020-01-01', takenTo: '2020-12-31' });
  expect(tileNames()).toEqual([['DSC2.ARW']]);

  presenter.setFilters({ takenFrom: undefined, takenTo: undefined, cameraModels: ['R5'] });
  expect(tileNames()).toEqual([['DSC1.ARW', 'DSC1.JPG']]);
});

test('add to library sends the selected files of the chosen shoot', async () => {
  await scanned();
  presenter.setShootChoice({ kind: 'shoot', id: 'sht00009' });
  presenter.toggle(store.entries.find((entry) => entry.lead.id === 3)!);

  await presenter.add();

  expect(started).toHaveLength(1);
  expect(started[0]?.shoot_id).toBe('sht00009');
  expect(started[0]?.file_ids.sort()).toEqual([0, 1, 2]);
});

test('a new shoot is made first, by its trimmed name, and its id goes with the copy', async () => {
  await scanned();
  presenter.setShootChoice({ kind: 'new' });
  presenter.setNewShootName(' Trip ');
  shootsApi.list = mock(async () => [{ id: 'sht00001' } as Shoot]);

  await presenter.add();

  expect(createdShoots).toEqual(['Trip']);
  expect(started[0]?.shoot_id).toBe('sht00001');
  expect(store.shootChoice).toEqual({ kind: 'shoot', id: 'sht00001' });
});

test('finishing announces once and marks what landed as in the library', async () => {
  await scanned();
  presenter.jobProgressed(job());
  inLibrary = [0, 1, 2, 3];

  presenter.jobProgressed(job({ status: 'finished', copied: 4 }));
  presenter.jobProgressed(job({ status: 'finished', copied: 4 }));
  await Bun.sleep(0);

  expect(toasts).toHaveLength(1);
  expect(store.entries.every((entry) => store.isInLibrary(entry))).toBe(true);
  expect(store.selectedEntryCount).toBe(0);
});

test('a finish that overtakes the start answer stays finished', async () => {
  await scanned();
  importsApi.start = mock(async () => {
    presenter.jobProgressed(job());
    presenter.jobProgressed(job({ status: 'finished', copied: 4 }));
    return job();
  });

  await presenter.add();

  expect(store.copying).toBe(false);
  expect(toasts).toHaveLength(1);
});

test('a run the server no longer knows stops showing as copying', async () => {
  presenter.jobProgressed(job());
  importsApi.currentJob = mock(async () => null);

  await presenter.loadJob();

  expect(store.copying).toBe(false);
});

test('adding without the option asks nothing and deletes nothing', async () => {
  await scanned();

  await presenter.add();

  expect(asked).toHaveLength(0);
  expect(started[0]?.delete_originals).toBe(false);
});

test('deleting after copying asks first, naming how many originals go', async () => {
  await scanned();
  presenter.setDeleteOriginals(true);

  await presenter.add();

  expect(asked.map((request) => request.title)).toEqual(['Copy and delete 4 originals?']);
  expect(asked[0]?.tone).toBe('danger');
  expect(started[0]?.delete_originals).toBe(true);
});

test('declining the question starts nothing and makes no shoot', async () => {
  await scanned();
  presenter.setShootChoice({ kind: 'new' });
  presenter.setNewShootName('Trip');
  presenter.setDeleteOriginals(true);
  confirmed = false;

  await presenter.add();

  expect(started).toHaveLength(0);
  expect(createdShoots).toHaveLength(0);
});

test('what a run deleted leaves the list, without scanning, keeping ticks and filters', async () => {
  await scanned();
  presenter.toggle(store.entries.find((entry) => entry.lead.id === 3)!);
  presenter.setFilters({ search: 'DSC' });
  presenter.jobProgressed(job());
  const scan = mock(async () => scanOf([]));
  importsApi.scan = scan;
  deletedFiles = [0, 1];

  presenter.jobProgressed(job({ status: 'finished', copied: 2, deleted: 2 }));
  await Bun.sleep(0);

  expect(scan).not.toHaveBeenCalled();
  expect(tileNames()).toEqual([['DSC2.ARW'], ['DSC3.JPG']]);
  expect(store.selectedFileIds).toEqual([2]);
  expect(store.filters.search).toBe('DSC');
  expect(toasts).toEqual(['Added 2 files to the library and deleted 2 originals.']);
});

test('an original kept after its copy stays listed, unticked, as in the library', async () => {
  await scanned(CARD.slice(2, 3));
  presenter.jobProgressed(job());
  inLibrary = [2];

  presenter.jobProgressed(
    job({ status: 'finished', copied: 1, kept: 1, kept_names: ['DCIM/DSC2.ARW'] }),
  );
  await Bun.sleep(0);

  expect(store.selectedFileIds).toEqual([]);
  expect(store.isInLibrary(store.entries[0]!)).toBe(true);
});

test('a camera whose every file was deleted leaves the filter options', async () => {
  importsApi.headers = mock(async () => [
    { file_id: 2, date_taken: null, camera_model: 'A7 IV', lens_model: null },
    { file_id: 3, date_taken: null, camera_model: 'R5', lens_model: null },
  ]);
  await scanned();
  await Bun.sleep(0);
  presenter.jobProgressed(job());
  deletedFiles = [2];

  presenter.jobProgressed(job({ status: 'finished', copied: 1, deleted: 1 }));
  await Bun.sleep(0);

  expect(store.cameraModelOptions).toEqual(['R5']);
});

test('reopening the page drops what a run deleted while nobody was told', async () => {
  await scanned();
  deletedFiles = [0, 1];

  await presenter.chooseLibrary();

  expect(tileNames()).toEqual([['DSC2.ARW'], ['DSC3.JPG']]);
});

test('delete after copying is off until asked for, then stays on', async () => {
  expect(store.deleteOriginals).toBe(false);

  presenter.setDeleteOriginals(true);
  await scanned();
  presenter.jobProgressed(job());
  presenter.jobProgressed(job({ status: 'finished', copied: 4, deleted: 4 }));
  await Bun.sleep(0);

  expect(store.deleteOriginals).toBe(true);

  const reopened = storeOf([]);
  new ImportPresenter(
    reopened,
    { create: async () => null },
    { show: () => {}, showError: () => {} },
    { ask: async () => false },
  );
  expect(reopened.deleteOriginals).toBe(true);
});

test('an original kept after its copy is reported as an error', () => {
  presenter.jobProgressed(job());

  presenter.jobProgressed(
    job({ status: 'finished', copied: 4, deleted: 3, kept: 1, kept_names: ['a'] }),
  );

  expect(errors).toEqual(["We couldn't delete 1 original."]);
  expect(toasts).toHaveLength(0);
});

test('a run with failures says so', () => {
  presenter.jobProgressed(job());

  presenter.jobProgressed(job({ status: 'finished', copied: 3, failed: 1, failed_names: ['a'] }));

  expect(errors).toHaveLength(1);
  expect(toasts).toHaveLength(0);
});
