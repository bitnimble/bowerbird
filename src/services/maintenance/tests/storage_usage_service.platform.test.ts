import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StorageUsageService } from '../storage_usage_service';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bowerbird-storage-test-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(relative: string, bytes: number): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes));
  return file;
}

function service(cachePaths: readonly string[] = []): StorageUsageService {
  return new StorageUsageService({
    dataDir: path.join(root, 'data'),
    dbPath: path.join(root, 'catalogue.db'),
    cachePaths,
  });
}

test('counts persistent generated files, catalogue, backups, and caches without originals or staged updates', async () => {
  put('data/library/renditions/full-hdr/photo.avif', 10);
  put('data/library/analysis/photo.bba', 20);
  put('data/library/drafts/layers/seams.bin', 30);
  const cache = put('quality-cache/photo.avif', 40);
  put('catalogue.db', 50);
  put('catalogue.db-wal', 60);
  put('catalogue.db-shm', 70);
  put('catalogue.db-journal', 80);
  put('backups/catalogue.db-2026-09-01T00-00-00-000Z.db', 90);
  put('printer-profiles/paper.icc', 100);
  put('catalogue.db.pre-restore-123', 110);
  put('catalogue.db.pre-restore-123-wal', 120);
  const reference = put('reference_frame.ARW', 130);
  put('originals/photo.ARW', 10_000);
  put('originals/Bin/photo.ARW', 10_000);
  put('updates/staged/payload', 10_000);
  put('exports/photo.avif', 10_000);
  put('catalogue.db.restoring-123', 10_000);
  put('other.db.pre-restore-123', 10_000);
  put('backups/originals/photo.ARW', 10_000);
  put('backups/.catalogue.db-2026-09-01T00-00-00-000Z-1.part', 10_000);
  put('backups/other.db-2026-09-01T00-00-00-000Z.db', 10_000);
  put('backups/catalogue.db-2026-09-02T00-00-00-000Z.db/photo.ARW', 10_000);
  put('printer-profiles/originals/photo.ARW', 10_000);

  expect(await service([path.dirname(cache), reference]).measure()).toEqual({ bytes: 910 });
});

test('missing optional data and catalogue paths contribute zero', async () => {
  expect(await service([path.join(root, 'missing-cache')]).measure()).toEqual({ bytes: 0 });
});

test('counts retained data without render, fetch, scan, or assembly staging files', async () => {
  put('data/library/renditions/full-hdr/photo.avif', 10);
  put('data/library/analysis/photo.bba', 20);
  put('data/library/drafts/layers/seams.bin', 30);
  put('data/library/renditions/full-hdr/photo.avif.abcdefgh.tmp', 10_000);
  put('data/library/renditions/full-hdr/photo.avif.abcdefgh.fetching', 10_000);
  put('data/library/renditions/grid/photo.avif.descriptor', 10_000);
  put('data/library/drafts/.volume-abcdefgh.bin', 10_000);
  put('data/library/renditions/full-hdr/photo.avif.abcdefghijklmnop.tmp', 10_000);

  expect(await service().measure()).toEqual({ bytes: 60 });
});

test('excludes catalogue staging when the database lives inside generated data', async () => {
  const dataDir = path.join(root, 'data');
  const dbPath = put('data/catalogue.db', 10);
  put('data/backups/catalogue.db-2026-09-01T00-00-00-000Z.db', 20);
  put('data/backups/.catalogue.db-2026-09-01T00-00-00-000Z-1.part', 10_000);
  put('data/catalogue.db.restoring-2026-09-01T00-00-00-000Z', 10_000);

  expect(await new StorageUsageService({ dataDir, dbPath }).measure()).toEqual({ bytes: 30 });
});

test.each(['updates', ''])('excludes staged updates inside DATA_DIR/%s without excluding persistent data', async (directory) => {
  const dataDir = path.join(root, 'data');
  const dbPath = put('data/catalogue.db', 10);
  put('data/library/renditions/full-hdr/photo.avif', 20);
  put(path.join('data', directory, 'download/payload.tar'), 10_000);
  put(path.join('data', directory, 'staged/bowerbird'), 10_000);
  put(path.join('data', directory, 'staged.version'), 10_000);
  const updatesDir = path.join(dataDir, directory);

  expect(await new StorageUsageService({ dataDir, dbPath, updatesDir }).measure()).toEqual({ bytes: 30 });
});

test('counts overlapping roots and hardlinked files once', async () => {
  const dataDir = path.join(root, 'data');
  const dbPath = put('data/catalogue.db', 10);
  put('data/backups/snapshot.db', 20);
  const rendition = put('data/library/renditions/photo.avif', 30);
  const duplicate = path.join(root, 'data/duplicate.avif');
  linkSync(rendition, duplicate);
  const usage = new StorageUsageService({ dataDir, dbPath, cachePaths: [dataDir, rendition, duplicate] });

  expect(await usage.measure()).toEqual({ bytes: 60 });
});

test.skipIf(process.platform === 'win32')('resolves managed roots and catalogue links, skips nested links into originals', async () => {
  const data = put('generated/renditions/photo.avif', 10);
  symlinkSync(path.dirname(path.dirname(data)), path.join(root, 'data'), 'dir');
  const original = put('originals/photo.ARW', 10_000);
  symlinkSync(path.dirname(original), path.join(root, 'generated/originals'), 'dir');
  symlinkSync(original, path.join(root, 'generated/photo.ARW'));
  const catalogue = put('volume/catalogue.db', 20);
  symlinkSync(catalogue, path.join(root, 'catalogue.db'));
  put('volume/catalogue.db-wal', 30);
  put('volume/catalogue.db.pre-restore-123', 40);
  put('backups/catalogue.db-2026-09-01T00-00-00-000Z.db', 50);
  put('volume/backups/catalogue.db-2026-09-02T00-00-00-000Z.db', 60);
  put('printer-profiles/paper.icc', 70);

  expect(await service().measure()).toEqual({ bytes: 280 });
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails visibly when a data directory cannot be read', async () => {
  put('data/private/photo.avif', 10);
  const directory = path.join(root, 'data/private');
  chmodSync(directory, 0);
  try {
    await expect(service().measure()).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    chmodSync(directory, 0o700);
  }
});
