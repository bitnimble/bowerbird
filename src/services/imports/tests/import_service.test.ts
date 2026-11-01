import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../../../errors';
import type { ImportJob } from '../../../schemas/imports';
import type { Library } from '../../../schemas/libraries';
import type { Shoot } from '../../../schemas/shoots';
import { computeFileHash } from '../../../utils/hash';
import type { HeaderMetadata } from '../../processing/analysis/metadata';
import type { ScanScope } from '../../sync/scan/scan_evidence';
import { ImportService } from '../import_service';

const SHOT_AT = new Date('2026-03-04T05:06:07.000Z');
const WAIT_MS = 4000;

let scratch: string;
let card: string;
let root: string;
let library: Library;
let held: { file_hash: string; file_path: string }[];
let scanned: { libraryId: string; scope: ScanScope }[];
let scanConflicts: number;
let onProgress: (job: ImportJob) => void;
let service: ImportService;

function place(dir: string, relPath: string, bytes = relPath, at = SHOT_AT): string {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  utimesSync(abs, at, at);
  return abs;
}

async function until<T>(found: () => T | null | undefined): Promise<T> {
  const deadline = performance.now() + WAIT_MS;
  while (performance.now() < deadline) {
    const value = found();
    if (value != null) return value;
    await Bun.sleep(1);
  }
  throw new Error('timed out waiting on the import');
}

function finished(): Promise<ImportJob> {
  return until(() => {
    const job = service.currentJob();
    return job?.status === 'copying' ? null : job;
  });
}

async function scanAndCopyAll(shootId: string | null = null): Promise<ImportJob> {
  const scan = await service.scan(card);
  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: shootId,
    file_ids: scan.files.map((file) => file.id),
    delete_originals: false,
  });
  return await finished();
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'bb-import-'));
  card = path.join(scratch, 'card');
  root = path.join(scratch, 'library');
  mkdirSync(card);
  mkdirSync(root);
  library = {
    id: 'lib00001',
    name: 'Library',
    root_path: root,
    read_only: false,
  } as Library;
  held = [];
  scanned = [];
  scanConflicts = 0;
  onProgress = () => {};
  const shoots = [
    { id: 'sht00001', library_id: 'lib00001', folder_path: 'Trip' },
    { id: 'sht00002', library_id: 'lib00002', folder_path: 'Elsewhere' },
    { id: 'sht00003', library_id: 'lib00001', folder_path: '../escaped' },
  ] as Shoot[];
  service = new ImportService(
    { getById: (id) => (id === library.id ? library : null), list: () => [library] },
    { getById: (id) => shoots.find((shoot) => shoot.id === id) ?? null },
    { filesHeld: () => held },
    {
      scanLibrary: async (libraryId, scope) => {
        if (scanConflicts-- > 0) throw new AppError('SYNC_IN_PROGRESS', 'a scan is running');
        scanned.push({ libraryId, scope });
      },
    },
    {
      read: async (absPath) => {
        if (absPath.endsWith('broken.arw')) throw new Error('unreadable');
        return {
          dateTaken: '2026-03-04T05:06:07.000Z',
          cameraModel: 'A7 IV',
          lensModel: '35mm',
        } as HeaderMetadata;
      },
      liftEmbedded: async (absPath) =>
        absPath.endsWith('blank.arw') ? null : new Uint8Array([0xff, 0xd8]),
    },
    () => 4,
    (job) => onProgress(job),
  );
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test('a scan finds originals anywhere under the source and keeps nothing else', async () => {
  place(card, 'DCIM/100MSDCF/DSC1.ARW');
  place(card, 'DCIM/101MSDCF/DSC2.JPG');
  place(card, 'DCIM/101MSDCF/clip.MP4');
  place(card, 'DCIM/._DSC1.ARW');
  place(card, '.Trashes/DSC3.ARW');

  const scan = await service.scan(card);

  expect(scan.complete).toBe(true);
  expect(scan.files.map((file) => [file.rel_path, file.format]).sort()).toEqual([
    ['DCIM/100MSDCF/DSC1.ARW', 'arw'],
    ['DCIM/101MSDCF/DSC2.JPG', 'jpeg'],
  ]);
  expect(scan.files[0]?.modified_at).toBe(SHOT_AT.toISOString());
});

test('a source that is not there is a not-found', async () => {
  await expect(service.scan(path.join(scratch, 'unplugged'))).rejects.toThrow("couldn't find");
});

test('a recycle bin at the root of a drive is not listed', async () => {
  place(card, '$RECYCLE.BIN/S-1-5/$R1.ARW');
  place(card, 'DSC1.ARW');

  const scan = await service.scan(card);

  expect(scan.files.map((file) => file.rel_path)).toEqual(['DSC1.ARW']);
});

test('recognises what the library holds by its stat hash and name', async () => {
  const onCard = place(card, 'held.arw');
  place(card, 'new.arw', 'other bytes of another size');
  const hash = computeFileHash(onCard, {
    mtime: SHOT_AT.toISOString(),
    fileSize: statSync(onCard).size,
  });
  held = [{ file_hash: hash, file_path: 'Trip/HELD.ARW' }];

  const scan = await service.scan(card);
  const ids = service.fileStates(scan.id, library.id).in_library;

  expect(ids.map((id) => scan.files[id]?.rel_path)).toEqual(['held.arw']);
});

test('a frame of the same size and time under another name is not held', async () => {
  const first = place(card, 'burst1.arw', 'same size');
  place(card, 'burst2.arw', 'same size');
  const hash = computeFileHash(first, {
    mtime: SHOT_AT.toISOString(),
    fileSize: statSync(first).size,
  });
  held = [{ file_hash: hash, file_path: 'burst1.arw' }];

  const scan = await service.scan(card);
  const ids = service.fileStates(scan.id, library.id).in_library;

  expect(ids.map((id) => scan.files[id]?.rel_path)).toEqual(['burst1.arw']);
});

test('a file the copy gave a suffix is still recognised on the card', async () => {
  const onCard = place(card, 'DSC1.ARW');
  const hash = computeFileHash(onCard, {
    mtime: SHOT_AT.toISOString(),
    fileSize: statSync(onCard).size,
  });
  held = [{ file_hash: hash, file_path: 'DSC1_1.ARW' }];

  const scan = await service.scan(card);

  expect(service.fileStates(scan.id, library.id).in_library).toEqual([0]);
});

test('copies into the library root with the original mtime, and scans what landed', async () => {
  place(card, 'DCIM/100MSDCF/DSC1.ARW', 'raw bytes');

  const job = await scanAndCopyAll();

  const copied = path.join(root, 'DSC1.ARW');
  expect(readFileSync(copied, 'utf8')).toBe('raw bytes');
  expect(statSync(copied).mtimeMs).toBe(SHOT_AT.getTime());
  expect(job).toMatchObject({ status: 'finished', total: 1, copied: 1, skipped: 0, failed: 0 });
  expect(scanned).toEqual([{ libraryId: library.id, scope: { paths: ['DSC1.ARW'] } }]);
  expect(readdirSync(root)).toEqual(['DSC1.ARW']);
  expect(existsSync(path.join(card, 'DCIM/100MSDCF/DSC1.ARW'))).toBe(true);
});

test('copies into a shoot folder', async () => {
  place(card, 'DSC1.ARW');

  await scanAndCopyAll('sht00001');

  expect(existsSync(path.join(root, 'Trip/DSC1.ARW'))).toBe(true);
  expect(scanned[0]?.scope).toEqual({ paths: ['Trip/DSC1.ARW'] });
});

test('a different file of the same name gets a suffix, and replaces nothing', async () => {
  place(root, 'DSC1.ARW', 'older frame');
  place(card, 'DSC1.ARW', 'new frame');

  await scanAndCopyAll();

  expect(readFileSync(path.join(root, 'DSC1.ARW'), 'utf8')).toBe('older frame');
  expect(readFileSync(path.join(root, 'DSC1_1.ARW'), 'utf8')).toBe('new frame');
});

test('a RAW and its camera file keep one stem through a suffix', async () => {
  place(root, 'DSC1.ARW', 'older frame');
  place(card, 'DSC1.ARW', 'new raw');
  place(card, 'DSC1.JPG', 'new jpeg');

  await scanAndCopyAll();

  expect(readdirSync(root).sort()).toEqual(['DSC1.ARW', 'DSC1_1.ARW', 'DSC1_1.JPG']);
});

test('a camera file copied later follows the suffix its RAW landed under', async () => {
  place(root, 'DSC1.ARW', 'older frame');
  place(card, 'DSC1.ARW', 'new raw');
  place(card, 'DSC1.JPG', 'new jpeg');
  const scan = await service.scan(card);
  const idOf = (name: string): number =>
    scan.files.find((file) => file.rel_path === name)?.id ?? -1;
  const copy = async (name: string): Promise<void> => {
    await service.start({
      scan_id: scan.id,
      library_id: library.id,
      shoot_id: null,
      file_ids: [idOf(name)],
      delete_originals: false,
    });
    await finished();
  };

  await copy('DSC1.ARW');
  await copy('DSC1.JPG');

  expect(readdirSync(root).sort()).toEqual(['DSC1.ARW', 'DSC1_1.ARW', 'DSC1_1.JPG']);
});

test('a copy a crash left behind is swept, and nothing else is', async () => {
  place(card, 'DSC1.ARW');
  place(root, 'DSC9.ARW.abcdefgh12345678.tmp');
  place(root, 'notes.abcdefgh12345678.tmp');
  place(root, 'DSC8.ARW.bak.tmp');

  await scanAndCopyAll();

  expect(readdirSync(root).sort()).toEqual([
    'DSC1.ARW',
    'DSC8.ARW.bak.tmp',
    'notes.abcdefgh12345678.tmp',
  ]);
});

test('with the RAW already there, its camera file alone lands under the same stem', async () => {
  place(card, 'DSC1.ARW', 'the raw');
  place(card, 'DSC1.JPG', 'the jpeg');
  place(root, 'DSC1.ARW', 'the raw');
  const scan = await service.scan(card);
  const jpeg = scan.files.find((file) => file.format === 'jpeg')?.id ?? -1;

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [jpeg],
    delete_originals: false,
  });
  const job = await finished();

  expect(job).toMatchObject({ total: 1, copied: 1, skipped: 0 });
  expect(readdirSync(root).sort()).toEqual(['DSC1.ARW', 'DSC1.JPG']);
});

test('a suffix holds across a pair whose stems differ only in case', async () => {
  place(root, 'dsc1.arw', 'older frame');
  place(card, 'dsc1.arw', 'new raw');
  place(card, 'DSC1.JPG', 'new jpeg');

  await scanAndCopyAll();

  expect(readdirSync(root).sort()).toEqual(['DSC1_1.JPG', 'dsc1.arw', 'dsc1_1.arw']);
});

test('a copy whose mtime a coarse library rounded still counts as already there', async () => {
  place(card, 'DSC1.ARW', 'raw bytes', new Date(SHOT_AT.getTime() + 1500));
  place(root, 'DSC1.ARW', 'raw bytes', SHOT_AT);

  const job = await scanAndCopyAll();

  expect(job).toMatchObject({ copied: 0, skipped: 1 });
  expect(readdirSync(root)).toEqual(['DSC1.ARW']);
});

test('frames sharing a name in different card folders both arrive', async () => {
  place(card, '100MSDCF/DSC1.ARW', 'first roll');
  place(card, '101MSDCF/DSC1.ARW', 'second roll');

  await scanAndCopyAll();

  expect(readFileSync(path.join(root, 'DSC1.ARW'), 'utf8')).not.toBe(
    readFileSync(path.join(root, 'DSC1_1.ARW'), 'utf8'),
  );
});

test('a file already at the destination is skipped, so a repeat run adds nothing', async () => {
  place(card, 'DSC1.ARW', 'raw bytes');

  await scanAndCopyAll();
  const again = await scanAndCopyAll();

  expect(again).toMatchObject({ copied: 0, skipped: 1 });
  expect(readdirSync(root)).toEqual(['DSC1.ARW']);
});

test('a vanished source file is reported and the rest still copy', async () => {
  const gone = place(card, 'a.arw');
  place(card, 'b.arw');
  const scan = await service.scan(card);
  rmSync(gone);

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: scan.files.map((file) => file.id),
    delete_originals: false,
  });
  const job = await finished();

  expect(job).toMatchObject({ status: 'finished', copied: 1, failed: 1, failed_names: ['a.arw'] });
  expect(readdirSync(root)).toEqual(['b.arw']);
});

async function copyDeleting(fileIds?: number[]): Promise<ImportJob> {
  const scan = await service.scan(card);
  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: fileIds ?? scan.files.map((file) => file.id),
    delete_originals: true,
  });
  return await finished();
}

test('deleting after copying takes the originals once their copies landed', async () => {
  const original = place(card, 'DCIM/DSC1.ARW', 'raw bytes');

  const job = await copyDeleting();

  expect(existsSync(original)).toBe(false);
  expect(readFileSync(path.join(root, 'DSC1.ARW'), 'utf8')).toBe('raw bytes');
  expect(job).toMatchObject({ status: 'finished', copied: 1, deleted: 1, kept: 0 });
  expect(scanned).toEqual([{ libraryId: library.id, scope: { paths: ['DSC1.ARW'] } }]);
});

test('a scan names what its run deleted, and its ids still reach the rest', async () => {
  place(card, 'a.arw', 'first');
  place(card, 'b.arw', 'second');
  const scan = await service.scan(card);
  const a = scan.files.find((file) => file.rel_path === 'a.arw')?.id ?? -1;
  const b = scan.files.find((file) => file.rel_path === 'b.arw')?.id ?? -1;

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [a],
    delete_originals: true,
  });
  await finished();

  expect(service.fileStates(scan.id, library.id).deleted).toEqual([a]);
  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [b],
    delete_originals: false,
  });
  await finished();
  expect(readFileSync(path.join(root, 'b.arw'), 'utf8')).toBe('second');
});

test('without the option no original is deleted', async () => {
  const original = place(card, 'DSC1.ARW');

  const job = await scanAndCopyAll();

  expect(existsSync(original)).toBe(true);
  expect(job).toMatchObject({ deleted: 0, kept: 0 });
});

test('a file left unticked stays on the card', async () => {
  const ticked = place(card, 'a.arw');
  const unticked = place(card, 'b.arw');
  const scan = await service.scan(card);
  const a = scan.files.find((file) => file.rel_path === 'a.arw')?.id ?? -1;

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [a],
    delete_originals: true,
  });
  const job = await finished();

  expect(existsSync(ticked)).toBe(false);
  expect(existsSync(unticked)).toBe(true);
  expect(job).toMatchObject({ total: 1, deleted: 1 });
});

test('a file already at the destination is deleted once it reads back the same', async () => {
  const original = place(card, 'DSC1.ARW', 'raw bytes');
  place(root, 'DSC1.ARW', 'raw bytes');

  const job = await copyDeleting();

  expect(existsSync(original)).toBe(false);
  expect(job).toMatchObject({ copied: 0, skipped: 1, deleted: 1 });
});

test('a same-sized, same-dated file holding other bytes keeps the original, as a failure', async () => {
  const original = place(card, 'DSC1.ARW', 'raw bytes');
  place(root, 'DSC1.ARW', 'bad bytes');

  const job = await copyDeleting();

  expect(readFileSync(original, 'utf8')).toBe('raw bytes');
  expect(readFileSync(path.join(root, 'DSC1.ARW'), 'utf8')).toBe('bad bytes');
  expect(job).toMatchObject({
    status: 'finished',
    skipped: 0,
    failed: 1,
    failed_names: ['DSC1.ARW'],
    deleted: 0,
    kept: 0,
  });
  expect(scanned).toHaveLength(0);
});

test('an unticked half of a pair stays on the card and out of the library', async () => {
  const raw = place(card, 'DSC1.ARW', 'the raw');
  const jpeg = place(card, 'DSC1.JPG', 'the jpeg');
  const scan = await service.scan(card);
  const id = scan.files.find((file) => file.rel_path === 'DSC1.ARW')?.id ?? -1;

  await copyDeleting([id]);

  expect(existsSync(raw)).toBe(false);
  expect(existsSync(jpeg)).toBe(true);
  expect(readdirSync(root)).toEqual(['DSC1.ARW']);
});

test('stopping between a RAW and its camera file leaves the second untouched', async () => {
  const originals = [place(card, 'DSC1.ARW', 'the raw'), place(card, 'DSC1.JPG', 'the jpeg')];
  onProgress = (job) => {
    if (job.deleted === 1) service.stop();
  };

  const job = await copyDeleting();

  expect(job).toMatchObject({ status: 'stopped', copied: 1, deleted: 1 });
  expect(originals.filter((original) => existsSync(original))).toHaveLength(1);
  expect(readdirSync(root)).toHaveLength(1);
});

test('a copy that fails deletes nothing, and the rest carry on', async () => {
  const gone = place(card, 'a.arw');
  const fine = place(card, 'b.arw');
  const scan = await service.scan(card);
  rmSync(gone);

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: scan.files.map((file) => file.id),
    delete_originals: true,
  });
  const job = await finished();

  expect(existsSync(fine)).toBe(false);
  expect(job).toMatchObject({ copied: 1, failed: 1, deleted: 1, kept: 0 });
});

test('a copy that fails never reaches the deletion', async () => {
  const original = place(card, 'DSC1.ARW');
  const scan = await service.scan(card);
  rmSync(original);
  mkdirSync(original);

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [0],
    delete_originals: true,
  });
  const job = await finished();

  expect(job).toMatchObject({ failed: 1, deleted: 0, kept: 0 });
});

test('stopping keeps the originals of what was never copied', async () => {
  const originals = ['a.arw', 'b.arw', 'c.arw'].map((name) => place(card, name));
  onProgress = (job) => {
    if (job.deleted === 1) service.stop();
  };

  const job = await copyDeleting();

  expect(job).toMatchObject({ status: 'stopped', copied: 1, deleted: 1 });
  expect(originals.filter((original) => existsSync(original))).toHaveLength(2);
});

test('refuses to delete originals a library catalogues, and copies nothing', async () => {
  const inLibrary = place(root, 'Trip/DSC1.ARW');
  const scan = await service.scan(path.join(root, 'Trip'));

  await expect(
    service.start({
      scan_id: scan.id,
      library_id: library.id,
      shoot_id: null,
      file_ids: [0],
      delete_originals: true,
    }),
  ).rejects.toThrow('in a library');
  expect(existsSync(inLibrary)).toBe(true);
  expect(readdirSync(root)).toEqual(['Trip']);
});

test('the same source may still be copied without deleting', async () => {
  const inLibrary = place(root, 'Trip/DSC1.ARW');
  const scan = await service.scan(path.join(root, 'Trip'));

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [0],
    delete_originals: false,
  });
  const job = await finished();

  expect(job).toMatchObject({ copied: 1, deleted: 0 });
  expect(existsSync(inLibrary)).toBe(true);
});

test('waits out a scan already running', async () => {
  place(card, 'DSC1.ARW');
  scanConflicts = 1;

  await scanAndCopyAll();

  expect(scanned).toHaveLength(1);
});

test('stopping ends the wait for a running scan', async () => {
  place(card, 'DSC1.ARW');
  scanConflicts = Number.POSITIVE_INFINITY;
  const scan = await service.scan(card);

  onProgress = (job) => {
    if (job.copied === 1) service.stop();
  };

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [0],
    delete_originals: false,
  });
  const job = await finished();

  expect(job).toMatchObject({ status: 'finished', copied: 1 });
  expect(scanned).toHaveLength(0);
});

test('stopping keeps what landed and scans it', async () => {
  place(card, 'a.arw');
  place(card, 'b.arw');
  place(card, 'c.arw');
  onProgress = (job) => {
    if (job.copied === 1) service.stop();
  };

  const job = await scanAndCopyAll();

  expect(job).toMatchObject({ status: 'stopped', copied: 1, total: 3 });
  const landed = readdirSync(root);
  expect(landed).toHaveLength(1);
  expect(scanned).toEqual([{ libraryId: library.id, scope: { paths: landed } }]);
});

test('stopping after the last file still reads as finished', async () => {
  place(card, 'a.arw');
  onProgress = (job) => {
    if (job.copied === 1) service.stop();
  };

  const job = await scanAndCopyAll();

  expect(job).toMatchObject({ status: 'finished', copied: 1 });
});

test('the same file asked for twice counts and copies once', async () => {
  place(card, 'a.arw');
  const scan = await service.scan(card);

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [0, 0],
    delete_originals: false,
  });
  const job = await finished();

  expect(job).toMatchObject({ status: 'finished', total: 1, copied: 1 });
});

test('names kept for a failed run stop at 20, the count does not', async () => {
  const gone: string[] = [];
  for (let n = 0; n < 25; n++) gone.push(place(card, `frame${n}.arw`));
  const scan = await service.scan(card);
  for (const file of gone) rmSync(file);

  await service.start({
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: scan.files.map((file) => file.id),
    delete_originals: false,
  });
  const job = await finished();

  expect(job.failed).toBe(25);
  expect(job.failed_names).toHaveLength(20);
});

test.each([
  ['in another library', 'sht00002'],
  ['with a path out of the library', 'sht00003'],
])('refuses a shoot %s, and creates nothing', async (_, shootId) => {
  place(card, 'DSC1.ARW');
  const scan = await service.scan(card);

  await expect(
    service.start({
      scan_id: scan.id,
      library_id: library.id,
      shoot_id: shootId,
      file_ids: [0],
      delete_originals: false,
    }),
  ).rejects.toThrow('shoot');
  expect(readdirSync(root)).toEqual([]);
  expect(existsSync(path.join(scratch, 'escaped'))).toBe(false);
});

test('refuses a read-only library', async () => {
  place(card, 'DSC1.ARW');
  library.read_only = true;
  const scan = await service.scan(card);

  await expect(
    service.start({
      scan_id: scan.id,
      library_id: library.id,
      shoot_id: null,
      file_ids: [0],
      delete_originals: false,
    }),
  ).rejects.toThrow('read-only');
});

test('refuses a library whose root is not connected, and creates nothing there', async () => {
  place(card, 'DSC1.ARW');
  rmSync(root, { recursive: true });
  const scan = await service.scan(card);

  await expect(
    service.start({
      scan_id: scan.id,
      library_id: library.id,
      shoot_id: 'sht00001',
      file_ids: [0],
      delete_originals: false,
    }),
  ).rejects.toThrow("isn't connected");
  expect(existsSync(root)).toBe(false);
});

test('refuses a second run while one is copying', async () => {
  place(card, 'DSC1.ARW');
  const scan = await service.scan(card);
  const request = {
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [0],
    delete_originals: false,
  };

  await service.start(request);
  await expect(service.start(request)).rejects.toThrow('already being added');
  await finished();
});

test('2 starts at once make 1 run', async () => {
  place(card, 'DSC1.ARW');
  const scan = await service.scan(card);
  const request = {
    scan_id: scan.id,
    library_id: library.id,
    shoot_id: null,
    file_ids: [0],
    delete_originals: false,
  };

  const results = await Promise.allSettled([service.start(request), service.start(request)]);
  await finished();

  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
});

test('a scan is only reachable by its own id', async () => {
  place(card, 'DSC1.ARW');
  const stale = await service.scan(card);
  await service.scan(card);

  await expect(service.picture(stale.id, 0)).rejects.toThrow('scan not found');
  expect(() => service.fileStates(stale.id, library.id)).toThrow('scan not found');
});

test('a picture is the JPEG file itself, or the RAW embedded one, and never a HEIF', async () => {
  place(card, 'a.jpg');
  place(card, 'b.arw');
  place(card, 'blank.arw');
  place(card, 'c.heic');
  const scan = await service.scan(card);
  const id = (name: string): number => scan.files.find((file) => file.rel_path === name)?.id ?? -1;

  const camera = await service.picture(scan.id, id('a.jpg'));
  expect(camera.mediaType).toBe('image/jpeg');
  expect(await camera.body.text()).toBe('a.jpg');
  const embedded = await service.picture(scan.id, id('b.arw'));
  expect(embedded.mediaType).toBe('image/jpeg');
  expect(new Uint8Array(await embedded.body.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8]));
  await expect(service.picture(scan.id, id('blank.arw'))).rejects.toThrow('no embedded JPEG');
  await expect(service.picture(scan.id, id('c.heic'))).rejects.toThrow('no picture');
});

test('a header that cannot be read leaves that file blank and the rest intact', async () => {
  place(card, 'broken.arw');
  place(card, 'fine.arw');
  const scan = await service.scan(card);

  const headers = await service.readHeaders(
    scan.id,
    scan.files.map((file) => file.id),
  );
  const named = new Map(headers.map((h) => [scan.files[h.file_id]?.rel_path, h]));

  expect(named.get('broken.arw')).toMatchObject({ date_taken: null, camera_model: null });
  expect(named.get('fine.arw')).toMatchObject({
    date_taken: '2026-03-04T05:06:07.000Z',
    camera_model: 'A7 IV',
    lens_model: '35mm',
  });
});
